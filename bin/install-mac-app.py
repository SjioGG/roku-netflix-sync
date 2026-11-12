#!/usr/bin/env python3
"""Build/install a local macOS app using an existing official Electron runtime.

Uses Electron's documented prebuilt-binary packaging layout. Does not download
packages or change system security settings. Private settings stay in userData.
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = 'Roku Sync'
BUNDLE_ID = 'dev.rokusync.desktop'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, help='Path to an existing Electron.app')
    parser.add_argument('--destination', type=Path, default=Path('/Applications'))
    parser.add_argument('--build-only', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This installer builds macOS apps only.')
    runtimes = sorted((ROOT / 'desktop/.electron-cache').glob('*/Electron.app'), key=lambda p: p.stat().st_mtime, reverse=True)
    installed = ROOT / 'desktop/node_modules/electron/dist/Electron.app'
    runtime = args.runtime or (installed if installed.is_dir() else runtimes[0] if runtimes else None)
    if runtime is None or not runtime.is_dir():
        parser.error('No cached Electron.app. Supply --runtime /path/to/Electron.app.')
    with (runtime / 'Contents/Info.plist').open('rb') as f:
        runtime_info = plistlib.load(f)
    icon = ROOT / 'desktop/assets/app-icon.icns'
    if not icon.is_file():
        parser.error('Generate the icon first: swift bin/render-app-icon.swift')
    output = ROOT / 'dist/mac'
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='roku-sync-app-', dir=output))
    bundle = stage / f'{APP_NAME}.app'
    subprocess.run(['/usr/bin/ditto', str(runtime), str(bundle)], check=True)
    contents = bundle / 'Contents'
    resources = contents / 'Resources'
    # Remove Electron's generic starter page, if this runtime includes it.
    starter = resources / 'default_app.asar'
    if starter.exists(): starter.unlink()
    app_source = resources / 'app'
    app_source.mkdir()
    files = ['aec_daemon.py', 'roku_client.py', 'local_env.py']
    files += [f'desktop/{name}' for name in ['main.js', 'controller.cjs', 'local-env.cjs', 'runtime.cjs', 'preload.js', 'index.html', 'renderer.js', 'styles.css']]
    files += ['desktop/assets/app-icon.png']
    for name in files:
        destination = app_source / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, destination)
    package = json.loads((ROOT / 'desktop/package.json').read_text())
    (app_source / 'package.json').write_text(json.dumps({
        'name': 'roku-sync-desktop', 'productName': APP_NAME,
        'version': package['version'], 'main': 'desktop/main.js',
        'description': package['description'],
    }, indent=2) + '\n')
    shutil.copy2(icon, resources / 'app-icon.icns')
    info_path = contents / 'Info.plist'
    with info_path.open('rb') as f: info = plistlib.load(f)
    info.update(CFBundleName=APP_NAME, CFBundleDisplayName=APP_NAME,
                CFBundleIdentifier=BUNDLE_ID, CFBundleIconFile='app-icon.icns',
                CFBundleShortVersionString=package['version'], CFBundleVersion=package['version'],
                NSMicrophoneUsageDescription='Roku Sync uses your selected microphone only when you start the local echo-cancellation tool.',
                NSLocalNetworkUsageDescription='Roku Sync discovers and controls the Roku device you select on your local network.')
    with info_path.open('wb') as f: plistlib.dump(info, f)
    # Documented Electron rebranding: give every helper its own bundle identity.
    for helper in (contents / 'Frameworks').glob('Electron Helper*.app/Contents/Info.plist'):
        with helper.open('rb') as f: helper_info = plistlib.load(f)
        suffix = helper.parent.parent.stem.removeprefix('Electron Helper').strip(' ()').lower()
        helper_info.update(CFBundleName=f'{APP_NAME} Helper', CFBundleDisplayName=f'{APP_NAME} Helper',
                           CFBundleIdentifier=BUNDLE_ID + '.helper' + ('.' + suffix if suffix else ''))
        with helper.open('wb') as f: plistlib.dump(helper_info, f)
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(bundle)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    if args.build_only:
        print(bundle)
        return
    # Machine-local runtime config is never part of the distributable bundle.
    settings_dir = Path.home() / 'Library/Application Support' / APP_NAME
    settings_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_file = settings_dir / 'settings.env'
    if not settings_file.exists() and (ROOT / '.env').is_file():
        with open(settings_file, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
            f.write((ROOT / '.env').read_text())
    runtime_file = settings_dir / 'runtime.json'
    runtime_file.write_text(json.dumps({'pythonPath': str(Path(sys.executable).resolve())}) + '\n')
    runtime_file.chmod(0o600)
    args.destination.mkdir(parents=True, exist_ok=True)
    target = args.destination / bundle.name
    # Reinstallation preserves a recoverable copy, and never replaces another app.
    if target.exists():
        with (target / 'Contents/Info.plist').open('rb') as f: previous = plistlib.load(f)
        if previous.get('CFBundleIdentifier') != BUNDLE_ID:
            parser.error('Destination contains a different app; nothing overwritten.')
        backup = output / ('previous-' + datetime.now().strftime('%Y%m%dT%H%M%S') + '.app')
        shutil.move(str(target), backup)
    shutil.move(str(bundle), target)
    stage.rmdir()
    print(f'Installed {target} (Electron {runtime_info["CFBundleShortVersionString"]})')
    print('Open Roku Sync from Spotlight, Finder, or the Dock.')

if __name__ == '__main__': main()
