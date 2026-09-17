const fs = require('fs');
const config = require('./config');
const { id, nowIso, formatLocal } = require('./util');
const { ensureDirs } = require('./store');
const persona = require('./persona');

// Keep money as integer units at 12 decimal places of USD. JavaScript Number
// arithmetic cannot preserve small provider costs reliably enough for a ledger.
const USD_SCALE = 1_000_000_000_000n;
const TOKEN_SCALE = 1_000_000n;

// Exact accounting lives here. Costs are fixed-point integers; presentation
// and Telegram command formatting should call the helpers below.

// --- Fixed-point arithmetic and normalization ---------------------------------

function decimalToUnits(value) {
  let text = String(value ?? 0).trim();
  if (!text || !Number.isFinite(Number(text))) return 0n;
  if (/e/i.test(text)) text = Number(text).toFixed(12);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || '';
  const kept = fraction.padEnd(12, '0').slice(0, 12);
  let units = whole * USD_SCALE + BigInt(kept || '0');
  if (fraction.length > 12 && Number(fraction[12]) >= 5) units += 1n;
  return sign * units;
}

function unitsFromNumber(value) {
  if (typeof value === 'bigint') return value;
  return decimalToUnits(value);
}

function storedUnits(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  return 0n;
}

function numberFromUnits(units) {
  return Number(storedUnits(units)) / Number(USD_SCALE);
}

function formatCostUnits(units) {
  let value = storedUnits(units);
  const sign = value < 0n ? '-' : '';
  if (value < 0n) value = -value;
  const whole = value / USD_SCALE;
  const fraction = (value % USD_SCALE).toString().padStart(12, '0');
  return `$${sign}${whole}.${fraction}`;
}

function formatMoney(value, exactUnits = null) {
  return exactUnits === null || exactUnits === undefined
    ? formatCostUnits(decimalToUnits(value))
    : formatCostUnits(exactUnits);
}

function ratioUnits(totalUnits, denominator) {
  const divisor = BigInt(Math.max(1, Math.trunc(Number(denominator) || 1)));
  const total = storedUnits(totalUnits);
  return (total + divisor / 2n) / divisor;
}

function tokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function normalizeRates(rates) {
  const hasRate = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  return {
    input: hasRate(rates?.input) ? Number(rates.input) : 0,
    cache: hasRate(rates?.cache) ? Number(rates.cache) : 0,
    output: hasRate(rates?.output) ? Number(rates.output) : 0,
    cacheWrite: hasRate(rates?.cacheWrite) ? Number(rates.cacheWrite) : (hasRate(rates?.input) ? Number(rates.input) : 0)
  };
}

function ratesConfigured(rates, usage = {}) {
  const hasRate = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const cacheWriteTokens = tokenCount(usage.prompt_cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0);
  return hasRate(rates?.input) && hasRate(rates?.cache) && hasRate(rates?.output)
    && (!cacheWriteTokens || hasRate(rates?.cacheWrite));
}

function usageHasProviderCounts(usage = {}) {
  return [
    'prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens',
    'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
    'prompt_cache_hit_tokens', 'cache_hit_tokens', 'cached_tokens', 'cachedContentTokenCount',
    'cache_read_input_tokens', 'cache_creation_input_tokens'
  ].some(key => usage[key] !== undefined && usage[key] !== null);
}

function normalizeCostRecord(record = {}) {
  const exact = record.costUnits !== undefined && record.costUnits !== null
    ? storedUnits(record.costUnits)
    : unitsFromNumber(record.cost || 0);
  record.costUnits = exact.toString();
  record.cost = numberFromUnits(exact);
  return record;
}

function defaultLedger() {
  return {
    schemaVersion: 4,
    startedAt: nowIso(),
    calls: [],
    buckets: {},
    messageMap: {},
    totals: {
      calls: 0, replyGroups: 0, input: 0, cached: 0, cacheWrite: 0, fresh: 0, output: 0,
      cost: 0, costUnits: '0', usageReported: 0, usageMissing: 0, unpricedCalls: 0
    }
  };
}

