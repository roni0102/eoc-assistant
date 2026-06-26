# ITL EOC Assistant

Anonymous answer engine for clients filling out an **EOC** (Evaluation of Conformity) under
Israeli Standard **SI 6464 (2017)**.

**The product is corpus experience, not a checklist lookup.** For each SI 6464 **clause**, the
KB aggregates the **real client answers and IB comments mined from the whole archive of past
filled EOCs** — anonymized — into frequency-ranked patterns (e.g. *"Item closed" — 43 projects*).
The clause requirement is only scaffolding (demoted to a collapsible section in the UI).

Built from the **real ITL archive** (full SI 6464 Inspection Report format, keyed by clause).
Current KB = **all completed works: 49 projects, 76 EOC files, 407 clauses** (359 with accepted
replies, 351 with IB patterns). Lead-capture gate and premium full-review engine not built yet.

## What's here

| File | Purpose | Deliverable |
|------|---------|-------------|
| `src/anonymize.mjs` | Anonymity core: static blocklist + `scrubWith()` (dynamic per-project names) + structural patterns (codes, dates, backslash paths, emails, phones). `scan()` gate is **stricter than scrub**. | core |
| `src/archive.mjs` | Real-archive discovery: `discoverCompleted()` (latest-rev EOC per project) + `harvestIdentifiers()` (mines each project's PII from its Header sheet — never ingested). | #1 |
| `src/build_kb.mjs` | Clause-keyed aggregation: 2-pass (global identifier harvest → ingest), reads each Report Body, clusters client answers + dated IB comments per clause with frequency. | #1, #2 |
| `data/kb.json` | KB artifact: 407 clauses, each with `accepted_reply_patterns` / `ib_interaction_patterns` / `common_pitfalls` / `corpus_count`. | #2 |
| `src/anonymity_scan.mjs` | Automated gate — scans the KB, **exits non-zero on any identifier**. | #3 |
| `src/audit.mjs` | Independent residual-leak sweep (paths/dates/codes) over all corpus strings + sample cards. | — |
| `src/retrieve.mjs` | Retrieval: clause fast-path (exact + prefix) + bilingual (EN/HE) lexical search. | #4 |
| `src/answer.mjs` | Composes the anonymous answer card; **anonymity guard fails closed**. LLM phrasing abstracted (runs with no key today). | #4 |
| `src/qalog.mjs` | Persistent **anonymized** Q&A log — records each free-tier question+answer (question scrubbed first) so it can be shared with other clients. | shared FAQ |
| `src/leads.mjs` | Lead store — captures the visitor's email + phone + company + timestamp + tier; issues the session token; CSV export. | #6 |
| `src/server.mjs` | Express backend: `POST /lead`, gated `POST /ask` / `POST /review`, `GET /qa/recent`, `GET /leads/export`, serves the UI. | #4, #6 |
| `src/eoc.mjs` | Read/write an uploaded EOC workbook (ExcelJS) — Node port of the eoc-fill skill's column map + ping-pong logic + colour-coded output. | premium |
| `src/review.mjs` | Premium review engine: runs the eoc-fill methodology via Claude, grounded in corpus + standard, → per-row verdict/remark/predicted-IB/fix. | premium |
| `public/index.html` | Chat UI (free) + premium EOC-review tab, RTL-aware for Hebrew. | #5 |
| `src/corpus.mjs`, `src/inspect.mjs`, `src/inspect2.mjs` | Dev helpers (structure probe / xlsx dumpers). | — |

## Run

```bash
npm install            # SheetJS + express + @anthropic-ai/sdk + dotenv + pdf-parse + mammoth
cp .env.example .env     # then put your Anthropic key in .env (see "Connecting the LLM")
npm run build:kb         # ingest ALL completed works   -> data/kb.json   (slow: reads the archive over Dropbox)
npm run build:kb -- 8    # quick pilot: first 8 projects only
npm run build:standard   # extract SI 6464 standard + amendments -> data/standard.json
npm run test:anon        # anonymity gate (CI must fail the build if this fails)
node src/audit.mjs       # independent residual-leak sweep + sample cards
npm start                # backend + UI on http://localhost:3000
```

Node 18+ (developed on v24). **No Python required** (Node + SheetJS in place of the brief's
Python option). The archive root is `ARCHIVE_ROOT` in `src/archive.mjs`.

## Connecting the LLM

The assistant is **an LLM connected to two grounding sources + a web UI.** At query time the
backend retrieves, and Claude answers from, **both**:
- **STANDARD** — verbatim SI 6464 (2017) text + amendments + ITL clarification memos, indexed in
  `data/standard.json` by `npm run build:standard` (from the standard folder set as
  `STANDARD_ROOT` in `src/build_standard.mjs`). Authoritative for *what the clause requires*; the
  answer cites the clause number.
- **CORPUS** — the anonymized resolved history in `data/kb.json` (the past-EOC database).
  Authoritative for *how the item is actually answered* and *what the IB does*. Covers **Piping
  (Ch.7)** and **IAA gas appliances (Ch.4–6 + appliance-specific chapters)**. Each clause is
  tagged with an **appliance breakdown** (`appliance_breakdown`: which appliance types observed
  it, and in how many projects) derived from each EOC's file path — steam boiler, boiler,
  furnace, water heater, dryer, gas turbine, engine, thermal oil heater, thermal oxidizer (RTO),
  etc. When the client names an appliance, retrieval boosts that appliance's clauses and the LLM
  tailors the answer to it.

The standard is public reference (no client identifiers — verified) and is indexed verbatim;
the corpus is anonymized. Claude's output still passes the fail-closed anonymity guard.

- **Where the key goes:** put `ANTHROPIC_API_KEY=sk-ant-...` in `.env` (gitignored) — or set it
  as an environment variable. That's the only step to turn the LLM on. The key stays server-side
  (`src/llm.mjs`), never reaching the browser.
- **Model:** default `claude-opus-4-8`; override with `EOC_MODEL` in `.env`
  (e.g. `claude-sonnet-4-6` or `claude-haiku-4-5` for lower cost/latency).
- **Conversational** — the client can ask follow-ups; the browser holds the thread and posts it
  as `history` with each `/ask`, so Claude remembers prior turns. The backend stays stateless and
  blends the previous question into retrieval so context-dependent follow-ups ("and what does the
  IB ask for?", "is it different for a steam boiler?") stay on-topic. Each answer is still guarded.
- **Without a key:** `/ask` falls back to the deterministic cards — the app still runs.
- **Anonymity is preserved by construction:** Claude only ever sees the **already-anonymized**
  records (never raw client files), and its output is re-scanned by the same fail-closed guard.
- The startup log prints `LLM ON (model)` or `LLM OFF (set ANTHROPIC_API_KEY)`.

## How `/ask` works

`POST /ask {"q": "7.2.1.5"}` (or a free-text EN/HE question) →
1. **retrieve** — exact clause match, else clause-prefix (`7.2` → all `7.2.x`), else bilingual
   lexical scoring. A compact EN↔HE alias map bridges Hebrew queries (a *stopgap* until
   embeddings / an LLM pass — see `retrieve.mjs`).
2. **compose** — corpus-first card: **how the clause is actually answered** (frequency-ranked
   accepted patterns) → **IB comments seen & how they close** → common pitfalls → requirement
   (collapsible scaffold) → standing disclaimer.
3. **guard** — `scan()` runs on the outgoing answer; any identifier ⇒ withheld (HTTP 500,
   fail-closed). Code-generated fields (`clause`, `source_refs`, echoed `query`) are skipped —
   SI 6464 clause numbers like `7.2.1.10` look like dates but carry no client info.

The LLM is abstracted in `answer.mjs` (`composeAnswer` is deterministic today). With an
`ANTHROPIC_API_KEY`, the optional phrasing pass goes there — grounded in the retrieved record,
passing the same guard.

## Source data (read-only — never modified)

Real ITL archive (set via `ARCHIVE_ROOT` in `src/archive.mjs`):
`…\CH4 eng & consultants\ITL\פרוייקטים\2. עבודות גמורות\G 1. Customer\<PROJECT>\3. EOCs\`.

- **Format = full SI 6464 Inspection Report** (multi-sheet workbook):
  - `Header` sheet — concentrates the PII (Project Title, Client's participants name+phone,
    signer, EOC ref, address). **Harvested for the blocklist, never ingested into the KB.**
  - `Report Body` sheet — the EOC, keyed by **clause** (col A: `7.x` Piping, `4–6.x` IAA):
    `B`=Requirement (scaffold), `D`=Results/Remarks (client answer), `E`=Verdict, and one or
    more dated `Comments ITL` columns (the IB rounds).
- **Coverage** — per project, the **latest-revision** file in each leaf folder is taken (it
  carries the full dated-comment history). Each project votes **once per clause**, so revisions
  don't inflate frequency. Renewal-checklist files (no `Report Body` sheet) are skipped (26 of
  102 discovered) — they're the next format to fold in. Clause numbering is the stable
  cross-project key.

## The anonymity guarantee (how it's enforced end-to-end)

1. **The PII-bearing `Header` sheet is never ingested** — it's only *mined* for identifiers.
2. **Auto-derived, per-project + global identifiers.** Pass 1 harvests a **global** identifier
   set from every project's Header sheet (Project Title / Applicant / Client's participants) +
   folder name, filtered by a generic stoplist. Pass 2 scrubs each file with `scrubWith()` =
   that project's names ∪ the global set. The global union catches a name that's a participant
   in one project but appears in another project's prose (this is what eliminated an "Ido" leak).
3. **`scrubWith()` then applies** the static blocklist (recurring orgs like PAZGAS, the ITL
   signers) + structural patterns → placeholders: doc codes (`BTN-BPD-001`, `CAL-003/004`),
   EOC refs, **backslash file paths**, **dates** (`14.04.15`, `050814`), emails, phones. (Forward
   slashes are left alone — they're legitimate notation here, not paths.) Patterns left as
   mostly-placeholder are dropped (better signal, less leak surface).
4. **The gate is stricter than the scrubber.** `anonymity_scan.mjs` adds INDEPENDENT structural
   detectors (backslash, date-like, code-like). If `scrub()` ever has a gap, the gate still
   fires → non-zero exit → CI fails. `audit.mjs` is a second independent sweep. The backend runs
   the same `scan()` on every generated answer (fail-closed). All three are clean on the full KB
   (49 projects, ~32k strings): 0 identifiers, 0 known client tokens (BTG / PAZGAS / Tambour / …).

> **Known limitation (honest):** structural identifiers and any name present in a project's
> Header are handled. A given-name that appears ONLY in free prose (never in any Header) can
> still slip through — full coverage needs an **NER/LLM pass** (the documented next hardening
> step, deferred per the chosen "no-LLM-yet" approach). Add recurring cross-project orgs to the
> static blocklist in `anonymize.mjs` as needed.

## Adding more projects / scaling

Ingestion auto-discovers completed works and ingests **all** of them by default
(`npm run build:kb`); `-- N` limits to the first N projects for a quick pilot. To widen scope:
point `discoverCompleted()` at other roots (e.g. `3. עבודות תקועות` for live in-progress IB
comments), re-run, and confirm `test:anon` + `node src/audit.mjs` are clean. Cross-project
frequency is real here (full-report IB comments are standardized: e.g. *"Item closed"* appears
in dozens of projects), because items align on a shared **clause key**, not free-text matching.

## Lead-capture entry gate (#6)

The first thing every visitor sees is a **gate screen** — they can't reach the search bar,
ask, or upload until they submit **company + work email + phone** (validated: real email,
plausible phone, non-empty company). On submit, `POST /lead` stores the lead to
`data/leads.jsonl` (`{ts, company, email, phone, tier}`) and returns a **session token**.
- **Enforced server-side:** `/ask` and `/review` require the token (`requireGate`), so the
  gate can't be bypassed by hitting the API. A 401 `{gate:true}` re-opens the gate client-side.
- **Tier tracking:** leads start `tier:"free"`; a premium review marks that lead `premium`.
- **Export:** `GET /leads/export?key=…` returns a CSV, protected by `LEADS_ADMIN_KEY`
  (disabled with 403 if unset). Swap `addLead()` for a CRM hook to push leads elsewhere.
- **This is not the anonymity rule** — it captures the *present* visitor's own details (the
  business goal). The anonymity rule protects *past* clients in the knowledge base; the two are
  separate. Consent line shown on the gate; `data/leads.jsonl` is gitignored runtime data.

## Shared Q&A (a growing, anonymized FAQ)

Every answered free-tier question is recorded to `data/qa_log.jsonl` and shown to other
clients in the **"Questions other clients have asked"** panel (`GET /qa/recent`, or
`?q=` to search). Because a question may contain the *asker's own* client/site name, the
question is **`scrub()`-ed before it is stored** (e.g. *"…for the PAZGAS site, contact
052-1234567?"* → *"…for the [redacted] site, contact [phone]?"*); the answer is already
anonymous (it passed the answer guard, and is re-checked before storage). Premium EOC
uploads are **never** logged here. `qa_log.jsonl` is runtime data (gitignored).

> Residual: a brand-new client/site name in a free-text question that isn't in the
> blocklist relies on the structural scrubber only — the same NER limitation documented
> above; an LLM/NER pass on the stored question would close it fully.

## Premium — full EOC review (the eoc-fill engine, server-side)

`POST /review` (multipart, field `eoc` = the client's filled `.xlsx`) → an ITL-style
line-by-line audit. It is the bundled **eoc-fill** skill running server-side:
- `src/eoc.mjs` reads the Report Body with the skill's fixed column map (A clause · B
  requirement · C client doc · D ITL remarks · E verdict · F path · G+ ping-pong
  client/ITL) and detects EOC type (Piping / IAA).
- `src/review.mjs` sends each answered row to Claude under the eoc-fill methodology
  (PASS / N/A / AT_RISK / FAIL, house-style col-D and ping-pong reply formats, cite the
  clause only for AT_RISK/FAIL), grounded in the **anonymized corpus** (how the IB
  resolved this clause before) + the **SI 6464 standard** text. Output per row: verdict,
  ITL remark, the IB comment likely to come back, and a suggested fix.
- Returns a scoreboard (Pass / At-risk / Fail / N/A / Missing) + per-row cards, and a
  one-time download token for the **colour-coded annotated `.xlsx`** (PASS green / FAILED
  red / N/A yellow) written back via `eoc.writeEOC`.

**Privacy:** the uploaded EOC is processed **in memory only** — never written to disk,
never added to the knowledge base. The report is for that client about their own file, so
their own document names appear (not scrubbed); the grounding it's checked against is
anonymized, so no past client is exposed. **Gate:** `premiumOk()` checks
`PREMIUM_LICENSE_KEYS` (fallback when Grow billing is off); open in dev mode when unset.

## Not yet built (next milestones)

- Lead-capture gate (email + phone + company, validated) that blocks the app until submitted,
  and the leads store (Deliverable #6).
- NER/LLM anonymization pass for free-prose identifiers (beyond the structural + harvested layer).
- Semantic clustering (embeddings / LLM) to merge EN/HE paraphrases of the same answer (lexical
  clustering already yields strong frequencies on the standardized IB comments).
- Fold in the renewal-checklist-format EOCs (the 26 skipped files) and the in-progress works.
- Finalize the Grow/Meshulam payment adapter against their live API (see GROW_SETUP.md).
- Deploy to a public URL (currently runs on localhost).
- Multimodal upload on the free tier (screenshot / PDF), processed in memory only.
