import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TRIO_BASE_URL||'http://localhost:5173';
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
const result={drafts:{claude:'Draft'},reviews:{},answer:'Answer',errors:[],seconds:1,demo:false};
const fixtures=Array.from({length:30},(_,i)=>({id:String(i),title:`Saved ${i}`,time:'',turns:[{question:`Saved question ${i}`,mode:'fast',result}]}));
try{
  for(const account of [false,true]){
    const page=await browser.newPage({viewport:{width:1440,height:1050}});let snapshot,headers;const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const readSaved=async()=>account?(await(await page.request.get(base+'/api/workspace')).json()).sessions:page.evaluate(()=>JSON.parse(localStorage.getItem('trio-sessions')));
    const waitCloud=()=>account?page.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='PUT'):Promise.resolve(null);
    try{
      await page.goto(base+'/signin-with-chatgpt?return_to=%2Fdemo',{waitUntil:'networkidle'});
      if(account){snapshot=await(await page.request.get(base+'/api/workspace')).json();headers={Origin:base,'X-Trio-Account':snapshot.accountId,'X-Trio-Workspace-Version':'5'};assert.equal((await page.request.put(base+'/api/workspace',{headers,data:{revision:snapshot.revision,sessions:fixtures}})).status(),200);await page.goto(base+'/workspace',{waitUntil:'networkidle'});}
      else{await page.evaluate(sessions=>{localStorage.setItem('trio-remember','true');localStorage.setItem('trio-sessions',JSON.stringify(sessions));localStorage.setItem('trio-active-session','0');},fixtures);await page.reload({waitUntil:'networkidle'});}
      await page.getByText('Conversation limit reached',{exact:true}).waitFor();await page.getByRole('button',{name:/New session/}).click();assert.ok(await page.getByRole('button',{name:'Run demo',exact:true}).isDisabled());
      await page.getByRole('textbox',{name:'Your question',exact:true}).press('Control+Enter');assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).count(),0);assert.deepEqual(await readSaved(),fixtures);
      await page.getByRole('button',{name:'Connections',exact:true}).click();await page.getByPlaceholder('Paste your API key').nth(1).fill('fake-capacity-key');await page.getByRole('switch',{name:'Demo mode',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
      let calls=0;await page.route('**/api/ask',route=>{calls++;return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'final',result:{...result,answer:`Completed ${calls}`}})+'\n'});});
      await page.getByRole('textbox',{name:'Your question',exact:true}).fill('New conversation should wait');assert.ok(await page.getByRole('button',{name:'Ask Trio',exact:true}).isDisabled());await page.getByRole('textbox',{name:'Your question',exact:true}).press('Control+Enter');assert.equal(calls,0);assert.deepEqual(await readSaved(),fixtures);
      if(!account){await page.setViewportSize({width:390,height:844});await page.locator('.session-capacity').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/conversation-limit-mobile.png'});await page.setViewportSize({width:1440,height:1050});}
      await page.getByRole('group',{name:'Session: Saved 29',exact:true}).locator('.session-open').click();await page.getByRole('textbox',{name:'Your question',exact:true}).fill('Continue the oldest conversation');assert.equal(await page.getByRole('button',{name:'Ask Trio',exact:true}).isDisabled(),false);
      let save=waitCloud();await page.getByRole('button',{name:'Ask Trio',exact:true}).click();await page.getByText('Completed 1',{exact:true}).waitFor();if(account)assert.equal((await save).status(),200);else await page.waitForFunction(()=>JSON.parse(localStorage.getItem('trio-sessions')).find(s=>s.id==='29').turns.length===2);
      let saved=await readSaved();assert.equal(saved.length,30);assert.equal(saved.find(s=>s.id==='29').turns.length,2);for(const original of fixtures.filter(s=>s.id!=='29'))assert.deepEqual(saved.find(s=>s.id===original.id),original);
      await page.getByRole('button',{name:/New session/}).click();await page.getByRole('group',{name:'Session: Saved 1',exact:true}).getByRole('button',{name:'Session actions',exact:true}).click();await page.getByRole('menuitem',{name:'Delete session',exact:true}).click();save=waitCloud();await page.getByRole('button',{name:'Delete session',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});if(account)assert.equal((await save).status(),200);else await page.waitForFunction(()=>JSON.parse(localStorage.getItem('trio-sessions')).length===29);
      await page.getByRole('textbox',{name:'Your question',exact:true}).fill('New conversation after making room');save=waitCloud();await page.getByRole('button',{name:'Ask Trio',exact:true}).click();await page.getByText('Completed 2',{exact:true}).waitFor();if(account)assert.equal((await save).status(),200);else await page.waitForFunction(()=>JSON.parse(localStorage.getItem('trio-sessions')).length===30);
      saved=await readSaved();assert.equal(saved.length,30);assert.equal(calls,2);assert.equal(saved.some(s=>s.id==='1'),false);assert.equal(saved.find(s=>s.id==='29').turns.length,2);for(const original of fixtures.filter(s=>!['1','29'].includes(s.id)))assert.deepEqual(saved.find(s=>s.id===original.id),original);
      assert.deepEqual(errors,[]);
    }finally{if(snapshot){await page.goto(base+'/demo',{waitUntil:'networkidle'});const latest=await(await page.request.get(base+'/api/workspace')).json();assert.equal((await page.request.put(base+'/api/workspace',{headers,data:{revision:latest.revision,sessions:snapshot.sessions}})).status(),200);}await page.close();}
  }
  console.log('Conversation capacity passed for guest and signed-in D1 history: no demo/API start at 30, keyboard guard, existing follow-ups, explicit deletion frees space, no silent eviction, mobile notice.');
}finally{await browser.close();}
