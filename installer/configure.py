"""Create explicit non-secret settings; inspect the chosen SSH host read-only."""
from pathlib import Path
import argparse,json,shutil,os,subprocess
from bridge_config import SOURCE,validate,remote_python

def resolve_node(explicit=None):
    found=shutil.which(explicit or 'node')
    if not found:raise RuntimeError('Node.js 24+ must be available on PATH or provided via --node-executable')
    ver=subprocess.run([found,'-v'],capture_output=True,text=True,check=True,timeout=10).stdout.strip()
    major=int(ver.lstrip('v').split('.')[0]) if ver.lstrip('v').split('.')[0].isdigit() else 0
    if major<24:raise RuntimeError(f'Node.js 24 or newer is required for standalone T3 mode (found {ver})')
    return str(Path(found).resolve())

def main():
    p=argparse.ArgumentParser();p.add_argument('--ssh-host',required=True);p.add_argument('--host-root');p.add_argument('--t3-only',action='store_true',help='Configure standalone T3 Code mode without requiring CodexHost Desktop');p.add_argument('--node-executable',help='Local Node.js 24+ executable for --t3-only mode');p.add_argument('--remote-root');p.add_argument('--remote-workspace-root');p.add_argument('--remote-claude');p.add_argument('--remote-node');p.add_argument('--ssh-executable');p.add_argument('--ssh-routes',type=json.loads,default=argparse.SUPPRESS,help='Ordered SSH routes as a JSON array');p.add_argument('--output',type=Path,default=SOURCE/'bridge-config.local.json');a=p.parse_args()
    if a.output.exists():raise RuntimeError('Configuration already exists; edit it explicitly instead of overwriting it')
    if a.t3_only and a.host_root:raise RuntimeError('Use either --host-root (CodexHost) or --t3-only (standalone T3 Code), not both')
    host_fields={}
    if a.t3_only:
        host_fields['nodeExecutable']=resolve_node(a.node_executable)
    else:
        cli=shutil.which('codexhost');host=Path(a.host_root or os.environ.get('CLAUDE_VPS_HOST_ROOT') or (str(Path(cli).parent.parent) if cli else ''))
        if not (host/'app/host-runtime.mjs').is_file() or not (host/'runtime/node.exe').is_file():raise RuntimeError('Provide --host-root pointing to the installed CodexHost directory, or pass --t3-only to configure standalone T3 Code mode')
        host_fields['hostRoot']=str(host.resolve())
        if a.node_executable:host_fields['nodeExecutable']=resolve_node(a.node_executable)
    ssh=shutil.which(a.ssh_executable or 'ssh');pwsh=shutil.which('pwsh')
    if not ssh or not pwsh:raise RuntimeError('OpenSSH client and PowerShell 7 must be available on PATH')
    config={'schemaVersion':1,'sshHost':a.ssh_host,**host_fields,'sshExecutable':ssh,'pwshExecutable':pwsh,'remoteRoot':a.remote_root or '/pending','remoteWorkspaceRoot':a.remote_workspace_root or '/pending','remoteClaudeExecutable':a.remote_claude or '/pending','legacy':{'enabled':False}}
    if hasattr(a,'ssh_routes'):config['sshRoutes']=a.ssh_routes
    validate(config)
    ssh_check=subprocess.run([ssh,'-V'],capture_output=True,text=True,check=True,timeout=10)
    probe=remote_python(config,"import pathlib,json\npaths=discover_remote("+repr({'claude':a.remote_claude,'node':a.remote_node})+")\nprint(json.dumps({'home':str(pathlib.Path.home()),**paths}))\n")
    remote=json.loads(probe)
    config.update(remoteRoot=a.remote_root or remote['home']+'/.codexhost/windows-bridge',remoteWorkspaceRoot=a.remote_workspace_root or remote['home']+'/windows-local-work',remoteClaudeExecutable=a.remote_claude or remote['claude'])
    config['remoteNodeExecutable']=remote['node']
    validate(config);a.output.parent.mkdir(parents=True,exist_ok=True)
    with a.output.open('x',encoding='utf8') as f:json.dump(config,f,ensure_ascii=False,indent=2)
    print(json.dumps({'configured':True,'file':str(a.output),'sshExecutable':ssh,'sshVersion':(ssh_check.stderr or ssh_check.stdout).strip(),'optionalTools':'unchanged; use prepare-mcp.py for explicit changes'}))
if __name__=='__main__':main()
