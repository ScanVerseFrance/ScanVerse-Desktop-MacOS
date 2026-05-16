/**
 * Bridge between the ScanVerse webview and the Electron main process (macOS).
 *
 * Exposes window.scanverse to the page so the React app can:
 *   - Detect it's running in the desktop wrapper
 *   - Push rich presence data (title, cover, etc.) for the current page
 *
 * Also injects a custom Discord-style title bar at the top of every page.
 * On macOS, the OS-rendered traffic-light buttons (red/yellow/green) sit
 * in the top-left of the window over the bar — we leave a ~80 px gap on
 * the left so the SV logo + page label start *after* them, instead of
 * being painted underneath.
 *
 * Only this minimal API is exposed to the page — no fs, no shell, no
 * node access.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Read the wrapper's version from its own package.json so it stays in sync.
let WRAPPER_VERSION = '?.?.?';
try { WRAPPER_VERSION = require('../package.json').version || WRAPPER_VERSION; } catch {}

contextBridge.exposeInMainWorld('scanverse', {
  isElectron: true,
  platform: 'darwin',
  version: WRAPPER_VERSION,
  /**
   * @param {string} route   one of: home | catalogue | manga | reader | profile |
   *                         friends | wrapped | admin | login | register | settings | notfound
   * @param {object} params  route-specific data (title, cover, chapter, etc.)
   */
  setPresence(route, params = {}) {
    if (typeof route !== 'string') return;
    console.log('[scanverse:preload] setPresence', route, params);
    ipcRenderer.send('presence:update', { route, params });
  },
  clearPresence() {
    ipcRenderer.send('presence:clear');
  },
  setRpcEnabled(enabled) {
    ipcRenderer.send('presence:set-enabled', !!enabled);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('[scanverse:preload] bridge ready, window.scanverse is available');
  try {
    const disabled = localStorage.getItem('sv_discord_rpc_disabled') === '1';
    ipcRenderer.send('presence:set-enabled', !disabled);
  } catch { /* localStorage may be blocked */ }

  injectTitleBar();
});

// ──────────────────────────────────────────────────────────────────────────
// Custom title bar
// ──────────────────────────────────────────────────────────────────────────

const TITLE_BAR_HEIGHT = 32; // mirrors the visual mac toolbar height

// Expose the title bar height as a CSS custom property so the site can
// account for it in viewport-height calculations and full-screen overlays.
try {
  document.documentElement.style.setProperty('--sv-titlebar-height', `${TITLE_BAR_HEIGHT}px`);
} catch { /* document not yet available — fallback below in injectTitleBar */ }

// macOS traffic-light buttons (close/minimize/zoom) are painted by the OS
// in the top-left at roughly x=12 (set via trafficLightPosition in main.js)
// and span ~52 px wide for the three buttons. We reserve 80 px so our SV
// logo + label start cleanly to the right of them — keeps the layout
// breathing-room equivalent to a native macOS document window.
const TRAFFIC_LIGHTS_RESERVE = 80;

