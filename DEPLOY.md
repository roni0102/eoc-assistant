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

> **Plan note:** persistent disks need a paid plan (≥ Starter). On the free plan, drop the
> `disk:` block — the app still runs, but `leads.jsonl` / `qa_log.jsonl` reset on each redeploy
> (point `addLead()` at a CRM/DB instead if you go that route).

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
