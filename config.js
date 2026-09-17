const fs = require('fs');
const path = require('path');

// Single source of truth for environment variables and derived local paths.
// Keep secrets in .env or the process environment; never put them in code.

// Keep this dependency-free: local .env values are loaded before config is read.
const localEnv = path.join(__dirname, '.env');
if (fs.existsSync(localEnv)) {
  for (const line of fs.readFileSync(localEnv, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.NEGEV_DATA_DIR || path.join(ROOT, 'data'));
const LOG_DIR = path.resolve(process.env.NEGEV_LOG_DIR || path.join(ROOT, 'logs'));
const TEMP_DIR = path.join(DATA_DIR, 'tmp');
const PERSONA_FILE = path.resolve(ROOT, process.env.NEGEV_PERSONA_FILE || 'persona.local.json');

const localPipelineRoot = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'whisper-pipeline');
const pipelineCandidates = [
  path.join(localPipelineRoot, 'LIVE', 'transcribe.bat'),
  path.join(localPipelineRoot, 'transcribe.bat'),
  path.join(localPipelineRoot, 'dist', 'local-media-pipeline', 'transcribe.bat')
];
const defaultPipeline = pipelineCandidates.find(candidate => fs.existsSync(candidate)) || pipelineCandidates[0];
// Document conversion is deliberately opt-in and local-only. Keep the actual
// converter path in the ignored .env; the public example stays blank.
const documentPipeline = process.env.NEGEV_DOCUMENT_PIPELINE || '';
const detectedTimeZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; }
  catch (_) { return 'Europe/Berlin'; }
})();

const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const fallbacks = (process.env.DEEPSEEK_MODEL_FALLBACKS || 'deepseek-flash,deepseek-chat')
  .split(',').map(s => s.trim()).filter(Boolean);
const splitKeys = value => String(value || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
const numberedKeys = Object.entries(process.env)
  .filter(([name, value]) => /^DEEPSEEK_API_KEY_\d+$/i.test(name) && value)
  .sort(([a], [b]) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]))
  .map(([, value]) => value.trim())
  .filter(Boolean);
const deepSeekKeys = [...new Set([
  process.env.DEEPSEEK_API_KEY || '',
  ...splitKeys(process.env.DEEPSEEK_API_KEYS),
  ...numberedKeys
].filter(Boolean))];

module.exports = {
  ROOT,
  DATA_DIR,
  LOG_DIR,
  TEMP_DIR,
  STATE_FILE: path.join(DATA_DIR, 'state.json'),
  STATE_BACKUP_FILE: path.join(DATA_DIR, 'state.previous.json'),
  USAGE_FILE: path.join(DATA_DIR, 'usage.json'),
  LOCK_FILE: path.join(DATA_DIR, 'negev.lock'),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_OWNER_ID: process.env.TELEGRAM_OWNER_ID ? String(process.env.TELEGRAM_OWNER_ID) : '',
  // DEEPSEEK_API_KEY remains the backwards-compatible primary key. The pool
  // accepts a comma/newline-separated DEEPSEEK_API_KEYS value and numbered
  // DEEPSEEK_API_KEY_1, DEEPSEEK_API_KEY_2, ... variables.
  DEEPSEEK_API_KEY: deepSeekKeys[0] || '',
  DEEPSEEK_API_KEYS: deepSeekKeys,
  DEEPSEEK_KEY_COUNT: deepSeekKeys.length,
  DEEPSEEK_BASE_URL: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
  DEEPSEEK_MODELS: [...new Set([model, ...fallbacks])],
  // Blank means the actual timezone configured on this Windows machine.
  TIMEZONE: process.env.NEGEV_TIMEZONE || detectedTimeZone,
  LOCATION: process.env.NEGEV_LOCATION || 'your configured local area',
  DISPLAY_NAME: process.env.NEGEV_DISPLAY_NAME || 'Private companion',
  PERSONA_FILE,
  MEDIA_PIPELINE: process.env.NEGEV_MEDIA_PIPELINE || defaultPipeline,
  DOCUMENT_PIPELINE: documentPipeline,
  MAX_MEDIA_BYTES: Math.max(1, numberEnv('NEGEV_MAX_MEDIA_MB', 20)) * 1024 * 1024,
  MAX_DOCUMENT_CHARS: Math.max(10_000, Math.floor(numberEnv('NEGEV_MAX_DOCUMENT_CHARS', 120_000))),
  DAILY_PROACTIVE_MIN: Math.max(0, Math.floor(numberEnv('NEGEV_DAILY_PROACTIVE_MIN', 6))),
  DAILY_PROACTIVE_MAX: Math.max(0, Math.floor(numberEnv('NEGEV_DAILY_PROACTIVE_MAX', 9))),
  RATES: {
    input: numberEnv('DEEPSEEK_INPUT_USD_PER_M', 0.15),
    cache: numberEnv('DEEPSEEK_CACHE_USD_PER_M', 0.003),
    output: numberEnv('DEEPSEEK_OUTPUT_USD_PER_M', 0.60)
  },
  HTTP_TIMEOUT_MS: 90_000,
  TELEGRAM_TIMEOUT_MS: 35_000
};
