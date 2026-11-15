import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Memory, selectMemory } from '../src/memory.js';
import { buildRequest, readSSE, extractAnswer, runAgent } from '../src/agent.js';
import { createApp } from '../src/server.js';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'minimi-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const record = (role, content, extra = {}) => ({ role, content, createdAt: '2026-11-15T10:00:00.000Z', ...extra });
const chat = messages => ({ timezone: 'Asia/Kolkata', messages });

test('memory persists exact questions and timestamps across restart, with isolated chats', t => {
  const directory = temporary(t), memory = new Memory(directory);
  const a = memory.create('Asia/Kolkata'), b = memory.create();
  const message = memory.append(a, 'user', 'When did I ask about Europa?');
  const restarted = new Memory(directory);
  assert.deepEqual(restarted.get(a.id).messages, [message]);
  assert.match(message.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(restarted.get(b.id).messages.length, 0);
  assert.equal(restarted.list().length, 2);
  restarted.delete(a.id);
  assert.equal(restarted.get(a.id), null);
  assert.throws(() => memory.get('../../secrets'), /Invalid/);
});

test('older relevant memory and its neighbors survive beyond the recent window', () => {
  const messages = Array.from({ length: 100 }, (_, i) => record(i % 2 ? 'assistant' : 'user', `Turn ${i}: general conversation`));
  messages[22] = record('user', 'Can you explain Europa ocean research?', { createdAt: '2026-10-01T13:00:00.000Z' });
  const selected = selectMemory(messages, 'When did I ask about Europa?');
  assert.ok(selected.includes(messages[22]));
  assert.ok(selected.includes(messages[23]));
  assert.ok(selected.includes(messages[99]));
  assert.ok(selected.includes(messages[0]));
  assert.equal(new Set(selected).size, selected.length);
});

test('context has a bounded size and omits failed turns without deleting the archive', () => {
  const messages = Array.from({ length: 80 }, () => record('user', 'x'.repeat(8000)));
  messages.push(record('user', 'failed question', { status: 'failed' }));
  const selected = selectMemory(messages, 'x', 16000);
  assert.ok(selected.reduce((sum, m) => sum + m.content.length + 100, 0) <= 16000);
  assert.ok(!selected.includes(messages.at(-1)));
  assert.equal(messages.length, 81);
});

test('exactly one tool is exposed, with explicit search modes and no provider state', () => {
  const messages = [record('user', 'What is new today?')];
  const request = buildRequest(chat(messages), 'What is new today?', 'always', new Date('2026-11-15T11:00:00Z'));
  assert.deepEqual(request.tools.map(tool => tool.type), ['web_search']);
  assert.equal(request.tool_choice, 'required');
  assert.equal(request.store, false);
  assert.equal(request.max_tool_calls, 3);
  assert.match(request.input[0].content, /Asia\/Kolkata/);
  assert.match(request.input[1].content, /2026-11-15T10:00:00.000Z/);
  assert.equal(buildRequest(chat(messages), 'hello').tool_choice, 'auto');
  assert.equal(buildRequest(chat(messages), 'hello', 'never').tool_choice, 'none');
});

test('SSE handles split Unicode, CRLF, comments, and multiple events', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"delta":"café 🪴"}\r\n\r\ndata: {"done":true}\n\ndata: [DONE]\n\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events = [];
  for await (const event of readSSE(chunks())) events.push(event);
  assert.deepEqual(events, [{ delta: 'café 🪴' }, { done: true }]);
});

test('citations are collected with text offsets; unsafe URLs are rejected', () => {
  const result = extractAnswer({ output: [{ type: 'web_search_call' }, { type: 'message', content: [
    { type: 'output_text', text: 'First. ', annotations: [] },
    { type: 'output_text', text: 'Second [source]', annotations: [
      { type: 'url_citation', title: 'Official', url: 'https://example.com', start_index: 7, end_index: 15 },
      { type: 'url_citation', url: 'javascript:alert(1)', start_index: 0, end_index: 3 },
    ] },
  ] }] });
  assert.equal(result.text, 'First. Second [source]');
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].start, 14);
  assert.equal(result.searches, 1);
});