function loadLedger() {
  ensureDirs();
  try {
    const value = JSON.parse(fs.readFileSync(config.USAGE_FILE, 'utf8'));
    const defaults = defaultLedger();
    const ledger = { ...defaults, ...value, totals: { ...defaults.totals, ...(value.totals || {}) } };
    ledger.calls = Array.isArray(ledger.calls) ? ledger.calls : [];
    ledger.buckets = ledger.buckets && typeof ledger.buckets === 'object' ? ledger.buckets : {};
    ledger.messageMap = ledger.messageMap && typeof ledger.messageMap === 'object' ? ledger.messageMap : {};
    for (const call of ledger.calls) if (call && call.usage) normalizeCostRecord(call.usage);
    for (const bucket of Object.values(ledger.buckets)) if (bucket) normalizeCostRecord(bucket);
    normalizeCostRecord(ledger.totals);
    ledger.schemaVersion = 4;
    ledger.totals.replyGroups = value.totals && value.totals.replyGroups !== undefined
      ? Number(ledger.totals.replyGroups)
      : Object.keys(ledger.buckets).length;
    ledger.totals.usageReported = Number(ledger.totals.usageReported || ledger.calls.filter(call => call?.usageReported !== false).length);
    ledger.totals.usageMissing = Number(ledger.totals.usageMissing || ledger.calls.filter(call => call?.usageReported === false).length);
    ledger.totals.unpricedCalls = Number(ledger.totals.unpricedCalls || ledger.calls.filter(call => call?.usage?.ratesConfigured === false).length);
    return ledger;
  } catch (_) { return defaultLedger(); }
}

