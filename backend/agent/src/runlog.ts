/**
 * The run log: one runs/<requestId>.json per answer.
 *
 * Ten lines of adapter, and it is what `node quality/check.mjs .` reads. Without `depth`
 * nobody can tell an expensive deep run from a quick run that ran away — which is the
 * whole reason the field is required.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { db } from './db.js';

export interface RunLog {
  requestId: string;
  answerId: string;
  query: string;
  depth: 'quick' | 'deep';
  terminated: 'done' | 'cap' | 'error';
  wallClockSec: number;
  costUsd: number;
  tokens: { in: number; out: number };
  searchCached: boolean;
  toolCalls: Array<{ name: string; ok: boolean; error?: string }>;
  error?: string;
}

export async function writeRunLog(run: RunLog): Promise<void> {
  writeFileSync(join(env.runsDir, `${run.requestId}.json`), JSON.stringify(run, null, 2), 'utf-8');
  // Fly machines don't persist local disk across a restart or redeploy. `runs` in Mongo is
  // the durable copy `scripts/export-runs.mjs` pulls down onto disk for quality/check.mjs.
  await (await db()).collection('runs').insertOne({ ...run, createdAt: new Date() });
}
