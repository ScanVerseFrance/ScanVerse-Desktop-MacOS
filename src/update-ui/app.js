/**
 * Update modal — renderer logic. Tiny state machine over four screens
 * (prompt → downloading → ready → error) driven by IPC messages from
 * the main process (window.updater bridge).
 */

const states = Array.from(document.querySelectorAll('.state'));
function show(name) {
  for (const s of states) s.classList.toggle('active', s.dataset.state === name);
}

// ── State 1: prompt ─────────────────────────────────────────────────────
const latestVerEl  = document.getElementById('latest-ver');
const currentVerEl = document.getElementById('current-ver');
const dlVerEl      = document.getElementById('dl-ver');
const sizeLineEl   = document.getElementById('size-line');

function fmtBytes(n) {
  if (!n || n < 0) return '0 Mo';
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1).replace('.', ',')} Mo`;
  return `${(mb / 1024).toFixed(2).replace('.', ',')} Go`;
}

function applyInfo(info) {
  if (!info) return;
  latestVerEl.textContent  = info.latest;
  currentVerEl.textContent = info.current;
  dlVerEl.textContent      = info.latest;
  if (info.assetSize) {
    sizeLineEl.textContent = `Taille du téléchargement : ${fmtBytes(info.assetSize)}`;
  }
}

window.updater.onInfo(applyInfo);
// In case the modal opened before main pushed the initial event, pull it.
window.updater.getInfo().then(info => { if (info) applyInfo(info); });

// ── Buttons (prompt) ────────────────────────────────────────────────────
document.getElementById('later-btn').addEventListener('click', () => window.updater.close());
document.getElementById('close-btn').addEventListener('click', () => window.updater.close());

document.getElementById('download-btn').addEventListener('click', async () => {
  show('downloading');
  const r = await window.updater.download();
  if (r?.ok) {
    show('ready');
  } else if (r?.aborted) {
    // User cancelled — close the window entirely. (We're in 'downloading'
    // state but the cancel button already triggered close, so this branch
    // is mostly for race-free cleanup.)
    return;
  } else {
    document.getElementById('error-msg').textContent =
      r?.error || 'Le téléchargement a échoué. Vérifie ta connexion et réessaye.';
    show('error');
  }
});

// ── Buttons (downloading) ───────────────────────────────────────────────
document.getElementById('cancel-btn').addEventListener('click', () => window.updater.close());

// ── Buttons (ready) ─────────────────────────────────────────────────────
document.getElementById('ready-cancel-btn').addEventListener('click', () => window.updater.close());
document.getElementById('apply-btn').addEventListener('click', () => {
  // Disable the button to prevent double-clicks while we transition out.
  document.getElementById('apply-btn').disabled = true;
  document.getElementById('apply-btn').textContent = 'Ouverture…';
  window.updater.apply();
});

// ── Buttons (error) ─────────────────────────────────────────────────────
document.getElementById('error-close-btn').addEventListener('click', () => window.updater.close());
document.getElementById('error-browser-btn').addEventListener('click', () => {
  window.updater.openInBrowser();
  window.updater.close();
});

// ── Progress updates ────────────────────────────────────────────────────
const bar       = document.getElementById('progress-bar');
const detailEl  = document.getElementById('progress-detail');

window.updater.onProgress(({ downloaded, total }) => {
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  bar.style.width = pct + '%';
  detailEl.textContent = total > 0
    ? `${fmtBytes(downloaded)} / ${fmtBytes(total)} — ${pct}%`
    : fmtBytes(downloaded);
});
