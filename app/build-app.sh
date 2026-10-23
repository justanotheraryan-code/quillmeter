#!/bin/sh
# Build dist/Quillmeter.app and dist/Quillmeter-<version>.dmg
#   app/build-app.sh                       Apple silicon, ad-hoc signed (runs on this Mac)
#   ARCHS="arm64 x86_64" app/build-app.sh  universal app (needs a universal Node)
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" app/build-app.sh
#                                          hardened-runtime signing, the first step to notarization
#   NODE_BIN=/path/to/node                 Node to bundle (default: the one on PATH)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
ARCHS="${ARCHS:-arm64}"
IDENTITY="${SIGN_IDENTITY:--}"
OUT="$ROOT/dist"
APP="$OUT/Quillmeter.app"
RES="$APP/Contents/Resources"
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install" >&2; exit 1; }

rm -rf "$APP" "$OUT/.build"; mkdir -p "$APP/Contents/MacOS" "$RES/server" "$OUT/.build"

echo "1/6 compiling the host app ($ARCHS)"
for a in $ARCHS; do
  swiftc -O -swift-version 5 -target "$a-apple-macos13.0" -framework AppKit -framework WebKit -framework ServiceManagement \
    "$HERE/main.swift" -o "$OUT/.build/Quillmeter-$a"
done
set -- $ARCHS
if [ $# -eq 1 ]; then cp "$OUT/.build/Quillmeter-$1" "$APP/Contents/MacOS/Quillmeter"
else lipo -create "$OUT/.build"/Quillmeter-* -output "$APP/Contents/MacOS/Quillmeter"; fi

echo "2/6 bundling Node $("$NODE_BIN" -v) (thinned to: $ARCHS, then stripped)"
HAVE="$(lipo -archs "$NODE_BIN" 2>/dev/null || uname -m)"
if [ $# -eq 1 ]; then
  case " $HAVE " in *" $1 "*) ;; *) echo "this Node has no $1 slice (has: $HAVE)" >&2; exit 1 ;; esac
  if [ "$HAVE" = "$1" ]; then cp "$NODE_BIN" "$RES/node"; else lipo "$NODE_BIN" -thin "$1" -output "$RES/node"; fi
else
  for a in $ARCHS; do case " $HAVE " in *" $a "*) ;; *) echo "this Node has no $a slice (has: $HAVE)" >&2; exit 1 ;; esac; done
  cp "$NODE_BIN" "$RES/node"
fi
strip -x "$RES/node" 2>/dev/null || true
chmod 755 "$RES/node"

echo "3/6 copying the server and dashboard"
cp -R "$ROOT/server.js" "$ROOT/lib" "$ROOT/public" "$ROOT/bin" "$ROOT/package.json" "$RES/server/"

echo "4/6 drawing the icon"
swiftc -O -framework AppKit "$HERE/make-icon.swift" -o "$OUT/.build/make-icon" 2>/dev/null
"$OUT/.build/make-icon" "$OUT/.build/icon-1024.png"
ICONSET="$OUT/.build/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$OUT/.build/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$OUT/.build/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Quillmeter</string>
  <key>CFBundleDisplayName</key><string>Quillmeter</string>
  <key>CFBundleIdentifier</key><string>com.quillmeter.app</string>
  <key>CFBundleExecutable</key><string>Quillmeter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

echo "5/6 signing ($([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY"))"
if [ "$IDENTITY" = "-" ]; then FLAGS=""; else FLAGS="--options runtime --timestamp --entitlements $HERE/entitlements.plist"; fi
codesign --force --sign "$IDENTITY" $FLAGS "$RES/node"
codesign --force --sign "$IDENTITY" $FLAGS "$APP"
codesign --verify --strict "$APP" && echo "   signature verifies"

echo "6/6 building the disk image"
DMG="$OUT/Quillmeter-$VERSION.dmg"
STAGE="$OUT/.build/dmg"; rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Quillmeter" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"
rm -rf "$OUT/.build"
echo ""; echo "built:"; du -sh "$APP" | awk '{print "  " $2 "  (" $1 ")"}'; du -sh "$DMG" | awk '{print "  " $2 "  (" $1 ")"}'
