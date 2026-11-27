"""Remote half of the code-only transaction. Never copies or rolls back user state."""
import pathlib,json,hashlib,os,subprocess,shutil,base64
ROOT=pathlib.Path.home()/'.codexhost/windows-bridge'
def sha(data):return hashlib.sha256(data).hexdigest()
def replace(dest,data,mode):
    temp=dest.with_name(dest.name+'.switch.tmp')
    try:temp.write_bytes(data);temp.chmod(mode);os.replace(temp,dest)
    finally:temp.unlink(missing_ok=True)
def code_name(name):
    return isinstance(name,str) and pathlib.PurePath(name).name==name and not name.startswith('.') and name not in ('remote-config.json','adapter-selection.json','node-path','claude-path','managed-files.json')
def previous_managed():
    manifest=ROOT/'managed-files.json'
    if manifest.exists():
        value=json.loads(manifest.read_text())
        if value.get('schemaVersion')!=1 or not isinstance(value.get('files'),dict):raise ValueError('Invalid managed file manifest')
        return value['files']
    # Older installations have transaction journals but no managed manifest.
    # Only a committed journal proves which files this installer owned.
    for file in sorted((ROOT/'transactions').glob('*/journal.json'),reverse=True):
        value=json.loads(file.read_text())
        if value.get('phase')!='committed':continue
        return {row['name']:row['afterHash'] for row in value['rows'] if code_name(row['name']) and row['dest']==str(ROOT/row['name']) and row['afterHash'] is not None}
    return {}
