const crypto = require('crypto');

// Tiny dependency-free primitives shared by every module. Keep feature rules
// out of this file so helpers remain predictable and easy to test.

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function nowIso() { return new Date().toISOString(); }

function id(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function safeText(value, max = 12_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function stripEmoji(text) {
  return String(text || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function formatLocal(date, timeZone = 'Europe/Berlin', options = {}) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, ...options
  }).format(new Date(date));
}

function localParts(date, timeZone = 'Europe/Berlin') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(date));
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = part.value;
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day), hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second) };
}

function localDateKey(date, timeZone) {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function hashString(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seededRandom(seed) {
  let x = hashString(seed) || 1;
  return () => {
    x = Math.imul(1664525, x) + 1013904223;
    return (x >>> 0) / 4294967296;
  };
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(array, random = Math.random) {
  return array[Math.floor(random() * array.length) % array.length];
}

module.exports = {
  sleep, nowIso, id, clamp, safeText, stripEmoji, formatLocal, localParts,
  localDateKey, hashString, seededRandom, parseNumber, pick
};
