/**
 * fetch_page — actually read the page, don't skim the snippet.
 *
 * The rubric checks the trace for fetch_page and not snippet-only synthesis, because a
 * snippet is a search engine's summary of a page, and citing it means citing something
 * you never read.
 *
 * FAIL LOUD: a dead URL throws. The loop records ok:false with the error on the trace
 * step and carries on with the pages that did work — that is different from pretending
 * the page was empty.
 */
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

/** Cap what we feed the model. Whole pages blow the context and the bill for no gain. */
const MAX_CHARS = 12000;

export async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'LuminaBot/0.1 (+FDE bootcamp assignment)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow'
  });

  if (!res.ok) throw new Error(`fetch_page ${res.status} for ${url}`);

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();

  // Plain text and markdown need no extraction.
  if (!contentType.includes('html')) {
    return { url, title: url, text: raw.slice(0, MAX_CHARS) };
  }

  const dom = new JSDOM(raw, { url });
  const article = new Readability(dom.window.document).parse();

  const text = (article?.textContent ?? dom.window.document.body?.textContent ?? '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!text) throw new Error(`fetch_page extracted no text from ${url}`);

  return {
    url,
    title: article?.title || dom.window.document.title || url,
    text: text.slice(0, MAX_CHARS)
  };
}

/**
 * The snippet that goes on a Source, and the reason grounding passes.
 *
 * The bench checks that a source's snippet appears, normalized, in the fetched page. So
 * the snippet is a LITERAL SUBSTRING of the text we actually retrieved — never a model
 * paraphrase. Paraphrasing here is how you fabricate a citation without meaning to.
 */
export function snippetFor(page: FetchedPage, query: string): string {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);

  const haystack = page.text.toLowerCase();
  let best = 0;
  let bestScore = -1;

  // Slide a window over the page and keep the densest patch of query terms.
  const WINDOW = 400;
  for (let i = 0; i + WINDOW <= page.text.length; i += 200) {
    const window = haystack.slice(i, i + WINDOW);
    const score = words.reduce((n, w) => n + (window.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  return page.text.slice(best, best + WINDOW).trim();
}
