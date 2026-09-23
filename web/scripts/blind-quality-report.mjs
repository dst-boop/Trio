import { readFile, stat, mkdir, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { blindReview } from '../evaluation/blind.ts';

// Entirely offline: never imports provider adapters or makes API requests.
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help')console.log('Usage: node scripts/blind-quality-report.mjs INPUT_REPORT OUTPUT_REVIEW\nRequires a V2 evaluation report made with --include-answers. Writes a new review file and OUTPUT_REVIEW.key.json. Keep the key private until review is complete. No API calls.');
else {
 const handles=[];
 try {
  if(args.length!==2)throw new Error();
  const input=resolve(args[0]),output=resolve(args[1]),key=output+'.key.json';
  if((await stat(input)).size>20_000_000)throw new Error();
  const raw=await readFile(input,'utf8');if(Buffer.byteLength(raw)>20_000_000)throw new Error();
  const result=blindReview(JSON.parse(raw));await mkdir(dirname(output),{recursive:true});
  // Reserve both new files before writing either; never overwrite reports or keys.
  handles.push(await open(output,'wx'));handles.push(await open(key,'wx'));
  await handles[0].writeFile(JSON.stringify(result.review,null,2)+'\n');
  await handles[1].writeFile(JSON.stringify(result.key,null,2)+'\n');
  console.log(JSON.stringify({review:output,key,cases:result.review.cases.length}));
 }catch{console.error('Could not export. Use --help and a V2 report under 20 MB with --include-answers; both output paths must be new. A failed export can leave reserved empty files. No API calls were made.');process.exitCode=2;}
 finally{for(const handle of handles)await handle.close();}
}
