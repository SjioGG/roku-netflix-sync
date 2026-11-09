import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_env import load_local_env


class LocalEnvTest(unittest.TestCase):
    def test_literal_values_and_existing_environment(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'OVERRIDE': 'process'}, clear=True):
            file = Path(directory) / '.env'
            file.write_text('# comment\nOVERRIDE=file\nexport LITERAL="literal $value # text"\nEMPTY=\n')
            load_local_env(file)
            self.assertEqual(os.environ['OVERRIDE'], 'process')
            self.assertEqual(os.environ['LITERAL'], 'literal $value # text')
            self.assertEqual(os.environ['EMPTY'], '')
            load_local_env(Path(directory) / 'missing')

    def test_invalid_entries_do_not_expose_values(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / '.env'
            file.write_text('not an assignment')
            with self.assertRaisesRegex(ValueError, 'Invalid .env entry'):
                load_local_env(file)

    def test_private_file_loading_can_be_disabled(self):
        with patch.dict(os.environ, {'ROKU_SYNC_ENV_FILE': ''}, clear=True):
            load_local_env()
            self.assertEqual(dict(os.environ), {'ROKU_SYNC_ENV_FILE': ''})


if __name__ == '__main__':
    unittest.main()
