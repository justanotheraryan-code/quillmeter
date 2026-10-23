# Vitals on Mac

System vitals for your Mac: a local Activity Monitor alternative that groups ~1,000 processes into one row per app, with live CPU, memory, disk, network, GPU and battery, plus dev servers, Docker containers and coding agents.

Everything runs on your Mac. There is no account, no analytics and no outside network traffic. The server listens on `127.0.0.1` only.

## Requirements

- macOS (Apple silicon or Intel)
- Node.js 18 or newer
- Xcode command line tools, only for the optional menu bar item (`xcode-select --install`)

## Quick start

```bash
git clone https://github.com/justanotheraryan-code/vitalsonmac.git
cd vitalsonmac
node server.js                  # then open http://127.0.0.1:4747
```

To keep it running, start it at every login and restart it if it dies:

```bash
service/service.sh install      # uninstall / status also available
```

The installer copies the app to `~/.pulse/vitals`, because launchd jobs can be blocked from folders such as Downloads. Run `install` again after you change the code.

## What it does

- **Apps:** helpers are added to the app that launched them. Quit (SIGTERM) or Force quit (SIGKILL) an app or a single process, always after a confirm prompt. Finder, WindowServer, Dock, loginwindow and Vitals itself are protected.
- **CPU, Memory:** live figures with the apps behind them.
- **Disk:** free space, live read and write rates, and a storage breakdown of your home folder and Library (a `du` scan, cached and refreshed every 6 hours).
- **Network:** live rates and the apps using the network right now.
- **GPU:** utilization, renderer and tiler load, and GPU memory. Per-app GPU use needs root, so only the total is shown.
- **Battery:** charge, health and condition as macOS reports them, cycle count, live power draw and thermal state.
- **History:** per-minute data for 7 days, then hourly averages for up to a year (set in Settings).
- **Alerts:** an app holding the CPU, an app growing in memory, memory nearly full, low battery. Shown in the page and as native macOS notifications.
- **Projects:** dev servers grouped by git repo, with idle detection.
- **Docker:** running containers with CPU, memory, network and ports, read through the `docker` CLI (Docker Desktop, OrbStack, Colima or Homebrew).
- **Agents:** running coding agents (Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode, Aider) with everything they started, plus today's Claude Code token counts from its local session logs (counts only, never message text).
- **Settings:** bytes or bits, CPU per core or per Mac, chart colors (Vitals, monochrome, accessible), compact layout, history retention, notifications. Show, hide and reorder tabs and Overview cards.
- **Export image:** a 1200 x 630 share card of memory, CPU and top apps, in light or dark.

## Command line

```bash
node bin/vitals.js status
node bin/vitals.js apps --sort cpu --top 10
node bin/vitals.js ports
node bin/vitals.js agents
node bin/vitals.js apps --json
```

Run `npm link` in this folder to get a global `vitals` command.

## Menu bar item

A small native Swift app shows CPU and memory in the menu bar (red under strain). Click it for every figure and the busiest apps.

```bash
menubar/menubar.sh install      # build, then start at every login
menubar/menubar.sh uninstall
menubar/VitalsMenu.app/Contents/MacOS/VitalsMenu --print   # print what it would show
```

## MCP server

`bin/vitals-mcp.js` lets Claude, Codex or Cursor ask what is running. It is read-only: status, apps, dev servers, agents and alerts. There is no tool that quits or changes anything. Register it with your assistant, for example:

```bash
claude mcp add vitals -- node ~/.pulse/vitals/bin/vitals-mcp.js
```

Process names and folder paths are visible to any assistant you connect, so only register it with assistants you trust.

## Security

- Only requests whose `Host` is 127.0.0.1 or localhost are served (blocks DNS rebinding).
- Every POST needs an `X-Vitals` header and a same-origin `Origin`, so other websites can't call quit, stop or settings.
- Quit and stop only act on PIDs found in the latest process snapshot.

## Layout

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server, samplers, history, alerts, settings |
| `lib/extra.js` | GPU, battery detail, Docker and token-usage samplers |
| `public/` | The dashboard (plain HTML, CSS and JavaScript, no build step) |
| `bin/` | `vitals` command line tool and the MCP server |
| `menubar/` | Native menu bar app (Swift) and its build script |
| `service/` | launchd login-service installer |

Data lives in `~/.pulse` (history, hourly rollups, alerts, settings and the service log).

## Not built

CPU and battery temperatures and fans (they need a root helper), per-app GPU use, Neural Engine, Bluetooth batteries, per-app volume, AI plan limits (they need your account credentials) and Codex token counts. The Docker tab was tested against a stub CLI, not a real Docker install.

## Note on the name

Vitals is also the name of a commercial Mac app. This is an independent project with its own code and is not affiliated with it. Consider a different name before distributing it widely.
