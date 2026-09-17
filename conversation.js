const { id, nowIso, safeText, stripEmoji } = require('./util');
const config = require('./config');

// Short-lived relational context. This is deliberately separate from
// durable facts: it helps the next reply feel continuous without turning
// every passing detail into permanent memory.

const TOPICS = [
  ['motivation/work', /\b(?:motivation|procrastinat|lazy|stuck|roadmap|project|work|study|studying|code|coding|career|exam|assignment|deadline)\b/i],
  ['relationship', /\b(?:love|miss|feelings?|dating|girlfriend|boyfriend|argument|fight|jealous|cute|kiss)\b/i],
  ['sleep/energy', /\b(?:sleep|slept|tired|awake|bed|wake|nap|rest|energy|exhausted)\b/i],
  ['food/day', /\b(?:eat|ate|dinner|lunch|breakfast|food|cooking|hungry|drink|coffee|day|today|morning|evening)\b/i],
  ['health', /\b(?:hurt|pain|sick|ill|doctor|stress|anxious|anxiety|sad|depressed|overwhelmed)\b/i],
  ['technology', /\b(?:bot|telegram|server|api|model|token|computer|windows|bug|error|program|software)\b/i]
];

const CONVERSATION_IDEAS = [
  ['mood', 'ask what tiny thing changed his mood today, even if it was stupid'],
  ['day', 'bring up one ordinary detail from today and make it interesting'],
  ['food', 'ask what he would eat right now if effort and money did not matter'],
  ['music', 'ask what song has been stuck in his head lately and why'],
  ['memory', 'ask about a random childhood habit or oddly specific memory'],
  ['future', 'ask what he would like his life to feel like a year from now'],
  ['work', 'ask which project would feel best to make a tiny bit of progress on tonight'],
  ['curiosity', 'share a small weird fact or hypothetical and ask what he thinks'],
  ['preferences', 'start a low-stakes debate about a food, habit, game, or unpopular opinion'],
  ['local life', `bring up a small local-life question about ${config.LOCATION}, weather, walking, or places the user might like`],
  ['relationship', 'ask what kind of small attention makes him feel noticed'],
  ['playful', 'give him a silly either-or choice and defend the answer playfully']
];

function clean(text, limit = 900) {
  return stripEmoji(safeText(text, limit)).replace(/\s+/g, ' ').trim();
}

function messageEnergy(text) {
  const value = clean(text, 1200);
  if (!value) return 'quiet';
  if (/\b(?:sad|upset|hurt|rough|bad day|stressed|overwhelmed|anxious|lonely|angry|scared|panic|crying|tired|exhausted)\b/i.test(value)) return 'heavy';
  if (value.length <= 28 && !/[!?？]/.test(value)) return 'brief';
  if (/[!?]{2,}|\b(?:lol|lmao|xdd|xdddd|omg|yess+|nooo+)\b/i.test(value) || /\b[A-Z]{4,}\b/.test(value)) return 'playful';
  if (value.length >= 500 || value.split(/\s+/).length >= 90) return 'detailed';
  return 'steady';
}

function messageShape(text) {
  const value = clean(text, 1200);
  if (!value) return 'empty';
  if (/[?？]/.test(value)) return 'question';
  if (/^(?:hey|heyy+|hi|hello|morning|good morning|yo|sup)\b/i.test(value)) return 'greeting';
  if (value.length <= 28) return 'short share';
  if (/[.!?。！？]$/.test(value)) return 'statement';
  return 'open share';
}

