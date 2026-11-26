import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './release-metadata.ts';
export function assertUpdaterContract(project: string) {
 const sdk=path.join(project,'node_modules/electrobun');
 if(JSON.parse(readFileSync(path.join(sdk,'package.json'),'utf8')).version!=='1.18.1')throw new Error('Re-audit Electrobun updater contract before SDK upgrade');
 const pins={'dist/api/bun/core/Updater.ts':'fd99561820abbf09a5f7d8809cabfd7f3f2863aca6d1e0a5505c571e9f1107cb','src/cli/index.ts':'fb8a29a278eaa6af0340dc171fe6c326adbb3f49be0ca14bb6974c229790f32c'};
 for(const [file,hash] of Object.entries(pins))if(sha256(readFileSync(path.join(sdk,file)))!==hash)throw new Error('Unreviewed Electrobun updater/build contract');
 if(process.platform==='darwin' && process.arch==='arm64' && sha256(readFileSync(path.join(sdk,'bin/electrobun')))!=='e4bc0d606ff148862a9cc14cac494991ce4043d5f2aee137d97f726a4f7ee177')throw new Error('Unreviewed embedded Electrobun CLI');
 console.log('[FO-VERSION01] Updater contract verified');
}
