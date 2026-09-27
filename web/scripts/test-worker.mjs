// Runs every self-contained Worker test (tests/worker-*.mjs) in its own process, one at a time,
// so a new test file is picked up without editing package.json. Tests that need a running local
// Worker preview are listed below and run separately (see README).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const needsPreview = new Set(['worker-audio.mjs', 'worker-image-generation.mjs', 'worker-request-bodies.mjs']);
const filters = process.argv.slice(2);
const files = readdirSync('tests').filter(name => /^worker-.*\.mjs$/.test(name) && !needsPreview.has(name) && (!filters.length || filters.some(filter => name.includes(filter)))).sort();
if (!files.length) throw new Error('No matching Worker tests.');
const failed = [];
for (const file of files) {
  const started = Date.now();
  const { status, error } = spawnSync(process.execPath, ['tests/' + file], { stdio: 'inherit' });
  const passed = !error && status === 0;
  if (!passed) failed.push(file);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${Math.round((Date.now() - started) / 1000)}s)`);
}
console.log(`${files.length - failed.length}/${files.length} Worker test files passed.`);
if (failed.length) { console.log('Failed: ' + failed.join(', ')); process.exitCode = 1; }
