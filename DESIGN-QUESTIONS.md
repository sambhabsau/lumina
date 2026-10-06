# DESIGN-QUESTIONS.md — a worksheet, not an answer key

Prepared 2026-09-17. Working notes for writing `DESIGN.md`. **No answers are written here on
purpose**: `eval/rubric.json:127` makes "the design section answers the five questions in the
learner's own words" a red line, and the eval skill says explicitly *"if it is missing, do not
write it for them."* What this file gives you is the real question, the true facts about your
system, and the places your own PROMPT notes are wrong. You write the prose.

Aim for a paragraph each. A stranger reads it. Delete each PROMPT comment block in `DESIGN.md`
as you replace it, or it ships to the page verbatim — `build-report.mjs` does not strip HTML
comments and prints no warning.

---

## 1. Components

**The question** (`DESIGN.template.md:11-15`): *"What are the pieces of your system, and where
does each one run? Name them. Include the things that are not services — the jobs collection,
the search cache, the run logs — if they carry state or make decisions."*

**What is actually true as of tonight:**

| Piece | Runs where | Real? |
|---|---|---|
| Web UI (React/Vite) | Browser; built by Vite, hosted on Vercel | provided, complete |
| Gateway, `:8787` | Node process — the only public one | **built** |
| Agent service, `:8000` | Node process — holds every provider key | **built** |
| Quick loop (`loop.ts`) | inside the agent process | **built** |
| Two-tier search cache | tier 1 = agent process RAM (LRU, max 200, `search.ts:31`); tier 2 = `searchCache` in Atlas with a TTL index | **built** |
| Run logs | `runs/*.json` on disk, one file per answer | **built** |
| MongoDB Atlas | managed cloud, M0 free tier | **built** |
| Jobs worker | would be its own process | **STUB** — `worker.ts:37` logs a warning and exits 1 |

**Your notes are wrong about four things** (`DESIGN.md:12-22`):

- You list Atlas as holding `threads, messages, memories, chunks, searchCache, jobs, GridFS`.
  Only **`threads`**, **`searchCache`** and now **`spaces`** are ever written by code.
- `messages` is not a collection — it is an array embedded on each thread document
  (`index.ts:71-77`).
- `memories`, `chunks`, `jobs` and GridFS are never created. They exist only as zod schemas in
  `packages/contract/src/db.ts`.
- You describe the jobs worker as draining uploads. It does nothing at all.

**Changed tonight:** `POST /spaces` and `GET /spaces` are now real (a space is just a named
container). The documents *inside* a space still 501. Worth one honest sentence, because the
reason is interesting: the provided benchmark calls `POST /spaces` outside any try/catch, so an
honest 501 there crashed the grader's own tooling before it could write a report.

**To answer:** which pieces did you build, which are stubs, and which of these are not services
but still carry state or make decisions?

---

## 2. Responsibilities

**The question** (`DESIGN.template.md:17-22`): *"For each component: what is it the only one
allowed to do? The interesting sentences here are the exclusions. Which component may hold a
provider key? Which may talk to the browser? Which decides that a request is over its cap?"*

**Your notes narrowed this.** You kept the three example questions but dropped the general one —
*"for each component, what is it the only one allowed to do."* Put it back; the exclusions are
the whole point of the section.

**Facts you can lean on:**

- Provider keys are read in exactly one file: `backend/agent/src/env.ts:4-5` — *"Provider keys
  are read HERE and nowhere else."* The gateway's `env.ts` reads none, and
  `gateway/src/index.ts:4` says so out loud.
- `AGENTS.md:44-45`: *"The browser talks ONLY to the gateway (`:8787`). The gateway talks to the
  agent service (`:8000`)."*
- The cap: `AGENTS.md:105-107` — *"enforced in the agent service... Not in the gateway: a cap on
  the edge is a cap you bypass by reaching the agent service directly."* You made this argument
  yourself in the quiz. Use your own sentence, not theirs.

---

## 3. Communication

**The question** (`DESIGN.template.md:24-27`): *"How does each pair of components talk, and why
that way? ... Say what happens to an in-flight request when the thing on the other end is
down."*

**Your notes kept "why that way" only for SSE.** The template wants it for every pair — why HTTP
gateway to agent, why a polled collection for API to worker.

**Three factual corrections:**

