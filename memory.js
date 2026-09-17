const { id, nowIso, safeText, stripEmoji, localDateKey, localParts, formatLocal } = require('./util');

// Durable user data: explicit facts, promises, tasks, calendar references,
// rolling history, and the small amount of memory context sent to the model.

function ensureMemoryShape(state) {
  state.history = Array.isArray(state.history) ? state.history : [];
  state.facts = Array.isArray(state.facts) ? state.facts : [];
  state.promises = Array.isArray(state.promises) ? state.promises : [];
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.calendar = Array.isArray(state.calendar) ? state.calendar : [];
  state.unanswered = Array.isArray(state.unanswered) ? state.unanswered : [];
  for (const item of state.facts) backfillConfidence(item, 1);
  for (const item of state.promises) backfillConfidence(item, item.speaker === 'negev' ? 0.72 : 0.88);
  for (const item of state.tasks) backfillConfidence(item, 0.88);
  for (const item of state.calendar) backfillConfidence(item, item.speaker === 'negev' ? 0.72 : 0.84);
  // Older versions recorded every casual "today/tomorrow" mention from her
  // own conversation as a reminder. Keep genuine plans, but discard only
  // those non-actionable conversation entries when the state is touched.
  state.calendar = state.calendar.filter(item => item && (item.source !== 'conversation' || item.speaker !== 'negev' || hasCalendarIntent(item.value)));
  return state;
}

// --- Text extraction and natural date parsing --------------------------------

function backfillConfidence(item, fallback) {
  if (!item || typeof item !== 'object') return;
  const value = Number(item.confidence);
  if (!Number.isFinite(value)) item.confidence = fallback;
  if (!item.lastConfirmedAt) item.lastConfirmedAt = item.updatedAt || item.createdAt || item.pinnedAt || nowIso();
}

function confidenceNote(item) {
  return Number(item?.confidence) < 0.75 ? ' (tentative)' : '';
}

function cleanMemoryText(text) {
  return stripEmoji(safeText(text, 700)).replace(/\s+/g, ' ').trim();
}

function splitClauses(text) {
  const cleaned = cleanMemoryText(text).replace(/[.!?]+$/, '').trim();
  if (!cleaned) return [];
  const pieces = cleaned.split(/\s+(?=and\s+(?:my|our|the|on|at|to|i|we|she|he)\b)/i);
  return pieces.map(s => s.replace(/^and\s+/i, '').trim()).filter(Boolean);
}