function ensureConversation(state) {
  const current = state.conversation && typeof state.conversation === 'object' ? state.conversation : {};
  state.conversation = {
    topic: current.topic || 'general',
    topicChangedAt: current.topicChangedAt || null,
    currentIntent: current.currentIntent || 'casual',
    mode: current.mode || 'normal',
    lastUserText: current.lastUserText || '',
    lastUserAt: current.lastUserAt || null,
    openLoops: Array.isArray(current.openLoops) ? current.openLoops : [],
    recentOpenings: Array.isArray(current.recentOpenings) ? current.recentOpenings : [],
    recentPhrases: Array.isArray(current.recentPhrases) ? current.recentPhrases : [],
    ideaHistory: Array.isArray(current.ideaHistory) ? current.ideaHistory : [],
    userEnergy: current.userEnergy || 'steady',
    userMessageShape: current.userMessageShape || 'statement',
    lastAssistantAt: current.lastAssistantAt || null,
    lastAssistantEnergy: current.lastAssistantEnergy || null,
    motivation: current.motivation || null,
    repair: current.repair || null
  };
  state.conversation.openLoops = state.conversation.openLoops.filter(item => item && item.text).slice(-8);
  state.conversation.recentOpenings = state.conversation.recentOpenings.filter(Boolean).slice(-12);
  state.conversation.recentPhrases = state.conversation.recentPhrases.filter(Boolean).slice(-12);
  state.conversation.ideaHistory = state.conversation.ideaHistory.filter(item => item && item.idea).slice(-20);
  return state.conversation;
}

