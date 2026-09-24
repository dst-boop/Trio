import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { readSavedConnections } from '@/lib/credential-store';
import { qualitySettings } from '@/evaluation/hosted-config';
import { QualityError, startQualityRun, listQualityRuns, stepQualityRun, cancelQualityRun, qualityReport, qualityBlindExport } from '@/lib/quality-store';

const id=z.string().uuid();
const action=z.discriminatedUnion('action',[
  z.object({action:z.literal('start'),id,settings:qualitySettings,live:z.literal(true)}).strict(),
  z.object({action:z.literal('step'),id,step:z.number().int().min(0).max(100)}).strict(),
  z.object({action:z.literal('cancel'),id}).strict(),
]);
async function handle(request:Request) {
  const user=await getChatGPTUser();
  if(!user||request.headers.get('x-trio-account')!==user.userId)return reply({error:'Sign in again to open your private quality checks.'},401);
  if(request.method!=='GET'&&request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Invalid request origin.'},403);
  try {
    if(!env.DB)throw new Error();
    if(request.method==='GET') {
      const params=new URL(request.url).searchParams;
      if(!params.has('id'))return reply({runs:await listQualityRuns(env.DB,user.userId),connections:(await readSavedConnections(env.DB,user.userId)).connections});
      const runId=id.parse(params.get('id')),part=params.get('export');
      if(part&& !['report','sheet','key'].includes(part))return reply({error:'Unknown export.'},400);
      if(part==='sheet'||part==='key')return reply(await qualityBlindExport(env.DB,user.userId,runId,part));
      return reply(await qualityReport(env.DB,user.userId,runId));
    }
    const input=action.parse(await readSmallJson(request));
    const run=input.action==='start'?await startQualityRun(env.DB,env.TRIO_CREDENTIAL_KEY,request,user.userId,input.id,input.settings):input.action==='step'?await stepQualityRun(env.DB,env.TRIO_CREDENTIAL_KEY,request,user.userId,input.id,input.step):await cancelQualityRun(env.DB,user.userId,input.id);
    return reply({run});
  } catch(error) {
    if(error instanceof z.ZodError)return reply({error:'Choose a valid suite, baseline, at least two saved providers, and limits.'},400);
    return reply({error:error instanceof QualityError?error.message:'Quality check unavailable. Reload to recover saved progress before trying again.'},error instanceof QualityError?error.status:503);
  }
}
export const GET=handle;
export const POST=handle;
