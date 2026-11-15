# Minimi: design

## Objective and scope

Answer accurately with low perceived latency while remembering the user's questions and their timestamps. The agent exposes **exactly one tool: OpenAI's hosted `web_search`**. Persistence and deterministic history selection belong to the host application; the model cannot call a memory, database, browser, shell, or file tool.

The deliverable is a runnable local chat app and reviewable source repository. It is not a claim of perfect factual accuracy, indefinite full-context recall, or a production multi-tenant service.

## Architecture

```mermaid
flowchart LR
  UI[Browser chat and timeline] -->|JSON over localhost| HTTP[Node HTTP server]
  HTTP -->|Save question with UTC time| Disk[(Local conversation JSON)]
  Disk --> Memory[Bounded history selection]
  Memory --> Request[One Responses request]
  Request --> Model[OpenAI model]
  Model <--> Search[web_search: only exposed tool]
  Model -->|SSE events| HTTP
  HTTP -->|Text deltas and final citations| UI
  HTTP -->|Save completed answer| Disk
```

Node 20.12+ supplies HTTP, fetch, streams, crypto UUIDs, filesystem operations, the test runner, and `.env` loading. There are no runtime or development dependencies. The frontend is plain HTML/CSS/JavaScript; a new reviewer can start it without installing a framework or building assets.

### Turn lifecycle

1. Validate origin, host, request size, message length, and search mode.
2. Acquire an in-process conversation lock. Reject concurrent turns in the same conversation with HTTP 409; permit up to four independent active conversations.
3. Generate a timestamp on the server and persist the user's exact text before calling the provider.
4. Select history, attach current server time and the conversation's IANA timezone, and create one Responses request. Only `web_search` appears in `tools`.
5. Translate provider SSE into newline-delimited JSON for the browser. Stream search status and text immediately.
6. On `response.completed`, extract final text and citation offsets, save the completed assistant message, and return measured timing. A failed, incomplete, or truncated stream is never treated as a completed answer.
7. On failure or cancellation, retain and mark the question as failed, discard partial assistant output, release the lock, and offer a retry. The browser restores the question in the composer. Retries are explicit new turns, not hidden duplicate provider calls.

## Memory design

### Durable source of truth

Each conversation is stored in `DATA_DIR/<UUID>.json`:

```json
{
  "id": "uuid",
  "title": "First question…",
  "timezone": "Asia/Kolkata",
  "createdAt": "2026-11-15T10:00:00.000Z",
  "messages": [
    {
      "id": "message-uuid",
      "role": "user",
      "content": "When did Apollo 11 land?",
      "createdAt": "2026-11-15T10:00:03.123Z"
    }
  ]
}
```

Assistant records also store citations, search-call count, time to first text, and total duration. Timestamps are ISO 8601 UTC with milliseconds; timezone is captured from the browser when a conversation is created. Display times use the viewing browser's timezone. Exact UTC is visible on hover and in exported JSON. The model is given the original UTC timestamp of every selected message and the original conversation timezone for relative-date interpretation.

Writes use a temporary file and rename, preventing normal readers from seeing half-written JSON. This is not a write-ahead log or a power-loss durability guarantee. A failed parse is reported rather than silently resetting the conversation. One server process must own a data directory; locks are not distributed. Full-file reads and writes are acceptable for personal use; replace them with SQLite transactions and indexed retrieval when history volume or concurrent usage grows.

### Automatic context selection

`selectMemory` uses a 48,000-character content budget (including a per-record allowance):

1. Prefer the most recent 16 messages, newest first for admission.
2. Tokenize the current question using Unicode letters/numbers, discard generic stop words, and rank older records by matching query terms in content and timestamp.
3. Admit up to 12 matching older records and their neighbors, budget permitting.
4. Admit the opening exchange when space permits.
5. Deduplicate and restore chronological order before sending to the model.

Questions from failed turns remain in the inspectable archive but are excluded from model context so interrupted requests are not silently replayed. Exact message text is retained; there is no lossy, model-written summary that can rewrite a user's question or timestamp.

This selection is deterministic, local, and adds no external tool or extra inference round trip. The system states how many records were selected out of the archive and forbids claiming exhaustive recall when history is omitted. The history panel and JSON export provide the complete record independently of model selection.

### Known memory limits

Lexical matching can miss synonyms, indirect references, older facts without shared terms, and relative-date queries outside the recent window. A 48K-character budget is not a precise token budget. It bounds the selected history, not the provider's search content or reasoning. New conversations intentionally do not inherit other conversations. A future semantic index would improve recall but adds embedding cost, a dependency, and more sensitive data processing; it is omitted from this focused implementation.

