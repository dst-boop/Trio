# Browser regression suite

Run from `web/` in a **disposable local checkout**. Browser scripts write synthetic
history, preferences, memory and fake encrypted credentials to the local mock
account. Never point them at a hosted site or use real provider keys. Requests
that would generate answers are mocked; prepared demo examples need no keys.

Prerequisites: Node 24, the pinned pnpm version, `pnpm install --frozen-lockfile`,
and Playwright with a Chromium browser. Set `PLAYWRIGHT_MODULE` to an installed
Playwright module URL/path if it is outside this project's module resolution.
`PLAYWRIGHT_CHANNEL` defaults to `msedge`; set it to `chromium` to use Playwright's
bundled Chromium after installing it (`playwright install chromium`).

```sh
node scripts/setup-browser.mjs
node scripts/run-framework.mjs dev --port 5173
# In another terminal:
node scripts/test-browser.mjs
```

Setup applies **local-only** D1 migrations from `drizzle/` to `.wrangler/state`
and creates an ignored `.dev.vars` containing a random local encryption key.
It preserves existing environment files. Without migrations, account history
returns 503; without the encryption key, saved-credential writes correctly fail
closed. Neither failure means a UI regression. Restart previews after setup.

The runner warms `/demo`, executes scripts sequentially, resets the local mock
account's Demo/Single/ChatGPT preferences before each script, and returns nonzero
if any script fails. Every script keeps its own browser/storage context. Logs
and a JSON summary are written to ignored `test-output/browser-suite/`.
Pass filename fragments to run a subset, e.g. `node scripts/test-browser.mjs memory`.
Use `TRIO_BASE_URL=http://localhost:5183` for a different port (in PowerShell:
`$env:TRIO_BASE_URL='http://localhost:5183'`).

Three tests need **built Worker assets** and trusted synthetic auth headers,
which the Vite mock-auth middleware intentionally strips:

```sh
node scripts/run-framework.mjs build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --config dist/server/wrangler.json --local --persist-to .wrangler/state --ip 127.0.0.1 --port 8787 --inspector-port 0
# In another terminal (unset a dev TRIO_BASE_URL override first):
node scripts/test-browser.mjs --worker
```

This group covers `current-time`, `performance` and `startup`. The migration
configuration uses the source migration directory because the build does not
copy it to `dist/server`. Do not rebuild while the Worker preview is running.

Tests should select the answer mode they exercise, set switch state explicitly,
and open Tools & context or Run details before using nested controls. Do not
change the app's first-use Single answer default to satisfy a Council fixture.
Keep request payload, persistence, privacy and no-automatic-spend assertions;
update obsolete selectors rather than dropping behavior coverage.
