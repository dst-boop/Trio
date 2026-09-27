import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const workerTests = new Set(['browser-current-time.mjs', 'browser-performance.mjs', 'browser-startup.mjs']);
const group = process.argv.includes('--worker') ? 'worker' : 'dev';
const selected = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const base = process.env.TRIO_BASE_URL || (group === 'worker' ? 'http://127.0.0.1:8787' : 'http://localhost:5173');
const url = new URL(base);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Browser tests require a disposable local HTTP preview, never a hosted account.');
const files = (await readdir('tests')).filter(name => /^browser-.*\.mjs$/.test(name) && workerTests.has(name) === (group === 'worker') && (!selected.length || selected.some(filter => name.includes(filter)))).sort();
if (!files.length) throw new Error('No matching browser tests.');
await mkdir('test-output/browser-suite', { recursive: true });
// Warm the route once, so a cold dev compile is not charged to a UI assertion.
assert.equal((await fetch(base + '/demo')).status, 200, 'Start the appropriate preview before running tests.');
const results = [];
for (const file of files) {
  if (group === 'dev') {
    const login = await fetch(base + '/signin-with-chatgpt?return_to=%2Fworkspace', { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Use the local Vite preview with mock sign-in.');
    const workspace = await fetch(base + '/api/workspace', { headers: { cookie } });
    assert.equal(workspace.status, 200, 'Run browser:setup to migrate local D1 first.');
    const { accountId } = await workspace.json();
    const headers = { cookie, origin: base, 'X-Trio-Account': accountId, 'content-type': 'application/json' };
    const preferences = await fetch(base + '/api/preferences', { headers });
    assert.equal(preferences.status, 200);
    const { revision } = await preferences.json();
    const reset = await fetch(base + '/api/preferences', { method: 'PUT', headers, body: JSON.stringify({ revision, demo: true, mode: 'single', lead: 'openai' }) });
    assert.equal(reset.status, 200, 'Reset only local mock-account choices between scripts.');
  }
  const started = Date.now(); let output = '', timedOut = false;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/' + file], { env: { ...process.env, TRIO_BASE_URL: base }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }, 180_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  await writeFile(`test-output/browser-suite/${file}.log`, output);
  const result = { file, passed: code === 0 && !timedOut, seconds: Math.round((Date.now() - started) / 1000), timedOut };
  results.push(result); console.log(`${result.passed ? 'PASS' : 'FAIL'} ${file} (${result.seconds}s)`);
  if (!result.passed) console.log(output.slice(-2200));
}
await writeFile(`test-output/browser-suite/${group}-results.json`, JSON.stringify(results, null, 2));
console.log(`${results.filter(result => result.passed).length}/${results.length} ${group} browser scripts passed.`);
if (results.some(result => !result.passed)) process.exitCode = 1;
