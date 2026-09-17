const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const excludedDirectories = new Set(['.git', 'data', 'logs', 'tmp', 'outputs', 'work', 'node_modules']);
// The audit script contains the private-value patterns it is checking for;
// exclude its own policy text from the candidate set.
const excludedFiles = new Set(['.env', 'persona.local.json', 'public-audit.js']);
const publicExtensions = new Set(['.js', '.json', '.md', '.ps1', '.bat', '.yml', '.yaml', '.txt']);

function walk(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) found.push(...walk(path.join(directory, entry.name)));
      continue;
    }
    if (excludedFiles.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (publicExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name === '.env.example' || entry.name === '.gitignore') found.push(file);
  }
  return found;
}

function candidateFiles() {
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).filter(Boolean).map(file => path.join(root, file));
    if (tracked.length) return tracked.filter(file => !excludedFiles.has(path.basename(file)));
  } catch (_) { /* Git is optional while preparing a local project. */ }
  return walk(root);
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const profileFile = path.join(root, 'persona.local.json');
const privateProfile = (() => {
  try { return JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch (_) { return {}; }
})();
const forbiddenValues = [
  'Dortmund, Germany',
  'DATA SCIENCE FULL ROADMAP',
  "Girls' Frontline",
  privateProfile.location,
  privateProfile.knownProjectPath,
  privateProfile.voice,
  privateProfile.motivationFocus
].filter(value => typeof value === 'string' && value.trim().length >= 8);
const patterns = [
  { label: 'private value', regex: new RegExp(forbiddenValues.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') },
  { label: 'secret-like token', regex: /(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/ }
];

const findings = [];
for (const file of candidateFiles()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match) findings.push(`${path.relative(root, file)}:${lineNumber(text, match.index)} (${pattern.label})`);
  }
}

const gitignore = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
for (const required of ['.env', 'persona.local.json', 'data/', 'outputs/']) {
  if (!gitignore.split(/\r?\n/).some(line => line.trim() === required)) findings.push(`.gitignore (missing ${required})`);
}

if (findings.length) {
  console.error('Public audit failed. Review these candidate files before publishing:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public audit passed (${candidateFiles().length} candidate files scanned; private profile and runtime data excluded).`);
}