function saveLedger(ledger) {
  ensureDirs();
  const temp = `${config.USAGE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(temp, config.USAGE_FILE);
}

function createBucket(kind = 'reply', meta = {}) {
  const ledger = loadLedger();
  const bucketId = id(kind);
  ledger.buckets[bucketId] = {
    id: bucketId, kind, createdAt: nowIso(), model: meta.model || null, messageIds: [], calls: [],
    input: 0, cached: 0, cacheWrite: 0, fresh: 0, output: 0, cost: 0, costUnits: '0'
  };
  ledger.totals.replyGroups = Number(ledger.totals.replyGroups || 0) + 1;
  saveLedger(ledger);
  return bucketId;
}

// --- Provider call ledger and Telegram message binding ------------------------

function isPeak(date = new Date()) {
  const utcHour = date.getUTCHours();
  const day = date.getUTCDay();
  return day >= 1 && day <= 5 && ((utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10));
}

function priceUsage(usage = {}, date = new Date(), rates = config.RATES) {
  const hasPromptTokens = usage.prompt_tokens !== undefined && usage.prompt_tokens !== null;
  const anthropicExtraInput = hasPromptTokens ? 0 : tokenCount(usage.cache_read_input_tokens) + tokenCount(usage.cache_creation_input_tokens);
  const geminiInput = tokenCount(usage.promptTokenCount) + tokenCount(usage.toolUsePromptTokenCount);
  const input = tokenCount(usage.prompt_tokens ?? (usage.promptTokenCount !== undefined ? geminiInput : usage.input_tokens ?? 0)) + anthropicExtraInput;
  const geminiOutput = tokenCount(usage.candidatesTokenCount) + tokenCount(usage.thoughtsTokenCount);
  const output = tokenCount(usage.completion_tokens ?? (usage.candidatesTokenCount !== undefined ? geminiOutput : usage.output_tokens ?? 0));
  const cached = tokenCount(usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount ?? 0);
  const cacheWrite = tokenCount(usage.prompt_cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0);
  const safeCached = Math.min(input, cached);
  const safeCacheWrite = Math.min(Math.max(0, input - safeCached), cacheWrite);
  const fresh = Math.max(0, input - safeCached - safeCacheWrite);
  const multiplier = isPeak(date) ? 2 : 1;
  const normalized = normalizeRates(rates);
  const numerator = BigInt(fresh) * decimalToUnits(normalized.input)
    + BigInt(safeCached) * decimalToUnits(normalized.cache)
    + BigInt(safeCacheWrite) * decimalToUnits(normalized.cacheWrite)
    + BigInt(output) * decimalToUnits(normalized.output);
  const costUnits = (numerator * BigInt(multiplier) + TOKEN_SCALE / 2n) / TOKEN_SCALE;
  return {
    input, cached: safeCached, cacheWrite: safeCacheWrite, fresh, output, total: input + output,
    cost: numberFromUnits(costUnits), costUnits: costUnits.toString(),
    peak: multiplier === 2, rates: { ...normalized, multiplier },
    ratesConfigured: ratesConfigured(rates, usage), usageReported: usageHasProviderCounts(usage)
  };
}

// --- Human-readable reports and planning estimates ----------------------------

function recordCall({ bucketId, model, usage, purpose = 'reply', at = new Date(), provider = 'deepseek', providerKey = null, rates = config.RATES }) {
  const ledger = loadLedger();
  const priced = priceUsage(usage || {}, at, rates);
  const call = {
    id: id('call'), bucketId: bucketId || null, provider, model: model || 'unknown', purpose,
    at: at.toISOString(), usage: priced, usageReported: priced.usageReported, providerKey
  };
  ledger.calls.push(call);
  ledger.calls = ledger.calls.slice(-500);
  ledger.totals.calls = Number(ledger.totals.calls || 0) + 1;
  for (const key of ['input', 'cached', 'cacheWrite', 'fresh', 'output']) ledger.totals[key] = Number(ledger.totals[key] || 0) + priced[key];
  const totalCostUnits = storedUnits(ledger.totals.costUnits) + storedUnits(priced.costUnits);
  ledger.totals.costUnits = totalCostUnits.toString();
  ledger.totals.cost = numberFromUnits(totalCostUnits);
  if (priced.usageReported) ledger.totals.usageReported = Number(ledger.totals.usageReported || 0) + 1;
  else ledger.totals.usageMissing = Number(ledger.totals.usageMissing || 0) + 1;
  if (!priced.ratesConfigured) ledger.totals.unpricedCalls = Number(ledger.totals.unpricedCalls || 0) + 1;
  if (bucketId && ledger.buckets[bucketId]) {
    const bucket = ledger.buckets[bucketId];
    bucket.calls.push(call.id); bucket.model = model || bucket.model;
    for (const key of ['input', 'cached', 'cacheWrite', 'fresh', 'output']) bucket[key] = Number(bucket[key] || 0) + priced[key];
    const bucketCostUnits = storedUnits(bucket.costUnits) + storedUnits(priced.costUnits);
    bucket.costUnits = bucketCostUnits.toString();
    bucket.cost = numberFromUnits(bucketCostUnits);
  }
  saveLedger(ledger);
  return call;
}

function bindMessage(messageId, bucketId) {
  if (!messageId || !bucketId) return;
  const ledger = loadLedger();
  ledger.messageMap[String(messageId)] = bucketId;
  if (ledger.buckets[bucketId] && !ledger.buckets[bucketId].messageIds.includes(String(messageId))) ledger.buckets[bucketId].messageIds.push(String(messageId));
  const keys = Object.keys(ledger.messageMap);
  for (const key of keys.slice(0, Math.max(0, keys.length - 250))) delete ledger.messageMap[key];
  saveLedger(ledger);
}

function bucketForMessage(messageId) {
  const ledger = loadLedger();
  return ledger.messageMap[String(messageId)] || null;
}

function formatBucket(bucketId, timeZone = config.TIMEZONE) {
  const ledger = loadLedger();
  const bucket = ledger.buckets[bucketId];
  if (!bucket) return 'i dont have usage numbers for that message yet. tracking starts when the selected provider reports usage.';
  if (!bucket.calls.length) return ['what that reply cost', '- no provider call: it was a free local/canned message', '- input: 0 tokens', '- output: 0 tokens', '- total: 0 tokens', '- cost: $0.000000000000'].join('\n');
  const calls = ledger.calls.filter(call => call.bucketId === bucketId);
  const first = calls[0];
  const usageMissing = calls.some(call => call.usageReported === false);
  const ratesMissing = calls.some(call => call.usage?.ratesConfigured === false);
  const costLabel = usageMissing ? 'not exact — provider omitted usage' : ratesMissing ? 'unpriced — add this model\'s rates' : formatCostUnits(bucket.costUnits);
  return [
    'what that reply cost',
    `- sent: ${formatLocal(first.at, timeZone)}`,
    `- provider/model: ${first.provider || 'deepseek'} / ${bucket.model || first.model} (${calls.length} model call${calls.length === 1 ? '' : 's'})`,
    `- input: ${bucket.input.toLocaleString()} tokens - ${bucket.cached.toLocaleString()} cached / ${bucket.cacheWrite.toLocaleString()} cache-write / ${bucket.fresh.toLocaleString()} fresh`,
    `- output: ${bucket.output.toLocaleString()} tokens`,
    `- total: ${(bucket.input + bucket.output).toLocaleString()} tokens`,
    `- cost: ${costLabel}`,
    `- rates: ${first.usage.ratesConfigured === false ? 'not configured for this provider/model' : `$${first.usage.rates?.cache ?? config.RATES.cache}/M cached, $${first.usage.rates?.cacheWrite ?? first.usage.rates?.input ?? config.RATES.input}/M cache-write, $${first.usage.rates?.input ?? config.RATES.input}/M input, $${first.usage.rates?.output ?? config.RATES.output}/M output`}${first.usage.peak ? ' (peak-hour multiplier applied)' : ''}`
  ].join('\n');
}

function formatAll(timeZone = config.TIMEZONE) {
  const ledger = loadLedger();
  const t = ledger.totals;
  const days = {};
  for (const call of ledger.calls) {
    const day = formatLocal(call.at, timeZone).slice(0, 10);
    days[day] = days[day] || { costUnits: 0n, tokens: 0, calls: 0 };
    days[day].costUnits += call.usage.costUnits !== undefined
      ? storedUnits(call.usage.costUnits)
      : unitsFromNumber(call.usage.cost);
    days[day].tokens += call.usage.total; days[day].calls++;
  }
  const recent = Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).slice(-7)
    .map(([day, x]) => `${day} ${formatCostUnits(x.costUnits)}`).join(' | ');
  return [
    'everything she has spent',
    `- counting since: ${formatLocal(ledger.startedAt, timeZone)}`,
    `- model calls: ${Number(t.calls || 0).toLocaleString()}`,
    `- input: ${Number(t.input || 0).toLocaleString()} tokens - ${Number(t.cached || 0).toLocaleString()} cached / ${Number(t.cacheWrite || 0).toLocaleString()} cache-write / ${Number(t.fresh || 0).toLocaleString()} fresh`,
    `- output: ${Number(t.output || 0).toLocaleString()} tokens`,
    `- total: ${(Number(t.input || 0) + Number(t.output || 0)).toLocaleString()} tokens`,
    `- cost: ${formatCostUnits(t.costUnits)}`,
    recent ? `- recent days: ${recent}` : '- no calls counted yet'
  ].join('\n');
}

function formatLifetimeEstimate(timeZone = config.TIMEZONE) {
  const ledger = loadLedger();
  const t = ledger.totals || {};
  const totalCalls = Number(t.calls || 0);
  const groups = Number(t.replyGroups || Object.keys(ledger.buckets || {}).length);
  const total = Number(t.input || 0) + Number(t.output || 0);
  const averageTokens = totalCalls ? Math.round(total / totalCalls) : 0;
  const averageCostUnits = totalCalls ? ratioUnits(t.costUnits, totalCalls) : 0n;
  const usageMissing = Number(t.usageMissing || 0);
  const unpricedCalls = Number(t.unpricedCalls || 0);
  return [
    'overall conversation token estimate',
    `- tracked since: ${formatLocal(ledger.startedAt, timeZone)}`,
    `- AI provider replies counted: ${totalCalls.toLocaleString()}`,
    `- tracked reply groups: ${groups.toLocaleString()}`,
    `- input: ${Number(t.input || 0).toLocaleString()} tokens - ${Number(t.cached || 0).toLocaleString()} cached / ${Number(t.cacheWrite || 0).toLocaleString()} cache-write / ${Number(t.fresh || 0).toLocaleString()} fresh`,
    `- output: ${Number(t.output || 0).toLocaleString()} tokens`,
    `- overall total: ${total.toLocaleString()} tokens`,
    `- tracked provider cost: ${formatCostUnits(t.costUnits)}`,
    `- average per AI provider reply: ${averageTokens.toLocaleString()} tokens / ${formatCostUnits(averageCostUnits)}`,
    `- provider usage records: ${Number(t.usageReported || 0).toLocaleString()} complete${usageMissing ? `, ${usageMissing.toLocaleString()} missing usage blocks` : ''}${unpricedCalls ? `; ${unpricedCalls.toLocaleString()} calls need provider/model pricing` : ''}`,
    '- this cumulative ledger survives /start, /clear, memory resets, and server restarts',
    '- local commands use 0 provider tokens; replies are counted from provider usage when available'
  ].join('\n');
}

function roughTokens(text) { return Math.max(1, Math.ceil(String(text || '').length / 4)); }

function estimatedCost(input, output, cached = 0) {
  const fresh = Math.max(0, input - cached);
  const numerator = BigInt(Math.max(0, Math.trunc(fresh))) * decimalToUnits(config.RATES.input)
    + BigInt(Math.max(0, Math.trunc(cached))) * decimalToUnits(config.RATES.cache)
    + BigInt(Math.max(0, Math.trunc(output))) * decimalToUnits(config.RATES.output);
  return numberFromUnits((numerator + TOKEN_SCALE / 2n) / TOKEN_SCALE);
}

function estimateScenarios() {
  const stablePrompt = roughTokens(persona.CORE) + 110;
  const textInput = stablePrompt + roughTokens('a normal short text message from him plus the reply framing and memory headings');
  const photoInput = stablePrompt + roughTokens('a short caption and image framing') + 800;
  // memoryContext is capped at 6500 characters in the actual prompt builder.
  const memoryInput = stablePrompt + Math.ceil(6500 / 4) + roughTokens('a normal message');
  const output = 100;
  const lines = [
    'rough DeepSeek spend per one reply',
    `- text only: about ${textInput.toLocaleString()} input + ${output} output tokens, ${formatMoney(estimatedCost(textInput, output))} off-peak`,
    `- picture + short caption: about ${photoInput.toLocaleString()} input + ${output} output tokens, ${formatMoney(estimatedCost(photoInput, output))} off-peak (vision token count varies by image)`,
    `- a lot of memory: about ${memoryInput.toLocaleString()} input + ${output} output tokens, ${formatMoney(estimatedCost(memoryInput, output))} off-peak`,
    '- static prompt cache can lower those costs; !token after the reply is the exact provider-reported number',
    `- configured rates: $${config.RATES.cache}/M cached, $${config.RATES.input}/M fresh input, $${config.RATES.output}/M output`
  ];
  return lines.join('\n');
}

module.exports = {
  loadLedger, saveLedger, createBucket, isPeak, priceUsage, recordCall, bindMessage, bucketForMessage,
  formatBucket, formatAll, formatLifetimeEstimate, formatMoney, formatCostUnits, roughTokens, estimatedCost,
  estimateScenarios
};
