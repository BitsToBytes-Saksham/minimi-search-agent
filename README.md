# Minimi

**A little more certain.** A fast, single-tool chat agent that searches the web when needed and remembers what you asked, including when you asked it.

Built with Node.js and browser APIs. **Zero npm dependencies, no build step, no database service.**

## Run in two minutes

1. Install **Node.js 20.12+** (22 LTS recommended).
2. Clone this repository and enter its directory.
3. Copy `.env.example` to `.env` (`cp .env.example .env` on macOS/Linux; `Copy-Item .env.example .env` in PowerShell).
4. Put a **funded OpenAI API key** in `OPENAI_API_KEY` in `.env`.
5. Run `npm start`, then open **http://localhost:3000**.

No `npm install` is needed. ChatGPT subscription access alone does not supply API credits. Never commit `.env`.

## What it does

- **Exactly one model tool:** `web_search`, through the OpenAI Responses API. No function tools, file search, code execution, or extra agents.
- **Streaming answers:** text appears as it arrives; actual first-text and total durations are shown after completion.
- **Source citations:** clickable inline citations and source cards use the API's citation annotations.
- **Persistent memory:** original questions, answers, server UTC timestamps, timezone, citations, and timings survive restarts.
- **Recall:** recent context plus relevant older exchanges and opening context are automatically included. Memory is application logic, not a second tool.
- **Inspectable timeline:** search every saved question by text or date, see its timestamp, export the full conversation, or delete it.
- **Search controls:** automatic, always search, or no search for this turn. Each response has a three-tool-call budget.
- **Failure handling:** cancel a response, keep the original question, retry from the composer. Incomplete answers are never saved as successful answers.

Conversations are isolated. Start a new conversation for a fresh memory. This is a **local, single-user application**, not a publicly hosted multi-user service.

## Try it

1. Ask: “Search NASA: what date did Apollo 11 land on the Moon? Cite the original source.”
2. Ask: “What did I just ask, and when exactly did I ask it?”
3. Restart the app, open the same conversation, and ask again.
4. Open **History**, search “Apollo”, and inspect the original timestamp. Hover a timestamp to see exact UTC.

For current claims, use **Always search** when verification is mandatory. Automatic search is a model decision and is not a guarantee.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Required | Server-side API key with credits and model access |
| `OPENAI_MODEL` | `gpt-5-mini` | Responses model supporting web search and low reasoning effort |
| `PORT` | `3000` | Local HTTP port |
| `DATA_DIR` | `./data` | Private conversation storage; excluded from Git |

The default prioritizes lower cost and latency. A stronger compatible model can be selected without changing code; validate its search and reasoning support first. Existing process environment variables take precedence over `.env`.

## Validation

```sh
npm test             # Offline unit and HTTP integration tests; no key needed
npm run test:live    # Two paid real-model turns; needs a funded key
```

Automated tests cover persistence, timestamps, older-memory retrieval, bounded context, isolation, single-tool enforcement, search controls, split Unicode streaming, citations, error handling, concurrency, input validation, and local-origin protections. GitHub Actions runs the suite on Windows and Linux with Node 20 and 22.

The live script checks that web search actually runs and returns citations, then reloads memory from disk and checks exact timestamp recall without search. Temporary live-test conversations are removed afterward.

**Validation on November 15, 2026:** the offline suite passed locally. A real API attempt reached the provider but returned `credit_balance_exhausted`. Successful live answers and performance have therefore **not** been measured in this environment. Do not interpret mocked integration tests as an accuracy benchmark.

## Design and limits

See **[design.md](design.md)** for architecture, memory selection, search policy, security boundaries, evaluation, and trade-offs.

Full history stays on disk, but only a bounded selection goes to the model. Lexical retrieval can miss paraphrases and complex date queries. Source citations support verification; they do not prove every claim correct. The UI renders model text safely as plain text with linked citations; it deliberately does not render arbitrary HTML or full Markdown.

Local records are not encrypted. Selected conversation text is sent to OpenAI to generate answers; `store: false` disables Responses application storage, not all provider processing or retention. Run one server process per data directory. Do not expose this unauthenticated local service on a public network.

## Repository map

```text
src/agent.js          Prompt, one-tool request, stream parsing, citations
src/memory.js         Atomic local storage and bounded history selection
src/server.js         Local HTTP API, validation, cancellation, concurrency
public/              Responsive chat UI and searchable timeline
test/agent.test.js    Offline regression tests
scripts/live-check.js  Opt-in real API evaluation
design.md            Architecture and trade-offs
```

MIT licensed.
