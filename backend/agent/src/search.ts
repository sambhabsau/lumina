/**
 * web_search — the provider, behind a two-tier cache.
 *
 * Tier 1: an in-process LRU (free, dies with the process).
 * Tier 2: the `searchCache` collection with a TTL index (survives restarts, shared
 *         across instances).
 * Key: sha256(normalized query + provider), so "What is RAG?" and "what is rag" are
 * one entry.
 *
 * FAIL LOUD: a provider error throws. It does NOT return an empty result set — an empty
 * result and a dead provider must never look the same to the loop above (rule A1).
 */
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { env, secrets } from './env.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Same query, different capitalisation or spacing, is the same cache entry. */
function cacheKey(query: string, provider: string): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${normalized}::${provider}`).digest('hex');
}

// ---- tier 1: in-process LRU -------------------------------------------------

const LRU_MAX = 200;
const lru = new Map<string, SearchHit[]>();

function lruGet(key: string): SearchHit[] | undefined {
  const hit = lru.get(key);
  if (!hit) return undefined;
  // Re-insert to mark as most-recently-used.
  lru.delete(key);
  lru.set(key, hit);
  return hit;
}

function lruSet(key: string, value: SearchHit[]): void {
  if (lru.size >= LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest) lru.delete(oldest);
  }
  lru.set(key, value);
}

// ---- tier 2: mongo, with a TTL index ----------------------------------------

export async function ensureSearchCacheIndex(): Promise<void> {
  const collection = (await db()).collection('searchCache');
  await collection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: env.searchCacheTtlSeconds, name: 'searchCache_ttl' }
  );
  await collection.createIndex({ key: 1 }, { unique: true, name: 'searchCache_key' });
}

// ---- the provider ------------------------------------------------------------

async function tavily(query: string): Promise<SearchHit[]> {
  if (!secrets.tavily) throw new Error('TAVILY_API_KEY is not set');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: secrets.tavily,
      query,
      max_results: 6,
      search_depth: 'basic'
    }),
    signal: AbortSignal.timeout(15000)
  });

  // A non-2xx from the provider is an exception, not an empty result.
  if (!res.ok) {
    throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (body.results ?? []).map((r) => ({
    title: String(r.title ?? 'untitled'),
    url: String(r.url ?? ''),
    snippet: String(r.content ?? '')
  }));
}

/**
 * Returns the hits and whether THIS call was served from cache. The caller ANDs the
 * `cached` flags together: `searchCached` is true on the done event only when every
 * search in the request was a hit.
 */
export async function webSearch(query: string): Promise<{ hits: SearchHit[]; cached: boolean }> {
  const key = cacheKey(query, env.searchProvider);

  const local = lruGet(key);
  if (local) return { hits: local, cached: true };

  const collection = (await db()).collection<{ key: string; hits: SearchHit[] }>('searchCache');
  const stored = await collection.findOne({ key });
  if (stored?.hits) {
    lruSet(key, stored.hits);
    return { hits: stored.hits, cached: true };
  }

  if (env.searchProvider !== 'tavily') {
    throw new Error(`SEARCH_PROVIDER=${env.searchProvider} is not wired up in this build`);
  }
  const hits = await tavily(query);

  lruSet(key, hits);
  await collection.updateOne(
    { key },
    { $set: { key, hits, query, provider: env.searchProvider, createdAt: new Date() } },
    { upsert: true }
  );

  return { hits, cached: false };
}
