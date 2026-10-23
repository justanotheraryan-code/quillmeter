# Quillmeter

A local Activity Monitor alternative for your Mac that groups ~1,000 processes into one row per app, with live CPU, memory, disk, network, GPU and battery, plus dev servers, Docker containers and coding agents.

Everything runs on your Mac. There is no account, no analytics and no outside network traffic. The server listens on `127.0.0.1` only.

## Install

Build the app and the disk image (needs the Xcode command line tools: `xcode-select --install`):

```bash
git clone https://github.com/justanotheraryan-code/quillmeter.git
cd quillmeter
app/build-app.sh                # makes dist/Quillmeter.app and dist/Quillmeter-<version>.dmg
```

Open the DMG and drag **Quillmeter** to **Applications**, or copy `dist/Quillmeter.app` there yourself. The app bundles its own Node, so you don't need Node installed. It needs macOS 13 or newer, and the default build is for Apple silicon (see Building below for Intel).

**First launch of a downloaded copy:** builds from this repo are ad-hoc signed, not notarized, so macOS blocks a copy that arrived by download or AirDrop. Right-click the app, choose **Open**, then **Open** again. Or remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Quillmeter.app`. A copy you built or copied on the same Mac isn't affected.

## The app

- **Window and menu bar:** the dashboard opens in a native window with a sidebar (two levels, hideable with Control-Command-S). The menu bar item shows CPU and memory (red under strain), and its menu lists every figure and the busiest apps. Closing the window keeps Quillmeter running in the menu bar.
- **Settings:** Quillmeter menu, Settings… (Command-comma) opens a Settings window with General, Folders, Display and Sidebar panes.
- **Liquid glass:** controls respond to the cursor, one at a time. The control under the pointer leans toward it, stretches slightly, and shows a rim of light that follows it around its edge; the light hands off to the next control as you move, and never spills onto its neighbors. Buttons squash a little when pressed. The sidebar's selected-section indicator and the segmented controls are glass that slides to the new choice. Real glass (a backdrop blur) is only used on the floating layer: toolbar controls, those indicators and sheets. Buttons inside content, such as the Quit buttons in a table, get the same look without a blur. The toolbar floats over the content, which fades and blurs where it meets the bar. Reduce Motion removes the movement, Reduce Transparency and Increase Contrast switch to opaque fills, and touch pointers get larger targets.
- **First launch:** a short setup sheet asks which folders the disk breakdown may measure, whether to show Mac notifications, and whether to open at login. "Not Now" skips it and measures nothing.
- **Launch at login:** a toggle in the app menu, the menu bar menu, and Settings. From a terminal: `/Applications/Quillmeter.app/Contents/MacOS/Quillmeter --login on|off|status`. It works once the app is in `/Applications`.
- **Its own server:** the app starts the bundled server on port 4747 and stops it when you quit. If a Quillmeter server is already running there, the app attaches to it instead. If the app crashes, the server exits by itself within seconds.
- **Port:** set `QUILLMETER_PORT` to use a different port.
- **Quiet start:** `--background` starts without opening a window.

## What it does

- **Apps:** helpers are added to the app that launched them. Quit (SIGTERM) or Force quit (SIGKILL) an app or a single process, always after a confirm prompt. Finder, WindowServer, Dock, loginwindow and Quillmeter itself are protected.
- **CPU, Memory:** live figures with the apps behind them.
- **Disk:** free space, live read and write rates, and a storage breakdown of the folders you chose in setup (a `du` scan, cached and refreshed every 6 hours).
- **Network:** live rates and the apps using the network right now.
- **GPU:** utilization, renderer and tiler load, and GPU memory. Per-app GPU use needs root, so only the total is shown.
- **Battery:** charge, health and condition as macOS reports them, cycle count, live power draw and thermal state.
- **History:** per-minute data for 7 days, then hourly averages for up to a year (set in Settings).
- **Alerts:** an app holding the CPU, an app growing in memory, memory nearly full, low battery. Shown in the page and as native macOS notifications.
- **Projects:** dev servers grouped by git repo, with idle detection.
- **Docker:** running containers with CPU, memory, network and ports, read through the `docker` CLI (Docker Desktop, OrbStack, Colima or Homebrew).
- **Agents:** running coding agents (Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode, Aider) with everything they started, plus today's Claude Code token counts from its local session logs (counts only, never message text).
- **Settings:** the folders to measure, bytes or bits, CPU per core or per Mac, chart colors (Quillmeter, monochrome, accessible), compact layout, history retention, notifications, open at login. Show, hide and reorder sidebar sections and Overview cards.
- **Export image:** a 1200 x 630 share card of memory, CPU and top apps in your current appearance. A save panel lets you choose where it goes.

## Permissions

Quillmeter asks macOS for nothing at launch, and nothing is measured until you finish setup.

- **No prompts by default.** The recommended folders (Applications, app data and caches in Library, hidden developer folders, folders you made in your home folder) need no permission.
- **Folders macOS guards start switched off.** Downloads, Documents, Desktop, Pictures, Movies, Music and iCloud Drive are listed as "macOS will ask first". If you turn one on, macOS asks once, with a plain explanation of why.
- **Never read:** your Photos library, the Trash, and other apps' private data in Library (Mail, Messages, Safari, Containers and similar). They are skipped even when the folder around them is enabled. Quillmeter has no Photos permission entry at all.
- **Sizes only.** It measures how much space a folder uses and never opens file contents.
- **Change it any time** in Settings, Folders. Turning a folder off removes its results at once.

Finding a dev server's git repository would also touch a protected folder, so that only happens for folders you enabled.

## Command line

```bash
node bin/quillmeter.js status
node bin/quillmeter.js apps --sort cpu --top 10
node bin/quillmeter.js ports
node bin/quillmeter.js agents
node bin/quillmeter.js apps --json
```

Run `npm link` in this folder to get a global `quillmeter` command. It talks to the running app (or server).

## MCP server

`bin/quillmeter-mcp.js` lets Claude, Codex or Cursor ask what is running. It is read-only: status, apps, dev servers, agents and alerts. There is no tool that quits or changes anything. The installed app carries its own copy, so it works without a system Node:

```bash
claude mcp add quillmeter -- /Applications/Quillmeter.app/Contents/Resources/node /Applications/Quillmeter.app/Contents/Resources/server/bin/quillmeter-mcp.js
```

Process names and folder paths are visible to any assistant you connect, so only register it with assistants you trust.

## Running from source

```bash
node server.js                  # then open http://127.0.0.1:4747 (Node 18 or newer)
service/service.sh install      # headless: run the server at every login, no window
service/service.sh uninstall
```

`service.sh` is for servers and dev work. If you use the app, you don't need it.

## Building

`app/build-app.sh` compiles the Swift host app, thins and strips the Node binary (about 183 MB down to about 90 MB), copies in the server and dashboard, draws the icon, signs the bundle and builds the DMG.

```bash
app/build-app.sh                                  # Apple silicon, ad-hoc signed
ARCHS="arm64 x86_64" app/build-app.sh             # universal (needs a universal Node)
NODE_BIN=/path/to/node app/build-app.sh           # bundle a specific Node
SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" app/build-app.sh
```

The last form signs with the hardened runtime and the entitlements Node needs (`app/entitlements.plist`), which is the first step to notarization. After that you would run `xcrun notarytool submit dist/Quillmeter-<version>.dmg --keychain-profile <profile> --wait` and `xcrun stapler staple`. The signing and notarization steps are written but untested here, because they need a paid Apple Developer ID certificate.

## Security

- Only requests whose `Host` is 127.0.0.1 or localhost are served (blocks DNS rebinding).
- Every POST needs an `X-Quillmeter` header and a same-origin `Origin`, so other websites can't call quit, stop or settings.
- Quit and stop only act on PIDs found in the latest process snapshot.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server, samplers, history, alerts, settings |
| `lib/extra.js` | GPU, battery detail, Docker and token-usage samplers |
| `lib/scanplan.js` | Which folders the disk breakdown may read, and what it must never read |
| `public/` | The dashboard (plain HTML, CSS and JavaScript, no build step) |
| `public/glass.js` | The cursor-reactive glass behavior (adapted from liquid-glass-react, see below) |
| `app/` | The macOS app: Swift host (`main.swift`), icon generator, build script, entitlements |
| `bin/` | `quillmeter` command line tool and the MCP server |
| `service/` | Headless launchd login-service installer |

Data lives in `~/.quillmeter` (history, hourly rollups, alerts, settings and logs).

## Credits

The cursor-reactive glass behavior adapts ideas from [liquid-glass-react](https://github.com/rdev/liquid-glass-react) (MIT). The package itself isn't used, because it needs React and a bundler; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

On Chromium browsers (for example, if you choose Open in Browser) the glass also bends what is behind it using an SVG displacement filter. The app's own web view is WebKit, where that bending isn't shown, so it uses blur, saturation, the cursor-following light and the elastic motion.

## Not built

A native-looking settings toolbar built from AppKit controls (the interface is still a web page inside the app), notarized builds and auto-update (they need a Developer ID certificate), CPU and battery temperatures and fans (they need a root helper), per-app GPU use, Neural Engine, Bluetooth batteries, per-app volume, AI plan limits (they need your account credentials), Codex token counts, and native Swift collectors (the server is still Node). The Docker tab was tested against a stub CLI, not a real Docker install, and launch-at-login was verified as registered but not through an actual log out and in.
