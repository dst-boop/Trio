import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const issuer = 'https://trio-test.cloudflareaccess.com', audience = 'a'.repeat(64);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
async function token(sub, email = 'invitee@example.test') {
  return new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey);
}
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', entryPoints: ['worker/access-entry.ts'], plugins: [{ name: 'fixture-framework', setup(build) {
  build.onResolve({ filter: /^vinext\/server\/fetch-handler$/ }, () => ({ path: 'handler', namespace: 'fixture' }));
  build.onResolve({ filter: /^next\/(headers|navigation)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'ts', resolveDir: root, contents: args.path === 'handler' ? `
    import {GET,PUT} from './app/api/workspace/route.ts';
    export default {async fetch(request) {
      globalThis.fixtureHeaders = request.headers;
      if(new URL(request.url).pathname==='/identity') return Response.json(Object.fromEntries(request.headers));
      return request.method==='PUT'?PUT(request):GET(request);
    }};` : args.path === 'next/headers' ? 'export async function headers(){return globalThis.fixtureHeaders}' : 'export function redirect(){throw new Error("Unexpected redirect")}' }));
} }] });
let network = 0;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { TRIO_AUTH_PROVIDER: 'cloudflare-access', TRIO_ACCESS_TEAM_DOMAIN: issuer, TRIO_ACCESS_AUD: audience, TRIO_ACCESS_ALLOWED_EMAILS: 'invitee@example.test,owner@example.test' }, outboundService(request) {
  network++; assert.equal(request.url, issuer + '/cdn-cgi/access/certs'); return Response.json({ keys: [jwk] });
} });
const alice = await token('alice'), bob = await token('bob', 'owner@example.test');
const aliceId = 'cloudflare:trio-test.cloudflareaccess.com:alice';
const headers = { 'Content-Type': 'application/json', Origin: 'https://trio.test', 'X-Trio-Workspace-Version': '6' };
const session = { id: 'private', title: 'Alice private project', time: '', turns: [{ question: 'Help', mode: 'single', result: { answer: 'Private Alice answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
const write = { revision: 0, sessions: [session] };
async function call(jwt, method = 'GET', pin = aliceId, extra = {}, path = '/api/workspace') {
  return mf.dispatchFetch('https://trio.test' + path, { method, headers: { ...headers, 'X-Trio-Account': pin, ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...extra }, ...(method === 'PUT' ? { body: JSON.stringify(write) } : {}) });
}
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root + 'drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(root + 'drizzle/' + file, 'utf8').split('--> statement-breakpoint').map(text => text.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const jwt of [null, 'spoof', await token('outsider', 'outsider@test.invalid')]) assert.equal((await call(jwt, 'PUT', aliceId, { 'oai-authenticated-user-id': aliceId, 'oai-authenticated-user-email': 'invitee@example.test' })).status, 401);
  assert.equal((await call(alice, 'PUT')).status, 200);
  const own = await call(alice); assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'private, no-store'); assert.equal((await own.json()).sessions[0].title, session.title);
  assert.equal((await call(bob, 'PUT', aliceId)).status, 401, 'A stale or forged account pin cannot write another account');
  const other = await call(bob, 'GET', 'cloudflare:trio-test.cloudflareaccess.com:bob'); assert.equal(other.status, 200); assert.deepEqual((await other.json()).sessions, []);
  assert.equal((await call(alice, 'PUT', aliceId, { Origin: 'https://evil.test' })).status, 403);
  const identity = await (await call(alice, 'GET', aliceId, { 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-full-name': 'Forged', 'cf-access-authenticated-user-email': 'victim@test.invalid' }, '/identity')).json();
  assert.equal(identity['oai-authenticated-user-id'], aliceId); assert.equal(identity['oai-authenticated-user-full-name'], undefined); assert.equal(identity['cf-access-jwt-assertion'], undefined);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM workspaces').first()).count, 1);
  assert.equal(network, 1, 'JWKS is cached; no external provider calls');
  console.log('Standalone Worker Access passed: signed JWTs, forged identity rejection, real D1 account isolation, origin/account pins, no real network.');
} finally { await mf.dispose(); }
