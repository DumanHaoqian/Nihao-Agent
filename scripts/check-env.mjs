// Print configuration presence only. Never log keys or contact providers.
const names = ['POE_API_KEY', 'BAIDU_MAP_API_KEY', 'DOUBAO_API_KEY'];
let missing = false;
for (const name of names) {
  const loaded = Boolean(process.env[name]?.trim());
  console.log(`${name}: ${loaded ? 'loaded (value hidden)' : 'missing — fill in .env'}`);
  if (!loaded) missing = true;
}
console.log('Configuration check only; provider authorization and service access are not tested.');
if (missing) process.exitCode = 1;
