import assert from 'node:assert/strict';
const key=version=>{assert.match(version??'',/^\d+\.\d+\.\d+$/,'Invalid dependency version');return version.split('.').map(Number);};
const atLeast=(version,minimum)=>{const a=key(version),b=key(minimum);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return true;};
// The selection is the version prepare-dependency.py validated (latest or the kept one).
export function verifyUpgradeHealth(health,{policy,selection,manifest}){
  assert.ok(atLeast(selection.version,policy.minimumVersion),'Selected dependency is below the supported minimum');
  assert.equal(health.dependencyVersion,selection.version,'Active dependency differs from the validated selection; normal restart may still be required');
  assert.equal(health.adapterSha256,selection.sha256,'Active adapter differs from the validated official package');
  assert.equal(health.bridgeVersion,manifest.version,'Active bridge differs from the installation');
  assert.equal(health.protocol,policy.bridgeProtocol,'Bridge protocol changed');
}
