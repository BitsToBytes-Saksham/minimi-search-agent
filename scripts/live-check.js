import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { runAgent } from '../src/agent.js';

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY before running the paid live checks.');
const directory = mkdtempSync(join(tmpdir(), 'minimi-live-'));
try {
  const memory = new Memory(directory);
  let chat = memory.create('Asia/Kolkata');
  const ask = async (question, mode) => {
    memory.append(chat, 'user', question);
    const result = await runAgent(chat, question, mode, () => {}, new AbortController().signal);
    memory.append(chat, 'assistant', result.text, result);
    console.log(JSON.stringify({ question, answer: result.text, searches: result.searches,
      citations: result.citations.length, firstTokenMs: result.firstTokenMs, totalMs: result.totalMs }));
    return result;
  };
  const searched = await ask('Search the official NASA website: what date did Apollo 11 land on the Moon? Cite NASA.', 'always');
  assert.ok(searched.searches > 0, 'Must actually use web search');
  assert.ok(searched.citations.length > 0, 'Must return citations');
  assert.match(searched.text, /1969/);
  const userTimestamp = chat.messages[0].createdAt;
  chat = new Memory(directory).get(chat.id);
  const recalled = await ask('What did I just ask you, and at what exact UTC timestamp was my question recorded? Do not search.', 'never');
  assert.equal(recalled.searches, 0);
  assert.match(recalled.text, /Apollo 11/i);
  assert.ok(recalled.text.includes(userTimestamp), 'Must recall the exact persisted timestamp');
  console.log('Live search and restart-memory checks passed.');
} finally { rmSync(directory, { recursive: true, force: true }); }
