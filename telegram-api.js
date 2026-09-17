/**
 * Small Telegram Bot API adapter.
 *
 * Keeping HTTP and media-download details here leaves bot.js focused on
 * conversation, memory, timing, and scheduling decisions.
 */

function createTelegramApi({ token, timeoutMs = 35_000, maxMediaBytes = 20 * 1024 * 1024 } = {}) {
  async function apiCall(method, body = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description || response.status}`);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function downloadFile(fileId, maxBytes = maxMediaBytes) {
    const info = await apiCall('getFile', { file_id: fileId });
    if (!info?.file_path) throw new Error('Telegram did not return a media path');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`media download failed: ${response.status}`);
      const announced = Number(response.headers.get('content-length'));
      if (Number.isFinite(announced) && announced > maxBytes) throw new Error(`media is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      if (!response.body) return Buffer.from(await response.arrayBuffer());
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`media is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timer);
    }
  }

  return { apiCall, downloadFile };
}

module.exports = { createTelegramApi };
