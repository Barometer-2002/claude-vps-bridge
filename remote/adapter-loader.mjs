// Version selection belongs to the bridge, independently of global Host updates.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function loadClaudeAdapter(){
  const config=JSON.parse(await fs.readFile(path.join(here,'adapter-selection.json'),'utf8'));
  if(config.schemaVersion!==1||!path.isAbsolute(config.modulePath))throw new Error('Invalid managed Claude adapter selection');
  const platformRoot=path.resolve(config.modulePath,'../../../..');
  for(const name of ['cli','cli-linux-x64']){
    const pkg=JSON.parse(await fs.readFile(path.join(platformRoot,'..',name,'package.json'),'utf8'));
    if(pkg.name!=='@codexhost/'+name||pkg.version!==config.version)throw new Error('Managed Claude dependency version mismatch');
  }
  const bytes=await fs.readFile(config.modulePath);
  const sha=createHash('sha256').update(bytes).digest('hex');
  if(sha!==config.sha256)throw new Error('Managed Claude adapter changed; validate the candidate before selecting it');
  const module=await import(pathToFileURL(config.modulePath));
  if(typeof module.createHarnessAdapter!=='function')throw new Error('Claude adapter factory missing');
  return {createHarnessAdapter:module.createHarnessAdapter,modulePath:config.modulePath,dependencyVersion:config.version,adapterSha256:sha};
}
