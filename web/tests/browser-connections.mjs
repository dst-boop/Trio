import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  const url=base+'/api/connections/check';
  let response=await context.request.post(url,{data:{},headers:{Origin:base}});assert.equal(response.status(),401);assert.equal((await response.json()).status,'signin');
  await page.goto(base+'/signin-with-chatgpt?return_to=%2Fdemo',{waitUntil:'networkidle'});
  response=await context.request.post(url,{data:{},headers:{Origin:'https://other.test'}});assert.equal(response.status(),403);
  for(const data of [{provider:'openai',key:'test',model:'../messages'}, {provider:'openai',key:'test',model:'gpt-6-astra',otherKey:'private'}, {huge:'x'.repeat(32001)}]) {
    response=await context.request.post(url,{data,headers:{Origin:base}});assert.equal(response.status(),400);assert.equal((await response.json()).status,'invalid');assert.match(response.headers()['cache-control'],/no-store/);
  }
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  const rows=page.locator('.connection-row'),first=rows.nth(0),second=rows.nth(1);
  assert.ok(await first.getByRole('button',{name:'Check access',exact:true}).isDisabled());
  await first.getByLabel('API key',{exact:true}).fill('openai-private-test');
  await second.getByLabel('API key',{exact:true}).fill('claude-private-test');
  let status='checked',deferred=false,release;const requests=[];
  await page.route('**/api/connections/check',async route=>{
    requests.push(route.request().postDataJSON());
    if(deferred)await new Promise(resolve=>{release=resolve;});
    await route.fulfill({status:status==='checked'?200:502,json:{status,privateDiagnostic:'NEVER render this diagnostic'}}).catch(()=>{});
  });
  await first.getByRole('button',{name:'Check access',exact:true}).click();
  await first.getByText('Access checked',{exact:true}).waitFor();
  assert.deepEqual(requests[0],{provider:'openai',key:'openai-private-test',model:'gpt-6-astra'});
  await first.getByLabel('Model ID',{exact:true}).fill('another-model');
  assert.equal(await first.getByText('Access checked',{exact:true}).count(),0);
  status='credentials';await first.getByRole('button',{name:'Check access',exact:true}).click();await first.getByRole('status').filter({hasText:'provider rejected access'}).waitFor();
  assert.equal(await page.getByText('NEVER render this diagnostic',{exact:false}).count(),0);
  status='checked';deferred=true;await first.getByRole('button',{name:'Check access',exact:true}).click();
  await first.getByText('Checking access…',{exact:true}).waitFor();await page.waitForFunction(()=>true);while(!release)await new Promise(r=>setTimeout(r,10));
  await first.getByLabel('API key',{exact:true}).fill('replacement-private-test');release();release=undefined;
  await first.getByText('Key added · check access',{exact:true}).waitFor();
  await first.getByRole('button',{name:'Check access',exact:true}).click();while(!release)await new Promise(r=>setTimeout(r,10));
  await first.getByRole('button',{name:'Cancel',exact:true}).click();release();release=undefined;
  await first.getByRole('status').filter({hasText:'cancelled'}).waitFor();
  await first.getByRole('button',{name:'Check access',exact:true}).click();while(!release)await new Promise(r=>setTimeout(r,10));
  await page.getByRole('button',{name:'Done',exact:true}).click();release();release=undefined;
  await page.getByRole('button',{name:'Connections',exact:true}).click();assert.equal(await first.getByText('Access checked',{exact:true}).count(),0);
  await first.getByRole('button',{name:'Check access',exact:true}).click();while(!release)await new Promise(r=>setTimeout(r,10));
  await page.getByRole('button',{name:'Clear keys from this tab',exact:true}).click();release();release=undefined;
  await first.getByText('No key added',{exact:true}).waitFor();assert.equal(await first.getByLabel('API key',{exact:true}).inputValue(),'');assert.equal(await second.getByLabel('API key',{exact:true}).inputValue(),'');
  assert.ok(!(await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage}))).includes('private-test'));
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const el=document.querySelector('[role=dialog]');if(!el)return false;const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;},null,{timeout:3000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.locator('[role=dialog]').evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await page.locator('[role=dialog]').evaluate(el=>el.scrollTop=0);
  const box=await page.locator('[role=dialog]').boundingBox();assert.ok(box.y>=0 && box.y+box.height<=844,'The complete dialog frame stays in the mobile viewport: '+JSON.stringify(box));
  await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/connections-mobile.png'});
  await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Connections',exact:true}).click();await page.getByRole('dialog').waitFor();
  assert.deepEqual(errors,[]);
  console.log('Connection checks passed: authentication, origin and input limits; selected-key isolation; success/failure; edit/cancel/close/clear stale-result guards; private keys; mobile layout.');
} finally { await browser.close(); }
