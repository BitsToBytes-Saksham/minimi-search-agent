const $ = selector => document.querySelector(selector);
let chat = null;
let controller = null;
let busy = false;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const date = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function notice(text = '') { $('#notice').textContent = text; $('#notice').hidden = !text; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.json();
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function safeLink(url, text) {
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return document.createTextNode(text); }
  catch { return document.createTextNode(text); }
  const a = element('a', text);
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
function renderBody(node, text, citations = []) {
  node.replaceChildren();
  let cursor = 0;
  for (const [index, citation] of [...citations].sort((a, b) => a.start - b.start).entries()) {
    if (!Number.isInteger(citation.start) || !Number.isInteger(citation.end) || citation.start < cursor || citation.end > text.length || citation.end <= citation.start) continue;
    node.append(document.createTextNode(text.slice(cursor, citation.start)));
    node.append(safeLink(citation.url, `[${index + 1}]`));
    cursor = citation.end;
  }
  node.append(document.createTextNode(text.slice(cursor)));
}
function renderMessage(message) {
  const article = element('article', undefined, `message ${message.role}`);
  const head = element('div', undefined, 'message-head');
  head.append(element('strong', message.role === 'user' ? 'YOU' : 'MINIMI'));
  const time = element('time', date(message.createdAt)); time.dateTime = message.createdAt; time.title = message.createdAt;
  head.append(time);
  article.append(head);
  const body = element('div', undefined, 'message-body');
  renderBody(body, message.content, message.citations);
  article.append(body);
  if (message.citations?.length) {
    const sources = element('div', undefined, 'sources');
    for (const citation of [...new Map(message.citations.map(c => [c.url, c])).values()]) sources.append(safeLink(citation.url, citation.title || new URL(citation.url).hostname));
    article.append(sources);
  }
  if (message.totalMs) article.append(element('div', `${(message.totalMs / 1000).toFixed(1)}s · ${message.searches} search call${message.searches === 1 ? '' : 's'}${message.firstTokenMs == null ? '' : ` · first text ${(message.firstTokenMs / 1000).toFixed(1)}s`}`, 'metrics'));
  if (message.status === 'failed') article.append(element('div', 'This turn did not finish. Your question is saved.', 'metrics'));
  $('#messages').append(article);
  return { article, body };
}
function renderTimeline() {
  const query = $('#history-search').value.toLowerCase();
  $('#timeline').replaceChildren();
  for (const message of chat?.messages ?? []) {
    if (message.role !== 'user' || !`${message.content} ${message.createdAt} ${date(message.createdAt)}`.toLowerCase().includes(query)) continue;
    const entry = element('div', undefined, 'timeline-entry');
    const time = element('time', date(message.createdAt)); time.dateTime = message.createdAt; time.title = message.createdAt;
    entry.append(time, element('div', message.content)); $('#timeline').append(entry);
  }
  if (!$('#timeline').children.length) $('#timeline').append(element('p', 'No matching questions yet.'));
}
async function refreshChats() {
  const chats = await api('/api/chats');
  $('#chats').replaceChildren();
  for (const item of chats) {
    const button = element('button', item.title, item.id === chat?.id ? 'active' : '');
    button.disabled = busy; button.title = item.title;
    button.onclick = () => loadChat(item.id).catch(error => notice(error.message));
    $('#chats').append(button);
  }
  return chats;
}
async function loadChat(id) {
  chat = await api(`/api/chats/${id}`);
  localStorage.setItem('minimi.chat', id);
  $('#messages').replaceChildren();
  chat.messages.forEach(renderMessage);
  $('#welcome').hidden = chat.messages.length > 0;
  renderTimeline();
  await refreshChats();
}
async function newChat() {
  const created = await api('/api/chats', { method: 'POST', body: JSON.stringify({ timezone }) });
  await loadChat(created.id); $('#prompt').focus();
}
function setBusy(value) {
  busy = value;
  for (const node of document.querySelectorAll('#send, #new-chat, #delete, #chats button, .suggestions button')) node.disabled = value;
  $('#stop').hidden = !value;
  $('#send').hidden = value;
}
async function send(event) {
  event.preventDefault();
  const message = $('#prompt').value.trim();
  if (busy || !message) return;
  notice(); setBusy(true);
  let draft;
  try {
    if (!chat) await newChat();
    $('#welcome').hidden = true;
    controller = new AbortController();
    const response = await fetch(`/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, search: $('#search-mode').value }), signal: controller.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error);
    let buffer = '', text = '', completed = false;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'user') {
          chat.messages.push(event.message); renderMessage(event.message);
          $('#prompt').value = ''; renderTimeline();
        } else if (event.type === 'status') $('#status').textContent = event.text;
        else if (event.type === 'delta') {
          draft ??= renderMessage({ role: 'assistant', content: '', createdAt: new Date().toISOString() });
          text += event.text; draft.body.textContent = text;
          $('#status').textContent = 'Writing…';
        } else if (event.type === 'done') {
          draft?.article.remove(); draft = null;
          chat.messages.push(event.message); renderMessage(event.message); completed = true;
        } else if (event.type === 'error') throw new Error(event.message);
      }
    }
    if (!completed) throw new Error('The connection ended early. Your question is saved; please retry.');
  } catch (error) {
    draft?.article.remove();
    notice(error.name === 'AbortError' ? 'Stopped. Your question remains in the timeline.' : error.message);
    $('#prompt').value ||= message;
  } finally {
    controller = null; setBusy(false); $('#status').textContent = '';
    await refreshChats().catch(error => notice(error.message));
    $('#prompt').focus();
  }
}
$('#composer').onsubmit = send;
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
$('#new-chat').onclick = () => newChat().catch(error => notice(error.message));
$('#stop').onclick = () => controller?.abort();
$('#history-toggle').onclick = () => { $('#history').hidden = !$('#history').hidden; renderTimeline(); };
$('#history-close').onclick = () => { $('#history').hidden = true; };
$('#history-search').oninput = renderTimeline;
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); }; });
$('#export').onclick = async () => {
  if (!chat) return;
  try {
    const saved = await api(`/api/chats/${chat.id}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
    const a = element('a'); a.href = url; a.download = `minimi-${chat.id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notice(error.message); }
};
$('#delete').onclick = async () => {
  if (!chat || !confirm('Permanently delete this conversation from this device?')) return;
  try { await api(`/api/chats/${chat.id}`, { method: 'DELETE' }); chat = null; await newChat(); }
  catch (error) { notice(error.message); }
};
try {
  const config = await api('/api/config');
  if (!config.configured) notice(`Add ${config.keyName} to .env and restart to begin chatting.`);
  const chats = await refreshChats();
  const saved = localStorage.getItem('minimi.chat');
  const existing = chats.find(item => item.id === saved) ?? chats[0];
  if (existing) await loadChat(existing.id);
} catch (error) { notice(error.message); }
