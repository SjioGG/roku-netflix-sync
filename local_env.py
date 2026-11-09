"""Load the local .env as literal values, without shell expansion or execution."""
import os
from pathlib import Path
import re


def load_local_env(path=None):
    if path is None:
        override = os.environ.get('ROKU_SYNC_ENV_FILE')
        if override == '':
            return
        path = override or Path(__file__).with_name('.env')
    path = Path(path)
    if not path.is_file():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.removeprefix('export ').partition('=')
        key, value = key.strip(), value.strip()
        if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError('Invalid .env entry; expected KEY=value')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
