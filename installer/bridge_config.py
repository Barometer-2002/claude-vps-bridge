"""Non-secret installation settings shared by install commands. No account imports."""
from pathlib import Path, PurePosixPath
import json, os, re, subprocess

INSTALLER = Path(__file__).resolve().parent
# Repository root: local config, transactions and reports live here (git-ignored).
SOURCE = INSTALLER.parent
PLUGIN = SOURCE/'plugin'   # copied to the CodexHost plugin directory
REMOTE = SOURCE/'remote'   # copied flat to remoteRoot on the VPS
INSTALLED = Path.home()/'.codexhost/plugins/claude-vps'

def custom_codexhost_roots():
    """CodexHost location variables that point away from the default location.

    CodexHost 0.20.0 exports CODEXHOST_DATA_DIR to the processes it starts, so an
    install launched from a Host task inherits the default value. Only a different
    location is a customization this installer cannot target."""
    data=Path.home()/'.codexhost'
    defaults={'CODEXHOST_DATA_DIR':data,'CODEXHOST_PLUGIN_DIRECTORY':data/'plugins'}
    same=lambda a,b:os.path.normcase(os.path.abspath(a))==os.path.normcase(os.path.abspath(b))
    return [name for name,default in defaults.items() if os.environ.get(name) and not same(os.environ[name],default)]

def validate(value):
    if value.get('schemaVersion') != 1:
        raise ValueError('Unsupported bridge configuration version')
    if not isinstance(value.get('sshHost'), str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]*', value['sshHost']):
        raise ValueError('sshHost must be an SSH alias or user@host, not command options')
    for key in ('hostRoot', 'sshExecutable', 'pwshExecutable'):
        if not isinstance(value.get(key), str) or not Path(value[key]).is_absolute() or any(c in value[key] for c in '\r\n\0'):
            raise ValueError(key+' must be an absolute local path')
    for key in ('remoteRoot', 'remoteWorkspaceRoot', 'remoteClaudeExecutable', *(['remoteNodeExecutable'] if 'remoteNodeExecutable' in value else [])):
        p=value.get(key)
        if not isinstance(p,str) or not p.startswith('/') or p=='/' or '..' in PurePosixPath(p).parts or any(c in p for c in '\r\n\0'):
            raise ValueError(key+' must be an absolute remote path without parent traversal')
    return value

def load_config():
    explicit=os.environ.get('CLAUDE_VPS_CONFIG')
    candidates=[Path(explicit)] if explicit else [SOURCE/'bridge-config.local.json',INSTALLED/'bridge-config.json']
    for file in candidates:
        if file.is_file():return validate(json.loads(file.read_text(encoding='utf-8-sig')))
    raise RuntimeError('Bridge configuration missing. Run configure.py --ssh-host <alias> --host-root <CodexHost directory>.')

def ssh_args(config,command):
    return [config['sshExecutable'],'-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12',config['sshHost'],command]

def remote_python(config,code,timeout=120):
    code=(INSTALLER/'remote_discovery.py').read_text(encoding='utf-8')+'\n'+(INSTALLER/'dependency.py').read_text(encoding='utf-8')+'\n'+code
    result=subprocess.run(ssh_args(config,'python3 -'),input=code.encode(),capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout.decode()

if __name__=='__main__':
    # install.ps1 uses the same rule instead of a separate PowerShell copy.
    import sys
    if sys.argv[1:]!=['--check-roots']:raise SystemExit('usage: bridge_config.py --check-roots')
    custom=custom_codexhost_roots()
    if custom:raise SystemExit('Custom CodexHost location is not supported by this installer: '+', '.join(custom))
