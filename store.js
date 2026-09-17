const fs = require('fs');
const path = require('path');
const config = require('./config');
const { nowIso } = require('./util');

const DEFAULT_STATE = {
  schemaVersion: 9,
  ownerUserId: null,
  ownerChatId: null,
  claimedAt: null,
  telegramOffset: 0,
  botMessageIds: [],
  inboundMessageIds: [],
  history: [],
  summary: '',
  facts: [],
  promises: [],
  tasks: [],
  calendar: [],
  unanswered: [],
  overnight: [],
  scheduledReplies: [],
  sleep: null,
  sleepNotice: { date: null, bedtimeSent: false, goodnightSent: false, wakeKey: null },
  sleepExtension: { scheduleDate: null, minutes: 0, requestedAt: null },
  mood: { name: 'soft', until: null, reason: '', forced: false },
  mute: { until: null, setAt: null, minutes: 0 },
  proactive: { date: null, remaining: 0, nextAt: null, sent: 0 },
  busy: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  lastReactionAt: null,
  waitingForUser: { active: false, since: null, reason: '', pausedProactive: null },
  conversation: {
    topic: 'general', topicChangedAt: null, currentIntent: 'casual', mode: 'normal',
    lastUserText: '', lastUserAt: null, openLoops: [], recentOpenings: [], recentPhrases: [], ideaHistory: [],
    userEnergy: 'steady', userMessageShape: 'statement', lastAssistantAt: null, lastAssistantEnergy: null,
    motivation: null, repair: null
  }
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function ensureDirs() {
  for (const dir of [config.DATA_DIR, config.LOG_DIR, config.TEMP_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : clone(defaults);
  if (defaults && typeof defaults === 'object') {
    const out = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    for (const [key, fallback] of Object.entries(defaults)) out[key] = mergeDefaults(out[key], fallback);
    return out;
  }
  return value === undefined ? defaults : value;
}

function loadState() {
  ensureDirs();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
  } catch (error) {
    // Keep a damaged file for diagnosis and recover the last known-good copy
    // before falling back to defaults. This prevents one interrupted write
    // from looking like a deliberate memory wipe.
    if (fs.existsSync(config.STATE_FILE)) {
      const stamp = new Date().toISOString().replace(/[.:]/g, '-');
      try { fs.copyFileSync(config.STATE_FILE, `${config.STATE_FILE}.corrupt-${stamp}.json`, fs.constants.COPYFILE_EXCL); } catch (_) {}
    }
    try { state = JSON.parse(fs.readFileSync(config.STATE_BACKUP_FILE, 'utf8')); }
    catch (_) { state = {}; }
  }
  state = mergeDefaults(state, DEFAULT_STATE);
  state.schemaVersion = DEFAULT_STATE.schemaVersion;
  return state;
}

function saveState(state) {
  ensureDirs();
  const temp = `${config.STATE_FILE}.${process.pid}.tmp`;
  const serialized = JSON.stringify({ ...state, savedAt: nowIso() }, null, 2);
  fs.writeFileSync(temp, serialized, 'utf8');
  // Keep the previous complete snapshot. The live file is still replaced
  // atomically, while the backup gives loadState something safe to restore.
  if (fs.existsSync(config.STATE_FILE)) {
    try {
      JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
      fs.copyFileSync(config.STATE_FILE, config.STATE_BACKUP_FILE);
    } catch (_) { /* do not replace a good backup with a damaged live file */ }
  }
  fs.renameSync(temp, config.STATE_FILE);
}

function updateState(mutator) {
  const state = loadState();
  mutator(state);
  saveState(state);
  return state;
}

function appendLog(line) {
  ensureDirs();
  const filename = path.join(config.LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(filename, `[${nowIso()}] ${line}\n`, 'utf8');
}

function touchHeartbeat(extra = {}) {
  ensureDirs();
  const file = path.join(config.DATA_DIR, 'heartbeat.json');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ at: nowIso(), pid: process.pid, ...extra }), 'utf8');
  fs.renameSync(temp, file);
}

module.exports = { DEFAULT_STATE, ensureDirs, loadState, saveState, updateState, appendLog, touchHeartbeat };
