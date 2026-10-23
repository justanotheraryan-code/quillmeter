#!/bin/sh
# Build and manage the Vitals menu bar item (needs the Xcode command line tools for swiftc).
#   menubar/menubar.sh build        compile VitalsMenu.app next to this script
#   menubar/menubar.sh install      build, copy to ~/.pulse/vitals/menubar and start it at every login
#   menubar/menubar.sh uninstall    quit it and remove the login item
#   menubar/menubar.sh status
set -e
LABEL=com.vitals.menubar
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/VitalsMenu.app"
DEST="$HOME/.pulse/vitals/menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

build() {
  command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install" >&2; exit 1; }
  rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
  swiftc -O -swift-version 5 -framework AppKit "$HERE/main.swift" -o "$APP/Contents/MacOS/VitalsMenu"
  cat > "$APP/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Vitals Menu</string>
  <key>CFBundleIdentifier</key><string>com.vitals.menubar</string>
  <key>CFBundleExecutable</key><string>VitalsMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLISTEOF
  codesign -s - --force "$APP" >/dev/null 2>&1 || true
  echo "built $APP"
}

case "${1:-status}" in
  build) build ;;
  install)
    build
    mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
    rm -rf "$DEST/VitalsMenu.app"; cp -R "$APP" "$DEST/"
    # KeepAlive only on a crash, so choosing "Quit Vitals Menu" in its own menu keeps it quit until next login.
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DEST/VitalsMenu.app/Contents/MacOS/VitalsMenu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
    for _ in 1 2 3 4 5; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break; sleep 1; done
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "launchd refused to load $PLIST" >&2; exit 1; }
    echo "Menu bar item installed. Look for CPU and MEM at the top right."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Menu bar item removed."
    ;;
  status) launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =" || echo "not installed" ;;
  *) echo "usage: $0 build|install|uninstall|status" >&2; exit 1 ;;
esac
