"""Prepare the newest compatible official VPS dependency without selecting it.

The policy follows the official latest release. A candidate is used only after
its package, plugin API and adapter factory pass inspection; otherwise the
currently selected version is kept. Global npm is never changed."""
from pathlib import Path
import json, os
from bridge_config import load_config, remote_python, SOURCE
from dependency import load_policy

config = load_config()
policy = load_policy(Path(__file__).with_name('dependency-policy.json').read_text())
script = r'''
import pathlib,json,subprocess,shutil,os
policy=json.loads(POLICY)
root=pathlib.Path(REMOTE_ROOT)
paths=discover_remote({'node':REMOTE_NODE},required=('node','npm'));node=paths['node'];npm=paths['npm']
def prepare(version):
    target=root/'dependencies'/('codexhost-'+version)
    if not target.exists():
        # Install beside the final name so an interrupted download is never mistaken for a release.
        partial=target.with_name(target.name+'.partial')
        shutil.rmtree(partial,ignore_errors=True);partial.mkdir(parents=True)
        r=subprocess.run([npm,'install','--prefix',str(partial),'--save-exact','--ignore-scripts','--no-audit','--no-fund',policy['package']+'@'+version],capture_output=True,text=True,timeout=180)
        if r.returncode:shutil.rmtree(partial,ignore_errors=True);raise RuntimeError(r.stderr[-1000:])
        os.replace(partial,target)
    return inspect_dependency(target,version,node,policy['pluginApiVersion'])
latest=None;notes=[]
r=subprocess.run([npm,'view',policy['package']+'@latest','version'],capture_output=True,text=True,timeout=60)
if r.returncode==0:latest=r.stdout.strip()
else:notes.append('latest lookup failed: '+r.stderr.strip()[-300:])
selected=root/'adapter-selection.json'
current=json.loads(selected.read_text()).get('version') if selected.exists() else None
candidates=[]
for version in (latest,current):
    if version and version not in candidates:
        try:
            if supported(version,policy):candidates.append(version)
            else:notes.append(version+' is below minimum '+policy['minimumVersion'])
        except ValueError:notes.append('invalid version '+repr(version))
for version in candidates:
    try:
        selection=prepare(version)
        print(json.dumps({'prepared':True,'selected':False,'latest':latest,'current':current,'notes':notes,**selection}))
        break
    except Exception as error:
        notes.append(version+' incompatible or unavailable: '+str(error)[-300:])
else:
    raise RuntimeError('No compatible CodexHost dependency: '+'; '.join(notes))
'''.replace('POLICY', repr(json.dumps(policy))).replace('REMOTE_ROOT', repr(config['remoteRoot'])).replace('REMOTE_NODE', repr(config.get('remoteNodeExecutable')))
output = remote_python(config, script, timeout=300).strip().splitlines()[-1]
result = json.loads(output)
# deploy-transaction.py and verification read this result; nothing re-reads a version from policy.
report = SOURCE/'installation-dependency.json'
temp = report.with_name(report.name+'.tmp')
temp.write_text(json.dumps(result, indent=2), encoding='utf-8')
os.replace(temp, report)
print(json.dumps(result))
