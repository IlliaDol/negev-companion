const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sleep, id, nowIso, safeText, stripEmoji, formatLocal, localDateKey, pick } = require('./util');
const { ensureDirs, loadState, saveState, appendLog, touchHeartbeat } = require('./store');
const memory = require('./memory');
const conversation = require('./conversation');
const timing = require('./timing');
const style = require('./style');
const persona = require('./persona');
const usage = require('./usage');
const { callDeepSeek } = require('./deepseek');
const providers = require('./providers');
const { readLinks } = require('./links');
const { prepareMedia } = require('./media');
const { telegramHelp } = require('./commands');
const { createTelegramApi } = require('./telegram-api');

const { apiCall, downloadFile } = createTelegramApi({
  token: config.TELEGRAM_BOT_TOKEN,
  timeoutMs: config.TELEGRAM_TIMEOUT_MS,
  maxMediaBytes: config.MAX_MEDIA_BYTES
});

let state;
let running = true;
let schedulerBusy = false;
let lockOwned = false;

// -----------------------------------------------------------------------------
// Configuration, environment, and single-process lifecycle
// -----------------------------------------------------------------------------

function requireConfig() {
  const missing = [];
  if (!config.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  try {
    const activeProvider = providers.getActiveProvider();
    if (!activeProvider.keys.length) missing.push(`API key for active provider "${activeProvider.id}"`);
    if (!activeProvider.model) missing.push(`model for active provider "${activeProvider.id}"`);
  } catch (error) { missing.push(error.message); }
  if (missing.length) throw new Error(`missing environment variable(s): ${missing.join(', ')}. Copy .env.example to .env or set them in the service.`);
}

function loadDotEnv() {
  const file = path.join(config.ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function acquireLock() {
  ensureDirs();
  try { fs.writeFileSync(config.LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: nowIso() }), { flag: 'wx' }); lockOwned = true; return; }
  catch (_) {}
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(config.LOCK_FILE, 'utf8')); } catch (_) {}
  if (existing.pid && Number(existing.pid) === process.pid) {
    // Windows can reuse a PID after the previous process exited. In that
    // case the lock belongs to the dead process, not to this fresh startup.
    try { fs.unlinkSync(config.LOCK_FILE); } catch (_) {}
  } else if (existing.pid) {
    try { process.kill(Number(existing.pid), 0); throw new Error(`another Negev instance is running (pid ${existing.pid})`); } catch (error) {
      if (error.message.startsWith('another ')) throw error;
    }
  }
  fs.writeFileSync(config.LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: nowIso() }), 'utf8');
  lockOwned = true;
}

function releaseLock() { if (lockOwned) { try { fs.unlinkSync(config.LOCK_FILE); } catch (_) {} } }

// -----------------------------------------------------------------------------
// Ownership and command parsing
// -----------------------------------------------------------------------------

function isPrivateOwner(message) {
  const chat = message.chat;
  if (!chat || chat.type !== 'private') return false;
  const userId = String(message.from?.id || '');
  if (!userId) return false;
  if (config.TELEGRAM_OWNER_ID && userId !== config.TELEGRAM_OWNER_ID) return false;
  if (state.ownerUserId && userId !== String(state.ownerUserId)) return false;
  return true;
}

function claimIfAllowed(message) {
  if (state.ownerUserId) return true;
  const text = message.text || '';
  if (!/^[\/]start(?:@\w+)?(?:\s|$)/i.test(text) && !/^!start(?:@\w+)?(?:\s|$)/i.test(text)) return false;
  state.ownerUserId = String(message.from.id);
  state.ownerChatId = String(message.chat.id);
  state.claimedAt = nowIso();
  saveState(state);
  appendLog(`[privacy] claimed by user ${state.ownerUserId} in private chat ${state.ownerChatId}`);
  return true;
}

