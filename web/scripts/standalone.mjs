import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command] = process.argv.slice(2);
const sourcePath = existsSync(new URL('../wrangler.standalone.local.json', import.meta.url)) ? 'wrangler.standalone.local.json' : 'wrangler.standalone.json';
const read = path => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
const run = (path, args) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../' + path, import.meta.url)), ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (command === 'build' || command === 'dev') {
  run('node_modules/vite/bin/vite.js', [command, '--config', 'vite.standalone.config.ts']);
} else if (command === 'deploy' || command === 'migrate') {
  const source = read(sourcePath);
  const database = source.d1_databases?.find(db => db.binding === 'DB');
  if (!database || !/^[a-f0-9-]{36}$/.test(database.database_id) || database.database_id === '00000000-0000-4000-8000-000000000000') throw new Error('Configure the new standalone D1 database before deployment.');
  const vars = source.vars;
  if (vars?.TRIO_AUTH_PROVIDER !== 'cloudflare-access' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars.TRIO_ACCESS_TEAM_DOMAIN) || !/^[a-f0-9]{64}$/.test(vars.TRIO_ACCESS_AUD) || !vars.TRIO_ACCESS_ALLOWED_EMAILS?.trim()) throw new Error('Configure Cloudflare Access and the invitation allowlist before deployment.');
  if (command === 'migrate') {
    run('node_modules/wrangler/bin/wrangler.js', ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', sourcePath]);
  } else {
    const built = read('dist/server/wrangler.json');
    if (built.name !== source.name || built.vars?.TRIO_AUTH_PROVIDER !== 'cloudflare-access' || built.d1_databases?.find(db => db.binding === 'DB')?.database_id !== database.database_id || built.assets?.run_worker_first !== true || Object.entries(vars).some(([key, value]) => built.vars[key] !== value)) throw new Error('Build the standalone configuration before deploying. The current build is stale or belongs to Sites.');
    run('node_modules/wrangler/bin/wrangler.js', ['deploy', '--config', 'dist/server/wrangler.json']);
  }
} else {
  throw new Error('Use standalone.mjs build, dev, migrate, or deploy.');
}
