/**
 * ScanVerse Desktop (macOS) — Electron main process.
 *
 * Boots a single-window webview pointed at the ScanVerse site, and bridges
 * route changes (and rich data from the page itself) to a Discord Rich
 * Presence connection — same behaviour as the Windows wrapper, adapted to
 * macOS conventions:
 *   - Native traffic-light controls via titleBarStyle: 'hiddenInset'
 *   - scanverse:// protocol handled through app.on('open-url')
 *   - In-app updater downloads a .dmg (not a .exe installer) and opens it
 *     in Finder so the user can drag the new app into /Applications
 *
 * URL is selected from env vars:
 *   SCANVERSE_URL   — full URL to load (e.g. http://192.168.2.100:5173)
 *   SCANVERSE_DEV   — if set, defaults to http://localhost:5173 + opens DevTools
 *   (otherwise defaults to https://www.scanverse.online — the public prod URL)
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, powerMonitor, Menu } = require('electron');
const path = require('path');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const { init: initRpc, updatePresence, clearPresence } = require('./rpc');
const { getPresenceForRoute, cleanChapterLabel } = require('./routes');
const { checkForUpdates } = require('./update-check');
const fs = require('fs');
const os = require('os');

/**
 * Sweep stale ScanVerse .dmg downloads from the macOS temp dir.
 *
 * The in-app updater downloads each new release into the OS temp dir
 * (see update-check.js → ipc 'update:download'). Once the user has dragged
 * the new app into /Applications and relaunched, the leftover .dmg is no
 * longer useful. We sweep on next launch (best-effort).
 */
function cleanupStaleInstallers() {
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (/^ScanVerse-.*\.dmg$/i.test(name)) {
        try { fs.unlinkSync(path.join(tmp, name)); } catch {}
      }
    }
  } catch {/* ignore — best-effort */}
}

const isDev = !!process.env.SCANVERSE_DEV;
const TARGET_URL = process.env.SCANVERSE_URL || (isDev ? 'http://localhost:5173' : 'https://www.scanverse.online');

let mainWindow = null;

// ── Custom protocol: scanverse:// ────────────────────────────────────────────
// Lets anyone share a deep link like scanverse://manga/abc that opens the
// desktop app directly at that page. On macOS the protocol is also registered
// in Info.plist (via electron-builder's mac.protocols), so the OS already
// knows our app handles scanverse:// after install — this call is for dev.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('scanverse', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('scanverse');
}

// Single-instance lock — if the user clicks a scanverse:// link while the
// app is already open, macOS routes it via the open-url event (handled below)
// without spawning a new instance. The lock is still useful when launched
// manually twice in dev.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * Translate a scanverse:// URL into a path on the target site.
 *   scanverse://manga/abc           → /manga/abc
 *   scanverse://read/abc/1          → /read/abc/1
 *   scanverse://m/abc  (joinSecret) → /manga/abc
 *   scanverse://r/abc/1 (joinSecret)→ /read/abc/1
 */
function pathFromProtocolUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'scanverse:') return null;
  const host = u.hostname || '';
  const segs = u.pathname.split('/').filter(Boolean);
  if ((host === 'manga' || host === 'm') && segs[0]) {
    return `/manga/${encodeURIComponent(segs[0])}`;
  }
  if ((host === 'read' || host === 'r') && segs[0] && segs[1]) {
    return `/read/${encodeURIComponent(segs[0])}/${encodeURIComponent(segs[1])}`;
  }
  return null;
}

