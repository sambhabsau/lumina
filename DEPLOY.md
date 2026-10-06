# DEPLOY.md — LUMINA, first deploy, in order

Prepared 2026-09-17 for the 2026-09-18 session. Everything here is scaffolding; nothing has
been deployed. Read the ORDER section first — it is the part that saves you hours.

## The order matters, and it is circular-looking

You cannot benchmark a deployment that is not up yet, and the `/evals` page must show numbers
from a run against **this** deployment. So the gateway gets deployed **twice**:

1. Deploy agent + gateway + UI with **no report** → `/evals` shows an honest 404
2. Run the full benchmark **against the live gateway**
3. Build `reports/report.json` from that run
4. **Redeploy the gateway** so the image contains the report → `/evals` renders

That second deploy is ~2 minutes. Budget for it; don't be surprised by it.

## Step 0 — the trap that will cost you an hour if you skip it

**MongoDB Atlas blocks connections from IPs it does not know.** Your laptop is allow-listed
because you added it during setup. Fly's machines are not, and Fly's egress addresses are
dynamic, so there is no single IP to add.

Atlas → your cluster → **Network Access** → Add IP Address → `0.0.0.0/0`.

This is not as reckless as it looks — the connection is still TLS and still needs the
password in `MONGODB_URI`. It is, however, not what you would do in production, and it is a
genuinely good candidate for the "one trade-off I am unsure about" box in DESIGN.md.

Symptom if you skip it: the gateway deploys fine and `/health` reports `db: "down"` or the
request just hangs.

## Step 1 — the agent (private)

```
flyctl auth login
flyctl apps create lumina-agent-sambhab          # pick your own unique name
flyctl secrets set -a lumina-agent-sambhab \
  ANTHROPIC_API_KEY=sk-ant-... \
  TAVILY_API_KEY=tvly-... \
  MONGODB_URI='mongodb+srv://...' \
  MONGODB_DB=lumina
flyctl deploy -c fly.agent.toml
```

Quote `MONGODB_URI` in single quotes — it contains `&` and your shell will otherwise eat it.

Edit `app` in `fly.agent.toml` to the name you created before deploying.

## Step 2 — PROVE the agent is not public (this is a red line)

```
flyctl ips list -a lumina-agent-sambhab      # must print NO public v4/v6 address
curl -sS --max-time 10 https://lumina-agent-sambhab.fly.dev/health   # must FAIL to connect
```

If an IP was allocated: `flyctl ips release <address> -a lumina-agent-sambhab`.

Do not skip this. A reachable agent is an automatic fail regardless of your score, because
the deep-search spend cap lives in the agent and a cap you can bypass is not a cap.

## Step 3 — the gateway (public)

```
flyctl apps create lumina-gateway-sambhab
flyctl deploy -c fly.gateway.toml
curl -sS https://lumina-gateway-sambhab.fly.dev/health
```

Before deploying, in `fly.gateway.toml`, set `AGENT_URL` to
`http://<your-agent-app-name>.internal:8000`. The `.internal` suffix is Fly's private
network; a typo here shows up as every request returning 502.

Expect `/health` to report `db: "ok"` and name `claude-sonnet-5 · tavily`. If `db` is
`down`, go back to Step 0.

Then check the submission route exists even with no report yet:

```
curl -sS -o /dev/null -w '%{http_code}\n' https://lumina-gateway-sambhab.fly.dev/evals/report.json
# 404 is CORRECT here. 401 would be a bug (the bench probes for exactly this).
```

## Step 4 — the UI on Vercel (this URL is your submission)

Vercel dashboard → New Project → import the repo, then:

| Setting | Value |
|---|---|
| Root Directory | `modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina` |
| Framework Preset | Vite (or Other) |
| Build/Install/Output | leave blank — `vercel.json` at that root sets all three |
| Env var | `VITE_API_URL` = `https://lumina-gateway-sambhab.fly.dev` |

`VITE_*` variables are baked in **at build time**, not read at runtime. If you add or change
`VITE_API_URL` after a build, you must **redeploy** or the browser will keep calling
localhost. This is the single most common "why is my deployed app broken" cause.

Why a root `vercel.json` and not `web/vercel.json`: `web/` is provided code that must stay
unmodified (red line 2), and the workspace needs `@lumina/contract` compiled before the UI
builds. The root file does both without touching `web/`.

## Step 5 — let the browser talk to the gateway

In `fly.gateway.toml`, add your Vercel URL to `CORS_ORIGINS`:

```
CORS_ORIGINS = "http://localhost:5173,https://your-app.vercel.app"
```

then `flyctl deploy -c fly.gateway.toml` again. Symptom if you forget: the UI loads, asks a
question, and fails in a way that looks like the API is down. It is CORS.

## Step 6 — the full benchmark, against the deployment

```
node benchmark/bench.mjs --target https://lumina-gateway-sambhab.fly.dev
```

~20 web queries, roughly **$1.20**. Run it ONCE; you have about $4 of credit. It will report
missed SLA targets (TTFT and cost) — that is expected and honest, not a crash.

This run is also what clears the **R2 red line**, which currently shows as crossed only
because `--smoke` never exercises deep search.

## Step 7 — a failing trajectory (the page requires one)

```
flyctl secrets set TAVILY_API_KEY=deliberately-broken -a lumina-agent-sambhab
# ask one question through the UI, then:
flyctl secrets set TAVILY_API_KEY=tvly-your-real-key -a lumina-agent-sambhab
```

Copy that run's log into `runs/failing/`. It must live in `runs/failing/`, NOT `runs/` —
a run that terminated with anything other than `done` sitting in `runs/` fails rule A2.

## Step 8 — build the report and redeploy

```
node quality/check.mjs .
node eval/build-report.mjs \
  --student "Sambhab Sau" \
  --design DESIGN.md \
  --successful <a requestId from runs/> \
  --failing <the requestId from runs/failing/> \
  --successful-notes "what reading this run end to end taught me" \
  --failing-notes "what reading the failing run taught me" \
  --video "https://youtu.be/..." 
flyctl deploy -c fly.gateway.toml
```

`--design DESIGN.md` will happily publish HTML comments as your answers — `build-report.mjs`
does not strip them, and it prints no warning. Write DESIGN.md first.

## Final check before you post the link

- [ ] `/` works in a fresh browser with no local services running
- [ ] `/evals` renders, and `/evals/report.json` returns JSON
- [ ] `flyctl ips list` on the AGENT shows no public address
- [ ] No key in the browser: open devtools → Sources, search the bundle for `sk-ant` and
      `mongodb+srv` → zero hits
- [ ] The design section on `/evals` is your prose, with no `<!-- PROMPT` visible
- [ ] Both trajectories render with notes
- [ ] The video is embedded and 60–90 seconds

## If you would rather deploy the gateway only once

Store the report in MongoDB instead of on disk: have `build-report.mjs`'s output upserted
into a `reports` collection and change `GET /evals/report.json` to read from there. Then
rebuilding the report needs no redeploy. ~20 minutes of code, and strictly better
operationally — I did not write it tonight because you were asleep and it is new logic you
should see being written.

## Not on Fly?

Render or Railway work the same way, with one caveat that matters: the agent must be a
**private service** (Render calls it a Private Service; it gets no public URL). If your host
cannot do that, it cannot satisfy the red line.
