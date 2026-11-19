#!/bin/sh
# Builds dist/subcentral-job-filter-<version>.zip for uploading to the Chrome Web Store.
#
#   sh dev/build-zip.sh
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/subcentral-job-filter-$version.zip"
mkdir -p dist
rm -f "$out"
zip -X "$out" manifest.json background.js content.js fullsite.js transitous_rules.json icon48.png icon128.png
echo "Built $out"
