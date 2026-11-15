import test from 'node:test';
import assert from 'node:assert/strict';
import { providerConfig } from '../src/provider.js';
import { buildGeminiRequest, runGemini, webSearch, searchCitations } from '../src/gemini.js';

const chat = { timezone: 'Asia/Kolkata', messages: [{ role: 'user', content: 'Search NASA for Apollo 11', createdAt: '2026-11-15T10:00:00.123Z' }] };
const signal = () => new AbortController().signal;
const stream = candidates => new Response(candidates.map(candidate => `data: ${JSON.stringify({ candidates: [candidate] })}\n\n`).join(''));
const answer = text => stream([{ content: { parts: [{ text }] }, finishReason: 'STOP' }]);
const call = (name = 'web_search') => stream([{ content: { parts: [{ functionCall: { name, args: { query: 'site:nasa.gov Apollo 11 landing date' }, id: 'call-1' }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }]);

test('provider selection is explicit or prefers an existing Gemini key, with no secret exposure', () => {
  assert.equal(providerConfig({ GEMINI_API_KEY: 'secret' }).provider, 'gemini');
  assert.equal(providerConfig({ AI_PROVIDER: 'openai', GEMINI_API_KEY: 'secret' }).provider, 'openai');
  assert.equal(providerConfig({ AI_PROVIDER: 'gemini' }).configured, false);
  assert.equal(providerConfig({}).provider, 'openai');
  assert.ok(!JSON.stringify(providerConfig({ GEMINI_API_KEY: 'secret' })).includes('secret'));
  assert.throws(() => providerConfig({ AI_PROVIDER: 'unknown' }), /AI_PROVIDER/);
});

test('Gemini exposes only web_search, preserves timestamps, and enforces search modes', () => {
  for (const [mode, expected] of [['auto', 'AUTO'], ['always', 'ANY'], ['never', 'NONE']]) {
    const request = buildGeminiRequest(chat, 'NASA', mode);
    assert.equal(request.tools.length, 1);
    assert.deepEqual(request.tools[0].functionDeclarations.map(f => f.name), ['web_search']);
    assert.equal(request.toolConfig.functionCallingConfig.mode, expected);
    assert.match(request.contents[0].parts[0].text, /10:00:00.123Z/);
  }
});

test('search uses basic cost controls, safe sources, bounded excerpts, and keyless auth when no key', async () => {
  const result = await webSearch('NASA', signal(), async (url, options) => {
    assert.equal(url, 'https://api.tavily.com/search');
    const body = JSON.parse(options.body);
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.auto_parameters, false);
    assert.equal(body.max_results, 5);
    assert.equal(body.include_raw_content, false);
    assert.ok(options.headers.Authorization || options.headers['X-Tavily-Access-Mode'] === 'keyless');
    return Response.json({ results: [{ url: 'javascript:alert(1)' }, { url: 'https://nasa.gov', title: 'NASA', content: 'x'.repeat(4000) }] });
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].content.length, 3000);
  await assert.rejects(webSearch('', signal()), /query was invalid/);
  await assert.rejects(webSearch('NASA', signal(), async () => new Response('private error', { status: 429 })), /HTTP 429/);
});

test('citation links point only to actual returned sources and preserve Unicode offsets', () => {
  const text = '🌙 Café [2], again [2], unsupported [99].';
  const result = searchCitations(text, [{ id: 2, url: 'https://nasa.gov', title: 'NASA' }]);
  assert.equal(result.length, 2);
  for (const citation of result) assert.equal(text.slice(citation.start, citation.end), '[2]');
});

test('complete Gemini tool loop preserves signatures, returns numbered evidence, and links citations', async () => {
  let modelCalls = 0, searchCalls = 0;
  const events = [];
  const result = await runGemini(chat, 'NASA', 'always', (...e) => events.push(e), signal(), async (url, options) => {
    if (url === 'https://api.tavily.com/search') {
      searchCalls++;
      return Response.json({ results: [{ url: 'https://nasa.gov/apollo', title: 'NASA', content: 'July 20, 1969' }] });
    }
    modelCalls++;
    const request = JSON.parse(options.body);
    if (modelCalls === 1) return call();
    assert.equal(request.contents.at(-2).parts[0].thoughtSignature, 'opaque-signature');
    assert.equal(request.contents.at(-1).parts[0].functionResponse.response.results[0].id, 1);
    assert.equal(request.contents.at(-1).parts[0].functionResponse.id, 'call-1');
    assert.equal(request.toolConfig.functionCallingConfig.mode, 'AUTO');
    return answer('Apollo 11 landed July 20, 1969 [1].');
  });
  assert.equal(modelCalls, 2);
  assert.equal(searchCalls, 1);
  assert.equal(result.searches, 1);
  assert.equal(result.citations[0].url, 'https://nasa.gov/apollo');
  assert.ok(events.some(([type]) => type === 'delta'));
});

test('search-disabled turns cannot execute a tool even if the model requests it', async () => {
  let requests = 0;
  await assert.rejects(runGemini(chat, 'Hi', 'never', () => {}, signal(), async () => { requests++; return call(); }), /disallowed tool/);
  assert.equal(requests, 1);
  await assert.rejects(runGemini(chat, 'Hi', 'auto', () => {}, signal(), async () => call('shell')), /disallowed tool/);
});

test('Gemini search budget stops after three executions and never falls back to a paid provider', async () => {
  let searches = 0;
  await assert.rejects(runGemini(chat, 'NASA', 'auto', () => {}, signal(), async url => {
    if (url === 'https://api.tavily.com/search') { searches++; return Response.json({ results: [] }); }
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    return call();
  }), /search budget/);
  assert.equal(searches, 3);
});

test('Gemini rejects truncated streams and quota errors, while no-search memory answers succeed', async () => {
  const result = await runGemini(chat, 'What did I ask?', 'never', () => {}, signal(), async () => answer('You asked about Apollo 11.'));
  assert.equal(result.searches, 0);
  await assert.rejects(runGemini(chat, 'Hi', 'auto', () => {}, signal(), async () => stream([{ content: { parts: [{ text: 'partial' }] } }])), /did not finish/);
  await assert.rejects(runGemini(chat, 'Hi', 'auto', () => {}, signal(), async () => new Response('secret', { status: 429 })), /quota reached/);
});
