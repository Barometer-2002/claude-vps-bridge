"""Check distributed source syntax, pure offline self-test and plugin entry files without deployment."""
from pathlib import Path
import ast, json, os, re, shutil, subprocess, sys, tempfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN, REMOTE, INSTALLER, SHIM, T3_NATIVE, ACP = ROOT / 'plugin', ROOT / 'remote', ROOT / 'installer', ROOT / 'shim', ROOT / 't3-native', ROOT / 'acp'
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 24 must be on PATH')

python_files = [*REMOTE.glob('*.py'), *INSTALLER.glob('*.py'), *(ROOT / 'scripts').glob('*.py')]
python_files += [REMOTE / 'windows-agent', REMOTE / 'windows-workspace']
for file in python_files:
    if not file.name.startswith('test-'):
        ast.parse(file.read_text(encoding='utf-8-sig'), filename=str(file))
for file in [*PLUGIN.glob('*.mjs'), *(PLUGIN / 'runtime').glob('*.mjs'), *REMOTE.glob('*.mjs'), *INSTALLER.glob('*.mjs'), *SHIM.glob('*.mjs'), *T3_NATIVE.glob('*.mjs'), *ACP.glob('*.mjs')]:
    if not file.name.startswith(('test-', 'benchmark-')):
        subprocess.run([node, '--check', str(file)], check=True, cwd=ROOT)

manage_shim = (SHIM / 'manage-shim.mjs').read_text(encoding='utf-8')
assets_block = re.search(r"export const SCRIPT_ASSETS = \[([^\]]*)\]", manage_shim, re.S)
if not assets_block:
    raise SystemExit('Missing SCRIPT_ASSETS list in shim/manage-shim.mjs')
for name in re.findall(r"name:\s*'([^']+)'", assets_block.group(1)):
    if not (SHIM / name).is_file():
        raise SystemExit('Shim installer copies a missing file: shim/' + name)

for name in ('claude-vps-shim.cs', 'claude-vps-shim.mjs', 'http-mcp-client.mjs', 'manage-shim.mjs', 'bridge-installation.mjs', 'mcp-policy.mjs', 'stream-presenter.mjs'):
    if not (SHIM / name).is_file():
        raise SystemExit('Missing neutral shim file: shim/' + name)
if not (T3_NATIVE / 'manage-native.mjs').is_file():
    raise SystemExit('Missing T3 native registration manager: t3-native/manage-native.mjs')
for name in ('package.json', 'package-lock.json', 'workspace-presenter.mjs', 'claude-vps-acp.mjs', 'claude-vps-acp.cs', 'manage-acp.mjs'):
    if not (ACP / name).is_file():
        raise SystemExit('Missing standard ACP wrapper file: acp/' + name)

manifest = json.loads((PLUGIN / 'manifest.json').read_text(encoding='utf-8'))
for field in ('entry', 'icon'):
    if not (PLUGIN / manifest[field]).is_file():
        raise SystemExit('Missing plugin file: ' + manifest[field])

# Both ends load the same stream framing; the two copies must not drift.
if (PLUGIN / 'transport-streams.mjs').read_bytes() != (REMOTE / 'transport-streams.mjs').read_bytes():
    raise SystemExit('plugin/transport-streams.mjs and remote/transport-streams.mjs differ')

# Every file the installer copies to the VPS must exist in remote/.
deploy = (INSTALLER / 'deploy-transaction.py').read_text(encoding='utf-8')
names = re.search(r"names=\(([^)]*)\)", deploy).group(1)
for name in re.findall(r"'([^']+)'", names):
    if not (REMOTE / name).is_file():
        raise SystemExit('Installer copies a missing remote file: remote/' + name)

# Remote metadata is generated from these same source files during deployment.
for name in ('bridge-manifest.json','workspace-request-schema.json'):
    if "payload['"+name+"']" not in deploy:raise SystemExit('Missing generated metadata: '+name)
if 'bridgeVersion:' in (REMOTE / 'remote-server.mjs').read_text(encoding='utf-8'):
    raise SystemExit('Remote version must come from the deployed manifest')

