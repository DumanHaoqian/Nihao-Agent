import { spawn } from 'node:child_process';

const env = { ...process.env, NODE_USE_ENV_PROXY: '1', TSX_TSCONFIG_PATH: 'tsconfig.runtime.json' };
const children = [
  spawn(process.execPath, ['--use-env-proxy', '--import', 'tsx', '--watch', 'apps/nihao/server/start.ts'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/nihao/web/vite.config.ts'], { stdio: 'inherit', env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); close(1); });
  child.on('exit', (code) => { if (!closing) close(code ?? 1); });
}
