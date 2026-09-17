const { localParts, localDateKey, seededRandom, clamp, hashString } = require('./util');

// Pure local-time decisions. This module does not write state or send
// messages, which makes sleep and delay behavior straightforward to test.

const DEFAULTS = {
  instant: 0.22, short: 0.36, long: 0.20, later: 0.14, ignore: 0.08,
  busyChance: 0.08, maxWakingDelayMs: 25 * 60 * 1000
};

// When he is actively going back and forth, she should feel present in the
// chat. The slow human gaps still apply after the conversation has gone quiet.
const ACTIVE_CHAT_WINDOW_MS = 20 * 60 * 1000;
const ACTIVE_RANGES = {
  instant: [500, 2_500],
  short: [2_500, 10_000],
  long: [10_000, 30_000],
  later: [30_000, 90_000],
  ignore: [0, 0]
};

// --- Deterministic local sleep windows ----------------------------------------

function shiftDateKey(key, days) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function scheduleForDate(dateKey, random = seededRandom(`sleep:${dateKey}`)) {
  const bedtime = 23 * 60 + Math.floor(random() * 195) - 15; // 22:45–02:00
  const wake = 7 * 60 + Math.floor(random() * 180); // 07:00–10:00
  const bedDayOffset = bedtime >= 1440 ? 1 : 0;
  const bedDate = shiftDateKey(dateKey, bedDayOffset);
  const wakeDate = shiftDateKey(dateKey, bedDayOffset ? 1 : 1);
  return {
    dateKey, bedtimeMinute: bedtime, wakeMinute: wake,
    bedDate, wakeDate,
    bedtime: `${String(Math.floor(bedtime % 1440 / 60)).padStart(2, '0')}:${String(bedtime % 60).padStart(2, '0')}`,
    wakeTime: `${String(Math.floor(wake / 60)).padStart(2, '0')}:${String(wake % 60).padStart(2, '0')}`
  };
}

function withBedtimeExtension(schedule, minutes = 0) {
  const extra = Math.max(0, Math.min(60, Number(minutes) || 0));
  if (!extra) return schedule;
  const bedtimeMinute = schedule.bedtimeMinute + extra;
  const bedDate = shiftDateKey(schedule.dateKey, bedtimeMinute >= 1440 ? 1 : 0);
  return {
    ...schedule,
    bedtimeMinute,
    bedDate,
    bedtime: `${String(Math.floor(bedtimeMinute % 1440 / 60)).padStart(2, '0')}:${String(bedtimeMinute % 60).padStart(2, '0')}`
  };
}

function scheduleMatchesNow(schedule, parts) {
  const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const minute = parts.hour * 60 + parts.minute;
  if (schedule.bedDate === schedule.wakeDate && key === schedule.bedDate) return minute >= schedule.bedtimeMinute % 1440 && minute < schedule.wakeMinute;
  if (key === schedule.bedDate && minute >= schedule.bedtimeMinute % 1440) return true;
  if (key === schedule.wakeDate && minute < schedule.wakeMinute) return true;
  return false;
}

