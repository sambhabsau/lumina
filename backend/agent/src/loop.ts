/**
 * The quick loop. This is Module 1's my_agent_loop.py, in TypeScript, with a stream
 * attached and honest termination.
 *
 * Shape of a run:
 *   1. TOOL PHASE   - model chooses web_search / fetch_page, we execute, we feed results
 *                     back, repeat. Bounded by MAX_TOOL_CALLS and MAX_WALL_CLOCK_SEC.
 *   2. sources      - emitted BEFORE the first token, so the UI can draw citation chips
 *                     while the text is still arriving (contract sse.ts).
 *   3. SYNTHESIS    - one streaming call that writes the answer with [n] citations bound
 *                     to the source list we just emitted.
 *
 * Why synthesis is a separate call: the source numbering has to exist before the first
 * token, and the only way to guarantee that is to finish retrieving, freeze the list,
 * emit it, and only then start writing.
 *
 * Three invariants, all from AGENTS.md:
 *   - Fail loud. A provider exception ends the run terminated:"error" and the caller
 *     gets a 502. No catch returns a plausible answer.
 *   - Bounded and honest. Hitting a cap is terminated:"cap", never "done".
 *   - Grounded or nothing. Every [n] resolves to a source we retrieved in THIS request,
 *     and each source's snippet is a literal substring of the page we fetched.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Source, TraceEvent, Terminated } from '@lumina/contract';
import { newId, unresolvedCitations } from '@lumina/contract';
import { env, secrets } from './env.js';
import { webSearch, type SearchHit } from './search.js';
import { fetchPage, snippetFor, type FetchedPage } from './fetchpage.js';

const client = new Anthropic({ apiKey: secrets.anthropic });

/** Sonnet 5: $2 / MTok in, $10 / MTok out. */
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_OUT_PER_MTOK = 10.0;

/**
 * Quick gear only. plan_research is deep-only and is deliberately absent here: a quick
 * run that could reach it would be one prompt away from escalating its own bill.
 */
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for pages relevant to a question. Returns titles, URLs and short ' +
      'snippets. Snippets are NOT enough to answer from - follow up with fetch_page.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'fetch_page',
    description:
      'Fetch and read the full text of one URL returned by web_search. You must fetch a ' +
      'page before citing it. Call this for every source you intend to cite.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The absolute URL to read.' } },
      required: ['url'],
      additionalProperties: false
    }
  }
];

const SYSTEM = [
  'You are LUMINA, a research assistant that answers from sources it has actually read.',
  '',
  'Process: search the web, then FETCH the pages that look useful. Never answer from a',
  'search snippet alone - snippets are a search engine summarising a page you have not',
  'read. Two to four fetched pages is usually right for a quick answer.',
  '',
  'You may NOT stop calling tools until you have successfully fetched at least one page.',
  'A search snippet is not a source. With nothing fetched there is nothing to cite, and',
  'an uncitable answer is worthless. Once you have fetched enough, stop and say so.'
].join('\n');

export interface RunResult {
  answerId: string;
  text: string;
  sources: Source[];
  trace: TraceEvent[];
  terminated: Terminated;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  searchCached: boolean;
  ttftMs: number;
  latencyMs: number;
}

export interface Emitter {
  trace: (e: TraceEvent) => void;
  sources: (s: Source[]) => void;
  token: (t: string) => void;
}

