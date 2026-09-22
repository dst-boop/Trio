import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunStream, maxRunEventCharacters } from '../lib/read-run-stream.ts';
import type { Result, RunEvent } from '../lib/trio.ts';
const encoder = new TextEncoder();
const result: Result = { drafts:{openai:'Draft'},reviews:{},answer:'Finished 🌍',by:'openai',errors:[],seconds:1,demo:false };
const final = JSON.stringify({type:'final',result});
const signal=()=>new AbortController().signal;

test('the first valid final completes without EOF or a cleanup handshake and ignores trailing events', {timeout:1000}, async()=>{
  let cancelled=false;const events:RunEvent[]=[];
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(encoder.encode(final+'\n{"type":"error","text":"late error"}\nnot JSON'));},cancel(){cancelled=true;return new Promise(()=>{});}});
  assert.deepEqual(await readRunStream(body,signal(),e=>events.push(e)),result);assert.equal(events.length,1);assert.equal(events[0].type,'final');assert.ok(cancelled);assert.equal(body.locked,false);
});

test('split UTF-8 and an EOF-terminated final are accepted, and unknown events are ignored', async()=>{
  const bytes=encoder.encode('{"type":"future_event","extra":"data"}\n'+final);let offset=0;const events:RunEvent[]=[];
  const body=new ReadableStream<Uint8Array>({pull(c){if(offset===bytes.length)c.close();else c.enqueue(bytes.slice(offset,++offset));}});
  assert.deepEqual(await readRunStream(body,signal(),e=>events.push(e)),result);assert.equal(events.length,1);assert.equal(body.locked,false);
});

test('invalid finals, event shapes, UTF-8 and oversized frames are rejected with safe diagnostics', async()=>{
  for(const bad of ['private diagnostic','{"type":"final","result":{"answer":"private diagnostic"}}','{"type":"draft","provider":"other","text":"private diagnostic"}','{"type":"contribution_delta","phase":"unknown","provider":"openai","text":"private diagnostic"}','x'.repeat(maxRunEventCharacters+1),new Uint8Array([255])]){
    let cancelled=false;const events:RunEvent[]=[];const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(typeof bad==='string'?encoder.encode(bad+'\n'):bad);},cancel(){cancelled=true;}});
    await assert.rejects(readRunStream(body,signal(),e=>events.push(e)),{message:'Connection interrupted. Try again.'});assert.ok(cancelled);assert.equal(body.locked,false);assert.equal(events.length,0);
  }
});

test('EOF without final and Stop preserve only display events and never report completion', {timeout:1000}, async()=>{
  const partial={type:'contribution_delta',provider:'openai',phase:'draft',text:'Partial'};const events:RunEvent[]=[];
  await assert.rejects(readRunStream(new Response(JSON.stringify(partial)+'\n').body,signal(),e=>events.push(e)),/interrupted/);assert.equal(events.length,1);assert.equal(events[0].type,'contribution_delta');
  const controller=new AbortController();let cancelled=false;const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise(()=>{});}});
  const pending=readRunStream(body,controller.signal,()=>assert.fail('No event'));setTimeout(()=>controller.abort(),5);await assert.rejects(pending,/abort/i);assert.ok(cancelled);assert.equal(body.locked,false);
});

test('validated final results strip unexpected credential fields before reaching persistence', async()=>{
  const untrusted={...result,key:'secret-key',drafts:{...result.drafts,key:'nested-key'}};const events:RunEvent[]=[];
  const saved=await readRunStream(new Response(JSON.stringify({type:'final',result:untrusted,key:'event-key'})+'\n').body,signal(),e=>events.push(e));assert.deepEqual(saved,result);assert.ok(!JSON.stringify(events).includes('key'));
});
