import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { providers } from '../lib/trio.ts';

const text=z.string().max(120000);
const reportSchema=z.object({version:z.literal(2),mode:z.enum(['fast','council','deep']),baseline:z.enum(['openai','claude','gemini']),models:z.record(z.string().max(100)),results:z.array(z.object({id:z.string().max(100),question:z.string().max(22000),context:z.string().max(60000).optional(),expected:z.union([z.string().max(2000),z.number().finite()]),answers:z.object({baseline:z.object({openai:text.optional(),claude:text.optional(),gemini:text.optional()}),team:text.optional()}).optional()})).max(500)});
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Separate answer identities and ground truth from the sheet given to a reviewer. */
export function blindReview(value:unknown) {
 const report=reportSchema.parse(value);
 const terms=[...Object.values(report.models),'ChatGPT','OpenAI','Anthropic','Claude','Gemini','Google'].filter(Boolean).sort((a,b)=>b.length-a.length);
 const names=new RegExp(terms.map(escape).join('|'),'gi');
 const rows=report.results.flatMap(row=>{
  const answers=[...providers.flatMap(p=>row.answers?.baseline[p.id]?[{arm:p.id,text:row.answers.baseline[p.id]!}]:[]),...(row.answers?.team?[{arm:'team',text:row.answers.team}]:[])];
  if(answers.length<2)return [];
  for(let i=answers.length-1;i>0;i--){const j=randomInt(i+1);[answers[i],answers[j]]=[answers[j],answers[i]];}
  return [{row,answers:answers.map((a,i)=>({...a,label:String.fromCharCode(65+i)}))}];
 });
 if(!rows.length)throw new Error('A V2 report with --include-answers and at least two answers per case is required.');
 return {
  review:{format:'trio-blind-review',version:1,limitations:'Provider names and configured model IDs are replaced in answer text, but style/content may still reveal identity. Missing answers are omitted; this sheet alone cannot measure failure rates. These exact-JSON tasks measure correctness, not open-ended usefulness. Keep the separate key away from the reviewer until ratings are complete.',cases:rows.map(({row,answers})=>({id:row.id,question:row.question,...(row.context?{context:row.context}:{}),answers:answers.map(a=>({label:a.label,text:a.text.replace(names,'[provider]')})),preferred:null,notes:''}))},
  key:{format:'trio-blind-review-key',version:1,mode:report.mode,baseline:report.baseline,models:report.models,cases:rows.map(({row,answers})=>({id:row.id,expected:row.expected,arms:Object.fromEntries(answers.map(a=>[a.label,a.arm]))}))},
 };
}
