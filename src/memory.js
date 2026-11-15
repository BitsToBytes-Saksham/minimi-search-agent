import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Memory {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  path(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid conversation ID');
    return join(this.directory, `${id}.json`);
  }
  save(chat) {
    const path = this.path(chat.id);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(chat), { mode: 0o600 });
    renameSync(temporary, path);
    return chat;
  }
  create(timezone = 'UTC') {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return this.save({ id: randomUUID(), title: 'New conversation', timezone,
      createdAt: new Date().toISOString(), messages: [] });
  }
  get(id) {
    try { return JSON.parse(readFileSync(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  list() {
    return readdirSync(this.directory).filter(name => name.endsWith('.json'))
      .map(name => this.get(name.slice(0, -5)))
      .map(({ messages, ...chat }) => ({ ...chat, count: messages.length,
        updatedAt: messages.at(-1)?.createdAt ?? chat.createdAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  append(chat, role, content, extra = {}) {
    const message = { ...extra, id: randomUUID(), role, content, createdAt: new Date().toISOString() };
    chat.messages.push(message);
    if (role === 'user' && chat.messages.filter(m => m.role === 'user').length === 1) chat.title = content.slice(0, 70);
    this.save(chat);
    return message;
  }
  delete(id) { unlinkSync(this.path(id)); }
}

const STOP = new Set('a an the i me my you your what when did do was were is are have has asked ask about and or to of in it that this please remember earlier before'.split(' '));
const terms = text => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(x => x.length > 2 && !STOP.has(x)))];

export function selectMemory(messages, question, budget = 48000) {
  const words = terms(question);
  const recentStart = Math.max(0, messages.length - 16);
  const selected = new Set();
  let used = 0;
  const add = index => {
    if (selected.has(index) || !messages[index] || messages[index].status === 'failed') return;
    const cost = messages[index].content.length + 100;
    if (used + cost <= budget) { selected.add(index); used += cost; }
  };
  for (let i = messages.length - 1; i >= recentStart; i--) add(i);
  const ranked = messages.slice(0, recentStart).map((m, index) => {
    const text = `${m.content} ${m.createdAt}`.toLowerCase();
    return { index, score: words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
  for (const { index } of ranked.slice(0, 12)) { add(index); add(index - 1); add(index + 1); }
  // Keep the opening context available for questions such as "What did I ask first?".
  add(0); add(1);
  return [...selected].sort((a, b) => a - b).map(index => messages[index]);
}
