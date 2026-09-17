const config = require('./config');

// User-facing Telegram help. Parsing and execution stay in bot.js so this
// module remains safe to reuse for menus, documentation, and tests.

const displayName = config.DISPLAY_NAME;

const TELEGRAM_COMMANDS = [
  ['/start', 'clear recorded chat messages and begin a fresh chat; saved memory stays'],
  ['/help, !help, /commands, !commands', 'show every Telegram command'],
  ['/talk, !talk', 'keep the conversation going with a fresh topic'],
  ['/clear yes, !clear yes', 'clear recorded chat messages and short-term conversation'],
  ['/forgetall yes, !forgetall yes', 'erase learned memory but keep the built-in persona'],
  ['!caring, /caring', 'make her only slightly more caring until changed'],
  ['!tsundere, /tsundere', 'make her only slightly tsundere until changed'],
  ['!playful, /playful', 'make her slightly more playful until changed'],
  ['!warm, /warm', 'make her slightly warmer until changed'],
  ['!normal, /normal', 'return to her normal automatic mood'],
  ['!soft, /soft', 'keep her gently soft until changed'],
  ['!mood, /mood [style|auto]', 'show or change the current slight mood style'],
  ['/repair, !repair', 'reset a misunderstanding and ask what she got wrong'],
  ['/listen, !listen', 'listen without solving or interrogating for the next reply'],
  ['/advice, !advice', 'give a direct opinion and one practical next step'],
  ['/subject, !subject', 'drop the old thread and change topic'],
  ['/remember that ..., !remember that ...', 'save an explicit fact, promise, or task'],
  ['/forget ..., !forget ...', 'remove matching saved facts'],
  ['/promises, !promises', 'list open promises and tasks'],
  ['/tasks, !tasks', 'list open promises and tasks'],
  ['/calendar, !calendar', 'show remembered dates, plans, and their local times'],
  ['/done ..., !done ...', 'close matching open promises or tasks'],
  ['/status, !status', 'ask how she is right now in a normal human reply'],
  ['/sleep, !sleep', 'show the current sleep and wake window'],
  ['/mute 30, !mute 30', 'freeze replies for any number of minutes without deleting memory or chat'],
  ['/unmute, !unmute', 'end the mute early and resume replies'],
  ['!token, /token, !tokens, /tokens, !usage, /usage, !cost, /cost, !spend, /spend', `show exact usage for a replied-to ${displayName} message`],
  ['!tokenall, /tokenall', 'show lifetime model usage and exact provider cost'],
  ['!estimateall, /estimateall', 'show cumulative provider-reported tokens and exact spend across all conversations'],
  ['!estimate, /estimate', 'show rough text, picture, and memory estimates'],
  ['!force message, /force message', 'answer immediately, including during sleep, mute, or waiting mode']
];

const TELEGRAM_INPUTS = [
  ['text', 'ordinary text messages'],
  ['picture + caption', 'the image and written caption are sent together to vision'],
  ['video / voice / audio', 'local transcription, OCR, speech, and music separation'],
  ['links', 'X/Twitter, YouTube, and ordinary page context when available'],
  ['reply to her', 'the replied-to message is added as conversation context']
];

function formatRows(rows) {
  return rows.map(([name, description]) => `${name} — ${description}`).join('\n');
}

function telegramHelp() {
  return [
    `${displayName} commands`,
    '',
    'commands:',
    formatRows(TELEGRAM_COMMANDS),
    '',
    'things she understands:',
    formatRows(TELEGRAM_INPUTS),
    '',
    'natural conversation:',
    'if you ask for some time and say you will text her when ready, she waits without sending extra messages and resumes when you return.',
    'she may occasionally react to an ordinary message with a small Telegram emoji reaction; asking directly makes the reaction immediate when Telegram allows it.',
    `multiple promises, tasks, and date references are kept separately and sorted by their actual ${config.LOCATION} due time.`,
    'say "just listen", "no advice", "i meant...", or "change subject" naturally when you want to repair the interaction without using a command.',
    '',
    'memory examples:',
    'remember that my exam is monday',
    "i'll call the dentist tomorrow",
    'remind me to buy tea',
    'i have an exam tomorrow',
    "ill start the project in one week",
    'we can meet the Friday after next at 7pm',
    'remind me after lunch on the 15th of next month',
    '',
    `natural date wording is supported beyond these examples: written dates, weekdays, month dates, parts of the day, hours, minutes, calendar boundaries, and informal phrases are resolved using ${config.LOCATION} local time. send !token as a reply to one of her messages for exact provider usage. !estimate is only a rough planning number. !estimateall is the cumulative exact tracker across every conversation. /start begins a fresh chat but keeps saved memory; destructive clear commands require yes.`
  ].join('\n');
}

module.exports = { TELEGRAM_COMMANDS, TELEGRAM_INPUTS, telegramHelp };