function injectTitleBar() {
  if (document.getElementById('sv-titlebar')) return;

  const style = document.createElement('style');
  style.id = 'sv-titlebar-style';
  style.textContent = `
    body { padding-top: ${TITLE_BAR_HEIGHT}px !important; }

    #sv-titlebar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: ${TITLE_BAR_HEIGHT}px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      /* Reserve the left side for the macOS traffic-light controls; the
         right side stays free since macOS doesn't put any native widgets
         there in 'hiddenInset' mode. */
      padding: 0 14px 0 ${TRAFFIC_LIGHTS_RESERVE}px;
      background: #0a0a0f;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-family: 'Syne', system-ui, -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      color: #f0f0f5;
      user-select: none;
      -webkit-user-select: none;
      /* Whole bar is draggable — the .sv-tb-no-drag children opt out. The
         traffic-light area sits above the web contents layer so it stays
         clickable even though we paint behind it. */
      -webkit-app-region: drag;
    }
    #sv-titlebar .sv-tb-no-drag { -webkit-app-region: no-drag; }

    #sv-titlebar .sv-tb-logo {
      display: inline-flex;
      align-items: baseline;
      gap: 1px;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: -0.3px;
      color: #f0f0f5;
      flex-shrink: 0;
    }
    #sv-titlebar .sv-tb-logo .accent { color: #a855f7; }

    #sv-titlebar .sv-tb-divider {
      width: 1px;
      height: 14px;
      background: rgba(255,255,255,0.1);
      flex-shrink: 0;
    }

    #sv-titlebar .sv-tb-context {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      font-weight: 500;
      color: #9090a8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    #sv-titlebar .sv-tb-context strong {
      color: #f0f0f5;
      font-weight: 600;
    }

    #sv-titlebar .sv-tb-version {
      flex-shrink: 0;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.4px;
      color: #5a5a72;
      padding: 3px 7px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
      text-transform: lowercase;
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'sv-titlebar';
  bar.innerHTML = `
    <span class="sv-tb-logo">Scan<span class="accent">Verse</span></span>
    <span class="sv-tb-divider"></span>
    <span class="sv-tb-context" id="sv-tb-context">Accueil</span>
    <span class="sv-tb-version" id="sv-tb-version" title="Version de l'application"></span>
  `;
  document.body.appendChild(bar);

  const verEl = document.getElementById('sv-tb-version');
  if (verEl) {
    if (WRAPPER_VERSION && WRAPPER_VERSION !== '?.?.?') {
      verEl.textContent = 'v' + WRAPPER_VERSION;
    } else {
      verEl.style.display = 'none';
    }
  }
}

ipcRenderer.on('titlebar:context', (_event, msg) => {
  const ctx = document.getElementById('sv-tb-context');
  if (!ctx || !msg) return;
  ctx.textContent = msg.label || 'ScanVerse';
});

// ──────────────────────────────────────────────────────────────────────────
// Shift any fixed-positioned element pinned to the top edge so it doesn't
// sit underneath our injected title bar.
// ──────────────────────────────────────────────────────────────────────────

function shiftElementIfNeeded(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.id === 'sv-titlebar') return;
  if (el.dataset.svTopShifted === '1') return;
  if (!document.body || !document.body.contains(el)) return;
  const cs = getComputedStyle(el);
  if (cs.position !== 'fixed') return;
  const top = parseFloat(cs.top);
  if (!Number.isFinite(top)) return;
  if (top >= TITLE_BAR_HEIGHT) return;
  if (el.offsetHeight > 0 && el.offsetHeight > 200 && parseFloat(cs.bottom) === 0) {
    return;
  }
  el.dataset.svTopShifted = '1';
  el.dataset.svOriginalTop = String(top);
  el.style.setProperty('top', `${top + TITLE_BAR_HEIGHT}px`, 'important');
}

function scanAndShiftFixedElements() {
  if (!document.body) return;
  const candidates = document.querySelectorAll(
    'nav, header, aside, [role="banner"], [role="navigation"], [style*="fixed"], [class*="fixed"]'
  );
  candidates.forEach(shiftElementIfNeeded);
}

function startTopFixedShifter() {
  scanAndShiftFixedElements();

  const obs = new MutationObserver(muts => {
    let needsScan = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) shiftElementIfNeeded(n);
        }
      } else if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class')) {
        const el = m.target;
        if (el.dataset && el.dataset.svTopShifted === '1') {
          // already shifted — leave it
        } else {
          shiftElementIfNeeded(el);
        }
      }
    }
    if (needsScan) scanAndShiftFixedElements();
  });
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  setTimeout(scanAndShiftFixedElements, 500);
  setTimeout(scanAndShiftFixedElements, 1500);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startTopFixedShifter);
} else {
  startTopFixedShifter();
}