function navigateFromProtocolUrl(urlStr) {
  const path = pathFromProtocolUrl(urlStr);
  if (!path || !mainWindow || mainWindow.isDestroyed()) return;
  const target = `${TARGET_URL.replace(/\/$/, '')}${path}`;
  console.log('[Main] scanverse:// →', target);
  mainWindow.loadURL(target);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * Parses a URL and returns { route, params } usable by routes.js.
 */
function parseRouteFromUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' || p === '') return { route: 'home' };
  if (p.startsWith('/catalogue')) {
    const type = u.searchParams.get('type') ||
      (p.endsWith('/comics') ? 'comics' : p.endsWith('/manga') ? 'manga' : 'manga');
    const q = u.searchParams.get('q');
    const genres = u.searchParams.get('genres');
    const sort   = u.searchParams.get('sort');
    return { route: 'catalogue', params: {
      type,
      q: q || null,
      genres: genres ? genres.split(',').filter(Boolean) : [],
      sort: sort || null,
    } };
  }
  let m = p.match(/^\/read\/([^/]+)\/([^/?#]+)/);
  if (m) return { route: 'reader', params: { id: m[1], chapter: m[2] } };
  m = p.match(/^\/manga\/([^/?#]+)/);
  if (m) return { route: 'manga', params: { id: m[1] } };
  m = p.match(/^\/profile\/([^/?#]+)/);
  if (m) return { route: 'profile', params: { username: m[1] } };
  m = p.match(/^\/univers\/([^/?#]+)/);
  if (m) return { route: 'universe', params: { id: m[1] } };
  if (p === '/friends') return { route: 'friends' };
  if (p === '/wrapped' || p.startsWith('/wrapped/')) {
    const year = p.match(/^\/wrapped\/(\d{4})/)?.[1];
    return { route: 'wrapped', params: year ? { year } : {} };
  }
  if (p === '/admin' || p.startsWith('/admin/')) return { route: 'admin' };
  if (p === '/login') return { route: 'login' };
  if (p === '/register') return { route: 'register' };
  if (p === '/settings/blocked')    return { route: 'settings-blocked' };
  if (p === '/settings/privacy')    return { route: 'settings-privacy' };
  if (p === '/settings/appearance') return { route: 'settings-appearance' };
  if (p.startsWith('/settings')) return { route: 'settings' };
  if (p === '/suggestions') return { route: 'suggestions' };
  if (p === '/premium') return { route: 'premium' };
  if (p === '/about') return { route: 'about' };
  if (p === '/contact') return { route: 'contact' };
  if (p === '/privacy-policy') return { route: 'privacy' };
  if (p === '/terms') return { route: 'terms' };
  if (p === '/changelog') return { route: 'changelog' };
  if (p === '/messages' || p.startsWith('/messages/')) {
    const handle = p.match(/^\/messages\/([^/?#]+)/)?.[1] || null;
    return { route: 'messages', params: handle ? { handle: decodeURIComponent(handle) } : {} };
  }
  return { route: 'notfound' };
}

// Privacy gate — page can disable RPC via window.scanverse.setRpcEnabled(false).
let rpcEnabled = true;

// Cache of the last *rich* payload pushed by the frontend hook.
let lastRichPayload = null;

// Live session activity — # of users online on ScanVerse right now.
let onlineCount = 0;
async function pollOnlineCount() {
  try {
    const url = `${TARGET_URL.replace(/\/$/, '')}/api/presence/online-count`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const next = Number(data.online) || 0;
    if (next !== onlineCount) {
      onlineCount = next;
      console.log('[Main] online count:', onlineCount);
      if (rpcEnabled && mainWindow && !mainWindow.isDestroyed()) {
        emitPresenceFromUrl(mainWindow.webContents.getURL());
      }
    }
  } catch { /* ignore */ }
}

function titleBarLabelFor(route, params = {}) {
  switch (route) {
    case 'home':              return 'Accueil';
    case 'catalogue':         return params.type === 'comics' ? 'Catalogue · Comics' : 'Catalogue · Manga';
    case 'manga':             return params.title ? `${params.title}` : 'Fiche d\'œuvre';
    case 'reader': {
      const t = params.title || null;
      const ch = params.chapter != null ? cleanChapterLabel(params.chapter, params.id) : null;
      if (t && ch) {
        const isVol = /^(Tome|Intégrale|Hors-série)\s/.test(ch);
        return isVol ? `${t} — ${ch}` : `${t} — Ch.${ch}`;
      }
      if (t) return t;
      return 'Lecture en cours';
    }
    case 'profile':           return params.username ? `Profil de @${params.username}` : 'Profil';
    case 'friends':           return 'Amis';
    case 'wrapped':           return params.year ? `Wrapped ${params.year}` : 'Wrapped';
    case 'admin':             return 'Espace admin';
    case 'login':             return 'Connexion';
    case 'register':          return 'Inscription';
    case 'settings':          return 'Réglages';
    case 'settings-blocked':  return 'Réglages · Blocages';
    case 'settings-privacy':  return 'Réglages · Confidentialité';
    case 'settings-appearance': return 'Réglages · Apparence';
    case 'settings-music':    return 'Réglages · Musique';
    case 'settings-reader':   return 'Réglages · Lecteur';
    case 'universe':          return 'Univers';
    case 'suggestions':       return 'Suggestions';
    case 'premium':           return 'Premium';
    case 'about':             return 'À propos';
    case 'contact':           return 'Contact';
    case 'privacy':           return 'Confidentialité';
    case 'terms':             return 'CGU';
    case 'changelog':         return 'Changelog';
    case 'messages':          return params.handle ? `Messagerie · @${params.handle}` : 'Messagerie';
    case 'notfound':          return 'Page introuvable';
    default:                  return 'ScanVerse';
  }
}

function broadcastTitleBarContext(route, params = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const label = titleBarLabelFor(route, params);
  mainWindow.webContents.send('titlebar:context', { route, params, label });
}

function emitPresenceFromUrl(urlStr) {
  if (!rpcEnabled) return;
  const parsed = parseRouteFromUrl(urlStr);
  if (!parsed) return;

  if (lastRichPayload && lastRichPayload.route === parsed.route) {
    const richId = lastRichPayload.params?.id;
    const urlId  = parsed.params?.id;
    const idMatches = !richId || !urlId || String(richId) === String(urlId);
    if (idMatches) {
      const payload = getPresenceForRoute(lastRichPayload.route, lastRichPayload.params, { onlineCount });
      if (payload) updatePresence(payload);
      return;
    }
  }

  const payload = getPresenceForRoute(parsed.route, parsed.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
}

/**
 * Build a minimal native menu for macOS. Without an explicit menu the app
 * inherits Electron's default one, which exposes Reload / Toggle DevTools /
 * View Source — exactly the entries we want to suppress in production.
 *
 * We keep the standard macOS conventions (App > About / Quit, Edit clipboard
 * shortcuts, Window > Minimize / Close) so Cmd+Q, Cmd+C, Cmd+W keep working
 * as expected. DevTools is gated on isDev.
 */
function buildAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: isDev
        ? [
            { role: 'reload', label: 'Recharger' },
            { role: 'forceReload', label: 'Recharger sans cache' },
            { role: 'toggleDevTools', label: 'Outils de développement' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: 'Plein écran' },
          ]
        : [
            { role: 'togglefullscreen', label: 'Plein écran' },
          ],
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'close', label: 'Fermer' },
        { role: 'zoom', label: 'Agrandir' },
        { type: 'separator' },
        { role: 'front', label: 'Mettre au premier plan' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const icon = nativeImage.createFromPath(ICON_PATH);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon,
    backgroundColor: '#0a0a0f',
    title: 'ScanVerse',
    // macOS native title bar — traffic-light buttons (red/yellow/green) are
    // painted by the OS in the top-left and remain clickable. The rest of
    // the bar area is owned by our preload-injected #sv-titlebar (drag
    // region + page label). 'hiddenInset' shifts the traffic lights inward
    // slightly so they sit nicely centred in our 32 px bar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 9 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // Hard-disable DevTools in production builds.
      devTools: isDev,
      // Same Kazu-reported background-throttling fix as the Windows build —
      // alt-tabbing away for a while comes back to a black screen with all
      // UI gone because Chromium throttles RAF / evicts WebGL contexts when
      // the window is hidden. On macOS the same Three.js + per-layer
      // profile-effect intervals suffer the same fate. Cost: ~constant CPU
      // when the window is hidden, which is the right trade for a
      // chat/reader app where the user expects to come back to a live page.
      backgroundThrottling: false,
    },
  });

  // ── Lockdown: keyboard shortcuts + context menu ────────────────────────
  // Strip the obvious devtools / view-source shortcuts in production. In
  // dev we let them through. On macOS the canonical DevTools shortcut is
  // Cmd+Option+I, Cmd+Option+C (inspect element), Cmd+Option+J (console),
  // plus Cmd+U (view source) and Cmd+S (save page) which we also block
  // out of paranoia.
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const blocked =
        key === 'f12' ||
        (input.meta && input.alt && (key === 'i' || key === 'j' || key === 'c' || key === 'u')) ||
        (input.meta && (key === 'u' || key === 's')) ||
        // Belt-and-braces for users with non-Apple keyboards plugged into a Mac.
        (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) ||
        (input.control && (key === 'u' || key === 's'));
      if (blocked) event.preventDefault();
    });

    mainWindow.webContents.on('context-menu', e => e.preventDefault());
  }

  // Open external links (target=_blank, http(s) outside the site) in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isOurSite = url.startsWith(TARGET_URL.replace(/\/$/, '')) ||
                      url.startsWith('http://localhost') ||
                      url.startsWith('http://192.168.');
    if (!isOurSite && url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // URL-based presence detection — events + polling fallback.
  let lastSeenUrl = '';
  function checkUrl(reason) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (!url || url === lastSeenUrl) return;
    const prevUrl = lastSeenUrl;
    lastSeenUrl = url;
    const prevParsed = prevUrl ? parseRouteFromUrl(prevUrl) : null;
    const nextParsed = parseRouteFromUrl(url);
    const idChanged =
      !prevParsed || !nextParsed ||
      prevParsed.route !== nextParsed.route ||
      String(prevParsed.params?.id || '') !== String(nextParsed.params?.id || '');
    if (idChanged) lastRichPayload = null;
    console.log(`[Main] URL change (${reason}):`, url, idChanged ? '— cache cleared' : '— cache kept');
    if (/^https?:/i.test(url)) {
      const parsed = parseRouteFromUrl(url);
      if (parsed) broadcastTitleBarContext(parsed.route, parsed.params || {});
    }
    emitPresenceFromUrl(url);
  }
  mainWindow.webContents.on('did-navigate',         (_e, _url) => checkUrl('did-navigate'));
  mainWindow.webContents.on('did-navigate-in-page', (_e, _url) => checkUrl('did-navigate-in-page'));
  const pollId = setInterval(() => checkUrl('poll'), 1000);

  // OS-level idle detection — fallback for the frontend's idle timer.
  const OS_IDLE_THRESHOLD_S = 10 * 60; // 10 min
  let wrapperIdle = false;
  const idlePollId = setInterval(() => {
    if (!rpcEnabled) return;
    if (!lastRichPayload) return;
    if (lastRichPayload.route !== 'reader') return;
    let idleSeconds;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); }
    catch { return; }
    const shouldBeIdle = idleSeconds >= OS_IDLE_THRESHOLD_S;
    if (shouldBeIdle === wrapperIdle) return;
    wrapperIdle = shouldBeIdle;
    const merged = { ...lastRichPayload.params, idle: shouldBeIdle };
    lastRichPayload = { route: lastRichPayload.route, params: merged };
    const payload = getPresenceForRoute(lastRichPayload.route, merged, { onlineCount });
    if (payload) updatePresence(payload);
    console.log(`[Main] wrapper idle → ${shouldBeIdle} (${idleSeconds}s OS idle)`);
  }, 60_000);

  mainWindow.on('closed', () => {
    clearInterval(pollId);
    clearInterval(idlePollId);
    mainWindow = null;
  });

  // ── Loading + error overlays ─────────────────────────────────────────
  const FONTS_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

  const SPLASH_HTML = `
    <html><head><meta charset="utf-8"><title>ScanVerse</title>
    ${FONTS_HEAD}
    <style>
      html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
      .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px}
      .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:32px;letter-spacing:-1px}
      .logo .v{color:#a855f7}
      .spinner{width:32px;height:32px;border:3px solid rgba(168,85,247,0.2);border-top-color:#a855f7;border-radius:50%;animation:spin 0.8s linear infinite}
      .label{color:#5a5a72;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-family:'JetBrains Mono',ui-monospace,monospace}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head>
    <body><div class="wrap">
      <div class="logo"><span>Scan</span><span class="v">Verse</span></div>
      <div class="spinner"></div>
      <div class="label">Chargement…</div>
    </div></body></html>`;

  function buildErrorHtml(target, message) {
    const safeTarget = String(target || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    const safeMsg = String(message || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    return `
      <html><head><meta charset="utf-8"><title>ScanVerse — Erreur</title>
      ${FONTS_HEAD}
      <style>
        html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
        .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:24px;text-align:center;box-sizing:border-box}
        .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:24px;letter-spacing:-1px;opacity:0.5;margin-bottom:8px}
        .logo .v{color:#a855f7}
        h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px}
        p{margin:0;color:#9090a8;font-size:14px;max-width:480px;line-height:1.5}
        code{background:#18181f;padding:2px 8px;border-radius:4px;font-size:12px;color:#c4b5fd;font-family:'JetBrains Mono',ui-monospace,monospace}
        .err{background:#18181f;padding:8px 12px;border-radius:8px;font-size:12px;color:#ef4444;font-family:'JetBrains Mono',ui-monospace,monospace;max-width:560px;overflow-wrap:break-word;border:1px solid rgba(239,68,68,0.2)}
        .actions{display:flex;gap:12px;margin-top:8px}
        button{padding:10px 18px;border-radius:10px;border:none;font-weight:800;font-size:13px;cursor:pointer;transition:transform .1s;font-family:'Syne',system-ui,sans-serif;letter-spacing:0.02em;display:inline-flex;align-items:center;gap:7px}
        button:active{transform:scale(0.97)}
        .primary{background:#a855f7;color:#fff}
        .secondary{background:#18181f;color:#f0f0f5;border:1px solid rgba(255,255,255,0.1)}
        .discord{background:#5865f2;color:#fff}
        .discord-prompt{margin-top:4px;color:#9090a8;font-size:13px}
      </style></head>
      <body><div class="wrap">
        <div class="logo"><span>Scan</span><span class="v">Verse</span></div>
        <h1>ScanVerse est injoignable</h1>
        <p>Impossible de charger <code>${safeTarget}</code>. Vérifie que le site est en ligne.</p>
        <div class="err">${safeMsg}</div>
        <p class="discord-prompt">Pour toute question, rejoins le Discord :</p>
        <div class="actions">
          <button class="primary" onclick="location.reload()">Réessayer</button>
          <button class="discord" onclick="window.open('https://discord.gg/scanverse','_blank')">
            <svg width="14" height="14" viewBox="0 0 127 96" fill="currentColor"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
            Rejoindre
          </button>
          <button class="secondary" onclick="window.close()">Fermer</button>
        </div>
      </div></body></html>`;
  }

  // Show splash immediately while the real site loads.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));

  let didFinishOnce = false;
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    if (/aborted/i.test(errorDesc || '')) return;
    if (validatedURL && validatedURL.startsWith('data:')) return;
    console.error('[Main] did-fail-load', errorCode, errorDesc, 'at', validatedURL);
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      buildErrorHtml(TARGET_URL, `${errorDesc} (${errorCode})`)
    ));
  });
  mainWindow.webContents.on('did-finish-load', () => { didFinishOnce = true; });

  setTimeout(() => {
    console.log('[Main] Loading', TARGET_URL);
    mainWindow.loadURL(TARGET_URL).catch(err => {
      console.error('[Main] loadURL rejected:', err.message);
      if (!didFinishOnce) {
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          buildErrorHtml(TARGET_URL, err.message)
        ));
      }
    });
  }, 250);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// Second-instance (rare on macOS — the OS routes scanverse:// via open-url
// to the existing instance instead). Kept for parity / dev launches.
app.on('second-instance', (_event, argv) => {
  const protoUrl = argv.find(a => typeof a === 'string' && a.startsWith('scanverse://'));
  if (protoUrl) navigateFromProtocolUrl(protoUrl);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS — scanverse:// link opened externally. This is the canonical path
// for deep links on macOS; Windows uses second-instance argv.
app.on('open-url', (event, url) => {
  event.preventDefault();
  navigateFromProtocolUrl(url);
});

app.whenReady().then(async () => {
  cleanupStaleInstallers();
  buildAppMenu();

  await initRpc();
  createWindow();

  // Cold-start via scanverse:// — on macOS the OS usually emits open-url
  // *before* whenReady resolves, in which case navigateFromProtocolUrl
  // does nothing (no window yet). We re-check after createWindow so any
  // queued URL is honoured. (Belt-and-braces; the open-url handler will
  // also re-fire on subsequent clicks.)
  const coldStartProtoUrl = process.argv.find(a =>
    typeof a === 'string' && a.startsWith('scanverse://')
  );
  if (coldStartProtoUrl) {
    setTimeout(() => navigateFromProtocolUrl(coldStartProtoUrl), 500);
  }

  setTimeout(pollOnlineCount, 3000);
  setInterval(pollOnlineCount, 30000);

  // Update check — skipped in dev. Re-checks every 4 h while the app stays
  // open so users who keep the app running for days still get prompted.
  if (!isDev) {
    setTimeout(() => checkForUpdates(mainWindow).catch(() => {}), 8000);
    setInterval(() => checkForUpdates(mainWindow).catch(() => {}), 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS apps typically stay alive when all windows are closed — clicking
// the dock icon re-opens the window via the 'activate' handler. Keep that
// convention; Cmd+Q (handled by the native menu) is how the user truly
// quits the app.
app.on('window-all-closed', () => {
  clearPresence();
  if (process.platform !== 'darwin') app.quit();
});

// IPC: page -> main, push rich presence data
ipcMain.on('presence:update', (_event, msg) => {
  if (!msg || typeof msg.route !== 'string') return;
  console.log('[Main] presence:update from page —', msg.route, JSON.stringify(msg.params));
  broadcastTitleBarContext(msg.route, msg.params || {});
  if (!rpcEnabled) return;
  lastRichPayload = { route: msg.route, params: msg.params || {} };
  const payload = getPresenceForRoute(msg.route, msg.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
});

ipcMain.on('presence:clear', () => {
  lastRichPayload = null;
  clearPresence();
});

ipcMain.on('presence:set-enabled', (_event, enabled) => {
  const next = !!enabled;
  if (next === rpcEnabled) return;
  rpcEnabled = next;
  console.log('[Main] RPC privacy →', rpcEnabled ? 'ENABLED' : 'DISABLED');
  if (!rpcEnabled) {
    lastRichPayload = null;
    clearPresence();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const url = mainWindow.webContents.getURL();
    if (url) emitPresenceFromUrl(url);
  }
});