function classifyIntent(text) {
  const value = String(text || '').toLowerCase().replace(/[’]/g, "'").trim();
  if (!value) return 'casual';
  if (/\b(?:ignore|forget)\s+(?:my|that|the)\s+(?:last|previous)|you misunderstood|that's not what i meant|no,? i mean|i meant|wrong question|you got me wrong/i.test(value)) return 'repair';
  if (/\b(?:just listen|listen to me|don't solve|do not solve|no advice|dont ask questions|don't ask me questions|let me vent|i need to vent|hear me out)\b/i.test(value)) return 'listen';
  if (/\b(?:no motivation|can't start|cannot start|procrastinat|wasting the day|being lazy|feel stuck|need motivation|help me start|roadmap|what should i work on)\b/i.test(value)) return 'motivation';
  if (/\b(?:no idea what to talk about|nothing to talk about|keep (?:the )?conversation going|keep talking|want to talk but|give me something to talk about|conversation starter|start a conversation|what can we talk about)\b/i.test(value)) return 'conversation_starter';
  if (/\b(?:should i|which one|what do i choose|help me decide|is it better|pick one|choose for me)\b/i.test(value)) return 'decision';
  if (/\b(?:started|i did it|done|finished|completed|opened it|read it|made progress|i'm working|im working)\b/i.test(value)) return 'progress';
  if (/\b(?:sad|upset|hurt|rough day|bad day|stressed|overwhelmed|anxious|lonely|angry|tired)\b/i.test(value)) return 'emotional_support';
  if (/[?？]/.test(value) || /^(?:what|why|how|when|where|who|can|could|would|did|do|are|is|will)\b/i.test(value)) return 'question';
  return 'casual';
}

function topicFor(text, previous = 'general') {
  const value = String(text || '');
  const match = TOPICS.find(([, pattern]) => pattern.test(value));
  return match ? match[0] : previous || 'general';
}

function normalizedQuestion(text) {
  return clean(text, 320).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function addOpenLoop(conversation, text, topic, at, speaker = 'he') {
  const normalized = normalizedQuestion(text);
  if (!normalized || normalized.length < 5) return;
  const existing = conversation.openLoops.find(item => item.normalized === normalized && item.speaker === speaker);
  if (existing) { existing.lastSeenAt = at; return; }
  conversation.openLoops.push({ id: id('loop'), text: clean(text, 320), normalized, topic, speaker, createdAt: at, lastSeenAt: at, status: 'open' });
  conversation.openLoops = conversation.openLoops.slice(-8);
}

function observeUser(state, text, at = nowIso()) {
  const conversation = ensureConversation(state);
  const cleanText = clean(text, 1200);
  const intent = classifyIntent(cleanText);
  const topic = topicFor(cleanText, conversation.topic);
  if (topic !== conversation.topic) {
    conversation.topic = topic;
    conversation.topicChangedAt = at;
  }
  conversation.currentIntent = intent;
  conversation.lastUserText = cleanText;
  conversation.lastUserAt = at;
  conversation.userEnergy = messageEnergy(cleanText);
  conversation.userMessageShape = messageShape(cleanText);
  if (intent === 'listen') conversation.mode = 'listen';
  if (intent === 'repair') conversation.mode = 'repair';
  if (intent === 'question' || intent === 'decision') addOpenLoop(conversation, cleanText, topic, at, 'he');
  if (intent === 'repair') conversation.repair = { at, text: cleanText, pending: true };
  if (intent === 'progress' && conversation.motivation) {
    conversation.motivation = { ...conversation.motivation, status: /\b(?:done|finished|completed|did it)\b/i.test(cleanText) ? 'done' : 'started', updatedAt: at };
  }
  return { intent, topic, mode: conversation.mode };
}

function extractOpening(text) {
  return clean(text, 160).split(/\s+/).slice(0, 7).join(' ').toLowerCase().replace(/[.,!?;:]+/g, '').trim();
}

function observeAssistant(state, text, at = nowIso()) {
  const conversation = ensureConversation(state);
  const cleanText = clean(text, 700);
  conversation.lastAssistantAt = at;
  conversation.lastAssistantEnergy = messageEnergy(cleanText);
  const opening = extractOpening(cleanText);
  if (opening && !conversation.recentOpenings.includes(opening)) conversation.recentOpenings.push(opening);
  if (opening) conversation.recentOpenings = conversation.recentOpenings.slice(-12);
  if (cleanText) conversation.recentPhrases.push(cleanText.slice(0, 140));
  conversation.recentPhrases = conversation.recentPhrases.slice(-12);
  if (/[?？]/.test(cleanText)) addOpenLoop(conversation, cleanText, conversation.topic, at, 'negev');
  const action = cleanText.match(/\b(?:open|start|read|write|send|finish|do|work on|look at)\b[^.!?]{0,120}/i);
  if (action && /\b(?:now|today|first|just|one|minute|small|tiny|started|done)\b/i.test(cleanText)) {
    conversation.motivation = { action: action[0].trim(), status: 'proposed', at, updatedAt: at };
  }
  if (conversation.repair) conversation.repair = { ...conversation.repair, pending: false };
  if (conversation.mode !== 'normal') conversation.mode = 'normal';
}

function markAnswered(state) {
  const conversation = ensureConversation(state);
  const loop = [...conversation.openLoops].reverse().find(item => item.status === 'open' && item.speaker === 'he');
  if (!loop) return false;
  loop.status = 'answered';
  loop.answeredAt = nowIso();
  return true;
}

function setMode(state, mode) {
  const conversation = ensureConversation(state);
  conversation.mode = ['normal', 'listen', 'advice', 'repair', 'subject'].includes(mode) ? mode : 'normal';
  return conversation.mode;
}

function clearOpenLoops(state) {
  ensureConversation(state).openLoops = [];
}

function conversationIdeas(state, count = 3) {
  const conversation = ensureConversation(state);
  const used = new Set(conversation.ideaHistory.slice(-10).map(item => item.idea));
  const preferredTopic = conversation.topic;
  const ordered = [
    ...CONVERSATION_IDEAS.filter(([topic]) => topic === preferredTopic || (preferredTopic === 'motivation/work' && topic === 'work') || (preferredTopic === 'food/day' && topic === 'day')),
    ...CONVERSATION_IDEAS
  ];
  const selected = [];
  for (const [topic, idea] of ordered) {
    if (used.has(idea) || selected.some(item => item.idea === idea)) continue;
    selected.push({ topic, idea });
    if (selected.length >= count) break;
  }
  const at = nowIso();
  conversation.ideaHistory.push(...selected.map(item => ({ ...item, at })));
  conversation.ideaHistory = conversation.ideaHistory.slice(-20);
  return selected.map(item => item.idea);
}

function recentSharedDetails(state, limit = 4) {
  const conversation = ensureConversation(state);
  const current = normalizedQuestion(conversation.lastUserText);
  const seen = new Set();
  return (state.history || [])
    .filter(item => item && item.role === 'user' && item.text)
    .slice(-10)
    .reverse()
    .map(item => clean(item.text, 220))
    .filter(text => {
      const normalized = normalizedQuestion(text);
      if (!normalized || normalized === current || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, limit);
}

function responseGuidance(state) {
  const conversation = ensureConversation(state);
  if (conversation.currentIntent === 'repair') return 'Repair the exact misunderstanding first; do not continue as if the previous interpretation was correct.';
  if (conversation.currentIntent === 'listen') return 'Give presence before advice. Reflect one feeling or detail and leave room; do not interrogate him.';
  if (conversation.currentIntent === 'motivation') return 'Turn the stuck feeling into one tiny concrete action and one easy check-in, not a speech or a giant plan.';
  if (conversation.currentIntent === 'conversation_starter') return 'Choose one fresh, specific subject and make it easy to answer. Do not present a menu of prompts.';
  if (conversation.currentIntent === 'question' || conversation.userMessageShape === 'question') return 'Answer the actual question first. Add at most one useful follow-up only if it moves the conversation forward.';
  if (conversation.userEnergy === 'heavy') return 'Use a slower, warmer response shape and acknowledge the weight before trying to be playful or productive.';
  if (conversation.userEnergy === 'brief') return 'Keep it light and compact. Do not overwhelm a short message with a lecture or several questions.';
  if (conversation.userEnergy === 'playful') return 'Meet the playful energy without copying every slang word or turning the whole reply into a performance.';
  return 'Answer naturally, then choose whether to add one small related thought, callback, or open hook; a question is optional.';
}

function context(state) {
  const conversation = ensureConversation(state);
  const loops = conversation.openLoops.filter(item => item.status === 'open').slice(-4).map(item => `- ${item.speaker === 'negev' ? 'her question' : 'his question'}: ${item.text} [${item.topic}]`);
  const avoid = conversation.recentOpenings.slice(-5).join(' | ');
  const mode = conversation.mode !== 'normal' ? conversation.mode : '';
  const motivation = conversation.motivation ? `${conversation.motivation.status}: ${conversation.motivation.action}` : '';
  const ideas = conversation.currentIntent === 'conversation_starter' ? conversationIdeas(state).map(idea => `- ${idea}`) : [];
  const callbacks = recentSharedDetails(state).map(detail => `- ${detail}`);
  return [
    `current conversation topic: ${conversation.topic}`,
    `likely reply intention: ${conversation.currentIntent}`,
    `his current message energy: ${conversation.userEnergy}; shape: ${conversation.userMessageShape}`,
    `reply guidance: ${responseGuidance(state)}`,
    mode ? `temporary interaction mode: ${mode}` : '',
    loops.length ? `open loops worth answering only when relevant:\n${loops.join('\n')}` : '',
    motivation ? `motivation follow-through: ${motivation}` : '',
    ideas.length ? `fresh conversation sparks (choose one naturally; do not present this as a list):\n${ideas.join('\n')}` : '',
    callbacks.length ? `recent things he shared that can become a callback if genuinely relevant (use at most one):\n${callbacks.join('\n')}` : '',
    avoid ? `recent reply openings to vary, not copy: ${avoid}` : ''
  ].filter(Boolean).join('\n');
}

function modeGuidance(state) {
  const mode = ensureConversation(state).mode;
  if (mode === 'listen') return 'He asked you to listen. Do not solve the problem, give a productivity lecture, or end with a question unless he clearly asks one.';
  if (mode === 'advice') return 'He wants advice. Give a clear opinion and one practical next step, without turning the whole reply into a lecture.';
  if (mode === 'repair') return 'The conversation needs repair. Acknowledge the misunderstanding briefly, state what you think he meant, and ask one concise clarification if needed.';
  if (mode === 'subject') return 'He wants a subject change. Follow the newest topic and do not drag the old issue back in.';
  return '';
}

module.exports = { ensureConversation, classifyIntent, topicFor, messageEnergy, messageShape, observeUser, observeAssistant, markAnswered, setMode, clearOpenLoops, conversationIdeas, recentSharedDetails, responseGuidance, context, modeGuidance };
