#!/bin/bash
set -euo pipefail
temporary="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fbd-bootstrap.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
sources=(bootstrap/macos/Installer.swift)
swiftc -swift-version 5 -parse-as-library "${sources[@]}" bootstrap/macos/Tests.swift -o "$temporary/tests"
"$temporary/tests"
if [ "${1:-}" = --tests-only ]; then
  swiftc -swift-version 5 -parse-as-library "${sources[@]}" bootstrap/macos/App.swift -o "$temporary/ui-check"
  exit 0
fi
app="$temporary/image/Installer Fixed By Design.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
for architecture in arm64 x86_64; do
  swiftc -swift-version 5 -O -parse-as-library -target "$architecture-apple-macos12.0" "${sources[@]}" bootstrap/macos/App.swift -o "$temporary/bootstrap-$architecture"
done
lipo -create "$temporary/bootstrap-arm64" "$temporary/bootstrap-x86_64" -output "$app/Contents/MacOS/Bootstrap"
chmod 755 "$app/Contents/MacOS/Bootstrap"
cp 'release/mac-arm64/Fixed By Design.app/Contents/Resources/icon.icns' "$app/Contents/Resources/icon.icns"
cp bootstrap/macos/Info.plist "$app/Contents/Info.plist"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
hdiutil create -quiet -volname 'Installer Fixed By Design' -srcfolder "$temporary/image" -format UDZO 'release/FBD-Launcher-Setup-macos-universal.dmg'
version="$(node -p 'require("./package.json").version')"
architecture="$(uname -m)"
if [ "$architecture" = x86_64 ]; then architecture=x64; fi
"$temporary/tests" --install "release/FBD-Launcher-$version-macos-$architecture.dmg" "$version"
