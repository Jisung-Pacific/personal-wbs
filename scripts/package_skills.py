#!/usr/bin/env python3
"""Zip each skill for upload to claude.ai (or any app that installs Agent Skills from a zip).

Usage:
  python3 package_skills.py [--out dist]

Writes <out>/<skill>.zip for every folder in skills/. Each archive holds the skill
folder itself at the top level (<skill>/SKILL.md), as claude.ai expects, plus a copy
of the helper scripts under <skill>/scripts/ and the LICENSE, because an uploaded
skill can only see the files inside its own folder.
"""
import argparse
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPTS = ('wbs_schema.py', 'validate.py', 'make_agent_files.py', 'reconcile.py')


def main():
    ap = argparse.ArgumentParser(description='Zip each skill folder with the helper scripts.')
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist'))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    skills_dir = os.path.join(ROOT, 'skills')
    for name in sorted(os.listdir(skills_dir)):
        src = os.path.join(skills_dir, name)
        if not os.path.isfile(os.path.join(src, 'SKILL.md')):
            continue
        path = os.path.join(args.out, f'{name}.zip')
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
            for dirpath, _, files in os.walk(src):           # the skill folder as it is
                for f in sorted(files):
                    full = os.path.join(dirpath, f)
                    z.write(full, os.path.join(name, os.path.relpath(full, src)))
            for f in SCRIPTS:                                # helper scripts next to SKILL.md
                z.write(os.path.join(HERE, f), f'{name}/scripts/{f}')
            z.write(os.path.join(ROOT, 'LICENSE'), f'{name}/LICENSE')
        print(f'{path}: {len(zipfile.ZipFile(path).namelist())} files')


if __name__ == '__main__':
    main()
