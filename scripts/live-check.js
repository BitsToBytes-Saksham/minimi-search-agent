import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { runAgent, providerConfig } from '../src/provider.js';

const config = providerConfig();
if (!config.configured) throw new Error(`Set ${config.keyName} before running the live checks.`);
console.log(`Testing ${config.provider} / ${config.model}. Provider quotas and billing apply.`);
const directory = mkdtempSync(join(tmpdir(), 'minimi-live-'));
try {
  const memory = new Memory(directory);
  let chat = memory.create('Asia/Kolkata');
  const memoryOnly = process.argv.includes('--memory-only');
  const ask = async (question, mode) => {
    memory.append(chat, 'user', question);
    const result = await runAgent(chat, question, mode, () => {}, new AbortController().signal);
    memory.append(chat, 'assistant', result.text, result);
    console.log(JSON.stringify({ question, answer: result.text, searches: result.searches,
      citations: result.citations.length, firstTokenMs: result.firstTokenMs, totalMs: result.totalMs }));
    return result;
  };
  if (memoryOnly) {
    await ask('Remember: my research topic is Apollo 11. Just acknowledge; do not search.', 'never');
  } else {
    const searched = await ask('Search the official NASA website: what date did Apollo 11 land on the Moon? Cite NASA.', 'always');
    assert.ok(searched.searches > 0, 'Must actually use web search');
    assert.ok(searched.citations.length > 0, 'Must return citations');
    assert.match(searched.text, /1969/);
  }
  const userTimestamp = chat.messages[0].createdAt;
  chat = new Memory(directory).get(chat.id);
  const recalled = await ask('What did I just ask you, and at what exact UTC timestamp was my question recorded? Do not search.', 'never');
  assert.equal(recalled.searches, 0);
  assert.match(recalled.text, /Apollo 11/i);
  assert.ok(recalled.text.includes(userTimestamp), 'Must recall the exact persisted timestamp');
  console.log(memoryOnly ? 'Live restart-memory check passed (search was not tested).' : 'Live search and restart-memory checks passed.');
} finally { rmSync(directory, { recursive: true, force: true }); }
