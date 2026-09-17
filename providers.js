const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureDirs } = require('./store');

const PROVIDERS_FILE = path.join(config.DATA_DIR, 'providers.json');

// Provider catalog and selection. Secret values are read only when a request
// is made and are intentionally absent from catalog output and saved config.

function splitList(value) {
  return String(value || '').split(/[\r\n,;]+/).map(item => item.trim()).filter(Boolean);
}

function envNumber(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : null;
}

function envRates(prefix) {
  return {
    input: envNumber(`${prefix}_INPUT_USD_PER_M`),
    cache: envNumber(`${prefix}_CACHE_USD_PER_M`),
    output: envNumber(`${prefix}_OUTPUT_USD_PER_M`),
    cacheWrite: envNumber(`${prefix}_CACHE_WRITE_USD_PER_M`)
  };
}

function modelsFromEnv(prefix, rates, defaults = []) {
  const names = splitList(process.env[`${prefix}_MODELS`]);
  const configured = envRates(prefix);
  const overrides = Object.fromEntries(Object.entries(configured).filter(([, value]) => value !== null));
  const baseRates = { ...rates, ...overrides };
  const defaultRates = Object.fromEntries(defaults.filter(item => item && typeof item === 'object' && item.name).map(item => [item.name, item.rates || {}]));
  if (names.length) return names.map(name => ({ name, rates: { ...baseRates, ...(defaultRates[name] || {}), ...overrides } }));
  return defaults.map(item => typeof item === 'string'
    ? { name: item, rates: { ...baseRates } }
    : { name: item.name, rates: { ...baseRates, ...(item.rates || {}), ...overrides } });
}

