const assert = require('assert/strict');
const { splitBubbles, applyHumanStyle } = require('./style');
const memory = require('./memory');
const conversation = require('./conversation');
const timing = require('./timing');
const usage = require('./usage');
const persona = require('./persona');
const config = require('./config');
const deepseek = require('./deepseek');
const providers = require('./providers');
const { extractUrls } = require('./links');
const { mediaInfo, mimeFor, pullMusicLines } = require('./media');

// Dependency-free regression tests. Keep each test focused on one invariant;
// the local control center runs this file before a restart.
const { commandOf, parseMuteMinutes, inboundText, hasSupportedMedia, reactionForMessage, telegramHelp } = require('./bot');

function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}: ${error.message}`); process.exitCode = 1; }
}

test('model bubble separators become clean short bubbles', () => {
  assert.deepEqual(splitBubbles('one|||two|||three|||four'), ['one', 'two', 'three four']);
  assert.equal(splitBubbles('')[0], undefined);
});

test('emoji are removed but plain-text affection survives', () => {
  const text = applyHumanStyle('hey 😭 )) <3', { random: () => 1 });
  assert.equal(text, 'hey )) <3');
});

test('explicit remember clauses split facts without splitting normal and', () => {
  assert.deepEqual(memory.parseRemember('remember that my exam is monday and my sister visits friday').map(x => x.value), ['my exam is monday', 'my sister visits friday']);
  assert.deepEqual(memory.parseRemember('remembered our deal?'), []);
  assert.deepEqual(memory.parseRemember('remember fish and chips'), [{ type: 'fact', value: 'fish and chips' }]);
});

test('promises and tasks are recognized', () => {
  assert.equal(memory.parsePromise("i'll send that tomorrow")[0].type, 'promise');
  assert.equal(memory.parsePromise('remind me to call the dentist')[0].type, 'task');
  const state = { facts: [], promises: [], tasks: [], history: [], unanswered: [] };
  memory.addPromise(state, 'check back tomorrow', 'promise', new Date(), 'Europe/Berlin', 'negev');
  assert.equal(state.promises[0].speaker, 'negev');
});

test('multiple tasks stay separate and sort by due date', () => {
  const state = { facts: [], promises: [], tasks: [], history: [], unanswered: [] };
  const now = new Date('2026-09-16T12:00:00Z');
  memory.addPromise(state, 'finish the roadmap next week', 'task', now, 'Europe/Berlin', 'he');
  memory.addPromise(state, 'send the application tomorrow', 'task', now, 'Europe/Berlin', 'he');
  memory.rememberExplicit(state, 'also i need to send the application tomorrow', 'Europe/Berlin', now);
  assert.equal(state.tasks.length, 2);
  assert.equal(memory.listMemories(state).tasks[0].value, 'send the application tomorrow');
  assert.match(memory.memoryContext(state, 8, 'Europe/Berlin'), /finish the roadmap next week/);
  assert.match(persona.CORE, /Track multiple open tasks/);
});

test('relative dates become concrete local calendar times and remain actionable', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  assert.equal(memory.parseDueDate('finish the exercise tomorrow', now, 'Europe/Berlin').dateKey, '2026-09-17');
  assert.equal(memory.parseDueDate('review it in one week', now, 'Europe/Berlin').dateKey, '2026-09-23');
  assert.equal(memory.parseDueDate('meeting next monday at 14:30', now, 'Europe/Berlin').dateKey, '2026-09-21');
  assert.equal(memory.parseDueDate('in a couple of hours', now, 'Europe/Berlin').dueAt, '2026-09-16T14:00:00.000Z');
  assert.equal(memory.parseDueDate('the 15th of next month', now, 'Europe/Berlin').dateKey, '2026-10-15');
  assert.equal(memory.parseDueDate('next Friday at 7pm', now, 'Europe/Berlin').dueAt, '2026-09-18T17:00:00.000Z');
  assert.equal(memory.parseDueDate('a fortnight from now', now, 'Europe/Berlin').dateKey, '2026-09-30');
  assert.equal(memory.parseDueDate('end of next month', now, 'Europe/Berlin').dateKey, '2026-10-31');
  const state = { facts: [], promises: [], tasks: [], calendar: [], history: [], unanswered: [] };
  const remembered = memory.rememberExplicit(state, 'remember that my exam is tomorrow at 10:00', 'Europe/Berlin', now);
  assert.equal(remembered.calendar.length, 1);
  assert.equal(remembered.calendar[0].dueDate, '2026-09-17');
  assert.equal(memory.pendingCalendar(state, new Date('2026-09-17T07:30:00Z')).length, 0);
  assert.equal(memory.pendingCalendar(state, new Date('2026-09-17T08:30:00Z')).length, 1);
  assert.equal(memory.completeMemory(state, 'exam'), 1);
  assert.equal(memory.pendingCalendar(state, new Date('2026-09-18T08:30:00Z')).length, 0);
});

test('invalid work dates cannot poison reminder sorting', () => {
  const items = [
    { value: 'no date', dueAt: 'not-a-date', createdAt: '2026-09-16T12:00:00Z' },
    { value: 'tomorrow', dueAt: '2026-09-17T12:00:00Z', createdAt: '2026-09-16T12:00:00Z' }
  ].sort(memory.sortWorkItems);
  assert.equal(items[0].value, 'tomorrow');
  assert.equal(items[1].value, 'no date');
});

test('proactive scheduling never places a message in the already-finished evening', () => {
  const late = new Date('2026-09-17T22:30:00Z'); // late evening in the test timezone
  const next = new Date(timing.nextProactiveAt(late, 'UTC', 'late-test', () => 0));
  assert.ok(next > late);
  assert.equal(next.toISOString().slice(0, 10), '2026-09-18');
});

test('natural date wording is durable and uses the supplied local time zone', () => {
  const state = { facts: [], promises: [], tasks: [], calendar: [], history: [], unanswered: [] };
  const added = memory.rememberDateReferences(state, 'we can meet the Friday after next at 7pm', 'he', new Date('2026-09-16T12:00:00Z'), 'UTC');
  assert.equal(added.length, 1);
  assert.equal(added[0].dueDate, '2026-09-25');
  assert.equal(added[0].dueAt, '2026-09-25T19:00:00.000Z');
});

test('casual date questions do not become false calendar reminders', () => {
  const state = { facts: [], promises: [], tasks: [], calendar: [], history: [], unanswered: [] };
  assert.deepEqual(memory.rememberDateReferences(state, 'what were you doing today?', 'negev', new Date('2026-09-16T12:00:00Z'), 'UTC'), []);
  assert.equal(state.calendar.length, 0);
  assert.equal(memory.rememberDateReferences(state, 'we can meet tomorrow at 14:00', 'negev', new Date('2026-09-16T12:00:00Z'), 'UTC').length, 1);
});

test('facts re-pin instead of duplicating', () => {
  const state = { facts: [], promises: [], tasks: [], history: [], unanswered: [] };
  memory.pinFact(state, 'my exam is monday');
  memory.pinFact(state, 'my exam is Monday');
  assert.equal(state.facts.length, 1);
});

test('sleep is an absolute gate', () => {
  process.env.NEGEV_FORCE_SLEEP = 'asleep';
  assert.equal(timing.planReply({}).mode, 'sleep');
  process.env.NEGEV_FORCE_SLEEP = 'awake';
  assert.equal(timing.planReply({ force: true }).mode, 'instant');
  delete process.env.NEGEV_FORCE_SLEEP;
});

test('waking replies never exceed the configured daytime ceiling', () => {
  process.env.NEGEV_FORCE_SLEEP = 'awake';
  for (let i = 0; i < 100; i++) assert.ok(timing.planReply({ random: Math.random }).delayMs <= 25 * 60 * 1000);
  delete process.env.NEGEV_FORCE_SLEEP;
});

test('active back-and-forth replies stay much faster', () => {
  process.env.NEGEV_FORCE_SLEEP = 'awake';
  const now = new Date('2026-09-16T12:00:00Z');
  const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const active = timing.planReply({ now, lastInboundAt: recent, messageCount: 8, random: () => 0.8 });
  const quiet = timing.planReply({ now, lastInboundAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), random: () => 0.8 });
  assert.ok(active.delayMs <= 30_000);
  assert.ok(quiet.delayMs > active.delayMs);
  delete process.env.NEGEV_FORCE_SLEEP;
});

test('natural requests for time pause until he writes back', () => {
  assert.equal(timing.detectWaitForUser("im resting a bit, give me some time, ill text you when im ready").active, true);
  assert.equal(timing.detectWaitForUser('i need a quiet while, ill message you later').active, true);
  assert.equal(timing.detectWaitForUser('wait till i write back').active, true);
  assert.equal(timing.detectWaitForUser('give me a minute to explain this').active, false);
  assert.equal(timing.detectWaitForUser("i'm not in the mood to talk, i'll come back later").active, true);
});

test('natural requests can keep her awake for one short extension', () => {
  assert.equal(timing.detectStayUpRequest("dont go to sleep yet, stay with me"), true);
  assert.equal(timing.detectStayUpRequest('please stay awake for fifteen more minutes'), true);
  assert.equal(timing.detectStayUpRequest('i need to sleep, dont wake me'), false);
});

test('bedtime extension preserves the same wake time across midnight', () => {
  const schedule = timing.scheduleForDate('2026-09-17');
  const minute = schedule.bedtimeMinute % 1440 + 5;
  const local = `${schedule.bedDate}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+02:00`;
  const now = new Date(local);
  const base = timing.getSleepState(now, 'Europe/Berlin');
  const extended = timing.getSleepState(now, 'Europe/Berlin', { bedtimeExtensionMinutes: 15, bedtimeExtensionDate: schedule.dateKey });
  assert.equal(base.asleep, true);
  assert.equal(extended.asleep, false);
  assert.equal(extended.schedule.wakeTime, base.schedule.wakeTime);
  assert.equal(timing.untilBedMs(now, 'Europe/Berlin', { bedtimeExtensionMinutes: 15, bedtimeExtensionDate: schedule.dateKey }), 10 * 60 * 1000);
});

test('conversation state tracks intent, topics, open loops, and repair', () => {
  const state = {};
  const turn = conversation.observeUser(state, 'what should i work on for the roadmap?');
  assert.equal(turn.intent, 'motivation');
  assert.equal(turn.topic, 'motivation/work');
  assert.equal(state.conversation.openLoops.length, 0); // motivation is an intent, not automatically a question to nag about
  conversation.observeUser(state, 'which project should i choose?');
  assert.equal(state.conversation.openLoops.length, 1);
  conversation.markAnswered(state);
  assert.equal(state.conversation.openLoops[0].status, 'answered');
  conversation.observeUser(state, "no, that's not what i meant");
  assert.equal(state.conversation.mode, 'repair');
  assert.match(conversation.context(state), /repair|current conversation topic/);
});

test('conversation diary matches energy and offers restrained callbacks', () => {
  const state = {
    history: [
      { role: 'user', text: 'i finally opened the data science roadmap' },
      { role: 'assistant', text: 'good. one tiny step counts' },
      { role: 'user', text: 'i found a weird song and now it is stuck in my head' }
    ]
  };
  conversation.observeUser(state, 'im tired but i still want to talk');
  assert.equal(state.conversation.userEnergy, 'heavy');
  assert.equal(state.conversation.userMessageShape, 'open share');
  assert.match(conversation.context(state), /current message energy: heavy/);
  assert.match(conversation.context(state), /recent things he shared/);
  assert.match(conversation.responseGuidance(state), /warmer response/);
});

test('conversation starters stay specific and avoid immediate repetition', () => {
  const state = {};
  const turn = conversation.observeUser(state, 'i want to keep talking but i have no idea what to talk about');
  assert.equal(turn.intent, 'conversation_starter');
  const first = conversation.context(state);
  const second = conversation.context(state);
  assert.match(first, /fresh conversation sparks/);
  assert.match(second, /fresh conversation sparks/);
  assert.notEqual(first, second);
});

test('memory confidence distinguishes explicit facts from tentative model promises', () => {
  const state = { facts: [], promises: [], tasks: [], calendar: [], history: [], unanswered: [] };
  memory.rememberExplicit(state, 'remember that i prefer small steps', 'Europe/Berlin');
  memory.addPromise(state, 'i might start tomorrow', 'promise', new Date(), 'Europe/Berlin', 'negev', 'model');
  assert.equal(state.facts[0].confidence, 1);
  assert.ok(state.promises[0].confidence < 0.75);
  assert.match(memory.memoryContext(state), /tentative/);
});

test('serious messages receive presence instead of a long random delay', () => {
  process.env.NEGEV_FORCE_SLEEP = 'awake';
  const plan = timing.planReply({ intent: 'emotional_support', text: 'i feel overwhelmed', random: () => 0 });
  assert.equal(plan.mode, 'instant');
  delete process.env.NEGEV_FORCE_SLEEP;
});

test('usage pricing separates cached and fresh input', () => {
  const priced = usage.priceUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 700, completion_tokens: 100 }, new Date('2026-09-16T12:00:00Z'), { input: 0.15, cache: 0.003, output: 0.60 });
  assert.equal(priced.cached, 700); assert.equal(priced.fresh, 300); assert.equal(priced.output, 100); assert.ok(priced.cost > 0);
  assert.equal(priced.costUnits, '107100000');
  assert.equal(usage.formatCostUnits(priced.costUnits), '$0.000107100000');
  assert.equal(usage.formatMoney(0.001590042), '$0.001590042000');
  assert.equal(usage.priceUsage({ prompt_tokens: 10, completion_tokens: 2 }, new Date('2026-09-16T12:00:00Z'), { input: null, cache: null, output: null }).ratesConfigured, false);
  const claude = usage.priceUsage({ input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 5 }, new Date('2026-09-16T12:00:00Z'), { input: 3, cache: 0.3, cacheWrite: 3.75, output: 15 });
  assert.equal(claude.input, 130); assert.equal(claude.cached, 20); assert.equal(claude.cacheWrite, 10); assert.equal(claude.fresh, 100); assert.equal(claude.ratesConfigured, true);
  const gemini = usage.priceUsage({ promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 2 }, new Date('2026-09-16T12:00:00Z'), { input: 1, cache: 0.1, output: 2 });
  assert.equal(gemini.input, 100); assert.equal(gemini.cached, 20); assert.equal(gemini.output, 7);
});

test('usage estimates expose text, vision, and memory scenarios', () => {
  const estimate = usage.estimateScenarios();
  assert.match(estimate, /text only/); assert.match(estimate, /picture/); assert.match(estimate, /a lot of memory/);
  const lifetime = usage.formatLifetimeEstimate();
  const exactCost = usage.formatCostUnits(usage.loadLedger().totals.costUnits);
  assert.match(lifetime, /overall conversation token estimate/);
  assert.match(exactCost, /^\$\d+\.\d{12}$/);
  assert.ok(lifetime.includes(`tracked provider cost: ${exactCost}`));
  assert.equal(lifetime.includes('~'), false);
});

test('provider key pool supports failover without exposing credentials', () => {
  assert.ok(Array.isArray(config.DEEPSEEK_API_KEYS));
  assert.ok(config.DEEPSEEK_API_KEYS.length >= 1);
  assert.equal(deepseek.isCredentialOrTransientError(429, ''), true);
  assert.equal(deepseek.isCredentialOrTransientError(401, ''), true);
  assert.equal(deepseek.isCredentialOrTransientError(400, 'invalid request'), false);
  assert.equal(deepseek.isModelFallbackError(404, ''), true);
});

test('provider catalog exposes selectable compatible providers without secret values', () => {
  const catalog = providers.listProviders();
  assert.ok(catalog.some(item => item.id === 'deepseek'));
  assert.ok(catalog.some(item => item.id === 'openrouter'));
  assert.ok(catalog.some(item => item.id === 'openai'));
  assert.ok(catalog.some(item => item.id === 'claude' && item.protocol === 'anthropic'));
  assert.ok(catalog.some(item => item.id === 'glm' && item.protocol === 'openai'));
  assert.ok(catalog.some(item => item.id === 'gemini' && item.protocol === 'gemini'));
  assert.ok(catalog.every(item => !Object.prototype.hasOwnProperty.call(item, 'keys')));
});

test('native Claude and Gemini request adapters preserve text and pictures', () => {
  const messages = [
    { role: 'system', content: 'be natural' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
  ];
  const anthropic = deepseek.buildRequest({ id: 'claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', headers: {} }, 'claude-sonnet-4-6', messages, 100, 0.8, 'secret');
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.payload.system, 'be natural');
  assert.equal(anthropic.payload.messages[0].content[1].source.type, 'base64');
  assert.equal(anthropic.headers['x-api-key'], 'secret');
  const gemini = deepseek.buildRequest({ id: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', headers: {} }, 'gemini-3.8-flash', messages, 100, 0.8, 'secret');
  assert.match(gemini.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(gemini.payload.systemInstruction.parts[0].text, 'be natural');
  assert.equal(gemini.payload.contents[0].role, 'user');
  assert.equal(gemini.payload.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(deepseek.normalizeProviderUsage({ protocol: 'gemini' }, { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 }).completion_tokens, 6);
});

test('custom provider templates and token paths are supported', () => {
  const provider = {
    id: 'my-api', protocol: 'custom', baseUrl: 'https://example.test/api', requestUrl: 'https://example.test/generate/{{model}}',
    authHeader: 'x-api-key', authPrefix: '', responsePath: 'result.answer', modelPath: 'meta.model', usagePath: 'meta.usage',
    usageMap: { input: 'in', cached: 'cached', output: 'out' }, headers: {},
    requestTemplate: { engine: '{{model}}', prompt: '{{messages}}', options: { max: '{{maxTokens}}', temperature: '{{temperature}}' } }
  };
  const request = deepseek.buildRequest(provider, 'my-model', [{ role: 'user', content: 'hello' }], 80, 0.7, 'secret');
  assert.equal(request.url, 'https://example.test/generate/my-model');
  assert.equal(request.headers['x-api-key'], 'secret');
  assert.equal(request.payload.engine, 'my-model');
  assert.equal(request.payload.prompt[0].content, 'hello');
  assert.equal(deepseek.responseText ? deepseek.responseText(provider, { result: { answer: 'ok' } }) : 'ok', 'ok');
  const normalized = deepseek.normalizeCustomUsage(provider, { meta: { usage: { in: 10, cached: 2, out: 4 } } });
  assert.deepEqual(normalized, { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 2, prompt_cache_write_tokens: 0 });

  const textProvider = {
    id: 'plain-api', protocol: 'custom', baseUrl: 'https://example.test', requestMethod: 'GET',
    requestUrl: 'https://example.test/run', queryParams: { version: '{{model}}' }, authLocation: 'query',
    authQueryParam: 'api_key', authQueryPrefix: 'key-', authHeader: 'none', bodyType: 'text', contentType: 'text/plain',
    requestTemplate: '{{prompt}}', responsePath: '', responsePaths: [], headers: {}
  };
  const textRequest = deepseek.buildRequest(textProvider, 'plain-model', [{ role: 'user', content: 'hello' }], 80, 0.7, 'secret');
  assert.equal(textRequest.method, 'GET');
  assert.match(textRequest.url, /version=plain-model/);
  assert.match(textRequest.url, /api_key=key-secret/);
  assert.equal(textRequest.body, 'hello');
  assert.equal(textRequest.headers['Content-Type'], 'text/plain');
  assert.equal(deepseek.responseText(textProvider, { __rawText: 'plain answer' }), 'plain answer');
  assert.equal(deepseek.responseText({ protocol: 'custom', responsePaths: ['missing', 'items[0].answer'] }, { items: [{ answer: 'fallback' }] }), 'fallback');
});

test('link extraction handles social and ordinary URLs', () => {
  assert.deepEqual(extractUrls('look https://x.com/a/status/1 and https://example.com/a.'), ['https://x.com/a/status/1', 'https://example.com/a']);
});

test('media evidence keeps speech, OCR, and music separate', () => {
  const out = pullMusicLines('[Music]\nhello there\n♪ instrumental');
  assert.equal(out.speech, 'hello there'); assert.equal(out.music, '[Music]\n♪ instrumental');
});

test('commands include bang aliases and arguments', () => {
  assert.deepEqual(commandOf('!tokenall'), { name: '!tokenall', args: '' });
  assert.deepEqual(commandOf('!estimateall'), { name: '!estimateall', args: '' });
  assert.deepEqual(commandOf('/remember that i like tea'), { name: '/remember', args: 'that i like tea' });
  assert.equal(commandOf('!help').name, '!help');
  assert.equal(commandOf('!caring').name, '!caring');
  assert.equal(commandOf('/mood tsundere').args, 'tsundere');
  assert.equal(commandOf('!forgetall yes').args, 'yes');
  assert.equal(commandOf('!remember tea').name.slice(1), commandOf('/remember tea').name.slice(1));
  assert.equal(commandOf('!force tea').name.slice(1), commandOf('/force tea').name.slice(1));
  assert.equal(commandOf('/mute 30').args, '30');
  assert.equal(commandOf('!unmute').name, '!unmute');
  assert.equal(commandOf('!talk').name, '!talk');
  assert.equal(parseMuteMinutes('30'), 30);
  assert.equal(parseMuteMinutes('60 minutes'), 60);
  assert.equal(parseMuteMinutes('0'), 0);
  assert.equal(parseMuteMinutes('forever'), null);
  assert.equal(commandOf('!help@ExampleBot').name, '!help');
  assert.equal(commandOf('!help now').args, 'now');
  assert.match(telegramHelp(), /!force message/);
  assert.match(telegramHelp(), /sleep, mute, or waiting mode/);
  assert.match(telegramHelp(), /forgetall yes/);
  assert.match(telegramHelp(), /estimateall/);
  assert.match(telegramHelp(), /repair/);
  assert.match(telegramHelp(), /fresh topic/);
});

test('requested moods stay slight and override automatic mood swings', () => {
  assert.match(persona.buildSystemPrompt({ mood: 'caring' }), /only slightly more caring/);
  assert.equal(timing.moodForMessage('this is a bad day', { mood: { name: 'tsundere', forced: true } }).name, 'tsundere');
});

test('persona understands current chat slang without forcing it', () => {
  assert.ok(persona.profile);
  assert.match(persona.CORE, /casual natural English|configured language preferences/);
  assert.match(persona.CORE, /local time zone/);
  assert.match(persona.buildSystemPrompt({ replyMode: 'instant' }), /quick reply/);
  assert.match(persona.buildSystemPrompt({ replyMode: 'short' }), /commas, periods, missing marks/);
  assert.match(persona.CORE, /natural date or time wording/);
});

test('persona gives specific, non-shaming motivation', () => {
  assert.match(persona.MOTIVATION_GUIDANCE, /one tiny action/);
  assert.match(persona.MOTIVATION_GUIDANCE, /small-start approach|small, concrete next step/);
  assert.match(persona.buildProactivePrompt(), /Motivation should be occasional and specific/);
  assert.match(persona.MOTIVATION_GUIDANCE, /started.*done/);
  assert.match(persona.buildProactivePrompt(), /accountability.*warm/);
  assert.match(persona.HUMAN_CONVERSATION_GUIDANCE, /fresh subject/);
  assert.match(persona.RESPONSE_SHAPE_GUIDANCE, /at most one/);
});

test('automatic mood can stay the same or drift from conversation cues', () => {
  const stays = timing.moodForMessage('this is a bad day', { mood: { name: 'soft', forced: false } }, () => 0.99);
  const shifts = timing.moodForMessage('this is a bad day', { mood: { name: 'playful', forced: false } }, () => 0);
  const cooling = timing.moodForMessage('this is a bad day', { mood: { name: 'soft', forced: false, changedAt: new Date().toISOString() } }, () => 0);
  assert.equal(stays.name, 'soft');
  assert.notEqual(shifts.name, 'playful');
  assert.equal(shifts.forced, false);
  assert.equal(cooling.name, 'soft');
});

test('picture handling includes captions, image documents, and static stickers', () => {
  const photo = { photo: [{ file_id: 'p1' }], caption: 'look at this' };
  const imageDocument = { document: { file_id: 'd1', mime_type: 'image/png', file_name: 'note.png' } };
  const sticker = { sticker: { file_id: 's1', is_animated: false, is_video: false } };
  assert.equal(mediaInfo(photo).kind, 'photo');
  assert.equal(mediaInfo(imageDocument).kind, 'photo');
  assert.equal(mediaInfo(sticker).kind, 'photo');
  assert.equal(inboundText(photo), 'look at this');
  assert.equal(hasSupportedMedia(imageDocument), true);
});

test('ordinary Telegram documents enter the local conversion pipeline', () => {
  const pdf = { document: { file_id: 'pdf1', mime_type: 'application/pdf', file_name: 'report.pdf' }, caption: 'read this' };
  const spreadsheet = { document: { file_id: 'sheet1', file_name: 'plan.xlsx' } };
  assert.equal(mediaInfo(pdf).kind, 'document');
  assert.equal(mediaInfo(pdf).filename, 'report.pdf');
  assert.equal(mediaInfo(spreadsheet).kind, 'document');
  assert.equal(mimeFor('plan.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(hasSupportedMedia(pdf), true);
  assert.equal(inboundText(pdf), 'read this');
});

test('Telegram reactions are occasional and content-aware', () => {
  assert.equal(reactionForMessage({ message_id: 1 }, 'thanks, i love you', () => 0), '❤️');
  assert.equal(reactionForMessage({ message_id: 2 }, 'look at this', () => 0.99), null);
  assert.equal(reactionForMessage({ message_id: 3, photo: [{ file_id: 'p1' }] }, '', () => 0), '👀');
  assert.ok(reactionForMessage({ message_id: 4 }, 'please react to this with an emoji', () => 0.99));
});

if (!process.exitCode) console.log('\nALL SELF-TESTS PASSED');
