const providers = require('./providers');

// Small CLI for provider catalog inspection and selection. Interactive
// secret entry remains in the PowerShell control center.

function printList() {
  const active = providers.getActiveProvider();
  console.log(`active provider: ${active.id}`);
  console.log(`active model: ${active.model || '(none selected)'}`);
  console.log('');
  for (const item of providers.listProviders()) {
    console.log(`${item.active ? '* ' : '  '}${item.id} — ${item.label}`);
    console.log(`    endpoint: ${item.baseUrl}`);
    const aliases = item.keyAliases?.length ? `; aliases: ${item.keyAliases.join(', ')}` : '';
    console.log(`    protocol: ${item.protocol}; keys: ${item.keyCount} configured (${item.keyEnv}, ${item.keysEnv}${aliases})`);
    console.log(`    models: ${item.models.length ? item.models.join(', ') : '(add a model)'}`);
  }
}

function parseRate(value) {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid rate: ${value}`);
  return number;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'list') { printList(); return; }
  if (command === 'use') {
    const result = providers.setActive(args[0], args.slice(1).join(' '));
    console.log(`active provider set to ${result.id} / ${result.model || '(no model)'}`);
    return;
  }
  if (command === 'key-env') {
    const result = providers.keyEnvironment(args[0]);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'add') {
    const [id, label, baseUrl, keyEnv, model, input, cache, output, cacheWrite] = args;
    const result = providers.addProvider({
      id, label, baseUrl, keyEnv,
      model, rates: { input: parseRate(input), cache: parseRate(cache), output: parseRate(output), cacheWrite: parseRate(cacheWrite) }
    });
    console.log(`provider saved: ${result.id}; key variable: ${result.keyEnv}; model: ${result.model || '(none)'}`);
    return;
  }
  if (command === 'add-json') {
    let settings;
    try { settings = JSON.parse(args.join(' ')); } catch (_) { throw new Error('add-json requires one valid JSON provider settings object'); }
    const result = providers.addProvider(settings);
    console.log(`provider saved: ${result.id}; protocol: ${result.protocol}; key variable: ${result.keyEnv}; model: ${result.model || '(none)'}`);
    return;
  }
  throw new Error('use list, use, key-env, add, or add-json');
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
