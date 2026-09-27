import handler from 'vinext/server/fetch-handler';
import { protectAccessRequest, type AccessEnv } from '../lib/access-auth';

const worker = {
  async fetch(request: Request, env: Cloudflare.Env & AccessEnv, ctx: ExecutionContext) {
    const authenticated = await protectAccessRequest(request, env);
    if (authenticated instanceof Response) return authenticated;
    // run_worker_first keeps even browser assets behind sign-in. Vinext's
    // routing assumes the edge serves these, so delegate only this static
    // namespace to the private asset binding after authenticating.
    if (new URL(authenticated.url).pathname.startsWith('/_next/static/') && env.ASSETS) return env.ASSETS.fetch(authenticated);
    return handler.fetch(authenticated, env, ctx);
  },
};
export default worker;
