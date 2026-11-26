import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, macBundleVersion, validateBuildNumber, validateBuildMetadata, updateDecision, type BuildMetadata } from '../src/shared/release-version.ts';
import { advanceVersion } from './version.ts';
import { reserveStable } from './release-identities.ts';
import { stableBuildGates } from './stable-build-gates.ts';

export const metadata = (extra: Partial<BuildMetadata> = {}): BuildMetadata => ({schemaVersion:1,productVersion:'1.0.2',buildNumber:4,macBundleVersion:'1.0.3',sourceRevision:'a'.repeat(40),sourceTreeSHA256:'b'.repeat(64),sourceDirty:false,channel:'stable',identifier:'app.forgeorbit',platform:'macos',arch:'arm64',builtAt:'2026-10-28T00:00:00.000Z',...extra});
const feed = (extra: Partial<BuildMetadata> = {}, hash = 'sdk-next') => ({version: extra.productVersion ?? '1.0.3',hash,forgeorbit:{...metadata({productVersion:'1.0.3',buildNumber:5,macBundleVersion:'1.0.4',...extra}),artifactManifestSHA256:'c'.repeat(64)}});

test('canonical release SemVer orders numerically and rejects ambiguous short versions',()=>{
 expect(compareVersions('1.10.0','1.9.99')).toBe(1);expect(compareVersions('2.0.0','1.9999.9999')).toBe(1);
 for(const bad of ['01.0.0','1.0','1.0.2-beta.1','1.0.2+foo','10000.0.0','-1.0.0'])expect(()=>compareVersions(bad,'1.0.0')).toThrow();
});
test('global counter maps monotonically across Apple 4.2.2 boundaries',()=>{
 const counters=[1,2,100,101,10000,10001,99_990_000];
 expect(counters.map(macBundleVersion)).toEqual(['1.0.0','1.0.1','1.0.99','1.1.0','1.99.99','2.0.0','9999.99.99']);
 for(let i=1;i<counters.length;i++)expect(compareVersions(macBundleVersion(counters[i]!),macBundleVersion(counters[i-1]!))).toBe(1);
 for(const bad of [0,-1,1.5,NaN,Infinity,99_990_001,'4'])expect(()=>validateBuildNumber(bad)).toThrow();
});
test('local version allocation changes one source, increasing product and global build without Git/network',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fo-version-'));writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:'1.0.2',forgeorbitBuildNumber:4}));
 expect(advanceVersion(dir,'minor')).toEqual({version:'1.1.0',buildNumber:5});
 expect(advanceVersion(dir,'build')).toEqual({version:'1.1.0',buildNumber:6});
 expect(()=>advanceVersion(dir,'1.0.9')).toThrow();expect(()=>advanceVersion(dir,'1.1.0')).toThrow();
 expect(existsSync(path.join(dir,'electrobun.config.ts'))).toBe(false);
 expect(JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).forgeorbitBuildNumber).toBe(6);
});
test('stable reservations refuse reuse, different bytes/source at the same version, lower version/build and concurrent owners',()=>{
 const dir=path.join(mkdtempSync(path.join(tmpdir(),'fo-identities-')),'identities');
 reserveStable(dir,metadata());
 expect(()=>reserveStable(dir,metadata({sourceRevision:'d'.repeat(40)}))).toThrow('already reserved');
 expect(()=>reserveStable(dir,metadata({productVersion:'1.0.1',buildNumber:5,macBundleVersion:'1.0.4'}))).toThrow('version must increase');
 expect(()=>reserveStable(dir,metadata({productVersion:'1.0.3'}))).toThrow('Build number');
 reserveStable(dir,metadata({productVersion:'1.0.3',buildNumber:5,macBundleVersion:'1.0.4'}));
 mkdirSync(dir+'.lock');expect(()=>reserveStable(dir,metadata({productVersion:'1.0.4',buildNumber:6,macBundleVersion:'1.0.5'}))).toThrow();
});
test('stable preflight refuses dirty/QA/disabled signing/missing credentials without invoking SDK or Apple',()=>{
 const mac={codesign:true,notarize:true};const inert={ELECTROBUN_DEVELOPER_ID:'inert',ELECTROBUN_APPLEAPIKEY:'inert',ELECTROBUN_APPLEAPIISSUER:'inert',ELECTROBUN_APPLEAPIKEYPATH:'/nonexistent/inert'};
 expect(()=>stableBuildGates(metadata(),mac,{})).toThrow('credentials');
 expect(()=>stableBuildGates(metadata(),{codesign:false,notarize:true},inert)).toThrow('signing');
 expect(()=>stableBuildGates(metadata(),mac,{...inert,FORGEORBIT_NATIVE_QA_ROOT:'/tmp/inert'})).toThrow();
 expect(()=>stableBuildGates(metadata({sourceDirty:true}),mac,inert)).toThrow();
 expect(()=>stableBuildGates(metadata({identifier:'app.forgeorbit.qa'}),mac,inert)).toThrow();
 expect(()=>validateBuildMetadata(metadata({macBundleVersion:'4'}))).toThrow();
});
test('upgrade decision rejects downgrade, same-version recuts, nonincreasing builds, missing provenance and channel/identity mixing',()=>{
 const local=metadata();expect(updateDecision(local,'sdk-old',feed())).toBe('upgrade');
 expect(updateDecision(local,'sdk-old',feed({productVersion:'1.0.2',buildNumber:4,macBundleVersion:'1.0.3'},'sdk-old'))).toBe('same');
 for(const candidate of [feed({productVersion:'1.0.1'}),feed({buildNumber:3,macBundleVersion:'1.0.2'}),feed({productVersion:'1.0.2'}),feed({buildNumber:4,macBundleVersion:'1.0.3'}),feed({channel:'dev',identifier:'app.forgeorbit.qa'}),{version:'1.0.3',hash:'legacy-no-metadata'}])expect(()=>updateDecision(local,'sdk-old',candidate)).toThrow();
 expect(updateDecision(metadata({builtAt:'2099-01-01T00:00:00.000Z'}),'sdk-old',feed({builtAt:'2000-01-01T00:00:00.000Z'}))).toBe('upgrade');
});