function getSleepState(now = new Date(), timeZone = 'Europe/Berlin', { bedtimeExtensionMinutes = 0, bedtimeExtensionDate = null } = {}) {
  const forced = process.env.NEGEV_FORCE_SLEEP;
  const parts = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const schedules = [scheduleForDate(today), scheduleForDate(shiftDateKey(today, -1))]
    .map(schedule => (!bedtimeExtensionDate || schedule.dateKey === bedtimeExtensionDate)
      ? withBedtimeExtension(schedule, bedtimeExtensionMinutes)
      : schedule);
  let schedule = schedules.find(item => scheduleMatchesNow(item, parts));
  if (forced === 'awake') return { asleep: false, forced, schedule: null, reason: 'forced awake' };
  if (forced === 'asleep' || forced === 'bedtime') {
    const selected = schedule || schedules[0];
    return { asleep: true, forced, schedule: selected, reason: 'she is asleep' };
  }
  if (forced === 'justup') return { asleep: false, justUp: true, schedule: schedules[0], reason: 'she just woke up' };
  if (!schedule) {
    if (bedtimeExtensionDate) {
      const extensionSchedule = schedules.find(item => item.dateKey === bedtimeExtensionDate);
      const minute = parts.hour * 60 + parts.minute;
      const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      if (extensionSchedule && key === extensionSchedule.bedDate && minute < extensionSchedule.bedtimeMinute % 1440) {
        return { asleep: false, justWoke: false, schedule: extensionSchedule, reason: 'awake; bedtime extension is active' };
      }
    }
  }
  if (!schedule) {
    const wakeElapsed = parts.hour * 60 + parts.minute - schedules[1].wakeMinute;
    const recentlyWoke = schedules[1].wakeDate === today && wakeElapsed >= 0 && wakeElapsed <= 90;
    schedule = recentlyWoke ? schedules[1] : schedules[0];
    return { asleep: false, justWoke: recentlyWoke, schedule, reason: recentlyWoke ? 'just woke up' : 'awake' };
  }
  return { asleep: true, schedule, reason: `asleep until ${schedule.wakeTime}` };
}

function untilWakeMs(now = new Date(), timeZone = 'Europe/Berlin', options = {}) {
  const state = getSleepState(now, timeZone, options);
  if (!state.asleep || !state.schedule) return 0;
  const p = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const days = state.schedule.wakeDate === today ? 0 : 1;
  const currentMinute = p.hour * 60 + p.minute + p.second / 60;
  let delta = days * 24 * 60 + state.schedule.wakeMinute - currentMinute;
  if (delta < 0) delta += 24 * 60;
  return Math.max(0, Math.round(delta * 60 * 1000));
}

function untilBedMs(now = new Date(), timeZone = 'Europe/Berlin', options = {}) {
  const sleep = getSleepState(now, timeZone, options);
  if (sleep.asleep || !sleep.schedule) return 0;
  const p = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  const bedDate = sleep.schedule.bedDate;
  const currentMinute = p.hour * 60 + p.minute + p.second / 60;
  let days = bedDate === today ? 0 : 1;
  let delta = days * 24 * 60 + (sleep.schedule.bedtimeMinute % 1440) - currentMinute;
  if (delta < 0) delta += 24 * 60;
  return Math.max(0, Math.round(delta * 60 * 1000));
}

function sinceWakeMs(now = new Date(), timeZone = 'Europe/Berlin', options = {}) {
  const sleep = getSleepState(now, timeZone, options);
  if (!sleep.schedule) return Infinity;
  const p = localParts(now, timeZone);
  const today = localDateKey(now, timeZone);
  if (today !== sleep.schedule.wakeDate) return Infinity;
  return Math.max(0, Math.round((p.hour * 60 + p.minute + p.second / 60 - sleep.schedule.wakeMinute) * 60 * 1000));
}