def main(request):
    if not ROOT.is_absolute() or ROOT==pathlib.Path('/') or '..' in ROOT.parts:raise ValueError('Unsafe installation root')
    action=request['action'];tx=request['id']
    if not tx.replace('-','').isalnum():raise ValueError('Invalid transaction ID')
    stage=ROOT/'transactions'/tx
    if action=='prepare':
        paths=discover_remote({'node':request.get('remoteNodeExecutable'),'claude':request['remoteConfig']['claudeExecutable']},required=('node','claude'))
        stage.mkdir(parents=True,exist_ok=False)
        rows=[]
        previous=previous_managed()
        for name,digest in previous.items():
            if not code_name(name) or not isinstance(digest,str) or len(digest)!=64:raise ValueError('Unsafe managed file manifest')
            if name in request['files']:continue
            dest=ROOT/name
            if not dest.exists():continue
            before=dest.read_bytes()
            if sha(before)!=digest:raise RuntimeError('Retired managed file changed: '+name)
            (stage/(name+'.old')).write_bytes(before)
            rows.append({'dest':str(dest),'name':name,'beforeHash':digest,'afterHash':None,'mode':None,'beforeMode':dest.stat().st_mode&0o777})
        for name,text in request['files'].items():
            if not code_name(name):raise ValueError('Invalid code filename')
            dest=ROOT/name
            before=dest.read_bytes() if dest.exists() else None;data=text.encode()
            mode=0o700 if name in ('windows-agent','windows-workspace','claude-windows','workspace-guard.py','start-transport','check-health') else 0o600
            row={'dest':str(dest),'name':name,'beforeHash':sha(before) if before is not None else None,'afterHash':sha(data),'mode':mode,'beforeMode':dest.stat().st_mode&0o777 if before is not None else None}
            (stage/(name+'.new')).write_bytes(data)
            if before is not None:(stage/(name+'.old')).write_bytes(before)
            rows.append(row)
        node=paths['node']
        adapter_required=request.get('adapterRequired',True)
        config=None
        if adapter_required:
            selected=pathlib.Path(request['adapterPath'])
            # The selection is inside a separately installed complete npm dependency tree.
            expected=ROOT/'dependencies'/('codexhost-'+request['adapterVersion'])/'node_modules/@codexhost/cli-linux-x64/app/plugins/claude-code/plugin.mjs'
            if not selected.is_file() or selected.resolve()!=expected.resolve():raise RuntimeError('Managed adapter missing or outside the selected dependency tree; prepare its exact npm version first')
            config=inspect_dependency(selected.parents[6],request['adapterVersion'],node,request['pluginApiVersion'])
            if pathlib.Path(config['modulePath'])!=selected.resolve():raise RuntimeError('Unexpected managed adapter entry')
        managed={'schemaVersion':1,'files':{name:sha(text.encode()) for name,text in request['files'].items()}}
        generated={'managed-files.json':json.dumps(managed),'node-path':node+'\n'}
        if config is not None:generated['adapter-selection.json']=json.dumps(config)
        elif (ROOT/'adapter-selection.json').exists():
            stale_adapter=ROOT/'adapter-selection.json'
            before=stale_adapter.read_bytes()
            (stage/'adapter-selection.json.old').write_bytes(before)
            rows.append({'dest':str(stale_adapter),'name':'adapter-selection.json','beforeHash':sha(before),'afterHash':None,'mode':None,'beforeMode':stale_adapter.stat().st_mode&0o777})
        if 'remoteConfig' in request:
            generated['claude-path']=request['remoteConfig']['claudeExecutable']+'\n'
            generated['remote-config.json']=json.dumps(request['remoteConfig'])
        for name,text in generated.items():
            dest=ROOT/name;before=dest.read_bytes() if dest.exists() else None;data=text.encode()
            (stage/(name+'.new')).write_bytes(data)
            if before is not None:(stage/(name+'.old')).write_bytes(before)
            rows.append({'dest':str(dest),'name':name,'beforeHash':sha(before) if before is not None else None,'afterHash':sha(data),'mode':0o600,'beforeMode':dest.stat().st_mode&0o777 if before is not None else None})
        for row in rows:
            if row['afterHash'] is None:continue
            if row['name'].endswith('.mjs'):
                check=stage/row['name'];check.write_bytes((stage/(row['name']+'.new')).read_bytes());subprocess.run([node,'--check',str(check)],check=True,capture_output=True)
            if row['name'].endswith('.py'):compile((stage/(row['name']+'.new')).read_text(),row['name'],'exec')
        journal={'id':tx,'phase':'prepared','rows':rows,'node':node,'adapter':config};(stage/'journal.json').write_text(json.dumps(journal))
        return {'stage':str(stage),'adapter':config,'node':node,'hashes':{r['dest']:r['afterHash'] for r in rows}}
    journal=json.loads((stage/'journal.json').read_text());rows=journal['rows']
    for row in rows:
        if row['name'].startswith('.') or pathlib.Path(row['dest'])!=ROOT/row['name'] or pathlib.PurePath(row['name']).name!=row['name']:raise RuntimeError('Transaction contains an unmanaged path')
    if action=='commit':
        for row in rows:
            p=pathlib.Path(row['dest']);current=sha(p.read_bytes()) if p.exists() else None
            if current!=row['beforeHash']:raise RuntimeError('Concurrent remote modification: '+str(p))
            if row['afterHash'] is not None and sha((stage/(row['name']+'.new')).read_bytes())!=row['afterHash']:raise RuntimeError('Prepared remote code changed: '+row['name'])
        journal['phase']='committing';(stage/'journal.json').write_text(json.dumps(journal))
        try:
            for row in rows:
                if row['afterHash'] is None:pathlib.Path(row['dest']).unlink(missing_ok=True)
                else:replace(pathlib.Path(row['dest']),(stage/(row['name']+'.new')).read_bytes(),row['mode'])
        except Exception:
            main({'action':'rollback','id':tx});raise
        journal['phase']='committed';(stage/'journal.json').write_text(json.dumps(journal))
        return {'committed':True}
    if action in ('rollback','check-rollback'):
        for row in rows:
            p=pathlib.Path(row['dest']);current=sha(p.read_bytes()) if p.exists() else None
            if current not in (row['beforeHash'],row['afterHash']):raise RuntimeError('Remote rollback conflict: '+str(p))
            if row['beforeHash'] is not None and sha((stage/(row['name']+'.old')).read_bytes())!=row['beforeHash']:raise RuntimeError('Remote rollback backup changed: '+str(p))
        if action=='check-rollback':return {'ready':True}
        for row in rows:
            p=pathlib.Path(row['dest'])
            if row['beforeHash'] is None:
                if p.exists():p.unlink()
            else:replace(p,(stage/(row['name']+'.old')).read_bytes(),row['beforeMode'])
        journal['phase']='rolled-back';(stage/'journal.json').write_text(json.dumps(journal));return {'rolledBack':True}
    raise ValueError('Unknown action')
