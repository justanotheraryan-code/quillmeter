#!/bin/sh
# Install Quillmeter as a login item (launchd user agent) that restarts if it dies.
#   service/service.sh install     copy the app to ~/.quillmeter/quillmeter and start it at every login
#   service/service.sh uninstall   stop it and remove the agent (your data in ~/.quillmeter stays)
#   service/service.sh status
# The app is copied out of ~/Downloads first: launchd jobs can be blocked from protected folders
# (Downloads, Documents, Desktop). Re-run `install` after changing the code to update the copy.
set -e
LABEL=com.quillmeter.monitor
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.quillmeter/quillmeter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-status}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
    rm -rf "$HOME/.quillmeter/app"  # folder used by an earlier install
    mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
    rm -rf "$DEST/public" "$DEST/bin" "$DEST/lib"
    cp -R "$SRC/server.js" "$SRC/public" "$SRC/lib" "$SRC/package.json" "$DEST/"
    [ -d "$SRC/bin" ] && cp -R "$SRC/bin" "$DEST/"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/server.js</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.quillmeter/quillmeter.log</string>
  <key>StandardErrorPath</key><string>$HOME/.quillmeter/quillmeter.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout is asynchronous: wait for the old job to disappear before loading the new one.
    for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
    for _ in 1 2 3 4 5; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break; sleep 1; done
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "launchd refused to load $PLIST" >&2; exit 1; }
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Quillmeter installed. Open http://127.0.0.1:4747 (log: ~/.quillmeter/quillmeter.log)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Quillmeter agent removed. ~/.quillmeter/quillmeter and your data were left in place."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "not installed"
    ;;
  *) echo "usage: $0 install|uninstall|status" >&2; exit 1 ;;
esac
