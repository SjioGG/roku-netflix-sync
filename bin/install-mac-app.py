#!/usr/bin/env python3
"""Build/install a local macOS app using an existing official Electron runtime.

Uses Electron's documented prebuilt-binary packaging layout. Uses uv to bundle
standalone Python and pinned audio packages. Private settings stay in userData.
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
LSREGISTER = Path('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister')


def rename_executable(contents, name):
    """Electron determines app.isPackaged from the executable's basename."""
    info_path = contents / 'Info.plist'
    with info_path.open('rb') as source:
        info = plistlib.load(source)
    executable = contents / 'MacOS' / info['CFBundleExecutable']
    if executable.name != name:
        executable.rename(executable.with_name(name))
    info['CFBundleExecutable'] = name
    with info_path.open('wb') as destination:
        plistlib.dump(info, destination)


def build_executable(contents, name):
    """Build a dedicated launcher Mach-O so LC_UUID never collides with stock Electron.app.

    On macOS Sequoia/Tahoe, UserEventAgent resolves Local Network permissions by
    both PID and Mach-O LC_UUID. Reusing Electron's binary byte-for-byte shares
    its LC_UUID with cached Electron.app bundles (com.github.Electron) and
    suppresses the Local Network prompt while leaving LAN sockets blocked.
    """
    clang = shutil.which('clang')
    launcher_src = ROOT / 'desktop/macos-launcher.c'
    if not clang or not launcher_src.is_file():
        rename_executable(contents, name)
        return
    info_path = contents / 'Info.plist'
    with info_path.open('rb') as source:
        info = plistlib.load(source)
    old_executable = contents / 'MacOS' / info['CFBundleExecutable']
    target = contents / 'MacOS' / name
    frameworks = contents / 'Frameworks'
    subprocess.run([
        clang, '-O2', '-Wall', '-Wextra', '-mmacosx-version-min=12.0',
        str(launcher_src),
        f'-F{frameworks}', '-framework', 'Electron Framework',
        '-Wl,-rpath,@executable_path/../Frameworks',
        '-o', str(target),
    ], check=True)
    target.chmod(0o755)
    if old_executable != target and old_executable.exists():
        old_executable.unlink()
    info['CFBundleExecutable'] = name
    with info_path.open('wb') as destination:
        plistlib.dump(info, destination)


def unregister_bundle(bundle):
    """Remove temporary staging bundles from LaunchServices."""
    if LSREGISTER.is_file():
        subprocess.run([str(LSREGISTER), '-u', str(bundle)],
                       capture_output=True, check=False)


def build_chrome_audio_tap(resources):
    """Compile the native CoreAudio Chrome process tap helper into Resources/bin."""
    swiftc = shutil.which('swiftc')
    source = ROOT / 'desktop/chrome-audio-tap.swift'
    if not swiftc or not source.is_file():
        return None
    bin_dir = resources / 'bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    target = bin_dir / 'chrome-audio-tap'
    subprocess.run([
        swiftc, '-O', '-target', 'arm64-apple-macos14.2',
        str(source), '-o', str(target),
    ], check=True)
    target.chmod(0o755)
    check = subprocess.run([str(target), '--check'], capture_output=True, text=True, check=True)
    if not json.loads(check.stdout).get('ok'):
        raise RuntimeError('chrome-audio-tap runtime check failed')
    return target


