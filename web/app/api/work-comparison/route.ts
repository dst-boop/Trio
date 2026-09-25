import { env, waitUntil } from 'cloudflare:workers';
import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { JsonBodyError, readJsonBody } from '@/lib/request-json';
import { readSavedConnections } from '@/lib/credential-store';
import { comparisonTask, comparisonSettings, comparisonRatings } from '@/lib/work-comparison';
import { ComparisonError, listComparisons, startComparison, stepComparison, cancelComparison, comparisonReport, rateComparison, deleteComparison } from '@/lib/work-comparison-store';

const id=z.string().uuid();
const action=z.discriminatedUnion('action',[
  z.object({action:z.literal('start'),id,task:comparisonTask,settings:comparisonSettings,live:z.literal(true)}).strict(),
  z.object({action:z.literal('step'),id,step:z.number().int().min(0).max(1)}).strict(),
  z.object({action:z.literal('cancel'),id}).strict(),
  z.object({action:z.literal('rate'),id,ratings:comparisonRatings}).strict(),
  z.object({action:z.literal('delete'),id}).strict(),
]);
async function handle(request:Request) {
  const user=await getChatGPTUser();
  if(!user||request.headers.get('x-trio-account')!==user.userId)return reply({error:'Sign in again to open your private comparisons.'},401);
  if(request.method!=='GET'&&request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Invalid request origin.'},403);
  try {
    if(!env.DB)throw new Error();
    if(request.method==='GET') {
      const params=new URL(request.url).searchParams;
      if(params.has('id'))return reply(await comparisonReport(env.DB,user.userId,id.parse(params.get('id'))));
      return reply({runs:await listComparisons(env.DB,user.userId),connections:(await readSavedConnections(env.DB,user.userId)).connections});
    }
    const input=action.parse(await readJsonBody(request,96_000));
    if(input.action==='step') {
      const pending=stepComparison(env.DB,env.TRIO_CREDENTIAL_KEY,request,user.userId,input.id,input.step);
      waitUntil(pending.then(()=>{},()=>{}));
      return reply({run:await pending});
    }
    if(input.action==='rate')return reply(await rateComparison(env.DB,env.TRIO_CREDENTIAL_KEY,request,user.userId,input.id,input.ratings));
    if(input.action==='delete'){await deleteComparison(env.DB,user.userId,input.id);return reply({deleted:true});}
    return reply({run:input.action==='start'?await startComparison(env.DB,env.TRIO_CREDENTIAL_KEY,request,user.userId,input.id,input.task,input.settings):await cancelComparison(env.DB,user.userId,input.id)});
  } catch(error) {
    if(error instanceof z.ZodError)return reply({error:'Check the task, ratings, selected saved providers and limits.'},400);
    if(error instanceof JsonBodyError)return reply({error:error.message},error.status);
    return reply({error:error instanceof ComparisonError?error.message:'Comparison unavailable. Reload saved progress before trying again.'},error instanceof ComparisonError?error.status:503);
  }
}
export const GET=handle;
export const POST=handle;
