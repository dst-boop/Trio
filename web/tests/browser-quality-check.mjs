import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TRIO_BASE_URL||'http://localhost:5177';
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1440,height:1050}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
let run=null,starts=0,steps=0,release;
const connections=['openai','claude','gemini'].map(provider=>({provider,saved:true,enabled:true,model:'model',revision:1,updatedAt:null}));
const report={version:2,status:'complete',calls:10,mode:'council',baseline:'claude',summary:{team:{passed:1,total:1,notRun:0},baseline:{},degradedPhases:0},comparison:{overall:{eligible:1,correctedErrors:0,introducedErrors:0}},limitations:'Synthetic tasks are not proof of general accuracy.',results:[]};
await page.route('**/api/quality**',async route=>{
 const request=route.request(),url=new URL(request.url());let data;
 if(request.method()==='GET'){
  if(url.searchParams.has('export'))data={format:'fixture-'+url.searchParams.get('export')};
  else if(url.searchParams.has('id'))data={run,report};else data={runs:run?[run]:[],connections};
 }else{
  const body=request.postDataJSON();
  if(body.action==='start'){starts++;run={id:body.id,settings:body.settings,models:{},status:'running',startedAt:Date.now(),deadline:Date.now()+900000,finishedAt:null,totalSteps:2,completedSteps:0,calls:0,inFlight:false};}
  if(body.action==='step'){steps++;if(steps===1)await new Promise(resolve=>release=resolve);run={...run,completedSteps:run.completedSteps+1,calls:steps===1?3:10,status:steps===1?'running':'complete'};}
  if(body.action==='cancel')run={...run,status:'cancelled'};
  data={run};
 }
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
try{
 await page.goto(base+'/signin-with-chatgpt?return_to=%2Fworkspace',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Quality check',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByText('6 cases · 60 nominal calls · cap 60').waitFor();
 assert.equal(await dialog.getByRole('button',{name:'Start paid quality check'}).isEnabled(),false,'Demo cannot spend');assert.equal(starts,0);
 await dialog.getByRole('button',{name:'Connections',exact:true}).click();await page.getByRole('switch',{name:'Demo mode',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('button',{name:'Quality check',exact:true}).click();await dialog.getByRole('button',{name:'Start paid quality check'}).waitFor();
 await dialog.getByRole('checkbox',{name:'Include Gemini'}).uncheck();await dialog.getByRole('checkbox',{name:'Include ChatGPT'}).uncheck();assert.equal(await dialog.getByRole('button',{name:'Start paid quality check'}).isEnabled(),false);
 await dialog.getByRole('checkbox',{name:'Include ChatGPT'}).check();await dialog.getByRole('checkbox',{name:'Include Gemini'}).check();
 await page.setViewportSize({width:390,height:844});await mkdir('test-output',{recursive:true});await page.screenshot({path:'test-output/quality-setup-mobile.png'});
 assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await dialog.getByRole('button',{name:'Start paid quality check'}).click();await dialog.getByRole('button',{name:'Pause after this step'}).click();
 while(!release)await new Promise(resolve=>setTimeout(resolve,20));release();await dialog.getByRole('button',{name:'Continue quality check'}).waitFor();assert.equal(starts,1);assert.equal(steps,1);
 await page.reload({waitUntil:'networkidle'});assert.equal(starts,1);assert.equal(steps,1,'Reload must not start or resume billed work automatically');
 // Demo defaults back on after reload. Enable it explicitly before resuming.
 await page.getByRole('button',{name:'Connections',exact:true}).click();await page.getByRole('switch',{name:'Demo mode',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();
 // The sidebar may be hidden on mobile; widen without changing app state.
 await page.setViewportSize({width:1440,height:1050});await page.getByRole('button',{name:'Quality check',exact:true}).click();
 await dialog.getByRole('button',{name:'Continue quality check'}).click();await dialog.getByRole('heading',{name:'Complete',exact:true}).waitFor();assert.equal(starts,1);assert.equal(steps,2);
 await dialog.getByRole('button',{name:'View results',exact:true}).click();await dialog.getByRole('heading',{name:'Your private results'}).waitFor();
 const sheet=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download blinded sheet'}).click();assert.match((await sheet).suggestedFilename(),/-sheet.json$/);
 page.once('dialog',d=>d.accept());const key=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download identity key'}).click();assert.match((await key).suggestedFilename(),/-key.json$/);
 await page.setViewportSize({width:390,height:844});assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);await page.screenshot({path:'test-output/quality-results-mobile.png'});
 assert.deepEqual(errors,[]);console.log('Quality UI passed: demo gating, two-provider minimum, explicit start, pause/reload/resume without duplicate calls, private results, separate downloads, mobile layout, no console errors.');
}finally{release?.();await browser.close();}
