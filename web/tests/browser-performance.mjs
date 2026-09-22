import assert from 'node:assert/strict';
const baseUrl=process.env.TRIO_BASE_URL||'http://localhost:8787';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
try {
  const page=await browser.newPage(); const scripts=[]; const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.resourceType()==='script')scripts.push(r.url());});
  await page.goto(baseUrl+'/demo',{waitUntil:'networkidle'});
  assert.equal(scripts.filter(url=>url.includes('answer-renderer-')).length,0,'Markdown should not load for an empty workspace');
  await page.getByRole('button',{name:'Run demo',exact:true}).click();await page.getByRole('button',{name:'Run demo',exact:true}).waitFor();
  assert.equal(scripts.filter(url=>url.includes('answer-renderer-')).length,1);assert.ok(await page.locator('.prose-answer p').count());
  assert.deepEqual(errors,[]);
  const offline=await browser.newPage();let blocked=0;
  await offline.route('**/answer-renderer-*.js',route=>{blocked++;return route.abort('failed');});
  await offline.goto(baseUrl+'/demo',{waitUntil:'networkidle'});await offline.getByRole('button',{name:'Run demo',exact:true}).click();await offline.getByRole('button',{name:'Run demo',exact:true}).waitFor();
  await offline.getByText('Answer formatting is unavailable. You can still read and copy the full text.',{exact:true}).first().waitFor();
  assert.ok(blocked>0);assert.ok((await offline.locator('.prose-answer').allTextContents()).join('\n').includes('Make the first 30 days a learning sprint.'));
  await offline.getByRole('button',{name:/New session/}).click();await offline.getByRole('textbox',{name:'Your question',exact:true}).fill('The workspace still responds');assert.equal(await offline.getByRole('textbox',{name:'Your question',exact:true}).inputValue(),'The workspace still responds');
}finally{await browser.close();}
console.log('Production performance browser: deferred Markdown chunk, formatted answers, readable fallback on chunk failure, and responsive workspace passed');