function defaultProviders() {
  return {
    deepseek: {
      id: 'deepseek', label: 'DeepSeek', baseUrl: config.DEEPSEEK_BASE_URL,
      keyEnv: 'DEEPSEEK_API_KEY', keysEnv: 'DEEPSEEK_API_KEYS',
      models: config.DEEPSEEK_MODELS.map(name => ({ name, rates: { ...config.RATES } })), protocol: 'openai'
    },
    openrouter: {
      id: 'openrouter', label: 'OpenRouter', baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
      keyEnv: 'OPENROUTER_API_KEY', keysEnv: 'OPENROUTER_API_KEYS',
      models: modelsFromEnv('OPENROUTER', envRates('OPENROUTER')),
      headers: { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || '', 'X-Title': process.env.OPENROUTER_X_TITLE || 'Private Telegram companion' }, protocol: 'openai'
    },
    openai: {
      id: 'openai', label: 'OpenAI API (API key, not a ChatGPT subscription)', baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      keyEnv: 'OPENAI_API_KEY', keysEnv: 'OPENAI_API_KEYS',
      models: modelsFromEnv('OPENAI', envRates('OPENAI')), protocol: 'openai'
    },
    claude: {
      id: 'claude', label: 'Claude (Anthropic API)', baseUrl: (process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
      keyEnv: 'ANTHROPIC_API_KEY', keysEnv: 'ANTHROPIC_API_KEYS', keyAliases: ['CLAUDE_API_KEY'],
      models: modelsFromEnv('CLAUDE', { input: null, cache: null, output: null, cacheWrite: null }, [
        { name: 'claude-sonnet-4-6', rates: { input: 3, cache: 0.3, cacheWrite: 3.75, output: 15 } },
        { name: 'claude-opus-4-6', rates: { input: 5, cache: 0.5, cacheWrite: 6.25, output: 25 } },
        { name: 'claude-haiku-4-5-20251001', rates: { input: 1, cache: 0.1, cacheWrite: 1.25, output: 5 } }
      ]), protocol: 'anthropic'
    },
    glm: {
      id: 'glm', label: 'GLM (Z.AI)', baseUrl: (process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4').replace(/\/$/, ''),
      keyEnv: 'GLM_API_KEY', keysEnv: 'GLM_API_KEYS', keyAliases: ['ZAI_API_KEY'],
      models: modelsFromEnv('GLM', { input: null, cache: null, cacheWrite: null, output: null }, [
        { name: 'glm-5.1', rates: { input: 1.4, cache: 0.26, output: 4.4 } },
        { name: 'glm-5', rates: { input: 1, cache: 0.2, output: 3.2 } },
        { name: 'glm-4.7', rates: { input: 0.6, cache: 0.11, output: 2.2 } }
      ]), protocol: 'openai'
    },
    gemini: {
      id: 'gemini', label: 'Gemini (Google AI API)', baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
      keyEnv: 'GEMINI_API_KEY', keysEnv: 'GEMINI_API_KEYS',
      models: modelsFromEnv('GEMINI', { input: null, cache: null, cacheWrite: null, output: null }, [
        { name: 'gemini-3.8-flash', rates: { input: 0.75, cache: 0.075, output: 3.75 } },
        { name: 'gemini-3.7-flash', rates: { input: 0.75, cache: 0.075, output: 3.75 } },
        { name: 'gemini-3.6-flash', rates: { input: 0.75, cache: 0.075, output: 3.75 } },
        { name: 'gemini-3.5-flash-lite', rates: { input: 0.3, cache: 0.03, output: 2.5 } }
      ]), protocol: 'gemini'
    }
  };
}

// --- Saved catalog and secret-free resolution ---------------------------------

function readConfig() {
  try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function normalizeProvider(id, value = {}) {
  const models = Array.isArray(value.models) ? value.models.map(model => typeof model === 'string' ? { name: model } : model).filter(model => model?.name) : [];
  return {
    id,
    label: value.label || id,
    baseUrl: String(value.baseUrl || '').replace(/\/$/, ''),
    keyEnv: value.keyEnv || `${id.toUpperCase()}_API_KEY`,
    keysEnv: value.keysEnv || `${id.toUpperCase()}_API_KEYS`,
    keyAliases: Array.isArray(value.keyAliases) ? value.keyAliases.filter(Boolean) : [],
    models,
    rates: value.rates && typeof value.rates === 'object' ? value.rates : null,
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
    protocol: value.protocol || 'openai',
    requestMethod: String(value.requestMethod || 'POST').toUpperCase(),
    requestUrl: value.requestUrl || '',
    queryParams: value.queryParams && typeof value.queryParams === 'object' ? value.queryParams : {},
    requestTemplate: value.requestTemplate !== undefined && value.requestTemplate !== null ? value.requestTemplate : null,
    bodyType: String(value.bodyType || 'json').toLowerCase(),
    authLocation: String(value.authLocation || 'header').toLowerCase(),
    authQueryParam: value.authQueryParam || '',
    authQueryPrefix: value.authQueryPrefix !== undefined ? String(value.authQueryPrefix) : '',
    authHeader: value.authHeader || 'Authorization',
    authPrefix: value.authPrefix !== undefined ? String(value.authPrefix) : 'Bearer ',
    contentType: value.contentType || 'application/json',
    responsePath: value.responsePath || '',
    responsePaths: Array.isArray(value.responsePaths) ? value.responsePaths.filter(Boolean) : [],
    responseType: value.responseType || 'json',
    modelPath: value.modelPath || 'model',
    usagePath: value.usagePath || 'usage',
    usageMap: value.usageMap && typeof value.usageMap === 'object' ? value.usageMap : null
  };
}

function loadCatalog() {
  const stored = readConfig();
  const builtins = defaultProviders();
  const providers = {};
  for (const [id, value] of Object.entries(builtins)) providers[id] = normalizeProvider(id, value);
  for (const [id, value] of Object.entries(stored.providers || {})) providers[id] = normalizeProvider(id, { ...(providers[id] || {}), ...value });
  return { providers, stored };
}

// A provider may expose a friendly alias as well as its conventional key
// variable (for example CLAUDE_API_KEY and ANTHROPIC_API_KEY). Keep all
// credential lookup in one place and never return the actual secret values.
function getKeys(provider) {
  const singularNames = [provider.keyEnv, ...(provider.keyAliases || [])]
    .filter((name, index, values) => name && values.indexOf(name) === index);
  const keys = [];
  for (const singular of singularNames) {
    const plural = singular === provider.keyEnv ? provider.keysEnv : singular.replace(/_API_KEY$/i, '_API_KEYS');
    const escaped = singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numbered = Object.entries(process.env)
      .filter(([name, value]) => new RegExp(`^${escaped}_\\d+$`, 'i').test(name) && value)
      .sort(([a], [b]) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]))
      .map(([, value]) => value.trim());
    keys.push(process.env[singular] || '', ...splitList(process.env[plural]), ...numbered);
  }
  return [...new Set(keys.filter(Boolean))];
}

// --- Selection and interactive configuration ----------------------------------

function getRates(provider, modelEntry) {
  const rates = modelEntry?.rates || provider.rates || {};
  const hasRate = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  return {
    input: hasRate(rates.input) ? Number(rates.input) : null,
    cache: hasRate(rates.cache) ? Number(rates.cache) : null,
    output: hasRate(rates.output) ? Number(rates.output) : null,
    cacheWrite: hasRate(rates.cacheWrite) ? Number(rates.cacheWrite) : null
  };
}

function resolveProvider(providerId = null, modelName = null) {
  const catalog = loadCatalog();
  const id = providerId || process.env.NEGEV_PROVIDER || catalog.stored.activeProvider || 'deepseek';
  const provider = catalog.providers[id];
  if (!provider) throw new Error(`unknown provider "${id}"; run the control center providers command`);
  const selectedModel = modelName || process.env.NEGEV_MODEL || catalog.stored.activeModel || provider.models[0]?.name || '';
  const modelEntry = provider.models.find(item => item.name === selectedModel) || provider.models.find(Boolean) || null;
  return { ...provider, keys: getKeys(provider), model: modelEntry?.name || selectedModel, modelEntry, rates: getRates(provider, modelEntry) };
}

function getActiveProvider() {
  return resolveProvider();
}

function listProviders() {
  const catalog = loadCatalog();
  return Object.values(catalog.providers).map(provider => {
    const resolved = resolveProvider(provider.id);
    return {
      id: provider.id, label: provider.label, baseUrl: provider.baseUrl, protocol: provider.protocol,
      keyEnv: provider.keyEnv, keysEnv: provider.keysEnv, keyAliases: provider.keyAliases, keyCount: resolved.keys.length,
      models: provider.models.map(model => model.name),
      active: provider.id === (process.env.NEGEV_PROVIDER || catalog.stored.activeProvider || 'deepseek')
    };
  });
}

function writeConfig(value) {
  ensureDirs();
  const temp = `${PROVIDERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, PROVIDERS_FILE);
}

function setActive(providerId, modelName = '') {
  const catalog = loadCatalog();
  if (!catalog.providers[providerId]) throw new Error(`unknown provider "${providerId}"`);
  const model = modelName || catalog.providers[providerId].models[0]?.name || '';
  if (modelName && !catalog.providers[providerId].models.some(item => item.name === modelName)) {
    throw new Error(`model "${modelName}" is not configured for ${providerId}`);
  }
  writeConfig({ ...catalog.stored, activeProvider: providerId, activeModel: model });
  return resolveProvider(providerId, model);
}

function addProvider({ id, label, baseUrl, keyEnv, keysEnv, model, rates, protocol = 'openai', requestMethod = 'POST', requestUrl = '', queryParams = null, requestTemplate = null, bodyType = '', authLocation = '', authQueryParam = '', authQueryPrefix = '', authHeader = '', authPrefix = '', contentType = '', responsePath = '', responsePaths = null, responseType = '', modelPath = '', usagePath = '', usageMap = null, headers = null }) {
  const safeId = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safeId) throw new Error('provider id is required');
  if (!baseUrl) throw new Error('provider base URL is required');
  const catalog = loadCatalog();
  const existing = catalog.stored.providers?.[safeId] || {};
  const models = Array.isArray(existing.models) ? existing.models : [];
  if (model) {
    const modelIndex = models.findIndex(item => (typeof item === 'string' ? item : item.name) === model);
    if (modelIndex < 0) models.push({ name: model, rates });
    else if (rates) models[modelIndex] = { ...(typeof models[modelIndex] === 'string' ? { name: models[modelIndex] } : models[modelIndex]), rates };
  }
  const providers = { ...(catalog.stored.providers || {}), [safeId]: {
    ...existing, label: label || existing.label || safeId, baseUrl: baseUrl.replace(/\/$/, ''), protocol: protocol || existing.protocol || 'openai',
    keyEnv: keyEnv || existing.keyEnv || `${safeId.toUpperCase()}_API_KEY`,
    keysEnv: keysEnv || existing.keysEnv || `${safeId.toUpperCase()}_API_KEYS`, models,
    ...(requestMethod ? { requestMethod: String(requestMethod).toUpperCase() } : {}),
    ...(requestUrl ? { requestUrl } : {}),
    ...(queryParams ? { queryParams } : {}),
    ...(requestTemplate ? { requestTemplate } : {}),
    ...(bodyType ? { bodyType: String(bodyType).toLowerCase() } : {}),
    ...(authLocation ? { authLocation } : {}),
    ...(authQueryParam ? { authQueryParam } : {}),
    ...(authQueryPrefix !== '' ? { authQueryPrefix } : {}),
    ...(authHeader ? { authHeader } : {}),
    ...(authPrefix !== '' ? { authPrefix } : {}),
    ...(contentType ? { contentType } : {}),
    ...(responsePath ? { responsePath } : {}),
    ...(responsePaths ? { responsePaths } : {}),
    ...(responseType ? { responseType } : {}),
    ...(modelPath ? { modelPath } : {}),
    ...(usagePath ? { usagePath } : {}),
    ...(usageMap ? { usageMap } : {}),
    ...(headers ? { headers } : {})
  } };
  writeConfig({ ...catalog.stored, providers });
  return resolveProvider(safeId, model || '');
}

function keyEnvironment(providerId) {
  const catalog = loadCatalog();
  const provider = catalog.providers[providerId];
  if (!provider) throw new Error(`unknown provider "${providerId}"`);
  return { keyEnv: provider.keyEnv, keysEnv: provider.keysEnv, keyAliases: provider.keyAliases || [] };
}

module.exports = { PROVIDERS_FILE, splitList, getActiveProvider, resolveProvider, listProviders, setActive, addProvider, keyEnvironment };
