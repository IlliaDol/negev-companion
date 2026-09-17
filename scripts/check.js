const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(root)
  .filter(name => name.endsWith('.js'))
  .sort()
  .map(name => path.join(root, name));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`JavaScript syntax OK (${files.length} files)`);
