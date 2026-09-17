const { stripEmoji, clamp } = require('./util');

// Final response formatting only. It may split and lightly style model text,
// but it must not decide what the user meant or mutate memory.

function splitBubbles(text, max = 3) {
  let cleaned = stripEmoji(String(text || ''))
    .replace(/^\s*(?:negev(?:-chan)?|assistant)\s*:\s*/i, '')
    .replace(/```[\s\S]*?```/g, s => s.replace(/```/g, ''))
    .trim();
  if (!cleaned) return [];
  let bubbles = cleaned.split(/\s*\|\|\|\s*|\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (bubbles.length === 1 && bubbles[0].length > 420) {
    const sentences = bubbles[0].split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) {
      bubbles = [];
      for (const sentence of sentences) {
        if (!bubbles.length || bubbles[bubbles.length - 1].length + sentence.length > 180) bubbles.push(sentence);
        else bubbles[bubbles.length - 1] += ` ${sentence}`;
      }
    }
  }
  if (bubbles.length > max) bubbles = [...bubbles.slice(0, max - 1), bubbles.slice(max - 1).join(' ')];
  return bubbles.map(item => item.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
}

// --- Final Telegram-safe style pass -------------------------------------------

function applyHumanStyle(text, { mood = 'soft', random = Math.random } = {}) {
  let value = stripEmoji(String(text || '')).replace(/\s{2,}/g, ' ').trim();
  if (!value) return value;
  if (random() < (mood === 'sulky' ? 0.32 : 0.14)) value = value.replace(/,\s*/g, ' ');
  if (random() < 0.09) value = value.replace(/\breally\b/gi, 'rly').replace(/\bgoing to\b/gi, 'gonna');
  return value;
}

function formatTelegramText(text, max = 4096) {
  let value = stripEmoji(text).replace(/\u0000/g, '').trim();
  if (value.length <= max) return [value];
  const chunks = [];
  while (value.length > max) {
    let cut = value.lastIndexOf('\n', max);
    if (cut < 300) cut = value.lastIndexOf(' ', max);
    if (cut < 100) cut = max;
    chunks.push(value.slice(0, cut).trim());
    value = value.slice(cut).trim();
  }
  if (value) chunks.push(value);
  return chunks;
}

function ensureLaughMarks(text, random = Math.random) {
  let value = String(text || '');
  if (!/\b(?:lol|lmao|haha|xd|xdd)\b/i.test(value) || /\)|\)|<3|:3/.test(value)) return value;
  if (random() > 0.38) return value;
  const marks = random() < 0.35 ? ')' : random() < 0.5 ? '))' : random() < 0.75 ? ')))' : '))))';
  return `${value} ${marks}`.trim();
}

module.exports = { splitBubbles, applyHumanStyle, formatTelegramText, ensureLaughMarks };