- You wrote "provider throws → `terminated:"error"` → 502". True only **before the first byte**.
  Once SSE headers are sent the response is already a 200, so a provider exception can only emit
  an `error` frame carrying `{status: 502}` on that open stream (`agent/src/index.ts:266-271`).
  The contract allows it (`sse.ts:14`), but "→ 502" as a flat claim is wrong and a careful
  grader will catch it.
- You wrote TTFT "~800ms". Your declared SLA is **p95 ≤ 2500ms** (`benchmark/sla.json:7`) and
  your measured p95 tonight was **23714ms**. Don't put an aspiration in a design doc as if it
  were a target.
- `proxyStream` / `proxyJson` pass an upstream non-2xx **through unchanged**
  (`gateway/src/index.ts:152-156`), so an agent 501 reaches the browser as a 501. Only a
  *thrown* fetch — the agent being unreachable — becomes a 502.

**Why SSE and not polling, in your own words:** the UI receives `trace` frames at ~22ms, so the
user watches the search happen rather than staring at a spinner. That is a real answer and it is
yours.

---

## 4. State

**The question** (`DESIGN.template.md:29-33`): *"What is stored, where, and who owns it? Which
state is authoritative and which is a cache you could delete without losing anything? What is
the consistency story for a document that has been written but is not yet searchable?"*

**Your notes dropped "who owns it."** Put it back.

**The split, accurately:**

- **Authoritative** (losing it loses data): `threads` with messages embedded, `spaces`, and the
  run logs on disk.
- **Cache** (delete it and you lose only speed): the in-process LRU, and the `searchCache`
  collection with its TTL index.
- **Designed but not built:** `memories`, `documents` + GridFS, `chunks`, `jobs`.

**The hard sub-question, honestly.** The "upserted is not searchable" story is real and your
codebase states it (`worker.ts:28-30`, `AGENTS.md:89-90`): Atlas Search indexes are eventually
consistent, so a chunk you just wrote is not yet findable, and a **read-your-write probe** —
query the vector index for a chunk you just wrote, and get it back — is what earns the `indexed`
status. You saw this live tonight: `npm run indexes` reported that a search index *"reports
'building' for a while; it is not queryable until listSearchIndexes says queryable: true."*

But your note says *"the answer is in worker.ts."* The **text** is there; the **implementation**
is not. Write this as the consistency story you designed and did not build. Describing an
unbuilt subsystem in the present tense is the one thing in this section that could read as
dishonest.

---

## 5. Trade-offs

**The question** (`DESIGN.template.md:35-40`): *"Three or four decisions you made that **a
reasonable engineer would have made differently**, and what you gave up. Include at least one
you are unsure about."*

**Your notes softened this** to "DECISION → WHAT I GAVE UP" and lost the counterfactual. The
template is asking what the *other* engineer would have done instead. Keep that framing.

**Candidates, with tonight's real numbers:**

1. **Scope.** You shipped quick search, citations and observability, with honest 501s for
   memory, RAG and deep search. Cost: 40 rubric points. Reason: a fabricated citation or a cap
   reported as `done` is an automatic zero, so shipping less honestly beat shipping more
   dishonestly. Lead with this — and you can now *prove* it: grounding measured **1.0**, 9/9
   verifiable citations, 0 dangling.
2. **Atlas Vector Search over a dedicated vector store.** One document per citation, no join, at
   the cost of the M0 three-index limit. **This stopped being hypothetical tonight**:
   `npm run indexes` failed to create `chunks_text` with *"The maximum number of FTS indexes has
   been reached for this instance size."* Use the real error.
3. **Two services rather than one.** Separate deploys, and keys unreachable from the browser, at
   the cost of an extra network hop on every request and twice the operational surface.
4. **Sonnet 5 rather than Opus 5** for synthesis: roughly 2.5x cheaper per answer, at some
   quality cost on hard questions.
5. **New tonight, and worth writing up.** You fixed a 50%-failure grounding bug by making the
   *harness* enforce "an answer must be grounded in a page we actually read", instead of trusting
   the prompt to be obeyed. What you gave up is measurable: cost per answer went $0.028 →
   $0.058, and TTFT is now ~20s against a 2500ms target, because the loop actually reads pages.
   A reasonable engineer might have kept the faster, cheaper, sometimes-ungrounded version and
   filtered bad answers later.

**The unsure box.** Two strong candidates: whether the in-process LRU earns its complexity next
to a plain Mongo TTL lookup; or the `0.0.0.0/0` Atlas allow-list you will open during deploy
(`DEPLOY.md` Step 0), which is defensible for an assignment and wrong for production. This is
the most valuable box on the page. Do not leave it out.
