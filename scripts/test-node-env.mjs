import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

// Run after real setup. Fixtures use the installed Node, no provider calls/downloads.
const root = fileURLToPath(new URL('..', import.meta.url));
const version = readFileSync(join(root, '.node-version'), 'utf8').trim();
const distribution = `node-v${version}-${process.platform}-${process.arch}`;
const runtime = join(root, '.local/node-env', distribution);
assert.ok(existsSync(join(runtime, 'bin/node')), 'Run setup first.');
const work = mkdtempSync(join(tmpdir(), 'nihao env checks '));
const fixture = join(work, 'project with spaces');
const fakeBin = join(work, 'old system binaries');
mkdirSync(join(fixture, 'scripts'), { recursive: true });
mkdirSync(join(fixture, '.local/node-env'), { recursive: true });
mkdirSync(fakeBin);
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, npm_config_audit: 'false' };
for (const name of ['POE_API_KEY', 'BAIDU_MAP_API_KEY', 'DOUBAO_API_KEY', 'PORT', 'HOST', 'NIHAO_CLIENT_DIR']) delete env[name];
const run = (script, ...args) => spawnSync('/bin/bash', [join(fixture, script), ...args], { cwd: work, env, encoding: 'utf8', timeout: 60_000 });
const marker = join(work, 'wrong-node-used');
for (const name of ['node', 'npm']) writeFileSync(join(fakeBin, name), `#!/bin/sh\ntouch '${marker}'\nexit 91\n`, { mode: 0o755 });
for (const name of ['node-env.sh', 'setup-env.sh', 'run.sh', 'check-env.mjs']) copyFileSync(join(root, 'scripts', name), join(fixture, 'scripts', name));
for (const name of ['.node-version', '.env.example']) copyFileSync(join(root, name), join(fixture, name));
const manifest = { name: 'nihao-setup-fixture', version: '1.0.0', private: true, scripts: { build: 'node build.cjs' } };
writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest));
writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version } } }));
writeFileSync(join(fixture, 'build.cjs'), 'require("node:fs").writeFileSync("build-completed", process.execPath);');
let app;
try {
  assert.equal(run('scripts/run.sh', 'start').status, 1, 'missing runtime gives setup instructions');
  // Download failures must stop before npm/build and release their staging directory/lock.
  writeFileSync(join(fakeBin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
  const failedDownload = run('scripts/setup-env.sh');
  assert.notEqual(failedDownload.status, 0);
  assert.ok(!existsSync(join(fixture, 'build-completed')));
  assert.ok(!existsSync(join(fixture, '.local/node-env/setup.lock')));
  assert.ok(!existsSync(join(fixture, '.env')));
  symlinkSync(runtime, join(fixture, '.local/node-env', distribution), 'dir');
  const first = run('scripts/setup-env.sh');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(fixture, '.env'), 'utf8'), readFileSync(join(root, '.env.example'), 'utf8'));
  assert.equal(readFileSync(join(fixture, 'build-completed'), 'utf8'), join(runtime, 'bin/node'));
  assert.equal(run('scripts/run.sh', 'check').status, 1, 'empty keys reported');

  const listener = createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const settings = `# preserve this comment\nPOE_API_KEY="fixture-poe#key"\nBAIDU_MAP_API_KEY="fixture-map"\nDOUBAO_API_KEY="fixture-speech"\nPORT=${port}\n`;
  writeFileSync(join(fixture, '.env'), settings, { mode: 0o600 });
  const second = run('scripts/setup-env.sh');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(fixture, '.env'), 'utf8'), settings, 'repeat setup preserves exact user config');
  assert.ok(!second.stdout.includes('fixture-poe'));
  assert.equal(run('scripts/run.sh', 'check').status, 0);
  // Concurrent setup must not remove another process's lock.
  mkdirSync(join(fixture, '.local/node-env/setup.lock'));
  assert.equal(run('scripts/setup-env.sh').status, 1);
  assert.ok(existsSync(join(fixture, '.local/node-env/setup.lock')));
  rmSync(join(fixture, '.local/node-env/setup.lock'), { recursive: true });
  // A failed build propagates failure, preserves configuration and releases its own lock.
  writeFileSync(join(fixture, 'build.cjs'), 'process.exit(9);');
  assert.notEqual(run('scripts/setup-env.sh').status, 0);
  assert.equal(readFileSync(join(fixture, '.env'), 'utf8'), settings);
  assert.ok(!existsSync(join(fixture, '.local/node-env/setup.lock')));

  // Launch the real built server through the wrapper, with an old Node ahead in the caller PATH.
  symlinkSync(join(root, 'dist'), join(fixture, 'dist'), 'dir');
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  app = spawn('/bin/bash', [join(fixture, 'scripts/run.sh'), 'start'], { cwd: work, env, stdio: 'pipe' });
  let logs = '';
  app.stdout.on('data', chunk => { logs += chunk; });
  app.stderr.on('data', chunk => { logs += chunk; });
  let health;
  for (let i = 0; i < 100; i++) {
    try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); break; }
    catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(health?.ok, logs);
  for (const configured of [health.configured, health.maps.configured, health.speech.configured, health.recognition.configured]) assert.equal(configured, true);
  assert.ok(!logs.includes('fixture-poe'));
  assert.ok(!existsSync(marker), 'system/Conda node and npm never ran');
  console.log('PASS: spaced paths, old system Node isolation, actual server startup, missing keys, repeat setup/config preservation, download/build failure and setup locking (fixture keys; no provider calls).');
} finally {
  if (app && app.exitCode === null) {
    const exited = new Promise(r => app.once('exit', r));
    app.kill('SIGTERM');
    await exited;
  }
  rmSync(work, { recursive: true, force: true });
}
