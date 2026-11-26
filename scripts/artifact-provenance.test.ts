import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { patchBundleInfoPlist } from './macos-bundle-metadata.ts';
import { json, sha256, verifyProvenance, verifyShipping, writeProvenance } from './release-metadata.ts';
import { resolveDataDir } from '../src/bun/data-dir.ts';
import { macBundleVersion, updateDecision, type BuildMetadata } from '../src/shared/release-version.ts';

function fixture(root:string, version:string, buildNumber:number) {
 const app=path.join(root,'ForgeOrbit.app'),resources=path.join(app,'Contents/Resources');mkdirSync(resources,{recursive:true});
 const metadata:BuildMetadata={schemaVersion:1,productVersion:version,buildNumber,macBundleVersion:macBundleVersion(buildNumber),sourceRevision:String(buildNumber).repeat(40).slice(0,40),sourceTreeSHA256:'b'.repeat(64),sourceDirty:false,channel:'stable',identifier:'app.forgeorbit',platform:'macos',arch:'arm64',builtAt:'2026-10-28T00:00:00.000Z'};
 writeFileSync(path.join(app,'Contents/Info.plist'),patchBundleInfoPlist('<plist><dict><key>CFBundleIdentifier</key>\n    <string>app.forgeorbit</string></dict></plist>',version,buildNumber));
 writeFileSync(path.join(resources,'forgeorbit-build.json'),json(metadata));writeFileSync(path.join(resources,'version.json'),json({version,hash:'sdk-'+buildNumber,identifier:metadata.identifier,channel:'stable'}));
 writeFileSync(path.join(resources,'inert-payload.txt'),'Synthetic unsigned metadata fixture '+version);
 return {app,metadata,receipt:writeProvenance(app,root,metadata)};
}
test('detached final inventory binds embedded source, plist, SDK hash, modes and payload; tampering is refused',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'fo-provenance-')),f=fixture(root,'1.0.3',4);
 expect(verifyProvenance(f.app,root).artifactManifestSHA256).toBe(f.receipt.artifactManifestSHA256);
 const payload=path.join(f.app,'Contents/Resources/inert-payload.txt'),original=readFileSync(payload);writeFileSync(payload,'changed');expect(()=>verifyProvenance(f.app,root)).toThrow('inventory');writeFileSync(payload,original);
 const mode=0o600;chmodSync(payload,mode);expect(()=>verifyProvenance(f.app,root)).toThrow('inventory');
});
test('offline replacement of two unsigned metadata fixtures preserves actual synthetic SQLite data and default root',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'fo-version-upgrade-'));const a=fixture(path.join(root,'old'),'1.0.2',3),b=fixture(path.join(root,'next'),'1.0.3',4);
 expect(updateDecision(a.metadata,'sdk-3',{version:'1.0.3',hash:'sdk-4',forgeorbit:{...b.metadata,artifactManifestSHA256:b.receipt.artifactManifestSHA256}})).toBe('upgrade');
 expect(()=>updateDecision(b.metadata,'sdk-4',{version:'1.0.2',hash:'sdk-3',forgeorbit:{...a.metadata,artifactManifestSHA256:a.receipt.artifactManifestSHA256}})).toThrow('downgrade');
 const home=path.join(root,'Home With Spaces'),data=resolveDataDir({platform:'darwin',home,env:{}});mkdirSync(data,{recursive:true,mode:0o700});
 const file=path.join(data,'agetor.sqlite');const db=new Database(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE synthetic_records(kind TEXT,id TEXT PRIMARY KEY, payload TEXT);');
 for(const kind of ['Task','Run','Turn','Journal'])db.run('INSERT INTO synthetic_records VALUES(?,?,?)',[kind,kind+'-durable-id','synthetic '+kind]);
 const before=db.query('SELECT * FROM synthetic_records ORDER BY id').all();db.close();
 const installed=path.join(root,'Installed.app');cpSync(a.app,installed,{recursive:true});renameSync(installed,path.join(root,'Old-retained.app'));cpSync(b.app,installed,{recursive:true});
 expect(verifyProvenance(installed,path.dirname(b.app)).metadata.productVersion).toBe('1.0.3');
 const reopened=new Database(file);expect(reopened.query('SELECT * FROM synthetic_records ORDER BY id').all()).toEqual(before);expect(reopened.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});reopened.close();
 expect(resolveDataDir({platform:'darwin',home,env:{}})).toBe(data);
});
test('shipping receipt binds final archives and feed to the runtime manifest',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'fo-shipping-')),f=fixture(path.join(root,'receipt'),'1.0.3',4),out=path.join(root,'artifacts');mkdirSync(out);
 const names=['ForgeOrbit-arm64.dmg','stable-macos-arm64-ForgeOrbit.app.tar.zst'];
 for(const name of names)writeFileSync(path.join(out,name),'inert archive fixture '+name);
 writeFileSync(path.join(out,'forgeorbit-artifact-manifest.json'),readFileSync(path.join(root,'receipt/forgeorbit-artifact-manifest.json')));
 writeFileSync(path.join(out,'forgeorbit-provenance.json'),json({...f.receipt,shipped:names.map(name=>({name,sha256:sha256(readFileSync(path.join(out,name)))}))}));
 const feedPath=path.join(out,'stable-macos-arm64-update.json'),feed={version:'1.0.3',hash:'sdk-4',platform:'macos',arch:'arm64',forgeorbit:{...f.metadata,artifactManifestSHA256:f.receipt.artifactManifestSHA256}};
 writeFileSync(feedPath,json(feed));expect(verifyShipping(out,path.join(root,'receipt')).metadata).toEqual(f.metadata);
 writeFileSync(feedPath,json({...feed,hash:'other'}));expect(()=>verifyShipping(out,path.join(root,'receipt'))).toThrow('feed');writeFileSync(feedPath,json(feed));
 writeFileSync(path.join(out,names[0]!), 'modified DMG');expect(()=>verifyShipping(out,path.join(root,'receipt'))).toThrow('bytes/hash');
});
