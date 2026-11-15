# Minimi

**A little more certain.** A fast, single-tool chat agent that searches the web when needed and remembers what you asked, including when you asked it.

Built with Node.js and browser APIs. **Zero npm dependencies, no build step, no database service.**

## Run in two minutes

1. Install **Node.js 20.12+** (22 LTS recommended).
2. Clone this repository and enter its directory.
3. Copy `.env.example` to `.env` (`cp .env.example .env` on macOS/Linux; `Copy-Item .env.example .env` in PowerShell).
4. Put your [free Google AI Studio key](https://aistudio.google.com/api-keys) in `GEMINI_API_KEY`. Add a [free Tavily key](https://app.tavily.com/) in `TAVILY_API_KEY` for reliable search quotas.
5. Run `npm start`, then open **http://localhost:3000**.

No `npm install` is needed. Never commit `.env`. The default setup uses Gemini 3.5 Flash-Lite for chat and Tavily for its single `web_search` tool. Existing conversations remain compatible with either provider.

### Free-tier limits

- **Gemini:** Google currently lists free input/output tokens for Gemini 3.5 Flash-Lite, subject to your project's rate limits. Free-tier content can be used to improve Google's products. Use a free-tier project; a paid project's API usage can incur charges.
- **Tavily:** a free account includes **1,000 credits/month**, with no credit card required. The app uses basic search at one credit per search, up to three searches per turn. An empty `TAVILY_API_KEY` uses free, rate-limited keyless access; a free key is recommended because shared keyless quotas can already be exhausted.
- The app never upgrades plans, retries quota failures automatically, or falls back to a paid model. It cannot inspect your account's billing tier: keep provider accounts on their free plans to stay within free usage.

Sources checked November 15, 2026: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite), [Tavily credits](https://docs.tavily.com/documentation/api-credits), [keyless search](https://docs.tavily.com/documentation/keyless). Free offerings and limits may change.

The older Gemini 2.5 Flash-Lite advertises free built-in Google Search, but the live API rejected it as unavailable to new users. This app uses the accessible newer model with Tavily instead; it does not depend on paid Google Search grounding.

## What it does

- **Exactly one model tool:** `web_search`, implemented through Tavily for Gemini, or OpenAI's hosted search for the optional OpenAI provider. No file search, code execution, or extra agents.
- **Streaming answers:** text appears as it arrives; actual first-text and total durations are shown after completion.
- **Source citations:** clickable inline citations and source cards use actual returned search results (Gemini) or provider citation annotations (OpenAI).
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
| `AI_PROVIDER` | `gemini` in `.env.example` | `gemini` or `openai`; when unset, prefers a configured Gemini key |
| `GEMINI_API_KEY` | Required for Gemini | Server-side Google AI Studio API key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Free-tier-capable model supporting function calls |
| `TAVILY_API_KEY` | Optional, recommended | Free Tavily key; empty uses rate-limited keyless search |
| `OPENAI_API_KEY` | Required for OpenAI | Funded server-side API key |
| `OPENAI_MODEL` | `gpt-5-mini` | Responses model supporting web search and low reasoning effort |
| `PORT` | `3000` | Local HTTP port |
| `DATA_DIR` | `./data` | Private conversation storage; excluded from Git |

To use OpenAI, set `AI_PROVIDER=openai` and supply a funded `OPENAI_API_KEY`. There is no automatic fallback between providers. Existing process environment variables take precedence over `.env`. Model substitutions may have different pricing; verify before changing them.

## Validation

```sh
npm test             # Offline unit and HTTP integration tests; no key needed
npm run test:live    # Real search + exact timestamp recall; configured provider quotas apply
npm run test:live -- --memory-only  # Real conversation recall without web search
```

Automated tests cover persistence, timestamps, older-memory retrieval, bounded context, isolation, single-tool enforcement, search controls, split Unicode streaming, citations, error handling, concurrency, input validation, and local-origin protections. GitHub Actions runs the suite on Windows and Linux with Node 20 and 22.

The live script checks that web search actually runs and returns citations, then reloads memory from disk and checks exact timestamp recall without search. Temporary live-test conversations are removed afterward.

**Validation on November 15, 2026:** all 20 offline tests passed. With Gemini 3.5 Flash-Lite and a Tavily key, live search returned the correct Apollo 11 landing date with a NASA citation in 4.2 seconds; disk-reloaded memory recalled the exact original question and UTC timestamp without search in 1.7 seconds. These are individual smoke-test observations, not a latency or accuracy benchmark. OpenAI live validation remains blocked by the configured account's exhausted credits.

## Design and limits

See **[design.md](design.md)** for architecture, memory selection, search policy, security boundaries, evaluation, and trade-offs.

Full history stays on disk, but only a bounded selection goes to the model. Lexical retrieval can miss paraphrases and complex date queries. Source citations support verification; they do not prove every claim correct. The UI renders model text safely as plain text with linked citations; it deliberately does not render arbitrary HTML or full Markdown.

Local records are not encrypted. Selected conversation text is sent to the chosen model provider. In Gemini mode, public search queries are sent to Tavily, and returned excerpts are sent to Gemini. In OpenAI mode, `store: false` disables Responses application storage, not all provider processing or retention. Run one server process per data directory. Do not expose this unauthenticated local service on a public network.

## Repository map

```text
src/agent.js          Prompt, one-tool request, stream parsing, citations
src/gemini.js         Gemini tool loop and Tavily search integration
src/provider.js       Explicit provider selection; no paid fallback
src/memory.js         Atomic local storage and bounded history selection
src/server.js         Local HTTP API, validation, cancellation, concurrency
public/              Responsive chat UI and searchable timeline
test/agent.test.js    Offline regression tests
test/gemini.test.js   Provider, single-tool, search-budget, and citation tests
scripts/live-check.js  Opt-in real API evaluation
design.md            Architecture and trade-offs
```

MIT licensed.
