#!/usr/bin/env bash
# Builds a marcador.app that runs on any of your Macs.
#
# The app Xcode installs while developing is signed "Apple Development" and
# carries the get-task-allow debug entitlement, so Gatekeeper rejects it
# anywhere but the machine that built it. This produces the other kind: signed
# with Developer ID, hardened runtime on, notarised by Apple and stapled, which
# opens on a Mac that has never seen Xcode.
#
#   ./scripts/release-mac.sh
#
# One-time setup, both of which need your Apple ID:
#
#   1. A Developer ID Application certificate:
#        Xcode > Settings > Accounts > Manage Certificates > + >
#        Developer ID Application
#
#   2. Notarisation credentials stored in the keychain under "marcador":
#        xcrun notarytool store-credentials marcador \
#          --apple-id you@example.com --team-id W2BS7F6CHM \
#          --password <app-specific-password>
#
#      App-specific passwords come from appleid.apple.com > Sign-In and
#      Security > App-Specific Passwords. Your account password will not work.
set -euo pipefail

cd "$(dirname "$0")/.."

KEYCHAIN_PROFILE="${MARCADOR_NOTARY_PROFILE:-marcador}"
BUILD_DIR="build/mac"
ARCHIVE="$BUILD_DIR/marcador.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"

if [[ ! -d ios/App ]]; then
  echo "error: ios/ is missing. Run 'bun run ios' first." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "error: no 'Developer ID Application' certificate is installed." >&2
  echo "       Xcode > Settings > Accounts > Manage Certificates > + " >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Archiving (Mac Catalyst, Release)"
xcodebuild archive \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Release \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -archivePath "$ARCHIVE" \
  CODE_SIGN_STYLE=Automatic \
  ENABLE_HARDENED_RUNTIME=YES

# method "developer-id" is what strips the development entitlements and signs
# for distribution outside the App Store.
cat > "$BUILD_DIR/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

echo "==> Exporting"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$BUILD_DIR/export.plist"

APP="$EXPORT_DIR/marcador.app"
[[ -d "$APP" ]] || APP="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.app' | head -1)"
[[ -d "$APP" ]] || { echo "error: no .app came out of the export" >&2; exit 1; }

echo "==> Notarising $(basename "$APP")"
# Apple takes a zip, not a bundle; ditto preserves the symlinks a .app needs.
ZIP="$BUILD_DIR/marcador.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

xcrun notarytool submit "$ZIP" --keychain-profile "$KEYCHAIN_PROFILE" --wait

echo "==> Stapling"
# Staples the ticket into the bundle so it opens with no network round trip.
xcrun stapler staple "$APP"

echo "==> Verifying the way Gatekeeper will"
spctl -a -vvv -t exec "$APP"
xcrun stapler validate "$APP"

# Ship the stapled copy, not the pre-notarisation zip.
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

echo
echo "==> Done: $ZIP"
echo "    Copy it to any of your Macs, unzip, drag to /Applications."