## Search strategy and factual quality

Default mode is automatic: the instructions require search for current/changeable facts, uncertain or niche claims, and explicit verification requests. Greetings, rewriting provided material, basic reasoning, and personal memory questions avoid unnecessary search. The model makes this decision; no brittle keyword router or separate classifier call is added.

Users can select **Always search**, which sets `tool_choice: required`, or **No search**, which sets `tool_choice: none` while leaving the same single tool definition. Search receives a medium context size. A response has at most three built-in tool calls, allowing focused verification without an unbounded research loop. Hosted web search may internally search or open pages; these are actions of the same hosted tool, not additional registered tools.

Instructions prefer authoritative original sources, distinguish event dates from publication dates, request corroboration for consequential or disputed claims, and require explicit uncertainty. The app extracts URL citation annotations directly from the final provider response and turns them into inline links and source cards. It does not fabricate sources from model prose.

The app does not independently entailment-check each claim against every source. A cited answer can still be wrong. Important claims should be checked by the user; automated quality evaluation is a next step, not a claimed result.

## Speed and resource trade-offs

- **One inference request per turn:** no planner, summarizer, reflection pass, or multi-agent orchestration.
- **Default `gpt-5-mini`, low reasoning effort:** a configurable quality/cost/latency trade-off, not a claim to be the newest or universally best model.
- **Streaming:** show actual progress before completion. Measure first-text and total durations separately; do not confuse faster first text with a faster final answer.
- **Bounded work:** 5,000 output tokens, three tool calls, a 90-second provider deadline, 8,000 input characters per message, and four active responses maximum.
- **No answer cache:** avoids stale current facts and conversation-dependent cache leaks. A repeated factual question may cost another search.
- **No automatic retry:** avoids surprise costs and duplicated answers after partially received streams. Transient failures require a deliberate user retry.

A longer response or difficult question may reach the output/deadline budget. Incomplete text is discarded with an explicit error rather than represented as a verified answer.

## Security and privacy boundaries

- The server binds only to `127.0.0.1`; strict Host, Origin, and Fetch Metadata checks reduce DNS rebinding and cross-site access to local history. These checks are not multi-user authentication.
- API keys stay in the server environment, never frontend assets. `.env`, `data/`, logs, and test artifacts are ignored by Git.
- The UI uses text nodes rather than rendering arbitrary model HTML. Citations accept only HTTP(S); external links use `noopener noreferrer`. A restrictive Content Security Policy blocks external scripts, inline scripts, and framing.
- Conversation IDs are validated before filesystem access. Request bodies and message sizes are bounded. Raw provider error bodies are not forwarded to the browser.
- Web content is untrusted evidence. Instructions prohibit following webpage commands and discourage placing private context in search queries. This reduces risk but is not a formal prompt-injection defense or data-loss-prevention system.
- `store: false` avoids storing Responses application state at the provider. Selected context is still transmitted and processed by OpenAI under the account's policies. Local files are plaintext; deletion removes the active local file, not backups, filesystem remnants, or provider logs.

For a hosted deployment, first add authentication and per-user authorization, encrypted durable storage, distributed concurrency, rate limits, transport security, monitoring, and an explicit retention policy. Do not simply change the bind address.

## Verification and honest performance claims

`npm test` exercises persistence across re-instantiation, exact timestamps, conversation isolation, older-message retrieval, budget limits, a single exposed tool, mode selection, Unicode/chunked SSE, citation offsets, failure paths, HTTP round trips, concurrency, input validation, and hostile-origin rejection. Tests stub the model, so they establish application behavior, not model truthfulness.

`npm run test:live` performs two real paid turns: an authoritative NASA web query requiring a search call and citation, followed by a disk reload and exact timestamp recall with search disabled. It reports observed first-text/total latency and fails if the required behavior is missing.

On November 15, 2026, the offline suite passed locally. The live attempt reached the API but failed with `credit_balance_exhausted`. No successful live latency or accuracy result is claimed. Reviewers can run the provided live check with their own funded key.

A broader evaluation should include current facts, conflicting sources, false premises, follow-up pronouns, timezone midnight boundaries, paraphrased long-history recall, prompt injection in search results, and provider timeouts. Track grounded-answer correctness, citation relevance, memory/timestamp correctness, search precision, first-text/total p50 and p95 latency, and cost per successful answer. This repository does not claim results from such a benchmark.

## Official API references

- [Web search: tool configuration and citation annotations](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [GPT-5 mini capabilities](https://developers.openai.com/api/docs/models/gpt-5-mini)

Consulted November 15, 2026. Account access, model availability, pricing, and provider behavior may change.
