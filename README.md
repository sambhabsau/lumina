# LUMINA — a Perplexity-style AI search engine

Ask a question and get a **streamed answer with clickable citations**, built from a live web
search. Each citation points to a page the agent actually fetched and read.

**Live demo:** <https://lumina-xi-sage-58.vercel.app> · **Eval report:** the `/evals` page in the app

Built as Project 1 of the **FDE Agent Engineering Bootcamp** (cohort 2026-03). The course
provided the UI, a typed API contract, and the grading harness. I designed, built, and deployed
the two backend services behind them. **This repo contains my backend and deployment work.**

---

## What I built

| Area | What it does |
|---|---|
| **Agent loop** (`backend/agent/src/loop.ts`) | A bounded tool-use loop on Claude: the model calls `web_search` and `fetch_page`, the harness runs the tools and feeds results back, then the final answer streams token by token over SSE. Sources are sent before the first token. |
| **Harness-enforced grounding** | The harness only makes pages the agent actually **fetched** citable, and each citation snippet must be a literal substring of the fetched page. If the model tries to answer without reading anything, it gets nudged back to its tools. |
| **Honest termination** | A run that hits its turn cap or hits an error is labelled `cap` / `error`, never `done`. |
| **Two-tier search cache** (`search.ts`) | Tier 1 is an in-process LRU. Tier 2 is a MongoDB collection with a TTL index, so cached results survive restarts. Keys are normalized so the same query with different capitalization or spacing hits the same entry. |
| **Gateway** (`backend/gateway/`) | The only public service. It handles CORS, `X-User-Id` auth (401), per-user rate limiting (429), request IDs propagated end to end, structured logging, validation, and SSE pass-through. It holds no API keys. |
| **Observability** (`runlog.ts`) | One JSON run log per answer, written to disk and persisted to MongoDB so trajectories from the deployed app survive restarts. |
| **Deployment** | The UI is on Vercel. The gateway and agent run as separate Fly.io apps, and the agent is reachable only from the gateway. MongoDB Atlas is the only persistent store. See [`DEPLOY.md`](DEPLOY.md). |

## Architecture

```
Browser ──HTTP/SSE──▶ Gateway (Fly.io, public, no keys)
                        │  private HTTP
                        ▼
                      Agent (Fly.io, private, holds provider keys)
                        │  Mongo wire protocol
                        ▼
                      MongoDB Atlas  — threads, search cache (TTL), run logs
```

The agent is **stateless between requests**: every turn reloads the thread from MongoDB, so
any agent instance can serve any request. The full reasoning is in [`DESIGN.md`](DESIGN.md).

## Design trade-offs

- **Grounding enforced in code, not left to the prompt.** At first, about 50% of answers cited
  sources the model never opened. Enforcing it in the harness fixed that, at the cost of more
  page fetches, higher latency, and more runs reaching the turn cap.
- **Sonnet over Opus for every call.** It's cheaper and faster. Some quality is lost on
  the hardest questions, which I accepted because most queries are easy or medium.
- **One store (Atlas Vector Search) instead of MongoDB + a separate vector DB.** This avoids
  two systems drifting out of sync over citations. The cost is the M0 tier's 3-index cap.
- **Scope: depth over breadth.** I shipped the quick-search path end to end (streaming,
  citations, caching, auth, rate limits, observability, deploy). Deep search, document RAG,
  and long-term memory return explicit `501 not implemented` responses instead of half-working
  features. The eval report at `/evals` shows exactly what passes and what doesn't.

## Status

| Feature | Status |
|---|---|
| Quick search with streamed, cited answers | ✅ Shipped |
| Search cache, threads, run logs | ✅ Shipped |
| Gateway: auth, rate limits, request IDs, SSE | ✅ Shipped |
| Deployed (Vercel + Fly.io + Atlas) | ✅ Shipped |
| Deep search (plan → fan-out → merged citations) | ⏳ Not built (`501`) |
| RAG over uploaded documents | ⏳ Not built (`501`) |
| Long-term memory | ⏳ Not built (`501`) |

## Tech stack

TypeScript · Node.js · Express · React (Vite) · Claude (Anthropic API) · Tavily search ·
MongoDB Atlas · Server-Sent Events · zod · Docker · Fly.io · Vercel

## Trying it

**Use the live demo.** The services are on Fly.io's auto-stop, so the first request after a
quiet period can take a few seconds to wake them up.

This repo doesn't run on its own. The React UI and the shared typed contract
(`@lumina/contract`, zod schemas for every HTTP and SSE payload) that both services import
belong to the course and aren't published here. The rest of the setup (environment variables,
Fly.io and Vercel deployment, health checks) is in [`DEPLOY.md`](DEPLOY.md), and the variables
are listed in [`.env.example`](.env.example).

## Credits

The project brief, React UI, API contract, grading harness, and service skeletons (the `501`
stubs I built the services from) come from the
[FDE Agent Engineering Bootcamp](https://github.com/hamzafarooq/multi-agent-course) by
Hamza Farooq. The UI, contract, and harness aren't included in this repo.

My work: the agent and gateway implementations in `backend/`, the deployment setup
(Dockerfiles, `fly.*.toml`, `vercel.json`, [`DEPLOY.md`](DEPLOY.md)), and the design write-up
([`DESIGN.md`](DESIGN.md)).
