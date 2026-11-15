import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Memory } from './memory.js';
import { runAgent } from './agent.js';

const files = new Map(['index.html', 'app.js', 'style.css'].map(name => [
  name === 'index.html' ? '/' : `/${name}`,
  { content: readFileSync(new URL(`../public/${name}`, import.meta.url)),
    type: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' },
]));
const fail = (status, message) => Object.assign(new Error(message), { status });
async function readJSON(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Expected application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24000) throw fail(413, 'Request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
}

export function createApp({ directory = process.env.DATA_DIR || './data', agent = runAgent } = {}) {
  const memory = new Memory(directory);
  const busy = new Set();
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const port = req.socket.localPort;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) throw fail(403, 'Invalid host');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw fail(403, 'Cross-origin requests are blocked');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are blocked');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && files.has(url.pathname)) {
        const file = files.get(url.pathname);
        res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8` });
        return res.end(file.content);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'gpt-5-mini' });
      if (url.pathname === '/api/chats') {
        if (req.method === 'GET') return json(200, memory.list());
        if (req.method === 'POST') {
          const { timezone = 'UTC' } = await readJSON(req);
          if (typeof timezone !== 'string' || timezone.length > 100) throw fail(400, 'Invalid timezone');
          try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw fail(400, 'Invalid timezone'); }
          return json(201, memory.create(timezone));
        }
      }
      const match = /^\/api\/chats\/([a-f0-9-]{36})(\/messages)?$/.exec(url.pathname);
      if (!match) throw fail(404, 'Not found');
      const [, id, action] = match;
      if (req.method === 'POST' && action) {
        const { message, search = 'auto' } = await readJSON(req);
        if (typeof message !== 'string' || !message.trim() || message.length > 8000) throw fail(400, 'Enter a message of 1–8,000 characters');
        if (!['auto', 'always', 'never'].includes(search)) throw fail(400, 'Invalid search mode');
        if (!process.env.OPENAI_API_KEY && agent === runAgent) throw fail(503, 'Set OPENAI_API_KEY in .env and restart the server');
        if (busy.has(id)) throw fail(409, 'This conversation already has a response in progress');
        if (busy.size >= 4) throw fail(429, 'Too many active responses; please wait');
        const chat = memory.get(id);
        if (!chat) throw fail(404, 'Conversation not found');
        busy.add(id);
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        let userMessage;
        const emit = (type, data) => { if (!res.destroyed) res.write(`${JSON.stringify({ type, ...data })}\n`); };
        try {
          userMessage = memory.append(chat, 'user', message.trim());
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          emit('user', { message: userMessage });
          emit('status', { text: 'Thinking…' });
          const result = await agent(chat, message.trim(), search, emit, controller.signal);
          const saved = memory.append(chat, 'assistant', result.text, { citations: result.citations,
            searches: result.searches, firstTokenMs: result.firstTokenMs, totalMs: result.totalMs });
          emit('done', { message: saved });
        } catch (error) {
          if (userMessage) { userMessage.status = 'failed'; memory.save(chat); }
          const message = error.name === 'AbortError' ? 'Response stopped. Your question is saved.'
            : error.name === 'TimeoutError' ? 'The response timed out. Your question is saved; please retry.'
            : error.message.startsWith('Provider ') || error.message.startsWith('The ') ? error.message : 'Could not complete the response. Check connectivity and retry.';
          if (!res.headersSent) json(500, { error: message });
          else emit('error', { message });
        } finally { busy.delete(id); res.end(); }
        return;
      }
      const chat = memory.get(id);
      if (!chat) throw fail(404, 'Conversation not found');
      if (req.method === 'GET' && !action) return json(200, chat);
      if (req.method === 'DELETE' && !action) {
        if (busy.has(id)) throw fail(409, 'Stop the response before deleting this conversation');
        memory.delete(id);
        return json(200, { deleted: true });
      }
      throw fail(405, 'Method not allowed');
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Could not read or save local data' });
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`Minimi is ready at http://localhost:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
