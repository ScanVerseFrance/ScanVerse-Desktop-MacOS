/**
 * ScanVerse — in-app update orchestrator (macOS flavour).
 *
 * 1. On startup: fetch latest release from GitHub Releases API, compare
 *    against installed version. If newer → spawn a custom branded modal
 *    BrowserWindow (src/update-ui/) — same component used by the Windows
 *    build, so the UX feels identical across platforms.
 *
 * 2. User clicks "Télécharger" in the modal:
 *    - We pick the .dmg asset matching the user's CPU arch (arm64 for
 *      Apple Silicon, x64 for Intel; falls back to the universal/any-arch
 *      .dmg if the arch-specific one isn't published).
 *    - Stream the file into the OS temp dir. Progress at ~10 Hz.
 *    - Cancel-friendly via AbortController.
 *
 * 3. User clicks "Installer la mise à jour" on the ready screen:
 *    - We `shell.openPath` the .dmg. macOS mounts it and opens the Finder
 *      window with the drag-to-Applications shortcut (provided by the
 *      electron-builder DMG layout). The user replaces the old app in
 *      /Applications by dragging the new one in.
 *    - We quit ourselves so the running .app file is unlocked — without
 *      this, Finder shows "ScanVerse is in use" when copying over the
 *      existing bundle.
 *
 *    There's no silent install on macOS for unsigned apps: code-signing /
 *    notarization is required to perform an in-place app replacement
 *    without Gatekeeper / quarantine intervention. The drag-and-drop
 *    pattern is the canonical macOS upgrade flow for distributed-outside-
 *    the-App-Store apps and matches what apps like VS Code, Slack, etc.
 *    do when they don't ship a Squirrel.Mac updater.
 *
 * Failure modes:
 *   - No network / API rate-limit → silent skip, retry next launch.
 *   - Modal closed mid-download → abort, throw away partial file.
 *   - Open .dmg fails → user gets the error state with a fallback button
 *     to open the GitHub release page in their browser.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = 'ScanVerseFrance/ScanVerse-Desktop-MacOS';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

// ── Module state ─────────────────────────────────────────────────────────
let updateWindow = null;
let downloadAbort = null;
let downloadedDmgPath = null;
let cachedRelease = null;
let ipcRegistered = false;

function isNewer(latest, current) {
  const [la = 0, lb = 0, lc = 0] = String(latest).split('.').map(n => parseInt(n, 10) || 0);
  const [ca = 0, cb = 0, cc = 0] = String(current).split('.').map(n => parseInt(n, 10) || 0);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function fetchLatestRelease() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(RELEASES_API, {
      headers: {
        'User-Agent': `ScanVerse-Desktop-MacOS/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the .dmg asset that matches the current Mac's CPU architecture.
 *
 * electron-builder names DMGs like "ScanVerse-0.2.14-arm64.dmg" /
 * "ScanVerse-0.2.14-x64.dmg" when arch is specified, or just
 * "ScanVerse-0.2.14.dmg" for a universal binary. We try arch-specific
 * first; fall back to the un-suffixed one if not present.
 */
function pickDmgAsset(assets, arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const dmgs = assets.filter(a => /\.dmg$/i.test(a.name));
  if (dmgs.length === 0) return null;
  // Apple Silicon (M1/M2/M3) reports 'arm64' from Node's process.arch.
  // Intel Macs report 'x64'. Anything else (rare on macOS) falls through
  // to the universal asset.
  const archKey = arch === 'arm64' ? 'arm64' : 'x64';
  return (
    dmgs.find(a => new RegExp(`[-_]${archKey}\\.dmg$`, 'i').test(a.name)) ||
    dmgs.find(a => /universal/i.test(a.name)) ||
    dmgs.find(a => !/[-_](arm64|x64|universal)\.dmg$/i.test(a.name)) ||
    dmgs[0]
  );
}

