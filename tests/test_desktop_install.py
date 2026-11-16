"""Installer checks with all subprocesses mocked, no package or device access."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'desktop_install', Path(__file__).resolve().parents[1] / 'bin/install-mac-app.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DesktopInstallTest(unittest.TestCase):
    def test_launch_verification_cannot_force_packaged_status(self):
        with patch.dict(installer.os.environ, {'ELECTRON_RUN_AS_NODE': '1',
                                              'ELECTRON_FORCE_IS_PACKAGED': '1',
                                              'ROKU_SYNC_PYTHON': '/stale/python'}), \
                patch.object(installer.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = ''
            installer.verify_bundle(Path('/fixture/Roku Sync.app'))
        env = run.call_args.kwargs['env']
        self.assertNotIn('ELECTRON_RUN_AS_NODE', env)
        self.assertNotIn('ELECTRON_FORCE_IS_PACKAGED', env)
        self.assertNotIn('ROKU_SYNC_PYTHON', env)
        self.assertEqual(env['ROKU_SYNC_DESKTOP_SMOKE'], '1')
        self.assertEqual(env['ROKU_SYNC_ENV_FILE'], '')

    def test_packaging_builds_unique_launcher_or_renames_executable_with_plist(self):
        with tempfile.TemporaryDirectory() as directory:
            contents = Path(directory)
            executable = contents / 'MacOS/Electron'
            executable.parent.mkdir()
            executable.write_bytes(b'synthetic executable')
            (contents / 'Frameworks').mkdir()
            with (contents / 'Info.plist').open('wb') as output:
                installer.plistlib.dump({'CFBundleExecutable': 'Electron', 'Preserved': True}, output)
            with patch.object(installer.shutil, 'which', return_value='/usr/bin/clang'), \
                    patch.object(installer.subprocess, 'run') as run:
                def compile_launcher(cmd, **kwargs):
                    out = Path(cmd[cmd.index('-o') + 1])
                    out.write_bytes(b'compiled native launcher with fresh LC_UUID')
                run.side_effect = compile_launcher
                installer.build_executable(contents, 'Roku Sync')
            self.assertFalse(executable.exists(), 'stock Electron binary must be removed so its LC_UUID cannot collide')
            self.assertEqual((executable.parent / 'Roku Sync').read_bytes(),
                             b'compiled native launcher with fresh LC_UUID')
            compile_cmd = run.call_args.args[0]
            self.assertIn('Electron Framework', compile_cmd)
            with (contents / 'Info.plist').open('rb') as source:
                info = installer.plistlib.load(source)
            self.assertEqual(info['CFBundleExecutable'], 'Roku Sync')
            self.assertTrue(info['Preserved'])

    def test_uv_bundles_python_and_audio_without_external_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fake_run(command, **kwargs):
                if command[2:4] == ['python', 'install']:
                    staging = Path(command[command.index('--install-dir') + 1])
                    executable = staging / 'cpython-fixture/bin/python3'
                    executable.parent.mkdir(parents=True)
                    executable.write_text('synthetic standalone Python')
                    (staging / 'cpython-alias').symlink_to(executable.parent.parent)

            with patch.object(installer.shutil, 'which', return_value='/fixture/uv'), \
                    patch.object(installer.subprocess, 'run', side_effect=fake_run) as run:
                python = installer.prepare_python(root)
            self.assertEqual(python, root / 'python/bin/python3')
            self.assertTrue(python.is_file())
            self.assertFalse(python.is_symlink())
            calls = [call.args[0] for call in run.call_args_list]
            self.assertIn('--python-downloads-json-url', calls[0])
            self.assertEqual(calls[1][0:4], ['/fixture/uv', '--no-config', 'pip', 'install'])
            self.assertEqual(calls[1][calls[1].index('--python') + 1], str(python))
            self.assertIn('https://pypi.org/simple', calls[1])
            self.assertIn('copy', calls[1])
            self.assertEqual(calls[2], [str(python), '-I', '-B', '-c', 'import sounddevice, numpy'])

    def test_failed_dependencies_stop_installation(self):
        with patch.object(installer.shutil, 'which', return_value='/fixture/uv'), \
                patch.object(installer.subprocess, 'run',
                          side_effect=installer.subprocess.CalledProcessError(1, 'pip')):
            with self.assertRaises(installer.subprocess.CalledProcessError):
                installer.prepare_python(Path('/unused-fixture'))

    def test_missing_uv_is_actionable(self):
        with patch.object(installer.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'uv is required'):
                installer.prepare_python(Path('/unused-fixture'))

    def test_builds_chrome_audio_tap_into_resources_bin(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = Path(directory)

            def fake_run(cmd, **kwargs):
                if '-o' in cmd:
                    out = Path(cmd[cmd.index('-o') + 1])
                    out.write_bytes(b'synthetic tap binary')
                    return None
                res = unittest.mock.MagicMock()
                res.stdout = '{"ok":true,"supported":true}\n'
                return res

            with patch.object(installer.shutil, 'which', return_value='/usr/bin/swiftc'), \
                    patch.object(installer.subprocess, 'run', side_effect=fake_run) as run:
                target = installer.build_chrome_audio_tap(resources)
            self.assertEqual(target, resources / 'bin/chrome-audio-tap')
            self.assertTrue(target.is_file())
            self.assertEqual(len(run.call_args_list), 2)