function commandOf(text) {
  const match = String(text || '').trim().match(/^([!/][a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), args: (match[2] || '').trim() } : null;
}

function parseMuteMinutes(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const maxMinutes = Math.floor((8.64e15 - Date.now()) / 60_000);
  if (!Number.isFinite(amount) || amount < 0 || amount > maxMinutes) return null;
  return amount === 0 ? 0 : Math.max(1, Math.round(amount));
}

// -----------------------------------------------------------------------------
// Persistent interaction state: mute, waiting, and sleep extensions
// -----------------------------------------------------------------------------

function muteStatus() {
  const mute = state?.mute || {};
  const untilMs = mute.until ? new Date(mute.until).getTime() : NaN;
  if (Number.isFinite(untilMs) && untilMs > Date.now()) return { active: true, until: new Date(untilMs), minutes: mute.minutes || 0 };
  if (mute.until) {
    state.mute = { until: null, setAt: null, minutes: 0 };
    saveState(state);
  }
  return { active: false, until: null, minutes: 0 };
}

function muteUntilText(until) {
  return formatLocal(until, config.TIMEZONE, { second: undefined });
}

function setMute(minutes) {
  state.mute = minutes > 0
    ? { until: new Date(Date.now() + minutes * 60_000).toISOString(), setAt: nowIso(), minutes }
    : { until: null, setAt: null, minutes: 0 };
  saveState(state);
  return muteStatus();
}

function waitingForUserActive() {
  return Boolean(state?.waitingForUser?.active);
}

function userNickname() {
  return persona.profile?.nickname || 'friend';
}

function bedtimeExtensionMinutes(now = new Date()) {
  const base = timing.getSleepState(now, config.TIMEZONE);
  const extension = state?.sleepExtension;
  if (!base.schedule || !extension || extension.scheduleDate !== base.schedule.dateKey) return 0;
  return Math.max(0, Math.min(60, Number(extension.minutes) || 0));
}

function sleepStateAt(now = new Date()) {
  const extension = bedtimeExtensionMinutes(now);
  return timing.getSleepState(now, config.TIMEZONE, { bedtimeExtensionMinutes: extension });
}

function sleepTimingOptions(now = new Date()) {
  const extension = state?.sleepExtension || {};
  const minutes = bedtimeExtensionMinutes(now);
  return {
    bedtimeExtensionMinutes: minutes,
    bedtimeExtensionDate: minutes && extension.scheduleDate ? extension.scheduleDate : null
  };
}

function extendBedtimeForUser() {
  const now = new Date();
  const base = timing.getSleepState(now, config.TIMEZONE);
  const current = state.sleepExtension || {};
  if (!base.schedule || base.asleep) return false;
  if (current.scheduleDate === base.schedule.dateKey && Number(current.minutes) > 0) return false;
  state.sleepExtension = { scheduleDate: base.schedule.dateKey, minutes: 15, requestedAt: now.toISOString() };
  saveState(state);
  appendLog(`[sleep] bedtime extended by 15 minutes for ${base.schedule.dateKey}`);
  return true;
}

function clearWaitingForUser() {
  const waiting = state?.waitingForUser;
  if (!waiting?.active) return false;
  const today = localDateKey(new Date(), config.TIMEZONE);
  if (waiting.pausedProactive && waiting.pausedProactive.date === today) {
    state.proactive = { ...waiting.pausedProactive };
    if (!state.proactive.nextAt || new Date(state.proactive.nextAt).getTime() <= Date.now()) {
      state.proactive.nextAt = timing.nextProactiveAt(new Date(Date.now() + 45 * 60 * 1000), config.TIMEZONE);
    }
  } else {
    state.proactive = { date: null, remaining: 0, nextAt: null, sent: 0 };
  }
  state.waitingForUser = { active: false, since: null, reason: '', pausedProactive: null };
  saveState(state);
  appendLog('[conversation] user returned; resumed normal conversation mode');
  return true;
}

async function enterWaitingForUser(message, text, request, silent = false) {
  const queued = Array.isArray(state.scheduledReplies) ? state.scheduledReplies.splice(0) : [];
  for (const item of queued) {
    const queuedText = item.text || inboundText(item.message || {});
    if (queuedText) memory.addHistory(state, 'user', queuedText, {
      telegramMessageId: item.message?.message_id || null,
      replyToId: item.message?.reply_to_message?.message_id || null,
      cancelledBecause: 'waiting_for_user'
    });
  }
  state.waitingForUser = {
    active: true,
    since: nowIso(),
    reason: request.reason || 'he asked for some time and space',
    pausedProactive: state.proactive ? { ...state.proactive } : null
  };
  state.proactive = { ...(state.proactive || {}), remaining: 0, nextAt: null };
  state.lastInboundAt = nowIso();
  state.mood = timing.moodForMessage(text, state);
  memory.addHistory(state, 'user', text || '[message asking for time]', {
    telegramMessageId: message.message_id || null,
    replyToId: message.reply_to_message?.message_id || null,
    waitingForUser: true
  });
  saveState(state);
  appendLog(`[conversation] waiting for user after message ${message.message_id || '-'}`);
  if (silent) return;
  const acknowledgement = pick([
    'okay, take your time. ill wait here until you text me',
    'alright, go rest. ill leave you alone till you come back',
    `got it. no rush, ${userNickname()}. text me when youre ready`
  ]);
  const sent = await sendBubble(state.ownerChatId, acknowledgement, message.message_id || null);
  for (const item of sent) memory.addHistory(state, 'assistant', acknowledgement, { telegramMessageId: item.message_id || null, kind: 'waiting_ack' });
  if (sent.length) conversation.observeAssistant(state, acknowledgement);
  saveState(state);
}

// -----------------------------------------------------------------------------
// Incoming message normalization and outgoing Telegram messages
// -----------------------------------------------------------------------------

function rememberMutedMessage(message, text) {
  const rememberedText = text || '[message received while muted]';
  const explicit = memory.rememberExplicit(state, rememberedText, config.TIMEZONE);
  memory.addHistory(state, 'user', rememberedText, {
    telegramMessageId: message.message_id || null,
    replyToId: message.reply_to_message?.message_id || null,
    muted: true
  });
  state.lastInboundAt = nowIso();
  state.mood = timing.moodForMessage(rememberedText, state);
  saveState(state);
  appendLog(`[mute] silently remembered message ${message.message_id || '-'} (${explicit.facts.length + explicit.promises.length + explicit.calendar.length} durable items)`);
}

function replyContext(message) {
  const quoted = message.reply_to_message;
  if (!quoted) return '';
  const who = quoted.from?.is_bot ? config.DISPLAY_NAME : 'the user';
  const quotedPicture = quoted.photo || (quoted.document && (/^image\//i.test(quoted.document.mime_type || '') || /\.(?:jpe?g|png|webp|gif)$/i.test(quoted.document.file_name || ''))) || (quoted.sticker && !quoted.sticker.is_animated && !quoted.sticker.is_video);
  const quotedDocument = quoted.document && !quotedPicture;
  const quotedText = quoted.text || quoted.caption || (quotedPicture ? '[a picture]' : quoted.video ? '[a video]' : quoted.sticker ? '[a sticker]' : quotedDocument ? `[a document: ${quoted.document.file_name || 'document'}]` : '[media]');
  return `The user is replying to ${who} message ${quoted.message_id}: ${safeText(quotedText, 1800)}`;
}

function inboundText(message) {
  const picture = message.photo || (message.document && (/^image\//i.test(message.document.mime_type || '') || /\.(?:jpe?g|png|webp|gif)$/i.test(message.document.file_name || ''))) || (message.sticker && !message.sticker.is_animated && !message.sticker.is_video);
  return message.text || message.caption || (picture ? '[the user sent a picture]' : message.video ? '[the user sent a video]' : message.voice ? '[the user sent a voice message]' : message.audio ? '[the user sent audio]' : message.sticker ? '[the user sent a sticker]' : message.document ? `[the user sent ${message.document.file_name || 'a document'}]` : '');
}

function hasSupportedMedia(message) {
  return Boolean(message.photo || message.video || message.animation || message.video_note || message.voice || message.audio ||
    (message.sticker && !message.sticker.is_animated && !message.sticker.is_video) ||
    message.document);
}

function isReactionRequest(text) {
  return /\b(?:react|reacting|reacted|reaction|reactions|emoji|emojis)\b/i.test(String(text || ''));
}

function reactionForMessage(message, text, random = Math.random) {
  if (!message?.message_id) return null;
  const lower = String(text || '').toLowerCase();
  const media = Boolean(message.photo || message.video || message.animation || message.video_note || message.voice || message.audio || message.sticker || message.document);
  let emojis = ['👍', '❤️', '👀'];
  let chance = 0.13;
  if (isReactionRequest(lower)) {
    emojis = ['❤️', '👍', '👀'];
    chance = 1;
  } else if (/\b(?:love|miss|cute|adorable|proud of you|thank(?:s| you)|i appreciate|<3)\b/i.test(lower)) {
    emojis = ['❤️', '🥰', '🫂'];
    chance = 0.30;
  } else if (/(?:lol|lmao|lmfao|haha|xdd|funny|😭|😂)/i.test(lower)) {
    emojis = ['😂', '😭', '🤣'];
    chance = 0.25;
  } else if (/\b(?:done|finished|started|got it|nice|good job|congrats|congratulations|lets go)\b/i.test(lower)) {
    emojis = ['🔥', '👏', '💪'];
    chance = 0.24;
  } else if (/\b(?:sad|tired|rough|bad day|hurt|stressed|overwhelmed|sorry)\b/i.test(lower)) {
    emojis = ['🫂', '❤️', '😔'];
    chance = 0.22;
  } else if (media && !lower.trim()) {
    emojis = ['👀', '❤️', '🔥'];
    chance = 0.18;
  }
  if (random() >= chance) return null;
  return pick(emojis, random);
}

async function maybeReactToMessage(message, text) {
  if (!state?.ownerChatId || !message?.message_id) return false;
  const requested = isReactionRequest(text);
  const last = state.lastReactionAt ? new Date(state.lastReactionAt).getTime() : NaN;
  if (!requested && Number.isFinite(last) && Date.now() - last < 75_000) return false;
  const emoji = reactionForMessage(message, text);
  if (!emoji) return false;
  try {
    await apiCall('setMessageReaction', {
      chat_id: state.ownerChatId,
      message_id: message.message_id,
      reaction: [{ type: 'emoji', emoji }],
      is_big: false
    });
    state.lastReactionAt = nowIso();
    saveState(state);
    appendLog(`[reaction] reacted to message ${message.message_id} with ${emoji}`);
    return true;
  } catch (error) {
    appendLog(`[reaction] Telegram could not react to message ${message.message_id}: ${error.message}`);
    return false;
  }
}

async function sendTyping(chatId) { try { await apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch (_) {} }

async function sendBubble(chatId, text, replyToId = null) {
  const chunks = style.formatTelegramText(stripEmoji(text));
  const sent = [];
  for (const chunk of chunks) {
    const body = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
    if (replyToId) body.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
    try { sent.push(await apiCall('sendMessage', body)); }
    catch (error) {
      let retryError = null;
      if (replyToId) {
        delete body.reply_parameters;
        body.reply_to_message_id = replyToId;
        try { sent.push(await apiCall('sendMessage', body)); } catch (retry) { retryError = retry; }
      }
      if (!sent.length || retryError) appendLog(`[telegram] send failed: ${retryError?.message || error.message}`);
    }
  }
  if (state && sent.length) {
    state.botMessageIds = [...new Set([...(state.botMessageIds || []), ...sent.map(item => String(item.message_id)).filter(Boolean)])].slice(-1000);
    saveState(state);
  }
  return sent;
}

function recordedBotMessageIds() {
  const ids = new Set((state?.botMessageIds || []).map(value => String(value)));
  try {
    const ledger = usage.loadLedger();
    for (const value of Object.keys(ledger.messageMap || {})) ids.add(String(value));
    for (const bucket of Object.values(ledger.buckets || {})) for (const value of bucket.messageIds || []) ids.add(String(value));
  } catch (error) { appendLog(`[start] could not read usage message map: ${error.message}`); }
  return [...ids].filter(value => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a)).slice(0, 1000);
}

function recordedConversationMessageIds() {
  const ids = new Set(recordedBotMessageIds());
  for (const value of state?.inboundMessageIds || []) ids.add(String(value));
  for (const item of state?.history || []) {
    if (item.telegramMessageId) ids.add(String(item.telegramMessageId));
  }
  for (const item of state?.overnight || []) if (item.messageId) ids.add(String(item.messageId));
  for (const item of state?.scheduledReplies || []) if (item.message?.message_id) ids.add(String(item.message.message_id));
  return [...ids].filter(value => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a)).slice(0, 1000);
}

async function deleteMessageIds(chatId, ids) {
  let cleared = 0;
  let failed = 0;
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100).map(value => Number(value));
    try {
      await apiCall('deleteMessages', { chat_id: chatId, message_ids: batch });
      cleared += batch.length;
    } catch (_) {
      // Older Bot API deployments may not expose deleteMessages. Fall back to
      // one message at a time so one stale ID cannot block the whole reset.
      for (const messageId of batch) {
        try { await apiCall('deleteMessage', { chat_id: chatId, message_id: messageId }); cleared++; }
        catch (error) { failed++; }
      }
    }
  }
  if (failed) appendLog(`[clear] requested ${ids.length} recorded messages; ${cleared} cleared and ${failed} could not be cleared by Telegram`);
  return { attempted: ids.length, cleared, failed };
}

async function deleteRecordedBotMessages(chatId, includeIncoming = false) {
  const ids = includeIncoming ? recordedConversationMessageIds() : recordedBotMessageIds();
  const result = await deleteMessageIds(chatId, ids);
  if (state) {
    state.botMessageIds = [];
    if (includeIncoming) state.inboundMessageIds = [];
    saveState(state);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Conversation reset and mood commands
// -----------------------------------------------------------------------------

function resetConversationState() {
  state.history = [];
  state.summary = '';
  state.unanswered = [];
  state.overnight = [];
  state.scheduledReplies = [];
  state.sleep = null;
  state.sleepNotice = { date: null, bedtimeSent: false, goodnightSent: false, wakeKey: null };
  state.sleepExtension = { scheduleDate: null, minutes: 0, requestedAt: null };
  state.proactive = { date: null, remaining: 0, nextAt: null, sent: 0 };
  state.busy = null;
  state.lastInboundAt = null;
  state.lastOutboundAt = null;
  state.lastReactionAt = null;
  state.waitingForUser = { active: false, since: null, reason: '', pausedProactive: null };
  conversation.ensureConversation(state);
  state.conversation = {
    topic: 'general', topicChangedAt: null, currentIntent: 'casual', mode: 'normal',
    lastUserText: '', lastUserAt: null, openLoops: [], recentOpenings: [], recentPhrases: [], ideaHistory: [],
    userEnergy: 'steady', userMessageShape: 'statement', lastAssistantAt: null, lastAssistantEnergy: null,
    motivation: null, repair: null
  };
}

async function freshStart(chatId) {
  const cleanup = await deleteRecordedBotMessages(chatId, true);
  resetConversationState();
  saveState(state);
  return cleanup;
}

const MOOD_COMMANDS = {
  '/caring': 'caring', '!caring': 'caring',
  '/tsundere': 'tsundere', '!tsundere': 'tsundere',
  '/playful': 'playful', '!playful': 'playful',
  '/warm': 'warm', '!warm': 'warm',
  '/normal': 'soft', '!normal': 'soft', '/soft': 'soft', '!soft': 'soft'
};
const AUTOMATIC_MOOD_COMMANDS = new Set(['/normal', '!normal']);

function setMood(name, forced = true) {
  state.mood = { name, until: null, reason: forced ? 'chosen directly by him' : 'automatic mood' , forced };
  saveState(state);
}

async function handleMoodCommand(chatId, command, replyToId = null) {
  let mood = MOOD_COMMANDS[command.name];
  let forced = !AUTOMATIC_MOOD_COMMANDS.has(command.name);
  if (command.name === '/mood' || command.name === '!mood') {
    const requested = command.args.toLowerCase();
    if (!requested || requested === 'show') {
      await sendBubble(chatId, `current style: ${state.mood?.name || 'soft'}${state.mood?.forced ? ' (locked until you change it)' : ' (automatic)'}`, replyToId);
      return true;
    }
    if (requested === 'off' || requested === 'auto') { mood = 'soft'; forced = false; }
    else mood = requested;
  }
  if (!mood || !['soft', 'caring', 'tsundere', 'playful', 'warm'].includes(mood)) {
    await sendBubble(chatId, 'choose one: !caring, !tsundere, !playful, !warm, !normal, or !mood auto', replyToId);
    return true;
  }
  setMood(mood, forced);
  const replies = {
    caring: 'fine. ill be a little more caring. only a little, so dont get dramatic about it',
    tsundere: 'tsundere mode, but lightly. i can tease you without becoming unbearable',
    playful: 'playful mode. try not to give me an excuse to become too annoying',
    warm: 'a little warmer, then. dont get used to me being obvious about it',
    soft: forced ? 'back to my usual soft setting' : 'back to automatic moods. i’ll read the room myself'
  };
  await sendBubble(chatId, replies[mood], replyToId);
  return true;
}

function taskMoment(state) {
  const items = memory.pendingReminders(state);
  if (!items.length) return { text: '', items: [] };
  return {
    items,
    text: `One remembered calendar item is due now. Act on it naturally: ${items.map(item => `${item.value} (date ${item.dueDate || item.dueLabel || 'now'})`).join('; ')}. Do not dump internal memory details.`
  };
}

// -----------------------------------------------------------------------------
// Model reply pipeline
// -----------------------------------------------------------------------------

function markRemindersNotified(items) {
  if (!items?.length) return false;
  const at = nowIso();
  let changed = false;
  for (const item of items) {
    if (!item.notifiedAt) { item.notifiedAt = at; changed = true; }
  }
  return changed;
}

async function buildAndSend({ message, text, media, force = false, morning = false, proactive = false, replyMode = 'short', replyToId = null, extraNote = '', recordUser = true }) {
  const chatId = state.ownerChatId;
  if (!chatId) return [];
  if (waitingForUserActive() && !force) {
    appendLog('[conversation] blocked an outbound message while waiting for user');
    return [];
  }
  if (muteStatus().active && !force) {
    appendLog('[mute] blocked a reply while muted');
    return [];
  }
  const sleepState = sleepStateAt(new Date());
  if (!proactive && sleepState.asleep && !force) {
    appendLog('[sleep] blocked a reply while asleep');
    return [];
  }
  await sendTyping(chatId);
  const links = await readLinks(text);
  const replyCtx = message ? replyContext(message) : '';
  const moodState = state.mood || { name: 'soft', reason: 'ordinary day', forced: false };
  const mood = moodState.name || 'soft';
  const memoryContext = memory.memoryContext(state, 8, config.TIMEZONE);
  const conversationContext = conversation.context(state);
  const conversationGuidance = conversation.modeGuidance(state);
  const unanswered = state.unanswered.slice(-5).map(item => `${item.messageId || item.id}: ${item.text}`).join('\n');
  const reminderContext = taskMoment(state);
  const system = persona.buildSystemPrompt({
    memory: memoryContext,
    mood,
    moodReason: moodState.reason,
    replyMode: morning ? 'morning' : proactive ? 'proactive' : replyMode,
    sleep: morning ? 'You just woke up after missing messages while asleep. Acknowledge the timing naturally in one short phrase, then focus on what he sent.' : '',
    replyContext: replyCtx,
    style: extraNote,
    conversationContext,
    conversationGuidance,
    responseIntent: proactive ? 'spontaneous connection' : (state.conversation?.currentIntent || 'natural reply')
  });
  const userPrompt = proactive
    ? persona.buildProactivePrompt({ memory: memoryContext, mood, reason: extraNote })
    : persona.buildUserPrompt({ messageText: text, mediaContext: media?.mediaContext || '', linksContext: links.context, unanswered, taskContext: reminderContext.text, conversationContext });
  // The digest/caption is already inside userPrompt. Keep the first text part
  // as the prompt and append only the actual image when vision is involved.
  const userContent = media?.content?.length
    ? media.content.map((part, index) => index === 0 && part.type === 'text' ? { type: 'text', text: userPrompt } : part)
    : userPrompt;
  const bucketId = usage.createBucket(proactive ? 'proactive' : morning ? 'morning' : 'reply');
  let result;
  try {
    result = await callDeepSeek({ messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }], maxTokens: proactive ? 260 : 380, temperature: 0.86, bucketId, purpose: proactive ? 'proactive' : 'reply' });
  } catch (error) {
    appendLog(`[model] ${error.message}`);
    const fallback = morning ? 'i just woke up and found your messages. give me a second to become a person again' : 'my brain tripped over itself for a second. send that again?';
    const sent = await sendBubble(chatId, fallback, replyToId);
    for (const item of sent) usage.bindMessage(item.message_id, bucketId);
    if (sent.length) {
      markRemindersNotified(reminderContext.items);
      if (!proactive && recordUser) conversation.markAnswered(state);
      if (!proactive && recordUser && text) memory.addHistory(state, 'user', text, { telegramMessageId: message?.message_id || null, replyToId: message?.reply_to_message?.message_id || null });
      memory.addHistory(state, 'assistant', fallback, { bucketId });
      conversation.observeAssistant(state, fallback);
      state.lastOutboundAt = nowIso();
      memory.removeUnanswered(state, message?.message_id);
      saveState(state);
    }
    return sent;
  }
  let bubbles = style.splitBubbles(result.text).map(item => style.ensureLaughMarks(style.applyHumanStyle(item, { mood }), Math.random));
  if (!bubbles.length) bubbles = ['you made me think too hard for a second. try that again?'];
  const sent = [];
  for (let index = 0; index < bubbles.length; index++) {
    if (index) await sleep(700 + Math.floor(Math.random() * 1300));
    const messages = await sendBubble(chatId, bubbles[index], index === 0 ? replyToId : null);
    sent.push(...messages);
  }
  for (const item of sent) usage.bindMessage(item.message_id, bucketId);
  if (sent.length) markRemindersNotified(reminderContext.items);
  if (sent.length && !proactive && recordUser) conversation.markAnswered(state);
  if (!proactive && recordUser && text) memory.addHistory(state, 'user', text, { telegramMessageId: message?.message_id || null, replyToId: message?.reply_to_message?.message_id || null });
  for (const bubble of bubbles) {
    memory.addHistory(state, 'assistant', bubble, { bucketId });
    conversation.observeAssistant(state, bubble);
    // Relative dates in her own promises or casual plans become concrete
    // calendar entries too, so "tomorrow" does not lose its meaning later.
    memory.rememberDateReferences(state, bubble, 'negev', new Date(), config.TIMEZONE, 'conversation');
    // A promise Negev makes is durable too, so "i'll remind you tomorrow"
    // becomes something she can actually follow through on later.
    for (const item of memory.parsePromise(bubble)) memory.addPromise(state, item.value, item.type, new Date(), config.TIMEZONE, 'negev', 'model');
  }
  state.lastOutboundAt = nowIso();
  memory.removeUnanswered(state, message?.message_id);
  saveState(state);
  return sent;
}

// -----------------------------------------------------------------------------
// Durable queues and Telegram commands
// -----------------------------------------------------------------------------

function queueOvernight(message) {
  const entry = { id: id('night'), messageId: message.message_id, chatId: String(message.chat.id), text: inboundText(message), at: nowIso(), replyToId: message.reply_to_message?.message_id || null, message };
  state.overnight.push(entry);
  state.overnight = state.overnight.slice(-40);
  saveState(state);
  appendLog(`[sleep] queued message ${message.message_id} until morning`);
}

function queueScheduled(message, media, force, plan) {
  // Never put a base64 photo into the durable queue. Telegram file_id is enough to
  // re-download it after a restart; transcript text is small and safe to persist.
  const durableMedia = media?.kind === 'photo' ? null : media;
  state.scheduledReplies.push({ id: id('scheduled'), dueAt: new Date(Date.now() + plan.delayMs).toISOString(), message, text: inboundText(message), media: durableMedia, force, mode: plan.mode });
  state.scheduledReplies = state.scheduledReplies.slice(-30);
  saveState(state);
  appendLog(`[timing] ${plan.mode} reply scheduled in ${Math.round(plan.delayMs / 1000)}s`);
}

async function handleCommand(message, command) {
  const chatId = state.ownerChatId || String(message.chat.id);
  const replyToId = message.message_id || null;
  const name = command.name;
  const action = name.replace(/^[!/]/, '');
  if (action === 'mute') {
    const minutes = parseMuteMinutes(command.args);
    if (minutes === null) {
      const current = muteStatus();
      await sendBubble(chatId, current.active
        ? `im already muted until ${muteUntilText(current.until)} here. use /unmute or /mute 0 to wake me early.`
        : 'tell me how many minutes, like /mute 30 or !mute 60. use 0 to keep me unmuted.', replyToId);
      return true;
    }
    if (minutes === 0) {
      setMute(0);
      await sendBubble(chatId, 'okay, mute cancelled. im here again, and nothing in memory or chat was touched.', replyToId);
      return true;
    }
    const current = setMute(minutes);
    await sendBubble(chatId, `okay. im going quiet for ${minutes} minute${minutes === 1 ? '' : 's'}, until around ${muteUntilText(current.until)} here. ill still remember what you send, and i wont clear anything.`, replyToId);
    return true;
  }
  if (action === 'unmute') {
    const wasMuted = muteStatus().active;
    setMute(0);
    await sendBubble(chatId, wasMuted ? 'im back. the mute ended early, and everything stayed saved.' : 'i wasnt muted, but im here.', replyToId);
    return true;
  }
  if (action === 'start') {
    const cleanup = await freshStart(chatId);
    const oldMessages = cleanup.cleared ? ` i cleared ${cleanup.cleared} recorded chat messages` : ' i cleared my recorded chat context';
    const limitation = cleanup.failed ? ' Telegram refused some older messages, so those need to be removed in the app itself.' : '';
    await sendBubble(chatId, `fresh start, ${userNickname()}.${oldMessages}. your saved memory stayed, obviously.${limitation}`);
    return true;
  }
  if (action === 'clear') {
    if (command.args.toLowerCase() !== 'yes') {
      await sendBubble(chatId, 'this clears the recorded chat messages and short-term conversation. send /clear yes if you really want that.', replyToId);
      return true;
    }
    const cleanup = await freshStart(chatId);
    await sendBubble(chatId, `chat cleared. i removed ${cleanup.cleared || 'the recorded'} messages i could reach, and kept your saved memory.`, replyToId);
    return true;
  }
  if (action === 'forgetall') {
    if (command.args.toLowerCase() !== 'yes') {
      await sendBubble(chatId, 'this erases learned facts, promises, tasks, and short-term memory, but never my built-in core. send /forgetall yes if you really mean it.', replyToId);
      return true;
    }
    state.facts = [];
    state.promises = [];
    state.tasks = [];
    state.calendar = [];
    resetConversationState();
    state.mood = { name: 'soft', until: null, reason: 'fresh memory', forced: false };
    saveState(state);
    await sendBubble(chatId, 'done. i forgot the learned memory and kept only my built-in core. we can start over properly now.', replyToId);
    return true;
  }
  if (action === 'help' || action === 'commands') {
    await sendBubble(chatId, telegramHelp(), replyToId);
    return true;
  }
  if (action === 'talk' || action === 'topic') {
    conversation.observeUser(state, 'i want to keep talking but i have no idea what to talk about');
    saveState(state);
    await buildAndSend({
      message,
      text: 'i want to keep talking but i have no idea what to talk about',
      force: true,
      replyMode: 'instant',
      replyToId,
      recordUser: false,
      extraNote: 'Keep the conversation going. Choose one fresh, specific topic spark from the private conversation state and bring it up naturally in one or two chat bubbles. Do not show a menu of ideas or mention the topic bank.'
    });
    return true;
  }
  if (['repair', 'correct'].includes(action)) {
    conversation.clearOpenLoops(state);
    conversation.setMode(state, 'repair');
    saveState(state);
    const text = 'okay, reset that thread a bit. what did i get wrong?';
    const sent = await sendBubble(chatId, text, replyToId);
    if (sent.length) { conversation.observeAssistant(state, text); conversation.setMode(state, 'repair'); saveState(state); }
    return true;
  }
  if (action === 'listen') {
    conversation.setMode(state, 'listen');
    saveState(state);
    const text = 'okay. no fixing it, no interrogation. im listening.';
    const sent = await sendBubble(chatId, text, replyToId);
    if (sent.length) { conversation.observeAssistant(state, text); conversation.setMode(state, 'listen'); saveState(state); }
    return true;
  }
  if (action === 'advice') {
    conversation.setMode(state, 'advice');
    saveState(state);
    const text = 'alright, advice mode. tell me the actual situation and ill give you a straight answer.';
    const sent = await sendBubble(chatId, text, replyToId);
    if (sent.length) { conversation.observeAssistant(state, text); conversation.setMode(state, 'advice'); saveState(state); }
    return true;
  }
  if (['subject', 'change'].includes(action)) {
    conversation.setMode(state, 'subject');
    conversation.clearOpenLoops(state);
    saveState(state);
    const text = 'fine, new subject. what are we talking about now?';
    const sent = await sendBubble(chatId, text, replyToId);
    if (sent.length) { conversation.observeAssistant(state, text); conversation.setMode(state, 'subject'); saveState(state); }
    return true;
  }
  if (MOOD_COMMANDS[name] || ['caring', 'tsundere', 'playful', 'warm', 'normal', 'soft', 'mood'].includes(action)) return handleMoodCommand(chatId, command, replyToId);
  if (['token', 'tokens', 'usage', 'cost', 'spend'].includes(action)) {
    const target = message.reply_to_message?.message_id;
    const bucket = target ? usage.bucketForMessage(target) : null;
    await sendBubble(chatId, bucket ? usage.formatBucket(bucket) : usage.formatBucket(usage.loadLedger().calls.at(-1)?.bucketId), replyToId);
    return true;
  }
  if (action === 'tokenall') { await sendBubble(chatId, usage.formatAll(), replyToId); return true; }
  if (action === 'estimateall') { await sendBubble(chatId, usage.formatLifetimeEstimate(), replyToId); return true; }
  if (action === 'estimate') { await sendBubble(chatId, usage.estimateScenarios(), replyToId); return true; }
  if (action === 'status') {
    await buildAndSend({
      message,
      text: 'how are you right now?',
      force: true,
      replyMode: 'instant',
      replyToId: message.message_id,
      extraNote: 'He asked how you are right now. Answer like a normal personal check-in from your current mood and recent context. Do not list internal state, commands, token counts, model names, sleep schedules, or memory statistics unless he specifically asks for technical status.'
    });
    return true;
  }
  if (action === 'remember') {
    const result = memory.rememberExplicit(state, `remember ${command.args}`, config.TIMEZONE);
    saveState(state);
    const remembered = result.facts.length + result.promises.length + result.calendar.length;
    await sendBubble(chatId, remembered ? `got it. i pinned ${remembered} thing${remembered === 1 ? '' : 's'}${result.calendar.length ? `, including the date ${result.calendar[0].dueDate}` : ''}` : 'tell me the actual thing you want me to remember', replyToId);
    return true;
  }
  if (action === 'forget') {
    const removed = memory.forgetFact(state, command.args); saveState(state);
    await sendBubble(chatId, removed ? `gone. i forgot ${removed} matching note${removed === 1 ? '' : 's'}` : 'i couldnt find a fact matching that', replyToId);
    return true;
  }
  if (action === 'promises' || action === 'tasks') {
    const items = memory.listMemories(state);
    const work = memory.sortWorkItems([
      ...items.promises.map(item => ({ ...item, workType: 'promise' })),
      ...items.tasks.map(item => ({ ...item, workType: 'task' }))
    ]);
    const lines = work.map(item => `${item.workType}: ${item.value}${item.dueDate ? ` [${item.dueDate}]` : ''}`);
    await sendBubble(chatId, lines.length ? lines.join('\n') : 'nothing open. suspiciously peaceful', replyToId); return true;
  }
  if (action === 'calendar') {
    const items = memory.listMemories(state).calendar;
    const lines = items.map(item => `${item.dueDate} around ${formatLocal(item.dueAt, config.TIMEZONE)} — ${item.value}`);
    await sendBubble(chatId, lines.length ? `calendar:\n${lines.join('\n')}` : 'calendar is empty. tell me what is happening and when', replyToId);
    return true;
  }
  if (action === 'done') {
    const count = memory.completeMemory(state, command.args); saveState(state); await sendBubble(chatId, count ? `done. closed ${count} item${count === 1 ? '' : 's'}` : 'i couldnt find an open promise or task matching that', replyToId); return true;
  }
  if (action === 'sleep') {
    const s = sleepStateAt(new Date()); await sendBubble(chatId, s.asleep ? `im asleep until about ${s.schedule.wakeTime}. queued messages wait for morning.` : `im awake right now. my next bed is around ${s.schedule?.bedtime || 'late tonight'}.`, replyToId); return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Incoming message orchestration
// -----------------------------------------------------------------------------

async function processMessage(message) {
  if (!isPrivateOwner(message)) return;
  if (!state.ownerUserId && !claimIfAllowed(message)) return;
  if (state.ownerChatId && String(message.chat.id) !== String(state.ownerChatId)) return;
  state.ownerChatId = String(message.chat.id);
  if (message.message_id) {
    state.inboundMessageIds = [...new Set([...(state.inboundMessageIds || []), String(message.message_id)])].slice(-1000);
    saveState(state);
  }
  const text = inboundText(message);
  appendLog(`[msg] ${message.chat.id} (reply to ${message.reply_to_message?.message_id || '-' }): ${safeText(text, 300)}`);
  const command = commandOf(message.text || '');
  const action = command ? command.name.replace(/^[!/]/, '') : '';
  const forceCommand = Boolean(command && action === 'force');
  const waitRequest = !command ? timing.detectWaitForUser(text) : { active: false, reason: '' };
  if (waitingForUserActive()) clearWaitingForUser();
  // Mute/unmute are the two controls that remain available while frozen. Every
  // other command and every ordinary message stays silent but is persisted.
  if (command && (action === 'mute' || action === 'unmute')) {
    await handleCommand(message, command);
    return;
  }
  if (muteStatus().active && !forceCommand) {
    rememberMutedMessage(message, text);
    return;
  }
  if (command && await handleCommand(message, command)) return;
  // A command-shaped message must never silently become an AI prompt. The
  // only exception is /force and !force, whose purpose is to deliberately
  // send the remaining text through the normal reply generator immediately,
  // including while sleep, mute, or waiting mode would otherwise block it.
  if (command && command.name.replace(/^[!/]/, '') !== 'force') {
    await sendBubble(state.ownerChatId, `i dont know that command. try /help or !help`, message.message_id || null);
    return;
  }
  const force = /^[!/]+force\b/i.test(text);
  const actualText = text.replace(/^[!/]+force\s*/i, '').trim() || 'reply to the context of my latest message';
  const conversationTurn = conversation.observeUser(state, actualText);
  const explicit = memory.rememberExplicit(state, actualText, config.TIMEZONE);
  if (explicit.facts.length || explicit.promises.length || explicit.calendar.length) saveState(state);
  const stayUpRequested = timing.detectStayUpRequest(actualText);
  const stayedUpLonger = stayUpRequested ? extendBedtimeForUser() : false;
  const sleepState = sleepStateAt(new Date());
  if (waitRequest.active) {
    await enterWaitingForUser(message, actualText, waitRequest, sleepState.asleep);
    return;
  }
  if (sleepState.asleep && !force) { queueOvernight({ ...message, text: actualText, caption: message.caption }); return; }
  const reactionRequested = isReactionRequest(actualText);
  const reactionSent = (!command || command.name.replace(/^[!/]/, '') === 'force')
    ? await maybeReactToMessage(message, actualText)
    : false;
  const reactionNote = reactionRequested
    ? reactionSent
      ? 'A Telegram emoji reaction was actually sent to his message. Do not invent a different reaction or claim more than that.'
      : 'No Telegram emoji reaction was sent successfully. Do not claim that you reacted; answer him normally.'
    : '';
  let media = null;
  if (hasSupportedMedia(message)) {
    try { media = await prepareMedia(message, { downloadFile }); }
    catch (error) { appendLog(`[media] ${error.message}`); media = { mediaContext: `MEDIA PROCESSING FAILED: ${safeText(error.message, 500)}. React to what he wrote, but do not pretend you saw the media.` }; }
  }
  const previousInboundAt = state.lastInboundAt;
  state.lastInboundAt = nowIso();
  state.mood = timing.moodForMessage(actualText, state);
  const plan = timing.planReply({ now: new Date(), timeZone: config.TIMEZONE, messageCount: state.history.filter(x => x.role === 'user').slice(-5).length, lastInboundAt: previousInboundAt, force, intent: conversationTurn.intent, text: actualText, ...sleepTimingOptions() });
  if (plan.mode === 'ignore') { memory.addUnanswered(state, { messageId: message.message_id, text: actualText, kind: media?.kind || 'text' }); saveState(state); return; }
  if (plan.delayMs > 0 && !force) {
    if (plan.mode === 'later' && Math.random() < 0.24) {
      const busy = pick(['im in the middle of something, dont vanish while im gone', 'busy for a bit. i saw this though, so dont think you escaped me', `give me a minute, ${userNickname()}. my day decided to become annoying`]);
      const sentBusy = await sendBubble(state.ownerChatId, busy, message.message_id);
      const busyBucket = usage.createBucket('busy');
      for (const item of sentBusy) { usage.bindMessage(item.message_id, busyBucket); memory.addHistory(state, 'assistant', busy, { telegramMessageId: item.message_id, kind: 'busy_ack', bucketId: busyBucket }); }
      if (sentBusy.length) conversation.observeAssistant(state, busy);
      saveState(state);
    }
    queueScheduled({ ...message, text: actualText, caption: message.caption }, media, force, plan); return;
  }
  saveState(state);
  const extraNotes = [
    explicit.facts.length ? 'He explicitly asked you to remember something in this message. Acknowledge it naturally without sounding like a database.' : '',
    stayUpRequested ? (stayedUpLonger
      ? 'He asked you not to go to sleep yet. Stay awake about 15 extra minutes tonight only, acknowledge that naturally, and do not promise a permanent schedule change.'
      : 'He asked you not to go to sleep yet, but you already gave him the small extra bedtime extension available tonight. Acknowledge him warmly without extending it again.') : '',
    reactionNote
  ].filter(Boolean).join(' ');
  await buildAndSend({ message, text: actualText, media, force, replyMode: plan.mode, replyToId: message.message_id, extraNote: extraNotes });
}

// -----------------------------------------------------------------------------
// Scheduler: queued replies, reminders, proactive messages, and sleep notices
// -----------------------------------------------------------------------------

async function processOvernight() {
  if (muteStatus().active) return;
  if (waitingForUserActive()) return;
  const sleepState = sleepStateAt(new Date());
  if (sleepState.asleep || !state.overnight.length) return;
  const batch = state.overnight.splice(0, state.overnight.length);
  saveState(state);
  const text = batch.map(item => item.text).join('\n');
  const last = batch.at(-1);
  let media = null;
  if (last?.message && hasSupportedMedia(last.message)) {
    try { media = await prepareMedia(last.message, { downloadFile }); } catch (error) { appendLog(`[media] morning processing: ${error.message}`); }
  }
  try {
    const sent = await buildAndSend({ message: last.message, text: `You just woke up. While you were asleep I sent:\n${text}`, media, morning: true, replyToId: last.messageId, extraNote: 'This is the first morning catch-up after sleeping. Be natural, not overly apologetic.' });
    if (!sent.length) {
      state.overnight = [...batch, ...state.overnight].slice(-40);
      saveState(state);
      appendLog('[sleep] kept the morning queue because no Telegram message was sent');
    }
  } catch (error) {
    state.overnight = [...batch, ...state.overnight].slice(-40);
    saveState(state);
    appendLog(`[sleep] restored the morning queue after failure: ${error.message}`);
  }
}

async function processScheduled() {
  if (muteStatus().active) return;
  if (waitingForUserActive()) return;
  if (sleepStateAt(new Date()).asleep || !state.scheduledReplies.length) return;
  const now = Date.now();
  const due = state.scheduledReplies.filter(item => new Date(item.dueAt).getTime() <= now);
  if (!due.length) return;
  state.scheduledReplies = state.scheduledReplies.filter(item => new Date(item.dueAt).getTime() > now);
  saveState(state);
  const item = due.at(-1);
  const text = due.map(x => x.text).join('\n');
  let media = item.media;
  if (!media && hasSupportedMedia(item.message)) {
    try { media = await prepareMedia(item.message, { downloadFile }); } catch (error) { appendLog(`[media] delayed processing: ${error.message}`); }
  }
  try {
    const sent = await buildAndSend({ message: item.message, text, media, force: item.force, replyMode: item.mode, replyToId: item.message.message_id, extraNote: item.mode === 'later' ? 'You took a while to answer. Give a small human reason only if it fits; do not write a long apology.' : '' });
    if (!sent.length) {
      state.scheduledReplies = [...due, ...state.scheduledReplies].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()).slice(-30);
      saveState(state);
      appendLog('[timing] kept scheduled messages because no Telegram message was sent');
    }
  } catch (error) {
    state.scheduledReplies = [...due, ...state.scheduledReplies].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()).slice(-30);
    saveState(state);
    appendLog(`[timing] restored scheduled messages after failure: ${error.message}`);
  }
}

function ensureProactivePlan() {
  const today = localDateKey(new Date(), config.TIMEZONE);
  if (state.proactive.date === today && state.proactive.remaining > 0 && state.proactive.nextAt) return;
  if (state.proactive.date === today && state.proactive.remaining <= 0) return;
  const min = Math.min(config.DAILY_PROACTIVE_MIN, config.DAILY_PROACTIVE_MAX);
  const max = Math.max(min, config.DAILY_PROACTIVE_MAX);
  const count = min + Math.floor(Math.random() * (max - min + 1));
  state.proactive = { date: today, remaining: count, nextAt: timing.nextProactiveAt(new Date(), config.TIMEZONE, today), sent: 0 };
  saveState(state);
}

async function processDueReminders() {
  if (muteStatus().active) return false;
  if (waitingForUserActive()) return false;
  if (!state.ownerChatId || sleepStateAt(new Date()).asleep) return false;
  const due = memory.pendingReminders(state);
  if (!due.length) return false;
  const details = due.map(item => `${item.value} on ${item.dueDate || item.dueLabel || 'now'}`).join('; ');
  const sent = await buildAndSend({
    proactive: true,
    text: '',
    extraNote: `A real calendar reminder is due now: ${details}. Bring it up naturally and help him act on it. Do not mention internal fields or say this is an automated job.`
  });
  if (sent.length && markRemindersNotified(due)) saveState(state);
  return sent.length > 0;
}

async function processProactive() {
  if (muteStatus().active) return;
  if (waitingForUserActive()) return;
  if (!state.ownerChatId || sleepStateAt(new Date()).asleep) return;
  // A spontaneous message should not interrupt an active back-and-forth. The
  // daily plan remains intact and can continue once the conversation quiets.
  if (state.lastInboundAt && Date.now() - new Date(state.lastInboundAt).getTime() < timing.ACTIVE_CHAT_WINDOW_MS) return;
  ensureProactivePlan();
  if (!state.proactive.remaining || !state.proactive.nextAt || Date.now() < new Date(state.proactive.nextAt).getTime()) return;
  const diary = pick(['coffee went wrong in a very personal way', 'i found a song that got stuck in my head', 'i started cleaning and made the mess worse', 'i kept thinking about something you said', 'i had a suspiciously dramatic snack break', 'i saw something that reminded me of you']);
  const sent = await buildAndSend({ proactive: true, text: '', extraNote: diary });
  if (sent.length) {
    state.proactive.remaining--;
    state.proactive.sent++;
    state.proactive.nextAt = state.proactive.remaining ? timing.nextProactiveAt(new Date(Date.now() + 45 * 60 * 1000), config.TIMEZONE) : null;
    saveState(state);
  }
}

async function processSleepNotices() {
  if (muteStatus().active) return;
  if (waitingForUserActive()) return;
  if (!state.ownerChatId) return;
  const now = new Date();
  const sleep = sleepStateAt(now);
  const schedule = sleep.schedule;
  if (!schedule) return;
  const beforeBed = timing.untilBedMs(now, config.TIMEZONE, sleepTimingOptions(now));
  if (!sleep.asleep && beforeBed > 0 && beforeBed <= 20 * 60 * 1000 && state.sleepNotice.date !== schedule.dateKey) {
    const bucket = usage.createBucket('sleep_notice');
    const minutes = Math.max(1, Math.ceil(beforeBed / 60_000));
    const text = `im getting sleepy. im heading to bed around ${schedule.bedtime}, and ill probably wake up around ${schedule.wakeTime}. weve got about ${minutes} minutes if you want a little before-bed conversation. if you text after i fall asleep, ill find it when i wake up`;
    const sent = await sendBubble(state.ownerChatId, text);
    for (const item of sent) usage.bindMessage(item.message_id, bucket);
    if (sent.length) {
      memory.addHistory(state, 'assistant', text, { kind: 'sleep_notice', bucketId: bucket });
      conversation.observeAssistant(state, text);
      state.sleepNotice = { date: schedule.dateKey, bedtimeSent: true, goodnightSent: false, wakeKey: null };
      saveState(state);
    }
    return;
  }
  if (sleep.asleep && (state.sleepNotice.date !== schedule.dateKey || !state.sleepNotice.goodnightSent)) {
    const bucket = usage.createBucket('goodnight_notice');
    const text = pick([
      `okay, im actually going to sleep now. good night, ${userNickname()}. sleep well, and ill talk to you when im up again`,
      `im off to sleep now. good night, sleep well, okay? ill find anything you send when i wake up`,
      `alright, bedtime won. good night. get some proper sleep too, and ill be here tomorrow`
    ]);
    const sent = await sendBubble(state.ownerChatId, text);
    for (const item of sent) usage.bindMessage(item.message_id, bucket);
    if (sent.length) {
      memory.addHistory(state, 'assistant', text, { kind: 'goodnight_notice', bucketId: bucket });
      conversation.observeAssistant(state, text);
      state.sleepNotice = { date: schedule.dateKey, bedtimeSent: state.sleepNotice.date === schedule.dateKey, goodnightSent: true, wakeKey: null };
      saveState(state);
    }
    return;
  }
  const sinceWake = timing.sinceWakeMs(now, config.TIMEZONE, sleepTimingOptions(now));
  if (!sleep.asleep && sinceWake <= 90 * 60 * 1000 && state.sleepNotice.wakeKey !== schedule.dateKey) {
    const bucket = usage.createBucket('wake_notice');
    const text = pick(['im awake now. still negotiating with my brain, but im here', `morning, ${userNickname()}. i am technically a person again`, 'im up. give me a minute before you judge the quality of my thoughts']);
    const sent = await sendBubble(state.ownerChatId, text);
    for (const item of sent) usage.bindMessage(item.message_id, bucket);
    if (sent.length) {
      memory.addHistory(state, 'assistant', text, { kind: 'wake_notice', bucketId: bucket });
      conversation.observeAssistant(state, text);
      state.sleepNotice = { date: schedule.dateKey, bedtimeSent: state.sleepNotice.date === schedule.dateKey, goodnightSent: state.sleepNotice.goodnightSent, wakeKey: schedule.dateKey };
      saveState(state);
    }
  }
}

async function schedulerTick() {
  if (schedulerBusy || !running) return;
  schedulerBusy = true;
  try { touchHeartbeat({ ownerChatId: state?.ownerChatId || null }); await processSleepNotices(); await processOvernight(); await processScheduled(); await processDueReminders(); await processProactive(); } catch (error) { appendLog(`[scheduler] ${error.stack || error.message}`); }
  finally { schedulerBusy = false; }
}

// -----------------------------------------------------------------------------
// Long-polling and Telegram command registration
// -----------------------------------------------------------------------------

async function poll() {
  while (running) {
    try {
      const updates = await apiCall('getUpdates', { offset: Number(state.telegramOffset || 0), timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        state.telegramOffset = Number(update.update_id) + 1; saveState(state);
        if (update.message) await processMessage(update.message);
      }
    } catch (error) { appendLog(`[poll] ${error.message}`); await sleep(5000); }
  }
}

async function setupTelegram() {
  try {
    await apiCall('setMyCommands', { commands: [
      { command: 'start', description: 'fresh chat; saved memory stays' },
      { command: 'help', description: 'show what she can do' },
      { command: 'commands', description: 'show every available command' },
      { command: 'talk', description: 'start a fresh conversation topic' },
      { command: 'clear', description: 'clear recorded chat messages (needs yes)' },
      { command: 'forgetall', description: 'erase learned memory (needs yes)' },
      { command: 'mood', description: 'show or change her slight emotional style' },
      { command: 'repair', description: 'repair a misunderstanding' },
      { command: 'listen', description: 'listen without solving' },
      { command: 'advice', description: 'give direct advice' },
      { command: 'subject', description: 'change the conversation subject' },
      { command: 'caring', description: 'make her slightly more caring' },
      { command: 'tsundere', description: 'make her slightly tsundere' },
      { command: 'normal', description: 'return to normal automatic moods' },
      { command: 'remember', description: 'save a fact or promise' },
      { command: 'forget', description: 'remove matching saved facts' },
      { command: 'promises', description: 'show open promises and tasks' },
      { command: 'tasks', description: 'show open promises and tasks' },
      { command: 'calendar', description: 'show remembered dates and plans' },
      { command: 'done', description: 'close a promise or task' },
      { command: 'status', description: 'ask how she feels right now' },
      { command: 'sleep', description: 'show the sleep and wake window' },
      { command: 'mute', description: 'pause replies for a number of minutes' },
      { command: 'unmute', description: 'resume replies early' },
      { command: 'token', description: 'show usage for a replied message' },
      { command: 'tokens', description: 'show usage for a replied message' },
      { command: 'usage', description: 'show usage for the latest reply' },
      { command: 'cost', description: 'show usage for the latest reply' },
      { command: 'spend', description: 'show usage for the latest reply' },
      { command: 'tokenall', description: 'show lifetime usage' },
      { command: 'estimateall', description: 'show cumulative usage across all conversations' },
      { command: 'estimate', description: 'estimate text, photo, and memory cost' },
      { command: 'force', description: 'answer immediately even during sleep or mute' }
    ] });
  } catch (error) { appendLog(`[telegram] command menu: ${error.message}`); }
}

async function main() {
  loadDotEnv();
  requireConfig();
  ensureDirs();
  acquireLock();
  state = loadState();
  memory.ensureMemoryShape(state);
  conversation.ensureConversation(state);
  // Persist schema upgrades/default collections (including the calendar)
  // without replacing any existing memory, history, or usage data.
  saveState(state);
  if (config.TELEGRAM_OWNER_ID && !state.ownerUserId) { state.ownerUserId = config.TELEGRAM_OWNER_ID; saveState(state); }
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });
  process.on('exit', releaseLock);
  await setupTelegram();
  appendLog(`[boot] ${config.DISPLAY_NAME} running; models=${config.DEEPSEEK_MODELS.join(',')} timezone=${config.TIMEZONE}`);
  setInterval(() => schedulerTick().catch(() => {}), 10_000);
  await poll();
}

if (require.main === module) main().catch(error => { appendLog(`[fatal] ${error.stack || error.message}`); releaseLock(); console.error(error.message); process.exitCode = 1; });

module.exports = { commandOf, parseMuteMinutes, replyContext, inboundText, hasSupportedMedia, reactionForMessage, telegramHelp, splitBubbles: style.splitBubbles, processMessage, queueOvernight, main };