// ── Modal window ─────────────────────────────────────────────────────────
function showUpdateWindow(parent) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 520,
    height: 380,
    parent: parent || undefined,
    modal: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0a0f',
    title: 'ScanVerse — Mise à jour',
    // Hide the dock entry for the modal — it would show a second ScanVerse
    // icon in the dock while open, which feels wrong for a child window.
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,
    },
  });
  updateWindow.loadFile(path.join(__dirname, 'update-ui', 'index.html'));
  updateWindow.on('closed', () => {
    updateWindow = null;
    if (downloadAbort) { try { downloadAbort.abort(); } catch {} downloadAbort = null; }
  });
  updateWindow.webContents.once('did-finish-load', () => {
    updateWindow?.webContents.send('update:info', {
      latest: cachedRelease.latest,
      current: cachedRelease.current,
      assetName: cachedRelease.asset.name,
      assetSize: cachedRelease.asset.size,
    });
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────
function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('update:get-info', () => {
    if (!cachedRelease) return null;
    return {
      latest: cachedRelease.latest,
      current: cachedRelease.current,
      assetName: cachedRelease.asset.name,
      assetSize: cachedRelease.asset.size,
    };
  });

  ipcMain.handle('update:download', async () => {
    if (!cachedRelease) return { ok: false, error: 'No release info' };
    const { asset, latest } = cachedRelease;
    const tmpPath = path.join(os.tmpdir(), `ScanVerse-${latest}-${process.arch}.dmg`);

    try { fs.unlinkSync(tmpPath); } catch {}

    downloadAbort = new AbortController();
    try {
      const res = await fetch(asset.browser_download_url, {
        signal: downloadAbort.signal,
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const total = parseInt(res.headers.get('content-length') || String(asset.size || 0), 10);
      const writer = fs.createWriteStream(tmpPath);
      const reader = res.body.getReader();
      let downloaded = 0;
      let lastEmit = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise((resolve, reject) => {
          writer.write(Buffer.from(value), err => err ? reject(err) : resolve());
        });
        downloaded += value.length;
        const now = Date.now();
        if (now - lastEmit > 100) {
          updateWindow?.webContents.send('update:progress', { downloaded, total });
          lastEmit = now;
        }
      }
      await new Promise((resolve, reject) => writer.end(err => err ? reject(err) : resolve()));
      updateWindow?.webContents.send('update:progress', { downloaded: total || downloaded, total: total || downloaded });

      downloadedDmgPath = tmpPath;
      return { ok: true };
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      console.error('[Update] download failed:', err);
      return { ok: false, error: err.message || String(err) };
    } finally {
      downloadAbort = null;
    }
  });

  // User clicked "Installer la mise à jour" — open the .dmg so Finder
  // mounts it and shows the drag-to-Applications window, then quit so the
  // existing app bundle is unlocked.
  ipcMain.on('update:apply', async () => {
    if (!downloadedDmgPath || !fs.existsSync(downloadedDmgPath)) return;
    try {
      const err = await shell.openPath(downloadedDmgPath);
      if (err) {
        console.error('[Update] openPath returned error:', err);
        // shell.openExternal as a fallback — some sandbox configs reject
        // openPath but accept openExternal on a file:// URL.
        await shell.openExternal('file://' + downloadedDmgPath);
      }
    } catch (e) {
      console.error('[Update] failed to open dmg:', e);
      return;
    }
    // Give Finder a beat to actually mount the dmg before we quit; without
    // this small delay the mount window can momentarily disappear when the
    // parent app exits (macOS sometimes treats us as the dmg's "owner").
    setTimeout(() => app.quit(), 800);
  });

  ipcMain.on('update:close', () => {
    if (downloadAbort) { try { downloadAbort.abort(); } catch {} }
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
  });

  ipcMain.on('update:open-release', () => {
    shell.openExternal(RELEASES_PAGE).catch(() => {});
  });
}

/**
 * Public entry point — call once on startup, after `app.whenReady`.
 *
 * @param {BrowserWindow|null} parent — optional parent for the modal.
 */
async function checkForUpdates(parent) {
  registerIpc();

  const release = await fetchLatestRelease();
  if (!release || !release.tag_name) {
    console.log('[Update] no release feed (yet) — skipping');
    return;
  }
  if (release.draft || release.prerelease) {
    console.log('[Update] latest release is draft/prerelease — skipping');
    return;
  }

  const latest = release.tag_name.replace(/^v/i, '');
  const current = app.getVersion();
  console.log(`[Update] current=${current}, latest=${latest}`);
  if (!isNewer(latest, current)) return;

  const asset = pickDmgAsset(release.assets || [], process.arch);
  if (!asset) {
    console.log('[Update] release has no .dmg asset for arch', process.arch, '— skipping');
    return;
  }

  cachedRelease = { latest, current, asset };
  showUpdateWindow(parent);
}

module.exports = { checkForUpdates };