function detectWaitForUser(text) {
  const value = String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!value) return { active: false, reason: '' };
  const explanatory = /\b(?:to|so i can)\s+(?:explain|answer|tell|show|ask)\b/.test(value);
  const timeRequest = !explanatory && (
    /\b(?:give|need|want|take|taking|let me have)\b.{0,35}\b(?:time|space|while|moment|minute|minutes|hour|hours)\b/.test(value) ||
    /\b(?:for|just)\s+(?:a\s+)?(?:bit|while|moment)\b/.test(value)
  );
  const pauseActivity = /\b(?:rest(?:ing)?|sleep(?:ing)?|nap(?:ping)?|break|chill(?:ing)?|relax(?:ing)?|unwind(?:ing)?|focus(?:ing)?|offline|away|busy|step away|lie down)\b/.test(value);
  const returnSignal = /(?:\b(?:text|write|message|reply|talk|speak)\b.{0,30}\b(?:later|when|once|after|ready|back)\b|\b(?:when|once|until)\b.{0,35}\b(?:text|write|message|reply|come back|be back|ready)\b|\b(?:i(?:'ll| will)|ill)\s+(?:be|come)\s+back\b)/.test(value);
  const explicitWait = /\b(?:wait(?:\s+(?:till|until|for))?|leave me(?: alone)?|let me be|don't\s+(?:text|message|write|call|bother)|do not\s+(?:text|message|write|call|bother)|no rush)\b/.test(value);
  const directSilence = /\b(?:not in the mood to talk|don't feel like talking|do not feel like talking|need to be alone|ill come back later|i'll come back later|text you later|talk later)\b/.test(value);
  const active = returnSignal || timeRequest || directSilence || (pauseActivity && explicitWait);
  return {
    active,
    reason: active ? 'he asked for time or space and will come back when he is ready' : ''
  };
}

// --- Natural interaction requests and reply timing ----------------------------

function detectStayUpRequest(text) {
  const value = String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return /\b(?:don't|dont|do not)\s+(?:go\s+to\s+sleep|sleep|go\s+to\s+bed|fall\s+asleep)\b/.test(value)
    || /\b(?:stay|keep)\s+(?:up|awake)\b/.test(value)
    || /\b(?:stay|be)\s+(?:up|awake)\s+with\s+me\b/.test(value)
    || /\b(?:wait|hold on)\b.{0,35}\b(?:before you sleep|before bed|until morning)\b/.test(value);
}

function planReply({ now = new Date(), timeZone = 'Europe/Berlin', messageCount = 1, lastInboundAt = null, force = false, random = Math.random, intent = 'casual', text = '', bedtimeExtensionMinutes = 0 } = {}) {
  const sleep = getSleepState(now, timeZone, { bedtimeExtensionMinutes });
  if (sleep.asleep) return { mode: 'sleep', delayMs: untilWakeMs(now, timeZone), sleep, reason: sleep.reason };
  if (force) return { mode: 'instant', delayMs: 0, sleep, reason: 'forced reply' };
  const active = lastInboundAt && now.getTime() - new Date(lastInboundAt).getTime() < ACTIVE_CHAT_WINDOW_MS;
  const urgent = ['emotional_support', 'motivation', 'repair', 'listen'].includes(intent)
    || /\b(?:help|scared|panic|crisis|hurt|overwhelmed|please answer|are you there)\b/i.test(String(text || ''));
  const complex = String(text || '').length > 700 || String(text || '').split(/\n+/).length >= 4;
  const weights = urgent
    ? { instant: 0.72, short: 0.25, long: 0.03, later: 0, ignore: 0 }
    : active ? { instant: 0.60, short: 0.35, long: 0.05, later: 0, ignore: 0 } : {
      instant: DEFAULTS.instant, short: DEFAULTS.short, long: DEFAULTS.long,
      later: DEFAULTS.later, ignore: DEFAULTS.ignore
    };
  if (messageCount >= 5) {
    if (urgent) {
      weights.instant = 0.78; weights.short = 0.20; weights.long = 0.02; weights.later = 0; weights.ignore = 0;
    } else if (active) {
      weights.instant = 0.45; weights.short = 0.45; weights.long = 0.10; weights.later = 0; weights.ignore = 0;
    } else {
      weights.instant = 0.08; weights.short = 0.40; weights.long = 0.31; weights.later = 0.18; weights.ignore = 0.03;
    }
  }
  if (complex && !urgent) {
    weights.instant *= 0.65;
    weights.short += 0.10;
    weights.long += 0.15;
  }
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  for (const key of Object.keys(weights)) weights[key] /= totalWeight;
  let n = random();
  let mode = 'short';
  for (const [candidate, weight] of Object.entries(weights)) { n -= weight; if (n <= 0) { mode = candidate; break; } }
  const ranges = active ? ACTIVE_RANGES : { instant: [1000, 5000], short: [10_000, 150_000], long: [120_000, 1_200_000], later: [1_200_000, 4_500_000], ignore: [0, 0] };
  const [min, max] = ranges[mode];
  const delayMs = max ? Math.min(DEFAULTS.maxWakingDelayMs, Math.round(min + random() * (max - min))) : 0;
  return { mode, delayMs, sleep, reason: mode === 'ignore' ? 'she saw it and is quiet for now' : urgent ? `quick ${mode} reply because the message needs presence` : `${mode} reply` };
}

function nextProactiveAt(now = new Date(), timeZone = 'Europe/Berlin', seed = localDateKey(now, timeZone), random = seededRandom(`proactive:${seed}`)) {
  const p = localParts(now, timeZone);
  const base = new Date(now.getTime());
  const hour = p.hour;
  const targetMinute = Math.floor(random() * 60);
  let deltaMinutes;
  if (hour < 9) {
    const targetHour = 9 + Math.floor(random() * 3);
    deltaMinutes = (targetHour - hour) * 60 + targetMinute - p.minute;
  } else if (hour >= 22) {
    const targetHour = 9 + Math.floor(random() * 3);
    deltaMinutes = ((24 - hour) * 60 - p.minute) + targetHour * 60 + targetMinute;
  } else {
    const targetHour = Math.min(22, hour + 1 + Math.floor(random() * 3));
    deltaMinutes = (targetHour - hour) * 60 + targetMinute - p.minute;
    if (deltaMinutes <= 0) deltaMinutes += 60;
  }
  const deltaMs = Math.max(30_000, deltaMinutes * 60_000);
  return new Date(base.getTime() + deltaMs).toISOString();
}

function moodForMessage(text, state = {}, random = Math.random) {
  if (state.mood?.forced && state.mood.name) return state.mood;
  const lower = String(text || '').toLowerCase();
  const current = state.mood && state.mood.name ? state.mood : 'soft';
  const cues = [
    { pattern: /sorry|rough|bad day|tired|sad|hurt|stressed|overwhelmed/, choices: ['soft', 'caring', 'warm'], reason: 'his words sounded like they needed gentleness', chance: 0.66 },
    { pattern: /lol|lmao|xdd|joke|funny|laughed|laughing/, choices: ['playful', 'warm', 'soft'], reason: 'his words pulled her toward a lighter mood', chance: 0.54 },
    { pattern: /ignore|busy|later|forgot|quiet today/, choices: ['sulky', 'soft', 'playful'], reason: 'she may have felt briefly overlooked', chance: 0.42 },
    { pattern: /love|miss|cute|pretty|thank you|thanks|proud of you/, choices: ['warm', 'caring', 'playful'], reason: 'his affection landed somewhere warm', chance: 0.58 },
    { pattern: /angry|annoyed|hate|wtf|frustrated/, choices: ['soft', 'sulky', 'caring'], reason: 'the conversation carried a sharper edge', chance: 0.38 }
  ];
  const cue = cues.find(item => item.pattern.test(lower));
  const elapsed = state.mood?.changedAt ? Date.now() - new Date(state.mood.changedAt).getTime() : Infinity;
  // A mood can drift from repeated conversation cues, but it should not flip
  // every message. Recent changes need a cooling-off period; strong cues can
  // still influence the next reply through the prompt without forcing a swap.
  const cooldown = elapsed >= 30 * 60 * 1000 ? 1 : elapsed >= 8 * 60 * 1000 ? 0.65 : 0.18;
  const chance = (cue?.chance || 0.07) * cooldown;
  // Mood is intentionally probabilistic: a cue can influence her without
  // forcing a visible switch, and a quiet conversation can still drift a bit.
  if (random() >= chance) return state.mood && state.mood.name ? state.mood : { name: 'soft', reason: 'ordinary day', forced: false };
  const choices = (cue?.choices || ['soft', 'warm', 'playful', 'caring', 'sulky']).filter(name => name !== current);
  if (!choices.length) return state.mood && state.mood.name ? state.mood : { name: current, reason: 'ordinary day', forced: false };
  const name = choices[Math.floor(random() * choices.length) % choices.length];
  return { name, reason: cue?.reason || 'something small in the day shifted her mood', forced: false, changedAt: new Date().toISOString() };
}

module.exports = {
  DEFAULTS, ACTIVE_CHAT_WINDOW_MS, ACTIVE_RANGES, shiftDateKey, scheduleForDate, getSleepState, untilWakeMs,
  untilBedMs, sinceWakeMs, detectWaitForUser, detectStayUpRequest, planReply, nextProactiveAt, moodForMessage
};
