#!/bin/sh
# Re-creates vendor/ (not archived). Needs npm and network access.
set -e
cd "$(dirname "$0")"
V=0.170.0
T=$(mktemp -d)
mkdir -p vendor
(cd "$T" && npm pack "three@$V" --silent >/dev/null && tar -xzf "three-$V.tgz")
cp "$T/package/build/three.module.min.js" vendor/three.module.min.js
cp "$T/package/LICENSE" vendor/THREE-LICENSE.txt
rm -rf "$T"
echo "vendor/ ready (three $V)"
