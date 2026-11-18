// Read-only installed-version verification. Does not open a model turn or restart Desktop.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {remoteHealth} from '../plugin/diagnose.mjs';
import {runRouteCommand} from './route-command.mjs';
import {validateConfig,getBridgeConfig} from '../plugin/runtime/bridge-config.mjs';
import {verifyUpgradeHealth} from './upgrade-health.mjs';
const report={checkedAt:new Date().toISOString(),checks:[],desktopActivation:'This check does not certify the running GUI; see the separate desktop-activation record. A new installation requires normal restart.'};
const sha=b=>createHash('sha256').update(b).digest('hex');
try{
  const installed=JSON.parse(await fs.readFile(new URL('../installation-workspace.json',import.meta.url),'utf8'));
  for(const entry of installed.files){
    if(entry.sha256===null)await assert.rejects(fs.stat(entry.path),{code:'ENOENT'},'Retired file remains: '+entry.path);
    else assert.equal(sha(await fs.readFile(entry.path)),entry.sha256,'Installed file changed: '+entry.path);
  }
  report.checks.push({name:'Installed local files match the installation manifest',status:'PASS'});
  const config=validateConfig(installed.connection??getBridgeConfig());
  const names=Object.keys(installed.remote.hashes);
  const code='import json,hashlib,pathlib,shutil\nprint(json.dumps({"hashes":{f:hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest() if pathlib.Path(f).exists() else None for f in '+JSON.stringify(names)+'},"pdfRenderer":shutil.which("pdftoppm")}))\n';
  const hashes=JSON.parse((await runRouteCommand(config,'python3 -',code,{timeoutMs:30000})).toString('utf8'));
  assert.deepEqual(hashes.hashes,installed.remote.hashes);report.checks.push({name:'VPS files match the same installation manifest',status:'PASS'});
  report.pdfRenderer=hashes.pdfRenderer;report.checks.push({name:'Optional native PDF page renderer',status:hashes.pdfRenderer?'PASS':'UNAVAILABLE'});
  report.health=await remoteHealth(config,{timeoutMs:30000});
  const policy=JSON.parse(await fs.readFile(new URL('dependency-policy.json',import.meta.url),'utf8'));
  const manifest=JSON.parse(await fs.readFile(new URL('../plugin/manifest.json',import.meta.url),'utf8'));
  verifyUpgradeHealth(report.health,{policy,selection:installed.remote.adapter,manifest});
  for(const c of ['project-context','local-policy','local-hooks','media-cache','agent-context','job-recovery','native-fork','duplex-control','live-reverse-probe','duplex-tools','context-delta'])assert.ok(report.health.capabilities.includes(c),c);
  report.checks.push({name:'Remote official adapter loads and bridge protocol capabilities match',status:'PASS'});report.success=true;
}catch(error){report.success=false;report.error=error.stack;process.exitCode=1;}
await fs.writeFile(new URL('verification-upgrade.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