function stream(events) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); }
test('streamed output requires completed response and records timing', async () => {
  const events = [];
  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(JSON.parse(options.body).tools.map(x => x.type), ['web_search']);
    return stream([{ type: 'response.web_search_call.searching' }, { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] } }]);
  };
  const result = await runAgent(chat([record('user', 'Hi')]), 'Hi', 'auto', (...event) => events.push(event), new AbortController().signal, fakeFetch);
  assert.equal(result.text, 'Hello');
  assert.ok(result.totalMs >= 0);
  assert.ok(result.firstTokenMs >= 0);
  assert.equal(events[0][0], 'status');
  await assert.rejects(runAgent(chat([]), 'Hi', 'auto', () => {}, new AbortController().signal,
    async () => stream([{ type: 'response.output_text.delta', delta: 'Partial' }])), /ended early/);
});

test('provider failures are sanitized; incomplete answers are rejected', async () => {
  await assert.rejects(runAgent(chat([]), 'Hi', 'auto', () => {}, new AbortController().signal,
    async () => new Response('sensitive upstream error', { status: 429 })), /HTTP 429.*quota/);
  await assert.rejects(runAgent(chat([]), 'Hi', 'auto', () => {}, new AbortController().signal,
    async () => stream([{ type: 'response.incomplete' }])), /could not finish/);
  await assert.rejects(runAgent(chat([]), 'Hi', 'auto', () => {}, new AbortController().signal,
    async () => stream([{ type: 'error', code: 'credit_balance_exhausted' }])), /no API credits/);
});

async function server(t, agent) {
  const directory = temporary(t);
  const app = createApp({ directory, agent });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const created = await request('/api/chats', 'POST', { timezone: 'Asia/Kolkata' });
  return { request, id: (await created.json()).id, directory, base };
}
const goodAgent = async () => ({ text: 'A sourced answer.', citations: [], searches: 1, totalMs: 10, firstTokenMs: 2 });

test('HTTP chat round-trip, persistence, validation, export data, and deletion', async t => {
  const { request, id, directory } = await server(t, goodAgent);
  const response = await request(`/api/chats/${id}/messages`, 'POST', { message: 'What is new?' });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  const saved = await (await request(`/api/chats/${id}`)).json();
  assert.equal(saved.messages.length, 2);
  assert.equal(JSON.parse(readFileSync(join(directory, `${id}.json`))).messages.length, 2);
  assert.equal((await request(`/api/chats/${id}/messages`, 'POST', { message: '' })).status, 400);
  assert.equal((await request(`/api/chats/${id}/messages`, 'POST', { message: 'x'.repeat(8001) })).status, 400);
  assert.equal((await request('/api/chats', 'POST', { timezone: 'invalid/zone' })).status, 400);
  assert.equal((await request(`/api/chats/${id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/chats/${id}`)).status, 404);
});

test('failed upstream keeps the question, marks failure, and saves no invented answer', async t => {
  const { request, id } = await server(t, async () => { throw new Error('secret diagnostic'); });
  const response = await request(`/api/chats/${id}/messages`, 'POST', { message: 'Remember this question' });
  const output = await response.text();
  assert.ok(!output.includes('secret diagnostic'));
  assert.match(output, /"type":"error"/);
  const saved = await (await request(`/api/chats/${id}`)).json();
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].status, 'failed');
});

test('same-chat concurrency and deletion are blocked while another chat stays usable', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request, id } = await server(t, async () => { await gate; return goodAgent(); });
  t.after(release);
  const first = await request(`/api/chats/${id}/messages`, 'POST', { message: 'First' });
  assert.equal((await request(`/api/chats/${id}/messages`, 'POST', { message: 'Second' })).status, 409);
  assert.equal((await request(`/api/chats/${id}`, 'DELETE')).status, 409);
  assert.equal((await request('/api/chats', 'POST', {})).status, 201);
  release();
  await first.text();
});

test('localhost service rejects hostile origins and DNS rebinding hosts', async t => {
  const { request, base } = await server(t, goodAgent);
  assert.equal((await request('/api/chats', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/chats`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await request('/api/chats', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});
