# Vtology roadmap

Vtology is a product for any brand, in any category: the brand lets us analyse its data and social
accounts and gets one connected picture, from ad or post to lead, partner (dealer, branch,
distributor) and sale. Everything built for one brand (CompareAuto was the first) must work for all.

## Next: one connection layer for any source
All sources feed the same model (people, journeys and stages, partners, campaigns, sales, consents),
with a saved per-brand field mapping ("their 'Car Booked' = our 'Booking'").

- Files: CSV (done), Excel, JSON; uploaded or scheduled.
- Pull from a database: read-only Postgres / MySQL with a saved query.
- Pull from an API: any JSON API with the brand's key, paged, scheduled (hourly/daily).
  First source: the CompareAuto dealer dashboard (leads, statuses, call outcomes, test drives,
  timestamped activity history; Meta campaign IDs on most leads).
- Push to Vtology: a private per-brand ingest address for CRMs, DMS, MMPs (AppsFlyer, Adjust,
  Branch postbacks) and DMPs.
- Ready-made connectors over time: Salesforce, HubSpot, Zoho, LeadSquared, Google Ads, Meta Ads, AppsFlyer.
- Mapping screen for every source (not only CSV), reused on every sync.

## Then
- Categories as templates, not fixed: brands adjust stages, time limits and content themes
  (real estate, education, healthcare, D2C, ...).
- Consent tracking aligned with India's DPDP Act 2023.
- Social: LinkedIn once access is approved; Facebook competitors need Meta's Page Public Content Access.
