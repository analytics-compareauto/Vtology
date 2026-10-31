# Vtology

The operational ontology for the acquisition-to-sales pipeline: Automotive OEMs, BFSI and FMCG.
Vtology takes exports from disconnected systems and works out who each person is. It follows every inquiry through its stages and flags the data that doesn't add up. Every fix goes through a governed action that is approved, logged and written back to the source system.

This is **v0.1, the core backend**. It runs for all three industries.

## What's in it

| Part | Where | What it does |
|---|---|---|
| Industry modules | `packages/core/src/modules.ts`, `supabase/migrations/…03_reference_data.sql` | Stages and SLA days for each industry, plus the six roles |
| Import & mapping | `packages/core/src/mapping.ts`, `packages/server/src/imports.ts` | Maps any CSV to the canonical fields, with errors per row. Phone, email and gov ID are hashed with a per-tenant salt |
| Identity resolution | `packages/core/src/identity.ts` | Deterministic matches on hashes; Jaro-Winkler matching within a pincode; merges at ≥0.94, sends ≥0.85 to review. Conflicting gov IDs never merge. A number shared by more than 3 names is held for review |
| Pipeline | `packages/server/src/pipeline.ts` | Resolves identities, keeps party ids stable across runs, links journeys, sales and consents, then runs the detectors |
| Detectors | `packages/core/src/rules.ts` | Phantom conversions, orphan transactions, unattributed spend, idle partners, shared identifiers |
| Actions | `packages/core/src/actions.ts`, `packages/server/src/actions.ts` | Reassign, escalate, merge, keep separate, hold payout, withdraw consent. Each action has rules, an approver role, edits kept apart from source data, and outbox writeback |
| Security | `supabase/migrations/…02_security.sql`, `…04_person_links.sql` | Row-level security for every role, masked names for marketing and finance, money visible only to marketing and finance, and an audit trigger |
| API | `packages/server/src/router.ts`, `apps/web/app/api/[...path]/route.ts` | A JSON API that runs on Vercel |

Source records are never changed. Human corrections live in `vt.edits` and are merged into `vt.journeys_current`.

## Run the tests

```bash
npm install
npm test          # 19 tests, on an in-memory Postgres 17 (PGlite) with a Supabase shim
npm run typecheck
```

## Set up for real

1. **Supabase**: create a project in South Asia (Mumbai). Paste `supabase/setup_all.sql` into the SQL editor and run it (choose "Run without RLS": the file enables RLS itself).
2. **First tenant**: sign up a user under Authentication. Then run `supabase/bootstrap.sql` with your values.
3. **Vercel**: import this repo and set the root directory to `apps/web`. Add `DATABASE_URL` and `SUPABASE_URL` as shown in `.env.example` (`SUPABASE_JWT_SECRET` only for projects on the legacy HS256 secret).
4. **Call it**: sign in with Supabase Auth on the client and send `Authorization: Bearer <access_token>`.

## API

All routes except `/api/health` need a Supabase access token. Each route checks the caller's role in that tenant.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/health` | anyone | |
| GET | `/api/tenants/:t/me` | members | |
| POST | `/api/tenants/:t/imports` | data_steward, marketing_head | `{ mapping: { entity, sourceSystem, fields }, csv, fileName? }` |
| POST | `/api/tenants/:t/pipeline/run` | data_steward, marketing_head, sales_ops | |
| GET | `/api/tenants/:t/journeys?stalled=true` | members, each limited to their own view | |
| GET | `/api/tenants/:t/partners` | members | |
| GET | `/api/tenants/:t/violations` | members (value hidden without money access) | |
| GET | `/api/tenants/:t/actions` | members | |
| POST | `/api/tenants/:t/actions` | depends on the action | `{ type, objectId, newPartnerId?, reason? }` |
| POST | `/api/tenants/:t/actions/:id/approve` · `/reject` | the action's approver role | |

`entity` is one of `lead`, `journey_event`, `transaction`, `campaign`, `partner` or `consent`. `fields` maps each canonical field to a column name, or to `{ column, transform, default }`.

Example mapping for a dealer CRM lead export:

```json
{ "entity": "lead", "sourceSystem": "dealer_crm",
  "fields": { "external_id": "Lead ID", "name": "Customer Name", "phone": "Mobile",
              "pincode": "PIN", "created_at": { "column": "Created On", "transform": "date" } } }
```

## Principles built in

- Consent is checked under DPDP, and withdrawing consent is itself a governed action.
- Only hashed identifiers leave the engine.
- No scraping of personal profiles, and no inference of sensitive traits.
- People see only what their role allows. This is enforced in the database, not only in the UI.

## Next milestones

1. Connect the console prototype to this API.
2. Put the revenue engine (segments, plays, uplift arbitration, holdouts) on the database.
3. Add connectors, replacing CSV exports with scheduled pulls.
