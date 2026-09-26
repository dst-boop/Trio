import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(root + 'dist/server/wrangler.json', 'utf8'));
assert.equal(config.vars?.TRIO_AUTH_PROVIDER, 'cloudflare-access', 'Run build:standalone before this test');
assert.equal(config.assets.run_worker_first, true);
assert.equal(config.preview_urls, false);
const issuer = 'https://trio-test.cloudflareaccess.com', audience = 'a'.repeat(64);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'production-test', alg: 'RS256' };
const serverRoot = root + 'dist/server/';
const modules = ['index.js', ...readdirSync(serverRoot, { recursive: true }).filter(path => path.endsWith('.js') && path !== 'index.js')].map(path => ({ type: 'ESModule', path: serverRoot + path, contents: readFileSync(serverRoot + path, 'utf8') }));
async function token(sub, email) {
  return new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey);
}
const mf = new Miniflare({ modules, modulesRoot: serverRoot, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, d1Databases: ['DB'], assets: { directory: root + 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } }, bindings: { ...config.vars, TRIO_ACCESS_TEAM_DOMAIN: issuer, TRIO_ACCESS_AUD: audience, TRIO_ACCESS_ALLOWED_EMAILS: 'invitee@example.test,owner@example.test' }, outboundService(request) {
  assert.equal(request.url, issuer + '/cdn-cgi/access/certs'); return Response.json({ keys: [jwk] });
} });
const alice = await token('alice', 'invitee@example.test'), bob = await token('bob', 'owner@example.test');
const account = sub => 'cloudflare:trio-test.cloudflareaccess.com:' + sub;
const get = (path, jwt) => mf.dispatchFetch('https://trio.test' + path, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root + 'drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(root + 'drizzle/' + file, 'utf8').split('--> statement-breakpoint').map(text => text.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const path of ['/', '/workspace', '/api/workspace', '/_next/static/css/index.css']) assert.equal((await get(path)).status, 401, 'Every route is protected');
  const workspace = await get('/workspace', alice); assert.equal(workspace.status, 200); const html = await workspace.text(); assert.ok(html.includes('Your Trio workspace')); assert.ok(html.includes('invitee@example.test'));
  const welcome = await get('/', alice); assert.equal(welcome.status, 200); assert.ok((await welcome.text()).includes('Open your workspace'));
  const saved = await mf.dispatchFetch('https://trio.test/api/workspace', { method: 'PUT', headers: { 'cf-access-jwt-assertion': alice, 'X-Trio-Account': account('alice'), 'X-Trio-Workspace-Version': '6', Origin: 'https://trio.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, sessions: [{ id: 'private', title: 'Synthetic private conversation', time: '', turns: [{ question: 'Explain', mode: 'single', result: { answer: 'Synthetic private answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] }] }) });
  assert.equal(saved.status, 200);
  const own = await get('/api/workspace', alice); assert.equal(own.status, 200); assert.equal((await own.json()).sessions[0].title, 'Synthetic private conversation');
  const other = await get('/api/workspace', bob); assert.equal(other.status, 200); assert.deepEqual((await other.json()).sessions, []);
  const jsPath = /src="([^\"]+\.js)"/.exec(html)?.[1]; assert.ok(jsPath, 'Workspace has browser assets'); assert.equal((await get(jsPath, alice)).status, 200, jsPath); assert.equal((await get(jsPath)).status, 401);
  console.log('Standalone production build passed: real SSR workspace, protected browser assets, signed email identity, private D1 save/reload and second-account isolation.');
} finally { await mf.dispose(); }
