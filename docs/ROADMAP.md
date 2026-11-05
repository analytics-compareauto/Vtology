# Vtology roadmap

Vtology is a revenue engine for any brand, in any category. The brand lets us read its data and
social accounts. In return it gets one connected picture, from ad or post to lead, partner (dealer,
branch, distributor) and sale. It also learns who to target, what to offer and where to spend, and
every result is proved against a holdout. Everything built for one brand (CompareAuto was the first)
must work for all of them.

The full plan, with the reasoning behind each decision, is kept in the master notes:
https://claude.ai/artifact/DGobpcFRJ6nT2gq9AeG9d7

## The layers

1. **Connect.** One connection layer for any source: CSV, lead feeds (dealer dashboards, DMS, CRM),
   social accounts, hashed audience lists. Later: databases, any JSON API, a push address for MMPs,
   DMPs and CRMs, and ready-made connectors.
2. **Understand.** The ontology: people, journeys and stages, partners, campaigns, sales and consents.
   It adds identity resolution, detectors and governed actions, plus social and growth intelligence.
3. **Decide.** Audiences: lists, buckets, propensity scores and a holdout on every bucket.
4. **Activate.** Buckets go to the brand's own DV360 or Meta (Customer Match), or to TeCreo's curated
   PMP deals as a segment ID. The agency only accepts a deal ID.
5. **Prove.** Buyers are matched back (in a clean room for large brands), and the targeted group is
   compared with the holdout. Cost per sale is reported for each channel, deal and publisher.

## The data firewall (non-negotiable)

- Identifiers are stored only hashed. Internal joins use a per-brand salt. Matching with outside
  partners uses a separate, standard SHA-256 match key. Nothing reads that key except the matching and
  export jobs: no dashboard and no database role.
- Vtology holds the brand's data and judges the results. TeCreo (the media seller) receives only a
  segment ID and the cost and KPI targets, never lists.
- Every upload expires on a set date. Every export is logged with who, what and how many.

## Build order

- **Now: audience layer.** Pre-hashed list upload (hashing in the browser for raw files), large
  files sent in chunks, list health, buckets with include/exclude lists and attribute rules, a holdout
  that never changes for a given person, lift against an uploaded list of buyers, and logged hashed
  exports for Customer Match or an SSP.
- **Next:**
  - DV360 audience connector, which needs Google API approval, so apply early.
  - A media and supply view: deal ID and publisher click macros, spend by deal and publisher, cost
    per lead, test drive and booking.
- **Then:**
  - Propensity scores trained on past outcomes.
  - An app-events connector (AppsFlyer, Adjust, Branch postbacks).
  - GA4 and Search Console.
  - A Vtology site tag.
  - Clean room partners: Ads Data Hub, AWS Clean Rooms (Mumbai).
- **Connections backlog:**
  - Excel and JSON files.
  - Read-only Postgres and MySQL.
  - Any JSON API.
  - A push ingest address.
  - Salesforce, HubSpot, Zoho, LeadSquared, Google Ads, Meta Ads.
- **Product backlog:**
  - Categories as editable templates (real estate, education, healthcare, D2C).
  - DPDP consent tracking.
  - LinkedIn.
  - Facebook competitors, which need Meta's Page Public Content Access.
