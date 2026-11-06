#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"
OUT_ZIP="$DIST_DIR/roku-netflix-sync-extension.zip"

MANIFEST="$EXT_DIR/manifest.json"
[ -f "$MANIFEST" ] || { echo "Missing $MANIFEST" >&2; exit 1; }
python3 -m json.tool "$MANIFEST" > /dev/null

# Every script and HTML file the manifest points at must exist before shipping.
REFERENCED="$(python3 - "$MANIFEST" <<'PY'
import json, os, re, sys
manifest = json.load(open(sys.argv[1]))
base = os.path.dirname(sys.argv[1])
files = set()
worker = manifest.get('background', {}).get('service_worker')
if worker:
    files.add(worker)
popup = manifest.get('action', {}).get('default_popup')
if popup:
    files.add(popup)
for script in manifest.get('content_scripts', []):
    files.update(script.get('js', []))
    files.update(script.get('css', []))
# Scripts and stylesheets pulled in by referenced HTML files ship in the archive too.
for page in [name for name in sorted(files) if name.endswith('.html')]:
    path = os.path.join(base, page)
    if not os.path.isfile(path):
        print(page)
        continue
    html = open(path, encoding='utf-8').read()
    for match in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\':]+)["\']', html):
        files.add(match.group(1))
for path in sorted(files):
    print(path)
PY
)"

for path in $REFERENCED; do
  [ -f "$EXT_DIR/$path" ] || { echo "Manifest references missing file: $path" >&2; exit 1; }
done

mkdir -p "$DIST_DIR"
rm -f "$OUT_ZIP"

cd "$EXT_DIR"
# shellcheck disable=SC2086
zip -q "$OUT_ZIP" manifest.json $REFERENCED -x "*.DS_Store"

echo "Packaged MV3 extension: $OUT_ZIP"
echo "Referenced files verified: $(echo "$REFERENCED" | tr '\n' ' ')"
unzip -l "$OUT_ZIP"
echo "Size: $(wc -c < "$OUT_ZIP" | tr -d ' ') bytes"
