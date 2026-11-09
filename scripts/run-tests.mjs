import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('test')
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `test/${name}`);

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
