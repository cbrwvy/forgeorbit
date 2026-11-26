import { expect, test } from 'bun:test';
import { installUpdateGuard, updatesEnabled } from './update-policy.ts';
import type { BuildMetadata } from '../shared/release-version.ts';
const local:BuildMetadata={schemaVersion:1,productVersion:'1.0.2',buildNumber:4,macBundleVersion:'1.0.3',sourceRevision:'a'.repeat(40),sourceTreeSHA256:'b'.repeat(64),sourceDirty:false,channel:'stable',identifier:'app.forgeorbit',platform:'macos',arch:'arm64',builtAt:'2026-10-28T00:00:00.000Z'};
const candidate=(version='1.0.3',buildNumber=5)=>({version,hash:'sdk-'+version,forgeorbit:{...local,productVersion:version,buildNumber,macBundleVersion:`1.0.${buildNumber-1}`,artifactManifestSHA256:'c'.repeat(64)}});
test('updates remain disabled by default and offline switches override explicit opt-in',()=>{
 expect(updatesEnabled({})).toBe(false);expect(updatesEnabled({FORGEORBIT_ENABLE_UPDATES:'1'})).toBe(true);
 expect(updatesEnabled({FORGEORBIT_ENABLE_UPDATES:'1',AGETOR_DISABLE_UPDATES:'1'})).toBe(false);
});
test('guard also covers SDK-internal download/apply feed rechecks and pins one artifact per operation',async()=>{
 let response:any=candidate();let replaced=false;
 const sdk={getLocalInfo:async()=>({version:local.productVersion,channel:'stable',identifier:local.identifier,hash:'sdk-old'}),checkForUpdate:async():Promise<any>=>response,
  downloadUpdate:async()=>{await sdk.checkForUpdate();},applyUpdate:async()=>{await sdk.checkForUpdate();replaced=true;}};
 const guard=installUpdateGuard(sdk,()=>local);expect((await sdk.checkForUpdate()).updateAvailable).toBe(true);
 response={error:'synthetic offline failure',hash:''};await expect(sdk.downloadUpdate()).rejects.toThrow('recheck failed');
 response=candidate('1.0.1',3);await expect(sdk.downloadUpdate()).rejects.toThrow('downgrade');await expect(sdk.applyUpdate()).rejects.toThrow();expect(replaced).toBe(false);
 response=candidate('1.0.4',6);await expect(sdk.downloadUpdate()).rejects.toThrow('feed changed');guard.beginCheck();await sdk.downloadUpdate();
 expect(installUpdateGuard(sdk,()=>local)).toBe(guard);
});
test('dev channel never invokes the underlying feed check even after opt-in',async()=>{
 let checked=false;const dev={...local,channel:'dev' as const,sourceDirty:true};
 const sdk={getLocalInfo:async()=>({version:dev.productVersion,channel:'dev',identifier:dev.identifier,hash:'dev'}),checkForUpdate:async():Promise<any>=>{checked=true;throw Error('unexpected feed');}};
 installUpdateGuard(sdk,()=>dev);expect((await sdk.checkForUpdate()).updateAvailable).toBe(false);expect(checked).toBe(false);
});
