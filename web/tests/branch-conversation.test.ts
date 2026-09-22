import test from 'node:test';
import assert from 'node:assert/strict';
import { branchConversation } from '../lib/branch-conversation.ts';
import { conversationHistory, serializeSessions, parseSessions, type Session } from '../lib/sessions.ts';
const source:Session={id:'source',title:'Original',instructions:'Newest instruction',time:'',turns:[{question:'First question',instructions:'Earlier instruction',mode:'council',result:{drafts:{openai:'Draft'},reviews:{},answer:'First answer',errors:[],seconds:1,demo:false,memory:'Earlier approved memory'}},{question:'Second question',mode:'compare',result:{drafts:{claude:'Second draft'},reviews:{},answer:'',errors:[],seconds:1,demo:false}}]};

test('a branch copies only the chosen completed prefix and uses that answer’s instruction snapshot',()=>{
  const before=structuredClone(source);const {session,sessions}=branchConversation([source],'source',0,' Alternative ','branch','2026-09-22T00:00:00Z');
  assert.equal(session.id,'branch');assert.equal(session.title,'Alternative');assert.equal(session.instructions,'Earlier instruction');assert.equal(session.turns.length,1);assert.equal(session.turns[0].result.memory,'Earlier approved memory');assert.deepEqual(source,before);assert.equal(sessions.length,2);assert.equal(sessions[1],source);
  session.turns[0].result.answer='Edited copy';assert.equal(source.turns[0].result.answer,'First answer');
  assert.deepEqual(parseSessions(serializeSessions(sessions)),sessions);
});

test('explicitly cleared instructions and Compare perspectives survive branching without later context',()=>{
  const {session}=branchConversation([source],'source',1,'Comparison branch','branch');assert.equal(session.instructions,'');assert.equal(session.turns.at(-1)!.mode,'compare');assert.match(conversationHistory(session.turns).at(-1)!.content,/Claude:\nSecond draft/);
  const first=branchConversation([source],'source',0,'Earlier','earlier').session;assert.ok(!JSON.stringify(conversationHistory(first.turns)).includes('Second'));assert.ok(!JSON.stringify(conversationHistory(first.turns)).includes('Earlier approved memory'));
});

test('invalid selections and full workspaces never mutate, evict, or silently replace conversations',()=>{
  const before=JSON.stringify(source);
  for(const index of [-1,2,0.5,NaN])assert.throws(()=>branchConversation([source],'source',index,'Branch','branch'),/Choose an answer/);
  assert.throws(()=>branchConversation([source],'missing',0,'Branch','branch'),/Choose an answer/);assert.throws(()=>branchConversation([source],'source',0,' ','branch'),/conversation name/);assert.throws(()=>branchConversation([source],'source',0,'x'.repeat(121),'branch'),/conversation name/);assert.throws(()=>branchConversation([source],'source',0,'Branch','source'),/separate conversation/);
  const full=Array.from({length:30},(_,i)=>({...source,id:String(i)}));assert.throws(()=>branchConversation(full,'0',0,'Branch','branch'),/30 conversations/);assert.equal(full.length,30);assert.equal(JSON.stringify(source),before);
});

test('branches cannot exceed the shared storage budget or copy unrecognized credential fields',()=>{
  const large=structuredClone(source);large.turns=Array.from({length:22},()=>({...source.turns[0],result:{...source.turns[0].result,answer:'x'.repeat(120000)}}));assert.throws(()=>branchConversation([large],'source',21,'Large copy','branch'),/storage limit/);assert.equal(large.turns.length,22);
  const unsafe={...source,key:'secret',turns:[{...source.turns[0],key:'secret',result:{...source.turns[0].result,key:'secret'}}]};assert.ok(!JSON.stringify(branchConversation([unsafe],'source',0,'Safe copy','branch').session).includes('secret'));
});
