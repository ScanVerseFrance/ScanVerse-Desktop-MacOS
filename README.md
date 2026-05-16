# ScanVerse Desktop — macOS

Native macOS desktop wrapper for [ScanVerse](https://www.scanverse.online) with Discord Rich Presence.

Loads the ScanVerse site in a frameless Chromium window with the native
macOS traffic-light controls, and pushes a custom Discord activity to the
local Discord client based on the page being viewed.

## Stack

- **Electron 41** — webview shell
- **discord-rpc** — IPC connection to local Discord client (no internet needed)
- **App ID (Discord)** : `1500986435220541591`
- **Bundle ID** : `com.scanverse.desktop`

## Setup

```bash
cd "ScanVerse Webview MacOS"
npm install
```

## Run

| Command | Loads | DevTools |
|---|---|---|
| `npm start` | `https://www.scanverse.online` (prod) | off |
| `npm run dev` | `http://localhost:5173` | on |
| `npm run lan` | `http://192.168.2.100:5173` | on |
| custom | set `SCANVERSE_URL=...` | set `SCANVERSE_DEV=1` for tools |

Example for a different LAN IP:
```bash
SCANVERSE_URL=http://192.168.1.42:5173 SCANVERSE_DEV=1 npm start
```

## Build

DMG installer for distribution:

```bash
npm run build:mac          # both arm64 + x64
npm run build:mac:arm64    # Apple Silicon only
npm run build:mac:x64      # Intel only
npm run build:mac:dir      # unpacked .app for quick local testing
```

Artefacts land in `dist/`. The build is **unsigned** — users will see
Gatekeeper warn them the first time they open the app and need to either:
1. Right-click the app → "Open" → confirm the dialog, **or**
2. Run `xattr -dr com.apple.quarantine /Applications/ScanVerse.app` once.

To enable Developer ID signing + notarization later, flip
`mac.hardenedRuntime` to `true` in `package.json`, set `mac.identity` to
your signing certificate name, and add `CSC_LINK` + `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` environment variables.

> **Note** — macOS DMGs are best built **on a Mac** (the underlying
> `hdiutil`/`iconutil` tooling). Building from Windows works for `--dir`
> (unpacked .app) but the .dmg packaging step will fail without macOS.

## Discord Rich Presence

The wrapper has **two presence detection modes**, both active at once.

### 1. URL-based (zero site changes required)

The main process listens to webview navigation events and parses the URL to
infer what page you're on. Works for: `/`, `/catalogue`, `/manga/:id`,
`/read/:mangaId/:chapterId`, `/profile/:user`, `/friends`, `/wrapped`,
`/admin`, `/login`, `/register`, `/settings*`, `/messages*`, `/univers/:id`,
404.

### 2. Page-emitted (rich data — title, cover, author)

When the site is loaded inside the wrapper, `window.scanverse` is exposed.
The site can call:

```js
if (window.scanverse?.isElectron) {
  window.scanverse.setPresence('manga', {
    id: 'abc-123',
    title: 'One Piece',
    author: 'Eiichiro Oda',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/...jpg',
  });
}
```

Page-emitted presence overrides URL-based (fires later with more info).

Detect macOS-specific behaviour via `window.scanverse?.platform === 'darwin'`.

## Custom protocol — `scanverse://`

Registered in `Info.plist` at build time via `mac.protocols`. The site can
share deep links that open the desktop app at the right page:

| URL                                | Opens                                |
|------------------------------------|--------------------------------------|
| `scanverse://manga/<id>`           | `/manga/<id>` (fiche d'œuvre)         |
| `scanverse://read/<id>/<chapter>`  | `/read/<id>/<chapter>` (lecteur)      |
| `scanverse://m/<id>` (short)       | `/manga/<id>`                         |
| `scanverse://r/<id>/<chapter>`     | `/read/<id>/<chapter>`                |

macOS routes the URL via `app.on('open-url')` to the already-running
instance (or cold-starts the app, which then picks up the URL from
`process.argv` after `whenReady`).

## In-app updater

On launch (and every 4 h while open), the wrapper polls the
[GitHub Releases API](https://api.github.com/repos/ScanVerseFrance/ScanVerse-Desktop-MacOS/releases/latest).
If a newer release is published with a `.dmg` asset matching the user's
CPU arch (arm64 / x64), a branded modal offers to download it.

After download, clicking **"Ouvrir le programme d'installation"** mounts
the .dmg in Finder and quits the app — the user drags the new ScanVerse
into `/Applications` (replacing the old one) and relaunches.

There's no silent in-place upgrade for unsigned macOS apps; this is the
standard drag-and-drop flow used by VS Code, Slack, Figma, etc. when they
don't ship a Squirrel.Mac autoupdater.

## Project layout

```
src/
  main.js            Electron main process (window, IPC, navigation)
  preload.js         contextBridge → window.scanverse + injected title bar
  routes.js          URL/route → Discord Rich Presence payload mapping
  rpc.js             discord-rpc wrapper with auto-reconnect + heartbeat
  update-check.js    GitHub Releases poll + DMG download orchestration
  update-preload.js  contextBridge for the update modal window
  update-ui/         HTML/CSS/JS of the branded update modal
assets/
  icon.png           1638×1638 source icon (electron-builder converts to .icns)
  license-fr.txt     End-user license (shown in DMG install flow)
build/
  entitlements.mac.plist  Entitlements file (for future signed builds)
```

## License

UNLICENSED — © 2026 Team ScanVerse.
