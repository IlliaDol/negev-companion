const { safeText } = require('./util');

const URL_RE = /https?:\/\/[^\s<>]+/gi;

// Bounded public-link enrichment. Failed or blocked pages stay explicitly
// unavailable instead of becoming invented model context.

function extractUrls(text) {
  return [...new Set((String(text || '').match(URL_RE) || []).map(url => url.replace(/[),.!?]+$/, '')))].slice(0, 5);
}

function hostOf(url) { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } }

async function fetchText(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'PrivateTelegramCompanion/1.0' }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function htmlMeta(html, url) {
  const pick = (patterns) => {
    for (const pattern of patterns) { const m = html.match(pattern); if (m) return m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim(); }
    return '';
  };
  return {
    url,
    title: pick([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i, /<title[^>]*>([^<]*)<\/title>/i]),
    description: pick([/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i])
  };
}

async function readX(url) {
  const match = url.match(/status\/(\d+)/i);
  if (!match) return null;
  const data = JSON.parse(await fetchText(`https://api.fxtwitter.com/status/${match[1]}`));
  const tweet = data.tweet;
  if (!tweet) return null;
  return { url, title: `${tweet.author?.name || 'someone'} on X`, description: tweet.text || '', author: tweet.author?.screen_name || '' };
}

async function readOne(url) {
  const host = hostOf(url);
  try {
    if ((host === 'x.com' || host === 'twitter.com') && /\/status\//i.test(url)) return await readX(url);
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com') {
      const oembed = await fetchText(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      const data = JSON.parse(oembed);
      return { url, title: data.title || 'YouTube video', description: `posted by ${data.author_name || 'unknown creator'}` };
    }
    if (host === 'instagram.com' || host === 'reddit.com' || host === 'threads.net') {
      try { return htmlMeta(await fetchText(url), url); } catch (_) { return { url, unavailable: 'this site blocked a safe metadata read' }; }
    }
    return htmlMeta(await fetchText(url), url);
  } catch (error) {
    return { url, unavailable: safeText(error.message, 180) || 'metadata could not be fetched' };
  }
}

async function readLinks(text) {
  const urls = extractUrls(text);
  if (!urls.length) return { urls: [], context: '' };
  const results = await Promise.all(urls.map(readOne));
  const context = results.map(item => {
    if (item.unavailable) return `URL: ${item.url}\nSTATUS: ${item.unavailable}. Do not pretend you saw the post; ask him what was in it if relevant.`;
    return `URL: ${item.url}\nTITLE: ${safeText(item.title, 500)}\nDESCRIPTION: ${safeText(item.description, 1800)}${item.author ? `\nAUTHOR: ${safeText(item.author, 120)}` : ''}`;
  }).join('\n\n');
  return { urls, results, context };
}

module.exports = { URL_RE, extractUrls, readLinks, hostOf, htmlMeta };
