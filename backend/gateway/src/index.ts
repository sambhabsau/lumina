/**
 * LUMINA gateway - the software backend, and the ONLY service the browser talks to.
 *
 * No provider key is ever read in this process. Its whole job is the edge:
 *   1. X-User-Id enforcement           -> 401 without it, on every route but /health
 *   2. zod validation from @lumina/contract -> 400 on a bad body
 *   3. a per-user rate limit           -> 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   5. 502 for any upstream failure    -> never a 2xx when the agent threw
 *
 * Note what is NOT here: the deep-search spend cap. That lives in the agent service,
 * because a cap on the edge is a cap you bypass by reaching the agent directly.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AskBody, HealthResponse, REQUEST_HEADER, ROUTES, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    autoLogging: true
  })
);

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- /health

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- /evals/report.json

/**
 * THE SUBMISSION. /evals renders whatever this returns and nothing else, so a grader
 * opening the deployed URL sees exactly this file (web/src/api.ts:114).
 *
 * Public and ahead of the rate limiter on purpose: a grader has no X-User-Id.
 *
 * Written by `node eval/build-report.mjs` into reports/report.json; this route only
 * reads it. It never synthesises one. A missing report is a 404 that says how to make
 * it, and unparseable JSON is a 502 - a plausible-looking empty report handed to a
 * grader is the Live Translate bug by choice (rule A1).
 */
app.get('/evals/report.json', (_req, res) => {
  if (!existsSync(env.reportPath)) {
    return res.status(404).json({
      error:
        'no report yet - run: node eval/build-report.mjs --student "Your Name" ' +
        '(needs reports/bench.json and reports/quality.json first)',
      status: 404,
      requestId: String(res.locals.requestId)
    });
  }

  let raw: string;
  try {
    raw = readFileSync(env.reportPath, 'utf8');
    JSON.parse(raw);
  } catch (err) {
    return res.status(502).json({
      error: `reports/report.json is unreadable: ${(err as Error).message}`,
      status: 502,
      requestId: String(res.locals.requestId)
    });
  }

  // Never cached: the grader must see the report this deployment actually has.
  res.status(200).type('application/json').set('Cache-Control', 'no-store').send(raw);
});

// ---------------------------------------------------------------- 401: who are you

const PUBLIC = new Set(['/health', '/evals/report.json']);

app.use((req, res, next) => {
  if (PUBLIC.has(req.path) || !req.path.match(/^\/(stats|threads|memory|spaces)/)) return next();
  if (!req.header(USER_HEADER)?.trim()) {
    return res.status(401).json({
      error: `missing ${USER_HEADER} header`,
      status: 401,
      requestId: String(res.locals.requestId)
    });
  }
  next();
});

// ---------------------------------------------------------------- 429: slow down

const buckets = new Map<string, { count: number; resetAt: number }>();

app.use((req, res, next) => {
  if (PUBLIC.has(req.path)) return next();
  const userId = req.header(USER_HEADER) ?? 'anonymous';
  const now = Date.now();
  const bucket = buckets.get(userId);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(userId, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (bucket.count >= env.rateLimitPerMinute) {
    return res.status(429).json({
      error: 'rate limit exceeded',
      status: 429,
      resetsAt: new Date(bucket.resetAt).toISOString(),
      requestId: String(res.locals.requestId)
    });
  }
  bucket.count += 1;
  next();
});

// ---------------------------------------------------------------- 400: is the body sane

app.post('/threads/:threadId/ask', (req, res, next) => {
  const parsed = AskBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'invalid request body',
      status: 400,
      requestId: String(res.locals.requestId)
    });
  }
  req.body = parsed.data;
  next();
});

// ---------------------------------------------------------------- the proxy

/** SSE pass-through: forward frames as they arrive. Buffering here is the classic bug
 *  that makes every token land at once and fails TTFT for a reason no profiler shows. */
async function proxyStream(req: express.Request, res: express.Response): Promise<void> {
  const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [USER_HEADER]: req.header(USER_HEADER) ?? '',
      [REQUEST_HEADER]: String(res.locals.requestId)
    },
    body: JSON.stringify(req.body)
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    res.status(upstream.status === 501 ? 501 : upstream.status).type('application/json').send(text);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function proxyJson(req: express.Request, res: express.Response): Promise<void> {
  const init: RequestInit = {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      [USER_HEADER]: req.header(USER_HEADER) ?? '',
      [REQUEST_HEADER]: String(res.locals.requestId)
    }
  };
  if (req.method !== 'GET' && req.method !== 'DELETE') init.body = JSON.stringify(req.body ?? {});

  const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, init);
  const text = await upstream.text();
  res.status(upstream.status).type('application/json').send(text);
}

for (const route of ROUTES) {
  if (route.path === '/health' || route.path === '/evals/report.json') continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';

  app[method](route.path, async (req, res, next) => {
    try {
      if (route.path === '/threads/:threadId/ask') await proxyStream(req, res);
      else await proxyJson(req, res);
    } catch (err) {
      next(err);
    }
  });
}

// ---------------------------------------------------------------- static UI

if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  if (res.headersSent) return res.end();
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info({ port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins }, 'gateway up');
});
