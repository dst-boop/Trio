import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
// Only a disposable local checkout: this never reads or writes hosted secrets.
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `# Synthetic local browser-test encryption key. Never deploy.\nTRIO_CREDENTIAL_KEY=${randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
} else if (!/^TRIO_CREDENTIAL_KEY\s*=/m.test(readFileSync('.dev.vars', 'utf8'))) {
  throw new Error('Existing .dev.vars has no TRIO_CREDENTIAL_KEY. Use a disposable checkout or add a local 32-byte base64 encryption key; setup will not overwrite your environment.');
}
mkdirSync('.wrangler', { recursive: true });
const config = '.wrangler/browser-migrate.json';
writeFileSync(config, JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'site-creator-d1', database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: resolve('drizzle') }] }));
const migration = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', '.wrangler/state'], { stdio: 'inherit', windowsHide: true });
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);
console.log('Local browser prerequisites ready. Start the Vite preview or build and start the Worker; see tests/README.md.');
