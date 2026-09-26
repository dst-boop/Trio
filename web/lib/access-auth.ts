import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AccessEnv = {
  TRIO_AUTH_PROVIDER?: string;
  TRIO_ACCESS_TEAM_DOMAIN?: string;
  TRIO_ACCESS_AUD?: string;
  TRIO_ACCESS_ALLOWED_EMAILS?: string;
};

type KeyResolver = Parameters<typeof jwtVerify>[1];
let cachedKeys: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

function configuration(env: AccessEnv) {
  if (env.TRIO_AUTH_PROVIDER !== 'cloudflare-access') return null;
  const issuer = env.TRIO_ACCESS_TEAM_DOMAIN;
  if (!issuer || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)) return null;
  const audience = env.TRIO_ACCESS_AUD;
  if (!audience || !/^[a-f0-9]{64}$/.test(audience)) return null;
  const emails = (env.TRIO_ACCESS_ALLOWED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase());
  if (!emails.length || emails.some(email => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) return null;
  return { issuer, audience, emails: new Set(emails) };
}

export function safeAccessReturn(value: string | null) {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/workspace';
  try {
    const url = new URL(value, 'https://trio.invalid');
    if (url.origin !== 'https://trio.invalid' || ['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback'].includes(url.pathname) || url.pathname.startsWith('/cdn-cgi/')) return '/workspace';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/workspace'; }
}

function failure(status: number) {
  return Response.json({ error: status === 503 ? 'Trio sign-in is being configured. Please try again later.' : 'Sign in to Trio with your invited email, then reload this page.' }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

// This is the standalone Worker's trust boundary. The Sites app consumes only
// the identity headers we create here after signature and invitation checks.
// Never trust client-supplied identity headers or email headers alone.
export async function protectAccessRequest(request: Request, env: AccessEnv, testKeys?: KeyResolver): Promise<Request | Response> {
  const config = configuration(env);
  if (!config) return failure(503);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16384) return failure(401);
  try {
    if (!testKeys && cachedKeys?.issuer !== config.issuer) {
      cachedKeys = { issuer: config.issuer, keys: createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }) };
    }
    const { payload } = await jwtVerify(token, testKeys ?? cachedKeys!.keys, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'],
    });
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.iat > Date.now() / 1000 + 30 || payload.exp <= payload.iat) return failure(401);
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !/^[!-~]{1,256}$/.test(payload.sub) || typeof payload.email !== 'string' || !config.emails.has(payload.email.toLowerCase())) return failure(401);
    const url = new URL(request.url);
    if (['/signout-with-chatgpt', '/signin-with-chatgpt'].includes(url.pathname)) {
      if ((request.headers.has('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return failure(403);
      if (request.headers.has('next-router-prefetch') || request.headers.get('x-middleware-prefetch') === '1' || /prefetch/i.test(request.headers.get('purpose') ?? request.headers.get('sec-purpose') ?? '')) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
      if (request.method !== 'GET' && !(url.pathname === '/signout-with-chatgpt' && request.method === 'POST')) return new Response(null, { status: 405, headers: { Allow: url.pathname === '/signout-with-chatgpt' ? 'GET, POST' : 'GET', 'Cache-Control': 'private, no-store' } });
    }
    if (url.pathname === '/signout-with-chatgpt') {
      // Access owns its HttpOnly authorization cookie and revokes the session.
      return new Response(null, { status: 302, headers: { Location: '/cdn-cgi/access/logout', 'Cache-Control': 'private, no-store' } });
    }
    if (url.pathname === '/signin-with-chatgpt') {
      return new Response(null, { status: 302, headers: { Location: safeAccessReturn(url.searchParams.get('return_to')), 'Cache-Control': 'private, no-store' } });
    }
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('oai-authenticated-user-') || name.startsWith('cf-access-')) headers.delete(name);
    }
    headers.set('oai-authenticated-user-id', `cloudflare:${new URL(config.issuer).hostname}:${payload.sub}`);
    headers.set('oai-authenticated-user-email', payload.email.toLowerCase());
    return new Request(request, { headers });
  } catch {
    // JWT errors can contain token details; do not return or log them.
    return failure(401);
  }
}
