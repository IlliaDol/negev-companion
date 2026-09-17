const config = require('./config');
const { sleep, safeText } = require('./util');
const usageLedger = require('./usage');
const providers = require('./providers');

// Provider-neutral request engine. Built-in native protocols and arbitrary
// custom templates are normalized here into one text/usage result shape.

let nextCredentialIndex = 0;

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

// --- Provider-neutral content conversion and request construction --------------

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => contentToText(part)).filter(Boolean).join(' ');
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.output_text === 'string') return content.output_text;
    if (content.content !== undefined) return contentToText(content.content);
  }
  return '';
}

function isModelFallbackError(status, detail = '') {
  return status === 404 || /model|thinking|reasoning/i.test(detail);
}

function isCredentialOrTransientError(status, detail = '') {
  return [401, 403, 408, 425, 429].includes(status)
    || (status >= 500 && status <= 599)
    || /rate.?limit|quota|timeout|timed out|temporar|overload|unavailable|fetch failed|aborted|empty response|network|socket|connect/i.test(detail);
}

function configuredModels(provider) {
  const names = provider.models.map(model => model.name);
  return [...new Set([provider.model, ...names].filter(Boolean))];
}

function getPath(value, pathName, fallback = undefined) {
  if (!pathName) return fallback;
  const parts = String(pathName).replace(/^\$\.?/, '').replace(/\[(['"]?)([^\]'"]+)\1\]/g, '.$2').split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return fallback;
    current = current[part];
  }
  return current === undefined ? fallback : current;
}

function interpolate(value, variables) {
  return String(value || '').replace(/\{\{\s*(messages|model|maxTokens|max_tokens|temperature|apiKey|prompt|system|userMessage|lastMessage|input)\s*\}\}/g, (_, name) => {
    const variable = variables[name];
    return typeof variable === 'string' ? variable : JSON.stringify(variable ?? '');
  });
}

function fillTemplate(value, variables) {
  if (Array.isArray(value)) return value.map(item => fillTemplate(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item, variables)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{\s*(messages|model|maxTokens|max_tokens|temperature|apiKey|prompt|system|userMessage|lastMessage|input)\s*\}\}$/);
  if (exact) return variables[exact[1]];
  return interpolate(value, variables);
}

function templateVariables(model, messages, maxTokens, temperature, key) {
  const system = messages.filter(message => message.role === 'system').map(message => contentToText(message.content)).filter(Boolean).join('\n\n');
  const userMessages = messages.filter(message => message.role !== 'system').map(message => contentToText(message.content)).filter(Boolean);
  const prompt = userMessages.join('\n\n');
  const lastMessage = userMessages[userMessages.length - 1] || '';
  return {
    model, messages, maxTokens, max_tokens: maxTokens, temperature, apiKey: key,
    prompt, system, userMessage: lastMessage, lastMessage, input: lastMessage
  };
}

function appendQuery(url, params = {}) {
  if (!params || typeof params !== 'object' || !Object.keys(params).length) return url;
  const parsed = new URL(url);
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') parsed.searchParams.set(name, String(value));
  return parsed.toString();
}

function dataUri(value) {
  const match = String(value || '').match(/^data:([^;,]+)(?:;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function anthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') { blocks.push({ type: 'text', text: part }); continue; }
    if (part?.type === 'text') { blocks.push({ type: 'text', text: part.text || '' }); continue; }
    if (part?.type === 'image_url') {
      const url = part.image_url?.url || '';
      const inline = dataUri(url);
      if (inline) blocks.push({ type: 'image', source: { type: 'base64', media_type: inline.mimeType, data: inline.data } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function toAnthropicMessages(messages = []) {
  const system = messages.filter(message => message.role === 'system').map(message => contentToText(message.content)).filter(Boolean).join('\n\n');
  const converted = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: anthropicContent(message.content)
  }));
  return { system, messages: converted.length ? converted : [{ role: 'user', content: [{ type: 'text', text: '' }] }] };
}

function geminiPart(part) {
  if (typeof part === 'string') return { text: part };
  if (part?.type === 'text') return { text: part.text || '' };
  if (part?.type === 'image_url') {
    const url = part.image_url?.url || '';
    const inline = dataUri(url);
    if (inline) return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
    // Gemini's REST API accepts file URIs, not arbitrary web URLs. The bot's
    // Telegram media path is always converted to a data URI before this point.
    if (/^(?:https?|gs):\/\//i.test(url)) return { fileData: { mimeType: 'image/jpeg', fileUri: url } };
    return { text: '[image unavailable]' };
  }
  return { text: part?.text || '' };
}

function geminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) return content.map(geminiPart).filter(Boolean);
  return [{ text: String(content || '') }];
}

function toGeminiContents(messages = []) {
  const systemText = messages.filter(message => message.role === 'system').map(message => contentToText(message.content)).filter(Boolean).join('\n\n');
  const contents = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: geminiParts(message.content)
  }));
  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  };
}