function parseRemember(text) {
  const raw = cleanMemoryText(text);
  const match = raw.match(/^(?:please\s+)?(?:remember|dont forget|don't forget)\s+(?:that\s+)?(.+)$/i);
  if (!match || /^(?:ed|ing)\b/i.test(match[1])) return [];
  return splitClauses(match[1]).map(value => ({ type: 'fact', value }));
}

function parsePromise(text) {
  const raw = cleanMemoryText(text);
  const results = [];
  const promise = raw.match(/\b(?:i\s+promise|i(?:'|’)ll|i\s+will|i(?:'|’)m\s+going\s+to|i\s+am\s+going\s+to)\s+(.+)/i);
  if (promise && promise[1].length > 2) {
    results.push({ type: 'promise', value: promise[1].replace(/[.!?]+$/, '').trim(), source: raw });
  }
  const task = raw.match(/^(?:please\s+)?(?:remind me to|i need to|i have to|we should|also i need to|and i need to)\s+(.+)$/i);
  if (task && task[1].length > 2) results.push({ type: 'task', value: task[1].replace(/[.!?]+$/, '').trim(), source: raw });
  return results;
}

function shiftDateKey(key, days) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// --- Durable memory writes and rolling history --------------------------------

function localWallTime(dateKey, hour, minute, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  // Convert a wall-clock date in the configured zone to UTC. Two passes handle
  // normal offsets and daylight-saving transitions without extra packages.
  for (let pass = 0; pass < 3; pass++) {
    const actual = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12
};
const NUMBER_WORDS = {
  zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  couple: 2, few: 3, several: 3
};
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_PATTERN = WEEKDAYS.join('|');
const QUANTITY_PATTERN = '(?:a couple of|a few|half an?|half a|couple of|few|several|\\d+(?:\\.\\d+)?|[a-z]+)';

function parseQuantity(value) {
  const raw = String(value || '').toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (/^half(?: an?| a)?$/.test(raw)) return 0.5;
  if (/^(?:a )?couple(?: of)?$/.test(raw)) return 2;
  if (/^(?:a )?few$/.test(raw)) return 3;
  if (NUMBER_WORDS[raw] !== undefined) return NUMBER_WORDS[raw];
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const words = raw.split(' ');
  if (words.length === 2 && NUMBER_WORDS[words[0]] !== undefined && NUMBER_WORDS[words[1]] !== undefined) {
    return NUMBER_WORDS[words[0]] + NUMBER_WORDS[words[1]];
  }
  return null;
}

function validDateKey(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addMonthsDateKey(key, months, requestedDay = null) {
  const base = new Date(`${key}T12:00:00Z`);
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 12)).getUTCDate();
  const day = Math.min(Number(requestedDay || 1), lastDay);
  return validDateKey(base.getUTCFullYear(), base.getUTCMonth() + 1, day);
}

function parseClock(text) {
  const raw = String(text || '').toLowerCase();
  const explicit = raw.match(/\b(?:at|around|about|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
    || raw.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/)
    || raw.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (explicit) {
    let hour = Number(explicit[1]);
    const minute = Number(explicit[2] || 0);
    const meridiem = (explicit[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59 || (!meridiem && hour > 23)) return null;
    return { hour, minute };
  }
  if (/\b(?:midnight|12\s*am)\b/.test(raw)) return { hour: 0, minute: 0 };
  if (/\b(?:noon|midday|12\s*pm)\b/.test(raw)) return { hour: 12, minute: 0 };
  if (/\b(?:after lunch|right after lunch)\b/.test(raw)) return { hour: 14, minute: 0 };
  if (/\b(?:after work|after class|after school)\b/.test(raw)) return { hour: 18, minute: 0 };
  if (/\b(?:end of (?:the )?day|close of day)\b/.test(raw)) return { hour: 18, minute: 0 };
  if (/\b(?:first thing|early morning)\b/.test(raw)) return { hour: 8, minute: 0 };
  if (/\b(?:late morning)\b/.test(raw)) return { hour: 11, minute: 0 };
  if (/\b(?:morning|breakfast)\b/.test(raw)) return { hour: 9, minute: 0 };
  if (/\b(?:afternoon)\b/.test(raw)) return { hour: 15, minute: 0 };
  if (/\b(?:evening|dinner)\b/.test(raw)) return { hour: 18, minute: 0 };
  if (/\b(?:late night|late evening)\b/.test(raw)) return { hour: 23, minute: 0 };
  if (/\b(?:tonight|night)\b/.test(raw)) return { hour: 20, minute: 0 };
  if (/\b(?:lunchtime|lunch)\b/.test(raw)) return { hour: 12, minute: 0 };
  return null;
}

function weekdayDateKey(now, timeZone, weekdayName, mode = 'next') {
  const currentKey = localDateKey(now, timeZone);
  const target = WEEKDAYS.indexOf(String(weekdayName || '').toLowerCase());
  if (target < 0) return null;
  const current = new Date(`${currentKey}T12:00:00Z`).getUTCDay();
  let delta = (target - current + 7) % 7;
  if (!delta && mode === 'next') delta = 7;
  return shiftDateKey(currentKey, delta);
}

function relativeReference(quantityText, unitText, phrase, now, timeZone) {
  const quantity = parseQuantity(quantityText);
  const unit = String(unitText || '').toLowerCase();
  if (!quantity || quantity < 0) return null;
  const currentKey = localDateKey(now, timeZone);
  const normalizedUnit = unit.replace(/s$/, '');
  if (normalizedUnit === 'minute' || normalizedUnit === 'hour') {
    const ms = quantity * (normalizedUnit === 'minute' ? 60_000 : 3_600_000);
    const due = new Date(now.getTime() + ms);
    const parts = localParts(due, timeZone);
    return { label: phrase, dateKey: localDateKey(due, timeZone), defaultHour: parts.hour, defaultMinute: parts.minute, dueAtOverride: due.toISOString() };
  }
  const days = normalizedUnit === 'day' ? quantity
    : normalizedUnit === 'week' || normalizedUnit === 'fortnight' ? quantity * (normalizedUnit === 'fortnight' ? 14 : 7)
      : normalizedUnit === 'month' || normalizedUnit === 'year' ? null : quantity * 365;
  if (days !== null) return { label: phrase, dateKey: shiftDateKey(currentKey, Math.round(days)), defaultHour: 9 };
  if (normalizedUnit === 'month' || normalizedUnit === 'year') {
    const months = normalizedUnit === 'year' ? Math.max(1, Math.round(quantity * 12)) : Math.max(1, Math.round(quantity));
    return { label: phrase, dateKey: addMonthsDateKey(currentKey, months, localParts(now, timeZone).day), defaultHour: 9 };
  }
  return null;
}

function dateReference(text, now = new Date(), timeZone = 'Europe/Berlin') {
  const raw = String(text || '').trim();
  const value = raw.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
  if (!value) return null;
  const current = localParts(now, timeZone);
  const currentKey = localDateKey(now, timeZone);
  const make = (dateKey, label, defaults = {}) => dateKey ? { dateKey, label, defaultHour: defaults.hour ?? 9, defaultMinute: defaults.minute ?? 0, dueAtOverride: defaults.dueAtOverride || null } : null;

  // Exact machine-readable dates and ordinary written calendar dates.
  let match = value.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (match) return make(validDateKey(match[1], match[2], match[3]), match[0]);
  match = value.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/);
  if (match) return make(validDateKey(match[3], match[2], match[1]), match[0]);

  const monthDate = (month, day, year, label) => {
    let targetYear = year ? Number(year) : current.year;
    let key = validDateKey(targetYear, month, day);
    if (!key) return null;
    if (!year && key < currentKey) key = validDateKey(targetYear + 1, month, day);
    return make(key, label);
  };
  match = value.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i'))
    || value.match(new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})(?:,?\\s+(20\\d{2}))?\\b`, 'i'));
  if (match) {
    const monthFirst = MONTHS[match[1]] !== undefined;
    const month = MONTHS[monthFirst ? match[1] : match[2]];
    const day = Number(monthFirst ? match[2] : match[1]);
    const year = monthFirst ? match[3] : match[3];
    return monthDate(month, day, year, match[0]);
  }

  // "the 15th of next month" and "next month on the 15th".
  match = value.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(this|next)\s+month\b/)
    || value.match(/\b(this|next)\s+month\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (match) {
    const dayFirst = !Number.isNaN(Number(match[1]));
    const day = dayFirst ? Number(match[1]) : Number(match[2]);
    const which = dayFirst ? match[2] : match[1];
    return make(addMonthsDateKey(currentKey, which === 'next' ? 1 : 0, day), match[0]);
  }
  match = value.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (match && !/\b(?:in|after)\s+\d+\s+(?:days?|weeks?|months?|years?)\b/.test(value)) {
    let month = current.month;
    let year = current.year;
    if (Number(match[1]) < current.day) month += 1;
    if (month > 12) { month = 1; year += 1; }
    return make(validDateKey(year, month, Number(match[1])), `the ${match[1]}th`);
  }

  // Common calendar boundaries and natural day parts.
  if (/\b(?:end|last day) of (?:this |the current )?month\b/.test(value)) {
    const last = new Date(Date.UTC(current.year, current.month, 0, 12));
    return make(validDateKey(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()), 'end of this month', { hour: 18 });
  }
  if (/\b(?:start|beginning|first day) of next month\b/.test(value)) return make(addMonthsDateKey(currentKey, 1, 1), 'start of next month');
  if (/\b(?:end|last day) of next month\b/.test(value)) {
    const next = new Date(`${addMonthsDateKey(currentKey, 1, 1)}T12:00:00Z`);
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0, 12));
    return make(validDateKey(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()), 'end of next month', { hour: 18 });
  }
  if (/\b(?:start|beginning|first day) of next week\b/.test(value)) {
    const currentDay = new Date(`${currentKey}T12:00:00Z`).getUTCDay();
    const mondayDelta = (8 - currentDay) % 7 || 7;
    return make(shiftDateKey(currentKey, mondayDelta), 'start of next week');
  }
  if (/\b(?:end|last day) of (?:this |the current )?week\b/.test(value)) {
    const currentDay = new Date(`${currentKey}T12:00:00Z`).getUTCDay();
    return make(shiftDateKey(currentKey, 7 - currentDay), 'end of this week', { hour: 18 });
  }
  if (/\b(?:end|last day) of next week\b/.test(value)) {
    const currentDay = new Date(`${currentKey}T12:00:00Z`).getUTCDay();
    return make(shiftDateKey(currentKey, (7 - currentDay) + 7), 'end of next week', { hour: 18 });
  }
  if (/\b(?:this|coming) weekend\b/.test(value)) return make(weekdayDateKey(now, timeZone, 'saturday', 'coming'), 'this weekend', { hour: 11 });
  if (/\bnext weekend\b/.test(value)) return make(shiftDateKey(weekdayDateKey(now, timeZone, 'saturday', 'coming'), 7), 'next weekend', { hour: 11 });
  if (/\b(?:this|the current) week\b/.test(value)) return make(currentKey, 'this week');
  if (/\bnext week\b/.test(value)) {
    const currentDay = new Date(`${currentKey}T12:00:00Z`).getUTCDay();
    const mondayDelta = (8 - currentDay) % 7 || 7;
    return make(shiftDateKey(currentKey, mondayDelta), 'next week');
  }
  if (/\bnext year\b/.test(value)) return make(validDateKey(current.year + 1, 1, 1), 'next year');
  if (/\b(?:this|later this) month\b/.test(value)) return make(currentKey, 'this month');

  if (/\b(?:the )?day after tomorrow\b/.test(value)) return make(shiftDateKey(currentKey, 2), 'day after tomorrow');
  if (/\b(?:the )?day before yesterday\b/.test(value)) return null;
  if (/\b(?:later today|sometime today|this afternoon|this evening|this morning)\b/.test(value)) {
    const hint = parseClock(value);
    return make(currentKey, value.match(/\b(?:later today|sometime today|this afternoon|this evening|this morning)\b/)[0], hint || { hour: 16 });
  }
  if (/\b(?:same time|this time) tomorrow\b/.test(value)) {
    return make(shiftDateKey(currentKey, 1), 'same time tomorrow', { hour: current.hour, minute: current.minute });
  }
  if (/\btonight\b/.test(value)) return make(currentKey, 'tonight', { hour: 20 });
  if (/\btomorrow\b/.test(value)) return make(shiftDateKey(currentKey, 1), 'tomorrow');
  if (/\btoday\b/.test(value)) return make(currentKey, 'today');

  // "the Friday after next", "coming Tuesday", "on Friday", or simply "Friday".
  match = value.match(new RegExp(`\\b(?:the\\s+)?(${WEEKDAY_PATTERN})\\s+after\\s+next\\b`, 'i'));
  if (match) return make(shiftDateKey(weekdayDateKey(now, timeZone, match[1], 'next'), 7), `${match[1]} after next`);
  match = value.match(new RegExp(`\\b(?:(this|next|coming|on|by)\\s+)?(${WEEKDAY_PATTERN})\\b`, 'i'));
  if (match && !/\blast\s+/.test(value)) {
    const mode = match[1] === 'next' ? 'next' : 'coming';
    return make(weekdayDateKey(now, timeZone, match[2], mode), match[0].trim());
  }

  // Hours/minutes are kept as an exact future instant; larger units become a
  // concrete local calendar date. This accepts digits, written numbers,
  // "a couple", "a few", "several", and "a fortnight".
  let relative = value.match(new RegExp(`\\b(?:in|after|within)\\s+(${QUANTITY_PATTERN})\\s+(minutes?|hours?|days?|weeks?|fortnights?|months?|years?)\\b`, 'i'))
    || value.match(new RegExp(`\\b(?:over|during|for)\\s+the\\s+next\\s+(${QUANTITY_PATTERN})\\s+(minutes?|hours?|days?|weeks?|fortnights?|months?|years?)\\b`, 'i'))
    || value.match(new RegExp(`\\b(${QUANTITY_PATTERN})\\s+(minutes?|hours?|days?|weeks?|fortnights?|months?|years?)\\s+from\\s+(?:now|today)\\b`, 'i'));
  if (relative) return relativeReference(relative[1], relative[2], relative[0], now, timeZone);
  relative = value.match(/\b(?:in|after)\s+a\s+fortnight\b/i);
  if (relative) return relativeReference('2', 'weeks', relative[0], now, timeZone);
  relative = value.match(/\bnext\s+(few|couple|several)\s+(days?|weeks?)\b/i);
  if (relative) return relativeReference(relative[1], relative[2], relative[0], now, timeZone);
  if (/\b(?:after lunch|right after lunch|after work|after class|after school)\b/.test(value)) {
    const hint = parseClock(value);
    return make(currentKey, value.match(/\b(?:after lunch|right after lunch|after work|after class|after school)\b/)[0], hint || { hour: 18 });
  }
  relative = value.match(/\b(?:in\s+)?(?:a\s+bit|a\s+little\s+while|shortly|soon)\b/i);
  if (relative) return relativeReference('30', 'minutes', relative[0], now, timeZone);
  if (/\blater\b/.test(value)) return relativeReference('3', 'hours', 'later', now, timeZone);
  if (/\b(?:when|after)\s+(?:i|we|she)\s+wake(?:s|\s+up)?\b/.test(value)) return make(currentKey, 'when you wake up', { hour: 8 });
  return null;
}

function dateReferenceMatches(text) {
  const raw = String(text || '');
  const regex = new RegExp(`\\b(?:20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[.\\/-]\\d{1,2}[.\\/-]20\\d{2}|(?:${MONTH_PATTERN})\\s+\\d{1,2}(?:st|nd|rd|th)?|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_PATTERN})|day after tomorrow|tomorrow|today|tonight|this weekend|next weekend|this week|next week|next year|in\\s+[^,.!?]+?\\s+(?:minutes?|hours?|days?|weeks?|fortnights?|months?|years?)|[^,.!?]+?\\s+(?:minutes?|hours?|days?|weeks?|fortnights?|months?|years?)\\s+from\\s+(?:now|today)|(?:this|next|coming|on|by)\\s+(?:${WEEKDAY_PATTERN})|(?:${WEEKDAY_PATTERN})\\s+after\\s+next|(?:${WEEKDAY_PATTERN})|end of (?:the )?(?:day|week|month))\\b`, 'gi');
  const matches = [...raw.matchAll(regex)].map(match => ({ phrase: match[0], index: match.index }));
  if (!matches.length && dateReference(raw)) return [{ phrase: raw, index: 0 }];
  return matches;
}

function hasCalendarIntent(text) {
  const clean = cleanMemoryText(text);
  if (!clean || !dateReferenceMatches(clean).length) return false;
  if (/^(?:what|how|where|when|are|is|did|do)\b/i.test(clean) && !/\b(?:remind|schedule|plan|meeting|appointment|exam|deadline)\b/i.test(clean)) return false;
  return /\b(?:remember|remind|schedule|scheduled|plan|planned|planning|appointment|meeting|meet|deadline|exam|test|birthday|event|trip|call|text|message|send|finish|start|work|study|visit|buy|pick up|go|leave|arrive|due|promise|need to|have to|going to|will|['’]ll|can|should|gonna)\b/i.test(clean);
}

function parseDueDate(text, now = new Date(), timeZone = 'Europe/Berlin') {
  const raw = String(text || '');
  const reference = dateReference(raw, now, timeZone);
  if (!reference) return { label: null, dateKey: null, dueAt: null };
  const explicitClock = parseClock(raw);
  if (reference.dueAtOverride && !explicitClock) return { label: reference.label, dateKey: reference.dateKey, dueAt: reference.dueAtOverride };
  const clock = explicitClock || { hour: reference.defaultHour ?? 9, minute: reference.defaultMinute ?? 0 };
  let dateKey = reference.dateKey;
  let dueAt = localWallTime(dateKey, clock.hour, clock.minute, timeZone);
  // A same-day reference whose wall-clock time already passed should still be
  // actionable in the current conversation, not silently wait 24 hours.
  if (new Date(dueAt).getTime() <= now.getTime() && dateKey === localDateKey(now, timeZone)) {
    dueAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  }
  return { label: reference.label, dateKey, dueAt };
}

function addCalendarItem(state, value, now = new Date(), timeZone = 'Europe/Berlin', speaker = 'he', source = 'conversation') {
  ensureMemoryShape(state);
  const clean = cleanMemoryText(value);
  if (!clean || !dateReference(clean) || (source === 'conversation' && speaker === 'negev' && !hasCalendarIntent(clean))) return null;
  const due = parseDueDate(clean, now, timeZone);
  if (!due.dueAt) return null;
  const key = `${speaker}|${due.dateKey}|${clean.toLowerCase()}`;
  const existing = state.calendar.find(item => item.status === 'open' && item.dedupeKey === key);
  if (existing) {
    existing.confidence = Math.max(Number(existing.confidence) || 0, source === 'explicit' ? 1 : speaker === 'negev' ? 0.72 : 0.84);
    existing.lastConfirmedAt = nowIso();
    return existing;
  }
  const item = {
    id: id('calendar'), value: clean, status: 'open', speaker, source,
    dueLabel: due.label, dueDate: due.dateKey, dueAt: due.dueAt, notifiedAt: null,
    confidence: source === 'explicit' ? 1 : speaker === 'negev' ? 0.72 : 0.84, lastConfirmedAt: nowIso(),
    dedupeKey: key, createdAt: nowIso()
  };
  state.calendar.push(item);
  state.calendar = state.calendar.slice(-100);
  return item;
}

function rememberDateReferences(state, text, speaker = 'he', now = new Date(), timeZone = 'Europe/Berlin', source = 'conversation') {
  ensureMemoryShape(state);
  const clean = cleanMemoryText(text);
  if (!clean || !dateReferenceMatches(clean).length) return [];
  // Promises and tasks already carry the resolved date themselves. The
  // separate calendar list is for date-bearing facts and casual plans, so a
  // single sentence does not produce two reminders.
  if (parsePromise(clean).length) return [];
  if (speaker === 'negev' && !hasCalendarIntent(clean)) return [];
  return [addCalendarItem(state, clean, now, timeZone, speaker, source)].filter(Boolean);
}

function addHistory(state, role, text, meta = {}) {
  ensureMemoryShape(state);
  const entry = { id: meta.id || id('turn'), at: nowIso(), role, text: cleanMemoryText(text), ...meta };
  delete entry.textLength;
  state.history.push(entry);
  if (state.history.length > 60) {
    const removed = state.history.splice(0, state.history.length - 60);
    const useful = removed.filter(item => item.role === 'user' || item.role === 'assistant').slice(-8);
    if (useful.length) state.summary = `${state.summary ? `${state.summary} ` : ''}${useful.map(item => `${item.role}: ${item.text}`).join(' | ')}`.slice(-2600);
  }
  return entry;
}

// --- Reminder queries and model-facing context --------------------------------

function pinFact(state, value, source = 'explicit') {
  ensureMemoryShape(state);
  const clean = cleanMemoryText(value);
  if (!clean) return null;
  const key = clean.toLowerCase();
  state.facts = state.facts.filter(item => item.value.toLowerCase() !== key);
  const item = { id: id('fact'), value: clean, source, confidence: 1, lastConfirmedAt: nowIso(), pinnedAt: nowIso() };
  state.facts.push(item);
  state.facts = state.facts.slice(-80);
  return item;
}

function addPromise(state, value, kind = 'promise', now = new Date(), timeZone = 'Europe/Berlin', speaker = 'he', source = 'conversation') {
  ensureMemoryShape(state);
  const clean = cleanMemoryText(value);
  if (!clean) return null;
  const due = parseDueDate(clean, now, timeZone);
  const list = kind === 'task' ? state.tasks : state.promises;
  const confidence = source === 'explicit' ? 1 : speaker === 'negev' ? 0.72 : 0.88;
  const existing = list.find(item => item.status === 'open' && item.value.toLowerCase() === clean.toLowerCase());
  if (existing) {
    existing.dueLabel = due.label;
    existing.dueDate = due.dateKey;
    existing.dueAt = due.dueAt;
    existing.notifiedAt = null;
    existing.confidence = Math.max(Number(existing.confidence) || 0, confidence);
    existing.lastConfirmedAt = nowIso();
    existing.updatedAt = nowIso();
    return existing;
  }
  const item = { id: id(kind), value: clean, status: 'open', speaker, source, confidence, lastConfirmedAt: nowIso(), dueLabel: due.label, dueDate: due.dateKey, dueAt: due.dueAt, notifiedAt: null, createdAt: nowIso() };
  list.push(item);
  while (list.length > 60) list.shift();
  return item;
}

function completeMemory(state, needle) {
  ensureMemoryShape(state);
  const q = String(needle || '').toLowerCase().trim();
  let found = 0;
  for (const list of [state.promises, state.tasks, state.calendar]) for (const item of list) {
    if (item.status === 'open' && item.value.toLowerCase().includes(q)) { item.status = 'done'; item.doneAt = nowIso(); found++; }
  }
  return found;
}

function forgetFact(state, needle) {
  const q = String(needle || '').toLowerCase().trim();
  const before = state.facts.length;
  state.facts = state.facts.filter(item => !item.value.toLowerCase().includes(q));
  return before - state.facts.length;
}

function rememberExplicit(state, text, timeZone, now = new Date()) {
  const facts = parseRemember(text);
  const promises = parsePromise(text);
  const addedFacts = facts.map(item => pinFact(state, item.value, 'explicit')).filter(Boolean);
  const addedPromises = promises.map(item => addPromise(state, item.value, item.type, now, timeZone, 'he', 'explicit')).filter(Boolean);
  const calendar = rememberDateReferences(state, text, 'he', now, timeZone, 'explicit');
  return { facts: addedFacts, promises: addedPromises, calendar };
}

function addUnanswered(state, message) {
  ensureMemoryShape(state);
  const entry = { id: message.id || id('unanswered'), messageId: message.messageId || null, text: cleanMemoryText(message.text), at: message.at || nowIso(), kind: message.kind || 'text' };
  state.unanswered = state.unanswered.filter(item => item.messageId !== entry.messageId);
  state.unanswered.push(entry);
  state.unanswered = state.unanswered.slice(-30);
  return entry;
}

function removeUnanswered(state, messageId) {
  state.unanswered = (state.unanswered || []).filter(item => String(item.messageId) !== String(messageId));
}

function pendingDue(state, now = new Date()) {
  const out = [];
  for (const list of [state.promises || [], state.tasks || []]) for (const item of list) {
    const due = item.dueAt ? new Date(item.dueAt).getTime() : NaN;
    if (item.status === 'open' && Number.isFinite(due) && due <= now.getTime()) out.push(item);
  }
  return out.sort(sortWorkItems);
}

function pendingCalendar(state, now = new Date()) {
  return (state.calendar || []).filter(item => {
    const due = item.dueAt ? new Date(item.dueAt).getTime() : NaN;
    return item.status === 'open' && !item.notifiedAt && Number.isFinite(due) && due <= now.getTime();
  }).sort(sortWorkItems);
}

function pendingReminders(state, now = new Date()) {
  const all = [...pendingDue(state, now).filter(item => !item.notifiedAt), ...pendingCalendar(state, now)];
  const seen = new Set();
  return all.filter(item => {
    const key = `${item.value.toLowerCase()}|${item.dueDate || item.dueAt || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortWorkItems(a, b) {
  const aDueValue = a.dueAt ? new Date(a.dueAt).getTime() : NaN;
  const bDueValue = b.dueAt ? new Date(b.dueAt).getTime() : NaN;
  const aDue = Number.isFinite(aDueValue) ? aDueValue : Infinity;
  const bDue = Number.isFinite(bDueValue) ? bDueValue : Infinity;
  if (aDue !== bDue) return aDue - bDue;
  const aCreatedValue = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
  const bCreatedValue = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
  const aCreated = Number.isFinite(aCreatedValue) ? aCreatedValue : 0;
  const bCreated = Number.isFinite(bCreatedValue) ? bCreatedValue : 0;
  return aCreated - bCreated;
}

function memoryContext(state, limit = 8, timeZone = 'Europe/Berlin') {
  ensureMemoryShape(state);
  const facts = state.facts.slice(-limit).map(item => `- ${item.value}`);
  const promises = state.promises.filter(x => x.status === 'open' && !x.notifiedAt).sort(sortWorkItems).slice(0, limit).map(item => `- ${item.speaker === 'negev' ? 'you promised' : 'he promised'}: ${item.value}${item.dueDate ? ` (date ${item.dueDate})` : ''}${confidenceNote(item)}`);
  const tasks = state.tasks.filter(x => x.status === 'open' && !x.notifiedAt).sort(sortWorkItems).slice(0, limit).map(item => `- task: ${item.value}${item.dueDate ? ` (date ${item.dueDate})` : ''}${confidenceNote(item)}`);
  const calendar = state.calendar.filter(x => x.status === 'open' && !x.notifiedAt).slice(-limit).map(item => `- ${item.speaker === 'negev' ? 'you said' : 'he said'}: ${item.value} (calendar date ${item.dueDate}; around ${formatLocal(item.dueAt, timeZone)})${confidenceNote(item)}`);
  return [
    state.summary ? `older conversation summary: ${state.summary}` : '',
    facts.length ? `facts he explicitly asked you to remember:\n${facts.join('\n')}` : '',
    promises.length ? `open promises:\n${promises.join('\n')}` : '',
    tasks.length ? `open tasks:\n${tasks.join('\n')}` : '',
    calendar.length ? `calendar commitments and date references:\n${calendar.join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

function listMemories(state) {
  ensureMemoryShape(state);
  return {
    facts: state.facts.slice(),
    promises: state.promises.filter(x => x.status === 'open').sort(sortWorkItems).slice(),
    tasks: state.tasks.filter(x => x.status === 'open').sort(sortWorkItems).slice(),
    calendar: state.calendar.filter(x => x.status === 'open').slice()
  };
}

module.exports = {
  ensureMemoryShape, parseRemember, parsePromise, parseDueDate, addHistory,
  pinFact, addPromise, addCalendarItem, rememberDateReferences, completeMemory, forgetFact, rememberExplicit,
  addUnanswered, removeUnanswered, pendingDue, pendingCalendar, pendingReminders, sortWorkItems, memoryContext, listMemories
};
