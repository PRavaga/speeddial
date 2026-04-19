#!/usr/bin/env bash
# Build distributable zips from extension/.
#
#   speeddial-<ver>.zip       — keeps manifest.key (sideload / dev install,
#                               produces stable extension ID + OAuth redirect)
#   speeddial-<ver>-cws.zip   — manifest.key stripped (Chrome Web Store upload;
#                               CWS pins the item to its own key at first upload)
set -euo pipefail

cd "$(dirname "$0")/.."
VER=$(node -p "require('./extension/manifest.json').version")
echo "Building Speed Dial $VER"

rm -rf dist
mkdir -p dist/sideload dist/cws
cp -r extension/. dist/sideload/
cp -r extension/. dist/cws/

node -e "const f='dist/cws/manifest.json';const m=require('path').resolve(f);const fs=require('fs');const j=JSON.parse(fs.readFileSync(m));delete j.key;fs.writeFileSync(m,JSON.stringify(j,null,2)+'\n')"

( cd dist/sideload && zip -rq "../speeddial-$VER.zip" . )
( cd dist/cws && zip -rq "../speeddial-$VER-cws.zip" . )

rm -rf dist/sideload dist/cws
ls -lh dist/*.zip
