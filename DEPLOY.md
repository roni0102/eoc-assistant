# Deploying the EOC Assistant (Render)

This is a persistent Node/Express server, so it needs a Node host, not static hosting.
`render.yaml` makes it a one-click Blueprint deploy.

## 1. Put the code on GitHub
From `ITL/eoc-assistant`:

```bash
git init
git add .
git commit -m "EOC Assistant"
git branch -M main
git remote add origin https://github.com/<you>/eoc-assistant.git
git push -u origin main
```

`.env`, `node_modules/`, `data/leads.jsonl`, and `data/qa_log.jsonl` are gitignored — **no
secrets or PII are committed**. `data/kb.json` and `data/standard.json` (the built knowledge
base, ~1.3 MB each) **are** committed — the server reads them at runtime, so they must ship.

## 2. Deploy on Render
1. [render.com](https://render.com) → **New + → Blueprint** → connect your GitHub repo.
2. Render reads `render.yaml` and creates the web service + a 1 GB persistent disk.
3. When prompted, set the secret env vars:
   - `ANTHROPIC_API_KEY` — **required** (the LLM). Use a freshly rotated key.
   - `LEADS_ADMIN_KEY` — required to download the leads CSV at `/leads/export?key=…`.
   - `PREMIUM_LICENSE_KEYS` — optional; comma-separated keys. Leave blank to keep premium open.
   - `EOC_MODEL` — optional; defaults to `claude-opus-4-8`.
4. Deploy. Your site is at `https://eoc-assistant.onrender.com` (or your custom domain).

## 2a. Make data durable — persistent disk (DO THIS BEFORE GOING LIVE WITH PAYMENTS)

All runtime state is written under **`DATA_DIR`** (default `./data`). On the **free** plan there is
no persistent disk, so every redeploy/restart **wipes** these six files:

| File | What it holds | Why it matters |
|---|---|---|
| `entitlements.json` | paid access (subscriptions, review/consult credits) | **paying customers lose access on each deploy** ⚠️ |
| `pending_payments.json` | in-flight payment → entitlement mapping | a payment mid-flight could miss its grant |
| `usage.json` | per-email free-question cap | the 5-question cap resets |
| `sessions.json` | active gate tokens | users have to re-enter their details |
| `leads.jsonl` | captured leads | *(also mirrored to your Google Sheet, so safe)* |
| `qa_log.jsonl` | the anonymized shared-Q&A / newsletter history | the FAQ can't grow |

**Set this up before turning on Morning payments**, so paid entitlements persist from day one.

**Steps (existing service, in the Render dashboard):**
1. **eoc-assistant → Settings → Instance Type →** upgrade to **Starter** (disks require a paid
   instance; ~$7/mo, and it stays always-on instead of sleeping).
2. **eoc-assistant → Disks → Add Disk:**
   - **Name:** `data`  ·  **Mount Path:** `/var/data`  ·  **Size:** `1 GB`
3. **eoc-assistant → Environment →** add `DATA_DIR = /var/data`.
4. **Save** → the service redeploys with the disk mounted. From then on everything persists at
   `/var/data/{entitlements,pending_payments,usage,sessions}.json` + `{leads,qa_log}.jsonl`.

**Notes**
- A service with a disk runs as a **single instance** (no horizontal autoscaling) — fine here.
- Free-tier data isn't migrated, but nothing critical is lost: leads/expert/consent/bug already
  mirror to your Google Sheet, and there are no real paid entitlements yet — which is exactly why
  **now** (pre-launch) is the moment to switch.
- `render.yaml` has a ready **starter + disk + DATA_DIR** block (commented) — uncomment it if you
  prefer to manage the plan from the Blueprint instead of the dashboard.
- To revert: remove the disk + `DATA_DIR` (back to ephemeral free).

## 3. Updating the knowledge base
`build:kb` / `build:standard` read the source EOC archive and the SI 6464 PDFs, which live on
your machine — so refresh the KB **locally**, then commit and push the updated artifacts:

```bash
npm run build:kb          # re-ingest completed works  -> data/kb.json
npm run build:standard    # re-extract SI 6464          -> data/standard.json
npm run test:anon         # anonymity gate must pass
git commit -am "Refresh KB" && git push   # Render auto-redeploys
```

The running server never touches the raw archive — only these two JSON artifacts.

## Health & ops
- `GET /healthz` — liveness (Render uses it).
- Leads CSV: `GET /leads/export?key=$LEADS_ADMIN_KEY`.
- The Anthropic key stays server-side; the browser never sees it.