export async function runQuick(
  query: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  emit: Emitter
): Promise<RunResult> {
  const startedAt = Date.now();
  const answerId = newId('ans');
  const trace: TraceEvent[] = [];
  const fetched: FetchedPage[] = [];
  const searchedHits: SearchHit[] = [];

  let step = 0;
  let toolCalls = 0;
  // Attempts, not successes: a fetch that threw still means the model tried to ground
  // itself, which is a different run from one that never reached for a page at all.
  let fetchAttempts = 0;
  let nudged = false;
  let tokensIn = 0;
  let tokensOut = 0;
  // AND of every search in the request: one miss and the answer was not cached.
  let allSearchesCached = true;
  let sawAnySearch = false;
  let terminated: Terminated = 'done';

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam),
    { role: 'user', content: query }
  ];

  const capHit = (): boolean =>
    toolCalls >= env.maxToolCalls || (Date.now() - startedAt) / 1000 >= env.maxWallClockSec;

  // ---- 1. TOOL PHASE --------------------------------------------------------

  while (!capHit()) {
    const response = await client.messages.create({
      model: env.llmModel,
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages
    });

    tokensIn += response.usage.input_tokens;
    tokensOut += response.usage.output_tokens;

    if (response.stop_reason !== 'tool_use') {
      // The model ended its turn. If it never reached for a page, the run has no grounding
      // and the answer is already worthless - so say so once and let it try again. Measured
      // at ~50% of runs on Sonnet 5, so hoping the prompt is obeyed is not a design.
      if (fetched.length === 0 && fetchAttempts === 0 && !nudged && !capHit()) {
        nudged = true;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content:
            'You have not fetched any pages, so there is nothing you can cite. Call ' +
            'fetch_page on at least one URL from the search results, then answer.'
        });
        continue;
      }
      // end_turn is the only stop reason that means the model chose to finish. max_tokens,
      // refusal and pause_turn all mean it was cut off, and reporting those as `done` is
      // the same lie as reporting a capped run as done.
      if (response.stop_reason !== 'end_turn') terminated = 'error';
      break;
    }

    // The WHOLE content list goes back, thinking blocks and all. The API is stateless;
    // `messages` is the entire memory, and a tool_result whose tool_use_id points at
    // nothing is a 400.
    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (capHit()) {
        terminated = 'cap';
        break;
      }

      toolCalls += 1;
      step += 1;
      const t0 = Date.now();
      const input = block.input as Record<string, string>;

      try {
        if (block.name === 'web_search') {
          const { hits, cached } = await webSearch(String(input.query ?? ''));
          sawAnySearch = true;
          if (!cached) allSearchesCached = false;
          searchedHits.push(...hits);

          const ev: TraceEvent = {
            step,
            tool: 'web_search',
            input,
            ok: true,
            ms: Date.now() - t0,
            reason: `${hits.length} results${cached ? ' (cache hit)' : ''}`
          };
          trace.push(ev);
          emit.trace(ev);

          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: hits
              .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`)
              .join('\n\n')
          });
        } else if (block.name === 'fetch_page') {
          fetchAttempts += 1;
          const page = await fetchPage(String(input.url ?? ''));
          fetched.push(page);

          const ev: TraceEvent = {
            step,
            tool: 'fetch_page',
            input,
            ok: true,
            ms: Date.now() - t0,
            reason: `read ${page.text.length} chars from ${page.title}`
          };
          trace.push(ev);
          emit.trace(ev);

          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `TITLE: ${page.title}\nURL: ${page.url}\n\n${page.text}`
          });
        } else {
          throw new Error(`unknown tool: ${block.name}`);
        }
      } catch (err) {
        // A tool that failed is recorded as failed, with the reason. A failure you cannot
        // tell apart from an empty result is the Live Translate bug (rule A1).
        const message = (err as Error).message;
        const ev: TraceEvent = {
          step,
          tool: block.name as TraceEvent['tool'],
          input,
          ok: false,
          ms: Date.now() - t0,
          error: message
        };
        trace.push(ev);
        emit.trace(ev);

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `ERROR: ${message}`,
          is_error: true
        });
      }
    }

    messages.push({ role: 'user', content: results });
    if (terminated === 'cap') break;
  }

  if (terminated === 'done' && capHit()) terminated = 'cap';

  // Grounded or nothing, enforced by the harness rather than trusted to the model. A run
  // that never TRIED to read a page did not terminate because it finished - it gave up, and
  // calling that `done` is exactly the A2 failure. A run whose fetches all failed did finish
  // honestly: every failure is in the trace with ok:false and an error string (A1).
  if (terminated === 'done' && fetched.length === 0 && fetchAttempts === 0) {
    terminated = 'error';
  }

  // ---- 2. SOURCES, before a single token ------------------------------------

  // Only pages we actually READ become citable. A search hit we never fetched is not a
  // source - citing it would be citing something we never looked at.
  const sources: Source[] = fetched.map((page, i) => ({
    n: i + 1,
    kind: 'web' as const,
    title: page.title,
    url: page.url,
    snippet: snippetFor(page, query)
  }));

  emit.sources(sources);

  // ---- 3. SYNTHESIS, streamed ----------------------------------------------

  const sourceBlock = fetched
    .map((page, i) => `[${i + 1}] ${page.title} - ${page.url}\n${page.text.slice(0, 6000)}`)
    .join('\n\n---\n\n');

  const capNote =
    terminated === 'cap'
      ? '\n\nIMPORTANT: this run hit its tool-call or time cap before finishing. Answer ' +
        'with what the sources below support, and say plainly at the end that the ' +
        'research was cut short. Do not pretend the answer is complete.'
      : '';

  const synthesisPrompt = sources.length
    ? [
        `Question: ${query}`,
        '',
        'Write the answer using ONLY the sources below. Cite with [n] matching the numbers',
        'given. Every factual claim needs a citation. Do not cite a number that is not in',
        'the list. Be concise - a few short paragraphs, no preamble.' + capNote,
        '',
        'SOURCES:',
        sourceBlock
      ].join('\n')
    : [
        `Question: ${query}`,
        '',
        'Retrieval returned nothing usable. Say so plainly in one or two sentences and cite',
        'nothing. Do not answer from memory and do not invent a source.'
      ].join('\n');

  let text = '';
  let ttftMs = 0;

  const stream = client.messages.stream({
    model: env.llmModel,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: 'user', content: synthesisPrompt }]
  });

  stream.on('text', (delta) => {
    if (!ttftMs) ttftMs = Date.now() - startedAt;
    text += delta;
    emit.token(delta);
  });

  const final = await stream.finalMessage();
  tokensIn += final.usage.input_tokens;
  tokensOut += final.usage.output_tokens;

  // Last line of defence on grounding: a citation the model invented never reaches the
  // client as a live number.
  const dangling = unresolvedCitations(text, sources);
  for (const n of dangling) text = text.replaceAll(`[${n}]`, '');

  return {
    answerId,
    text,
    sources,
    trace,
    terminated,
    tokensIn,
    tokensOut,
    costUsd: (tokensIn / 1e6) * PRICE_IN_PER_MTOK + (tokensOut / 1e6) * PRICE_OUT_PER_MTOK,
    searchCached: sawAnySearch && allSearchesCached,
    ttftMs: ttftMs || Date.now() - startedAt,
    latencyMs: Date.now() - startedAt
  };
}