# Pure offline self-test (no installed bridge, private config or network required).
pure_self_test = subprocess.run(
    [node, str(SHIM / 'claude-vps-shim.mjs'), '--self-test', '--pure'],
    check=True,
    capture_output=True,
    text=True,
    cwd=ROOT,
)
pure_result = json.loads(pure_self_test.stdout.strip())
if pure_result.get('ok') is not True:
    raise SystemExit('Shim pure offline self-test failed: ' + pure_self_test.stdout.strip())

acp_self_test = subprocess.run(
    [node, str(ACP / 'claude-vps-acp.mjs'), '--self-test', '--pure'],
    check=True,
    capture_output=True,
    text=True,
    cwd=ROOT,
)
acp_result = json.loads(acp_self_test.stdout.strip())
if acp_result.get('ok') is not True:
    raise SystemExit('ACP wrapper pure offline self-test failed: ' + acp_self_test.stdout.strip())

# On Windows, compile claude-vps-shim.cs and claude-vps-acp.cs with .NET csc.exe into temp dirs and verify execution.
if sys.platform == 'win32':
    windir = Path(os.environ.get('WINDIR', r'C:\Windows'))
    csc = next(
        (c for c in (
            Path(os.environ['CLAUDE_VPS_CSC']) if os.environ.get('CLAUDE_VPS_CSC') else None,
            windir / 'Microsoft.NET' / 'Framework64' / 'v4.0.30319' / 'csc.exe',
            windir / 'Microsoft.NET' / 'Framework' / 'v4.0.30319' / 'csc.exe',
        ) if c and c.is_file()),
        None,
    )
    if not csc:
        raise SystemExit('Windows .NET csc.exe not found; cannot verify C# launcher compilation')
    with tempfile.TemporaryDirectory(prefix='claude-vps-shim-check-') as tmp:
        tmp_dir = Path(tmp)
        for asset in ('bridge-installation.mjs', 'mcp-policy.mjs', 'http-mcp-client.mjs', 'stream-presenter.mjs', 'claude-vps-shim.mjs'):
            shutil.copy2(SHIM / asset, tmp_dir / asset)
        (tmp_dir / 'node-path.txt').write_text(str(Path(node).resolve()) + '\n', encoding='utf-8')
        exe = tmp_dir / 'claude-vps-shim.exe'
        subprocess.run(
            [str(csc), '/nologo', '/optimize+', '/target:exe', f'/out:{exe}', str(SHIM / 'claude-vps-shim.cs')],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        exe_test = subprocess.run(
            [str(exe), '--self-test', '--pure'],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        exe_result = json.loads(exe_test.stdout.strip())
        if exe_result.get('ok') is not True:
            raise SystemExit('Compiled claude-vps-shim.exe pure self-test failed: ' + exe_test.stdout.strip())
    with tempfile.TemporaryDirectory(prefix='claude-vps-acp-check-') as tmp:
        tmp_dir = Path(tmp)
        for asset in ('workspace-presenter.mjs', 'claude-vps-acp.mjs'):
            shutil.copy2(ACP / asset, tmp_dir / asset)
        (tmp_dir / 'node-path.txt').write_text(str(Path(node).resolve()) + '\n', encoding='utf-8')
        exe = tmp_dir / 'claude-vps-acp.exe'
        subprocess.run(
            [str(csc), '/nologo', '/optimize+', '/target:exe', f'/out:{exe}', str(ACP / 'claude-vps-acp.cs')],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        exe_test = subprocess.run(
            [str(exe), '--self-test', '--pure'],
            check=True,
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        exe_result = json.loads(exe_test.stdout.strip())
        if exe_result.get('ok') is not True:
            raise SystemExit('Compiled claude-vps-acp.exe pure self-test failed: ' + exe_test.stdout.strip())

print('PASS Source syntax, shim & ACP offline self-tests, plugin entry, shared transport and install manifest; runtime acceptance was not run')
