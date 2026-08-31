#!/usr/bin/env bash
# Regenerates the iOS project from scratch and opens it in Xcode.
#
# `ios/` is disposable: everything that makes it marcador lives in
# capacitor.config.ts, native/, and this script. Blowing it away each time keeps
# the generated project from drifting into a state nobody can reproduce.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f native/ShareExtension/Config.xcconfig ]]; then
  echo "warning: native/ShareExtension/Config.xcconfig is missing."
  echo "         Copy Config.xcconfig.example and fill in your server URL and"
  echo "         MARCADOR_TOKEN, or the share sheet will have nowhere to post."
  echo
fi

echo "==> Regenerating ios/"
rm -rf ios
bunx cap add ios

echo "==> Syncing web assets"
bunx cap sync ios

echo "==> Adding the Share Extension target"
# CocoaPods bundles xcodeproj, so prefer its Ruby when the active one lacks it.
if ruby -e "require 'xcodeproj'" >/dev/null 2>&1; then
  ruby scripts/add-share-extension.rb
else
  echo "    (xcodeproj not in the active Ruby; trying CocoaPods' copy)"
  /usr/bin/env ruby -e "require 'xcodeproj'" >/dev/null 2>&1 \
    && /usr/bin/env ruby scripts/add-share-extension.rb \
    || { echo "error: install it with \`gem install xcodeproj\`"; exit 1; }
fi

echo
echo "==> Done. Opening Xcode."
echo "    Set your signing team on both the App and ShareExtension targets,"
echo "    then run on a device. For the Mac app, pick 'My Mac (Mac Catalyst)'."
bunx cap open ios