def prepare_python(resources):
    """Build a movable Python distribution inside the app, with no venv links."""
    uv = shutil.which('uv')
    if not uv:
        raise RuntimeError('uv is required to build the app. Install uv, then rerun the installer.')
    pin = json.loads((ROOT / 'desktop/python-runtime.json').read_text())
    with tempfile.TemporaryDirectory(prefix='roku-python-') as directory:
        subprocess.run([uv, '--no-config', 'python', 'install', pin['version'],
                        '--install-dir', directory, '--no-bin',
                        '--python-downloads-json-url', pin['metadataUrl']], check=True)
        runtimes = [p for p in Path(directory).glob('cpython-*/bin/python3')
                    if not p.parent.parent.is_symlink()]
        if len(runtimes) != 1:
            raise RuntimeError('uv did not produce exactly one standalone Python runtime')
        shutil.copytree(runtimes[0].parent.parent, resources / 'python', symlinks=True)
    python = resources / 'python/bin/python3'
    subprocess.run([uv, '--no-config', 'pip', 'install', '--python', str(python),
                    '--system', '--break-system-packages', '--link-mode', 'copy',
                    '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple',
                    '-r', str(ROOT / 'desktop/requirements-audio.txt')], check=True)
    # Imports validate PortAudio availability without opening audio streams.
    subprocess.run([str(python), '-I', '-B', '-c', 'import sounddevice, numpy'], check=True)
    return python


def verify_bundle(bundle):
    """Exercise Electron's real launch decision before replacing the app."""
    with tempfile.TemporaryDirectory(prefix='roku-launch-check-') as user_data:
        env = dict(os.environ, ROKU_SYNC_DESKTOP_SMOKE='1',
                   ROKU_SYNC_SMOKE_USER_DATA=user_data, ROKU_SYNC_ENV_FILE='')
        env.pop('ELECTRON_RUN_AS_NODE', None)
        env.pop('ELECTRON_FORCE_IS_PACKAGED', None)
        env.pop('ROKU_SYNC_PYTHON', None)
        executable = bundle / 'Contents/MacOS' / APP_NAME
        result = subprocess.run([str(executable)], env=env, capture_output=True,
                                text=True, timeout=35)
        print(result.stdout, end='')
        if result.returncode:
            raise RuntimeError('Installed-app startup check failed: ' + result.stderr[-2000:])


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
    settings_dir = Path.home() / 'Library/Application Support' / APP_NAME
    output = ROOT / 'dist/mac'
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='roku-sync-app-', dir=output))
    bundle = stage / f'{APP_NAME}.app'
    subprocess.run(['/usr/bin/ditto', str(runtime), str(bundle)], check=True)
    contents = bundle / 'Contents'
    build_executable(contents, APP_NAME)
    resources = contents / 'Resources'
    build_chrome_audio_tap(resources)
    prepare_python(resources)
    # Remove Electron's generic starter page, if this runtime includes it.
    starter = resources / 'default_app.asar'
    if starter.exists(): starter.unlink()
    app_source = resources / 'app'
    app_source.mkdir()
    files = ['aec_daemon.py', 'aec_webrtc.py', 'roku_client.py', 'local_env.py']
    files += [f'desktop/{name}' for name in ['main.js', 'controller.cjs', 'server.cjs', 'local-env.cjs', 'runtime.cjs', 'preload.js', 'index.html', 'renderer.js', 'styles.css']]
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
                NSAudioCaptureUsageDescription='Roku Sync taps Google Chrome audio silently so it can subtract TV dialogue from your microphone during calls.',
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
    verify_bundle(bundle)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    if args.build_only:
        print(bundle)
        return
    unregister_bundle(bundle)
    for stale_stage in output.glob('roku-sync-app-*'):
        if stale_stage != stage and stale_stage.is_dir():
            unregister_bundle(stale_stage / f'{APP_NAME}.app')
            shutil.rmtree(stale_stage, ignore_errors=True)
    # Machine-local runtime config is never part of the distributable bundle.
    settings_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_file = settings_dir / 'settings.env'
    if not settings_file.exists() and (ROOT / '.env').is_file():
        with open(settings_file, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
            f.write((ROOT / '.env').read_text())
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
    if LSREGISTER.is_file():
        subprocess.run([str(LSREGISTER), '-f', str(target)], capture_output=True, check=False)
    print(f'Installed {target} (Electron {runtime_info["CFBundleShortVersionString"]})')
    print('Open Roku Sync from Spotlight, Finder, or the Dock.')

if __name__ == '__main__': main()