function buildRequest(provider, model, messages, maxTokens, temperature, key) {
  const protocol = provider.protocol || 'openai';
  if (protocol === 'anthropic') {
    const converted = toAnthropicMessages(messages);
    const payload = { model, max_tokens: maxTokens, messages: converted.messages };
    // Anthropic's current Claude 4.7+ models reject non-default temperature;
    // omitting it is valid for all Messages API models and keeps this adapter
    // compatible across the model list.
    if (converted.system) payload.system = converted.system;
    return {
      url: `${provider.baseUrl}/messages`,
      method: 'POST',
      headers: { ...provider.headers, 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      payload
    };
  }
  if (protocol === 'gemini') {
    const converted = toGeminiContents(messages);
    const payload = {
      contents: converted.contents,
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    };
    if (converted.systemInstruction) payload.systemInstruction = converted.systemInstruction;
    return {
      url: `${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: { ...provider.headers, 'x-goog-api-key': key, 'content-type': 'application/json' },
      payload
    };
  }
  if (protocol === 'custom') {
    const variables = templateVariables(model, messages, maxTokens, temperature, key);
    const payload = provider.requestTemplate
      ? fillTemplate(provider.requestTemplate, variables)
      : { model, messages, temperature, max_tokens: maxTokens, stream: false };
    let url = interpolate(provider.requestUrl || `${provider.baseUrl}/chat/completions`, variables);
    const queryParams = fillTemplate(provider.queryParams || {}, variables);
    if (provider.authLocation === 'query' && provider.authQueryParam) {
      queryParams[provider.authQueryParam] = `${provider.authQueryPrefix || ''}${key}`;
    }
    url = appendQuery(url, queryParams);
    const authHeader = String(provider.authHeader || 'Authorization');
    const headers = fillTemplate(provider.headers || {}, variables);
    if (provider.authLocation !== 'query' && provider.authLocation !== 'none' && authHeader.toLowerCase() !== 'none') headers[authHeader] = `${provider.authPrefix || ''}${key}`;
    if (String(provider.contentType || 'application/json').toLowerCase() !== 'none') headers['Content-Type'] = provider.contentType || 'application/json';
    const body = String(provider.bodyType || 'json').toLowerCase() === 'text'
      ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : JSON.stringify(payload);
    return { url, method: String(provider.requestMethod || 'POST').toUpperCase(), headers, payload, body };
  }
  const payload = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (provider.id === 'deepseek') payload.thinking = { type: 'disabled' };
  return {
    url: `${provider.baseUrl}/chat/completions`,
    method: 'POST',
    headers: { ...provider.headers, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    payload
  };
}

function responseText(provider, data) {
  if (provider.protocol === 'anthropic') return (data.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
  if (provider.protocol === 'gemini') return (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
  if (provider.protocol === 'custom') {
    const paths = Array.isArray(provider.responsePaths) && provider.responsePaths.length
      ? provider.responsePaths : [provider.responsePath || 'choices.0.message.content'];
    for (const pathName of paths) {
      const value = pathName ? getPath(data, pathName, '') : data;
      const text = contentToText(value);
      if (text) return text;
    }
    return typeof data?.__rawText === 'string' ? data.__rawText : '';
  }
  return contentToText(data.choices?.[0]?.message?.content);
}

// --- Provider usage normalization and call orchestration ----------------------

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function normalizeProviderUsage(provider, raw = {}) {
  if (provider.protocol === 'anthropic') {
    const cacheRead = count(raw.cache_read_input_tokens);
    const cacheWrite = count(raw.cache_creation_input_tokens);
    const input = count(raw.input_tokens) + cacheRead + cacheWrite;
    const output = count(raw.output_tokens);
    return {
      prompt_tokens: input, completion_tokens: output, prompt_cache_hit_tokens: cacheRead,
      prompt_cache_write_tokens: cacheWrite, input_tokens: input, output_tokens: output
    };
  }
  if (provider.protocol === 'gemini') {
    const cacheRead = count(raw.cachedContentTokenCount);
    const toolPrompt = count(raw.toolUsePromptTokenCount);
    const input = count(raw.promptTokenCount) + toolPrompt;
    const thoughts = count(raw.thoughtsTokenCount);
    const output = count(raw.candidatesTokenCount) + thoughts;
    return {
      prompt_tokens: input, completion_tokens: output, prompt_cache_hit_tokens: cacheRead,
      input_tokens: input, output_tokens: output, thoughts_tokens: thoughts,
      tool_use_prompt_tokens: toolPrompt, provider_total_tokens: count(raw.totalTokenCount)
    };
  }
  return raw || {};
}

function normalizeCustomUsage(provider, data) {
  const raw = getPath(data, provider.usagePath || 'usage', {}) || {};
  if (!provider.usageMap || !Object.keys(provider.usageMap).length) return raw;
  const lookup = pathName => getPath(data, pathName, getPath(raw, pathName, 0));
  return {
    prompt_tokens: count(lookup(provider.usageMap.input || provider.usageMap.prompt_tokens)),
    completion_tokens: count(lookup(provider.usageMap.output || provider.usageMap.completion_tokens)),
    prompt_cache_hit_tokens: count(lookup(provider.usageMap.cached || provider.usageMap.cache_hit_tokens)),
    prompt_cache_write_tokens: count(lookup(provider.usageMap.cacheWrite || provider.usageMap.cache_creation_input_tokens))
  };
}

async function callDeepSeek({ messages, maxTokens = 360, temperature = 0.86, bucketId, purpose = 'reply' }) {
  const provider = providers.getActiveProvider();
  if (!provider.keys.length) throw new Error(`no API key configured for active provider "${provider.id}" (${provider.keyEnv} or ${provider.keysEnv})`);
  const models = configuredModels(provider);
  if (!models.length) throw new Error(`no model configured for active provider "${provider.id}"`);
  let lastError = null;
  const keyOrder = provider.keys.map((_, offset) => (nextCredentialIndex + offset) % provider.keys.length);
  for (const model of models) {
    const modelEntry = provider.models.find(item => item.name === model);
    const rates = modelEntry?.rates || provider.rates;
    for (const keyIndex of keyOrder) {
      const request = buildRequest(provider, model, messages, maxTokens, temperature, provider.keys[keyIndex]);
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value));
      const timeout = timeoutSignal(config.HTTP_TIMEOUT_MS);
      try {
        const requestMethod = String(request.method || 'POST').toUpperCase();
        const hasBody = !['GET', 'HEAD'].includes(requestMethod);
        const response = await fetch(request.url, {
          method: requestMethod, headers, body: hasBody ? (request.body !== undefined ? request.body : JSON.stringify(request.payload)) : undefined, signal: timeout.signal
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { __rawText: text }; }
        if (!response.ok) {
          const detail = safeText(data.error?.message || data.message || text, 600);
          const error = new Error(`${response.status} ${detail}`); error.status = response.status;
          lastError = error;
          if (isModelFallbackError(response.status, detail)) break;
          if (isCredentialOrTransientError(response.status, detail)) { await sleep(180); continue; }
          throw error;
        }
        const rawUsage = provider.protocol === 'custom'
          ? getPath(data, provider.usagePath || 'usage', {}) || {}
          : data.usage || data.usageMetadata || {};
        const normalizedUsage = provider.protocol === 'custom'
          ? normalizeCustomUsage(provider, data)
          : normalizeProviderUsage(provider, rawUsage);
        const output = responseText(provider, data).trim();
        if (!output) throw new Error('provider returned an empty response');
        const responseModel = provider.protocol === 'custom' ? getPath(data, provider.modelPath || 'model', model) : data.model || model;
        const call = usageLedger.recordCall({
          bucketId, provider: provider.id, model: responseModel, usage: normalizedUsage,
          purpose, providerKey: `key-${keyIndex + 1}`, rates
        });
        nextCredentialIndex = (keyIndex + 1) % provider.keys.length;
        return { text: output, model: responseModel, usage: normalizedUsage, providerUsage: rawUsage, call };
      } catch (error) {
        lastError = error;
        if (isModelFallbackError(error.status, error.message)) break;
        if (isCredentialOrTransientError(error.status, error.message)) continue;
        throw error;
      } finally { timeout.close(); }
    }
  }
  throw lastError || new Error('provider request failed');
}

module.exports = {
  callDeepSeek, contentToText, isModelFallbackError, isCredentialOrTransientError, configuredModels,
  dataUri, anthropicContent, toAnthropicMessages, geminiPart, toGeminiContents, getPath, fillTemplate,
  buildRequest, responseText, normalizeProviderUsage, normalizeCustomUsage
};
