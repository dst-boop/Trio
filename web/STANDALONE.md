# Trio with email-code sign-in

This deployment runs in the owner's Cloudflare account, independently of
ChatGPT Sites. Cloudflare Access sends an invited user a login code by email.
There is no public registration and no ChatGPT account requirement.

The existing Sites configuration and invitation list are unchanged. Use the
separate commands below; the ordinary build still produces the Sites app.

## Initial setup

1. Sign into the owner's Cloudflare account with `pnpm exec wrangler login`.
   Enable Zero Trust and its **One-time PIN** identity provider. Account creation
   and any plan selection are performed by the owner.
2. Copy `wrangler.standalone.json` to the ignored
   `wrangler.standalone.local.json`; the standalone commands prefer that file.
   Create a dedicated database with `pnpm exec wrangler d1 create trio-workspace`.
   Put its returned ID in the local config. Use a new database,
   not the Sites database. Keep the binding named `DB`.
3. Set up an Access self-hosted application for the eventual Worker hostname
   (`trio-workspace.<account-subdomain>.workers.dev`) or a custom domain.
   Protect the whole hostname. Enable One-time PIN for this application.
   Its Allow policy must include only the explicitly invited email addresses;
   do not use Everyone, email-domain rules, or Bypass.
   A Worker-level Access application can protect every route to this Worker.
4. Copy its team domain (`https://<team>.cloudflareaccess.com`, no trailing
   slash) and Application Audience (AUD) tag into the corresponding vars in
   the local config. Keep the app-level email allowlist in sync
   with the Access policy. These settings are not credentials.
5. Run `pnpm migrate:standalone`, then `pnpm build:standalone` and
   `pnpm deploy:standalone`. The initial deployed Worker remains closed
   without a valid Access token, even if the edge policy is misconfigured.
6. Generate a separate random 32-byte base64 encryption master and upload it
   with `pnpm exec wrangler secret put TRIO_CREDENTIAL_KEY --config
   wrangler.standalone.local.json`. Enter it at Wrangler's hidden prompt. Preserve
   it across future deployments; replacing it makes saved keys unreadable.
   Do not commit it or reuse the Sites encryption master.
7. Optionally set `TRIO_WORKSPACE_OPENAI_KEY`, `TRIO_WORKSPACE_CLAUDE_KEY`,
   and `TRIO_WORKSPACE_GEMINI_KEY` with the same secret command. Included
   connections bill the operator's provider account. Otherwise each user
   adds their own keys in Connections.

For updates: run checks, migrate, build, then deploy with the standalone
commands. Deployment refuses a Sites build or configuration that has changed
since the build. Static assets run through the authentication entry point;
preview URLs are disabled. Do not add an alternate unprotected entry point.

## Login and validation

Open the new hostname and enter the invited email. Cloudflare sends a
single-use code; enter it to reach `/workspace`. **Sign out** redirects to
Access's logout endpoint, which clears its authorization cookie and revokes
the Access session (including sessions on other Access applications).

Before sharing the link, verify in a private browser that an invited email
can sign in and an uninvited email cannot. Verify saving and reloading a
synthetic conversation, then verify the other invited account cannot see it.
Direct requests with forged Sites identity headers must receive 401. Never
test with actual client material.

The Worker independently validates RS256 signature, fixed issuer, app audience,
expiry, subject, application-token type, and invited email. Its JWKS URL comes
only from configuration. Client identity headers are discarded. Account IDs
use the verified Access subject and issuer, not an email supplied by a caller.
Existing API origin and account-pin checks remain in place.

## Data and work-email access

The new host starts with separate account history and provider credentials.
To move selected conversations, export a portable backup from the old
workspace and restore it in the new one. Provider keys are not in backups;
add them again to the new account. No cross-account data is copied automatically.

This removes the ChatGPT Sites dependency. A company network may still need
to permit the new hostname and Cloudflare's login email. If a code is missing,
check spam or ask the email administrator to allow
`noreply@notify.cloudflare.com`.

References: [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[email-code login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
