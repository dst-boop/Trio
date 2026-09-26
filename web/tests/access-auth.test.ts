import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { protectAccessRequest, safeAccessReturn } from '../lib/access-auth.ts';

const issuer = 'https://trio-test.cloudflareaccess.com', audience = 'a'.repeat(64);
const env = { TRIO_AUTH_PROVIDER: 'cloudflare-access', TRIO_ACCESS_TEAM_DOMAIN: issuer, TRIO_ACCESS_AUD: audience, TRIO_ACCESS_ALLOWED_EMAILS: 'invitee@example.test,owner@example.test' };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
const keys = createLocalJWKSet({ keys: [jwk] });
const now = Math.floor(Date.now() / 1000);
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ iss: issuer, aud: [audience], sub: 'alice', email: 'invitee@example.test', type: 'app', iat: now, exp: now + 3600, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}
async function protect(jwt: string | null, path = '/workspace', extraHeaders = {}, config = env, method = 'GET') {
  return protectAccessRequest(new Request('https://trio.test' + path, { method, headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...extraHeaders } }), config, keys);
}
async function status(result: Request | Response, expected: number) {
  assert.ok(result instanceof Response);
  assert.equal(result.status, expected);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.ok(!(await result.text()).includes('private-token-marker'));
}

test('verified Access subject replaces every client identity header', async () => {
  const result = await protect(await token({ email: 'Invitee@Example.test' }), '/workspace', {
    'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@test.invalid',
    'oai-authenticated-user-full-name': 'Forged Name', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8', 'oai-authenticated-user-extra': 'forged',
    'cf-access-authenticated-user-email': 'victim@test.invalid', 'x-trio-account': 'victim', origin: 'https://other.test',
  });
  assert.ok(result instanceof Request);
  assert.equal(result.headers.get('oai-authenticated-user-id'), 'cloudflare:trio-test.cloudflareaccess.com:alice');
  assert.equal(result.headers.get('oai-authenticated-user-email'), 'invitee@example.test');
  assert.equal(result.headers.get('oai-authenticated-user-full-name'), null);
  assert.equal(result.headers.get('oai-authenticated-user-extra'), null);
  assert.equal(result.headers.get('cf-access-jwt-assertion'), null);
  assert.equal(result.headers.get('cf-access-authenticated-user-email'), null);
  assert.equal(result.headers.get('x-trio-account'), 'victim', 'Route must still reject an incorrect account pin');
  assert.equal(result.headers.get('origin'), 'https://other.test', 'Route must still reject cross-origin writes');
});

test('missing, malformed, tampered, expired and unauthorized tokens fail closed', async () => {
  const valid = await token();
  for (const jwt of [null, 'private-token-marker', 'x'.repeat(16385), valid.slice(0, -6) + 'AAAAAA',
    await token({ exp: now - 1 }), await token({ iss: 'https://other.cloudflareaccess.com' }),
    await token({ aud: 'b'.repeat(64) }), await token({ email: 'outsider@test.invalid' }),
    await token({ type: 'service' }), await token({ sub: '' }), await token({ email: null }),
    await token({ exp: undefined }), await token({ iat: now + 3600, exp: now + 7200 }), await token({ nbf: now + 3600 }),
  ]) await status(await protect(jwt), 401);
});

test('an unconfigured deployment never accepts Sites headers', async () => {
  for (const config of [{ ...env, TRIO_AUTH_PROVIDER: '' }, { ...env, TRIO_ACCESS_TEAM_DOMAIN: 'https://attacker.test' }, { ...env, TRIO_ACCESS_AUD: '' }, { ...env, TRIO_ACCESS_ALLOWED_EMAILS: '' }, { ...env, TRIO_ACCESS_ALLOWED_EMAILS: '*' }]) {
    await status(await protect(await token(), '/api/workspace', { 'oai-authenticated-user-id': 'victim' }, config), 503);
  }
});

test('login returns locally and logout goes to Access cookie revocation', async () => {
  const jwt = await token();
  for (const [path, location] of [['/signin-with-chatgpt?return_to=%2Fworkspace%3Ftab%3Dsaved', '/workspace?tab=saved'], ['/signin-with-chatgpt?return_to=https%3A%2F%2Fevil.test', '/workspace'], ['/signout-with-chatgpt?return_to=https%3A%2F%2Fevil.test', '/cdn-cgi/access/logout']]) {
    const result = await protect(jwt, path); assert.ok(result instanceof Response); assert.equal(result.status, 302); assert.equal(result.headers.get('location'), location);
  }
  await status(await protect(jwt, '/signout-with-chatgpt', { origin: 'https://evil.test' }), 403);
  await status(await protect(jwt, '/signout-with-chatgpt', { 'sec-fetch-site': 'cross-site' }), 403);
  await status(await protect(jwt, '/signout-with-chatgpt', { 'next-router-prefetch': '1' }), 204);
  await status(await protect(jwt, '/signin-with-chatgpt', {}, env, 'POST'), 405);
  for (const value of ['//evil.test', '/\\evil.test', '/cdn-cgi/access/logout', '/signout-with-chatgpt', '/callback']) assert.equal(safeAccessReturn(value), '/workspace');
});
