#!/usr/bin/env python3
"""Build a store copy of the browser extension with a fixed hub address (and optionally its own icon and name).

usage: python3 scripts/build_extension.py --hub https://hub.example.com --out dist/extension [--icon icon.svg] [--name "…"]
The hub origin becomes a host permission (no prompt at sign-in) and the default in lib.js; a zip is written next to --out.
Icons from --icon need playwright (node) to render; without --icon the repository's icons are kept.
"""
import argparse, json, re, shutil, subprocess, sys, zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hub', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--icon'); ap.add_argument('--name')
    a = ap.parse_args()
    u = urlparse(a.hub)
    if u.scheme != 'https' or not u.netloc: sys.exit('--hub must be an https origin')
    origin = f'https://{u.netloc}'
    out = Path(a.out); shutil.rmtree(out, ignore_errors=True); shutil.copytree(ROOT / 'extension', out, ignore=shutil.ignore_patterns('README.md', 'test'))
    man = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    man['host_permissions'] = [origin + '/*']
    if a.name:
        man['name'] = a.name
    (out / 'manifest.json').write_text(json.dumps(man, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lib = (out / 'lib.js').read_text(encoding='utf-8')
    lib, n = re.subn(r"export const BUILD_HUB = '';", f"export const BUILD_HUB = '{origin}';", lib)
    assert n == 1, 'BUILD_HUB marker not found'
    (out / 'lib.js').write_text(lib, encoding='utf-8')
    if a.icon:
        subprocess.run(['node', str(ROOT / 'scripts' / 'render_icons.js'), a.icon, str(out / 'icons')], check=True)
    z = out.with_suffix('.zip')
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as f:
        for p in sorted(out.rglob('*')):
            if p.is_file(): f.write(p, p.relative_to(out))
    print(f'{out} and {z} for {origin}')

if __name__ == '__main__':
    main()
