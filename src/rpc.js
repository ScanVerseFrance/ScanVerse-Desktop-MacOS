/**
 * Thin wrapper around discord-rpc with auto-reconnect and a single
 * "current presence" cache so we don't spam Discord with identical payloads.
 *
 * RPC events (connect / disconnect / payload validation errors) are also
 * appended to %APPDATA%/scanverse-webview/rpc.log so a user can send the
 * file when their Discord presence isn't showing — much easier than
 * walking them through opening DevTools or running from a terminal.
 */
const RPC = require('discord-rpc');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CLIENT_ID = '1500986435220541591';

let client = null;
let connected = false;
let connecting = false;
let lastPayload = null;
let queued = null;
// Heartbeat re-emit interval — Discord's CDN drops cached asset URLs after
// roughly 10 min of inactivity on the same payload, which manifests in the
// wild as "the cover/avatar disappears when I stay on my profile too long".
// Periodically re-pushing the *same* lastPayload (bypassing the de-dup
// guard) keeps the asset cache warm. 4 min is comfortably below the
// observed expiry and well above discord-rpc's 15s rate limit.
const HEARTBEAT_MS = 4 * 60 * 1000;
let heartbeatTimer = null;

// Resolve the log path lazily — `app.getPath('userData')` errors out before
// `app.whenReady()`, and rpc.js is required from main.js at load time.
let logPath = null;
function getLogPath() {
  if (logPath) return logPath;
  try { logPath = path.join(app.getPath('userData'), 'rpc.log'); } catch {}
  return logPath;
}
function logToFile(msg) {
  const p = getLogPath();
  if (!p) return;
  fs.appendFile(p, `[${new Date().toISOString()}] ${msg}\n`, () => {});
}

// Session-aware timestamp: when the same _sessionKey is provided across
// multiple updates, we keep the original startTimestamp so Discord shows
// elapsed time over the *whole reading session*, not since the last page
// turn or chapter change. Reader uses sessionKey "reader:<mangaId>" — so
// going between chapters of the same manga preserves the timer.
let sessionKey = null;
let sessionStart = null;

RPC.register(CLIENT_ID);

async function connect() {
  if (connected || connecting) return;
  connecting = true;
  try {
    client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      connected = true;
      const who = client.user?.username || 'unknown';
      console.log('[RPC] Connected as', who);
      logToFile(`Connected as ${who}`);
      if (queued) {
        const p = queued;
        queued = null;
        sendActivity(p);
      }
    });
    client.on('disconnected', () => {
      connected = false;
      console.log('[RPC] Disconnected');
      logToFile('Disconnected');
    });
    await client.login({ clientId: CLIENT_ID });
  } catch (err) {
    console.warn('[RPC] Discord client unreachable —', err.message);
    logToFile(`login failed: ${err.message || err}`);
    connected = false;
    client = null;
  } finally {
    connecting = false;
  }
}

function sendActivity(payload) {
  if (!client || !connected) {
    queued = payload;
    connect().catch(() => {});
    return;
  }
  client.setActivity(payload).catch(err => {
    const msg = err.message || String(err);
    console.error('[RPC] setActivity failed:', msg);
    logToFile(`setActivity failed: ${msg} | payload=${JSON.stringify({ details: payload.details, state: payload.state, hasButtons: !!payload.buttons })}`);
    // Validation errors (bad payload, e.g. invalid URI in buttons) don't
    // mean the transport is broken — keep the connection alive and let the
    // next valid update through. Only tear down on actual transport errors.
    const isValidation = /child "|fails because|valid uri|valid url|too long|secrets cannot|cannot be sent|invalid activity/i.test(msg);
    if (!isValidation) {
      connected = false;
      queued = payload;
      setTimeout(() => connect().catch(() => {}), 5000);
    } else {
      // Forget this bad payload so the next call (different content) is
      // not deduped against it.
      lastPayload = null;
    }
  });
}

function isSamePayload(a, b) {
  if (!a || !b) return false;
  return a.details === b.details
      && a.state === b.state
      && a.largeImageKey === b.largeImageKey
      && a.largeImageText === b.largeImageText
      && JSON.stringify(a.buttons || []) === JSON.stringify(b.buttons || []);
}

function updatePresence(payload) {
  if (!payload) return;

  // Persistent-session timestamp logic
  const newKey = payload._sessionKey || `${payload.details}|${payload.state}`;
  delete payload._sessionKey;
  const reset = newKey !== sessionKey;
  if (reset) {
    sessionKey = newKey;
    sessionStart = Date.now();
  }
  payload.startTimestamp = sessionStart;
  payload.instance = false;

  console.log(
    `[RPC] sessionKey=${sessionKey} ${reset ? 'RESET' : 'PRESERVED'}`,
    `startTimestamp=${new Date(sessionStart).toISOString()}`,
    `payload.state="${payload.state}"`
  );

  if (isSamePayload(payload, lastPayload)) return; // de-dupe
  lastPayload = { ...payload };
  sendActivity(payload);
}

function clearPresence() {
  lastPayload = null;
  sessionKey = null;
  sessionStart = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (client && connected) {
    client.clearActivity().catch(() => {});
  }
}

// Re-push the most recent payload to Discord without any de-dup gating.
// Used by the heartbeat to refresh asset cache. Best-effort; failures here
// are not fatal — the next real updatePresence() call will recover.
function refreshActivityNow() {
  if (!client || !connected) return;
  if (!lastPayload) return;
  client.setActivity(lastPayload).catch(err => {
    const msg = err.message || String(err);
    logToFile(`heartbeat setActivity failed: ${msg}`);
  });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(refreshActivityNow, HEARTBEAT_MS);
}

async function init() {
  await connect();
  startHeartbeat();
  // periodic reconnect if Discord client is closed/reopened
  setInterval(() => {
    if (!connected) connect().catch(() => {});
  }, 15000);
}

module.exports = { init, updatePresence, clearPresence };
