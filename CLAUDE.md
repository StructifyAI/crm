@AGENTS.md

## Structify fork: interim branch `structify/release`

This repository is a mirror of `trycompai/crm`. `release` and `main` stay identical to
upstream. Do not commit fixes to them.

`structify/release` is the branch crm.structify.ai deploys. It is upstream `release` plus
two commits that are submitted upstream and not yet released:

- `fix(api): resume calendar listing across ticks instead of restarting from page one` —
  `MailboxSync.resume` column + migration `calendar_sync_resume`; the calendar sync
  persists its page token so busy calendars finish a full pass.
- `feat(api): attach synced meetings to the company's only open deal` — synced
  `MEETING` activities get a `dealId` when the company has exactly one open deal.
- `feat(api): sync Granola meeting notes onto meetings` — `GRANOLA_API_KEY`, cron
  `/internal/sync/granola`, migrations `granola_sync` and `granola_sync_resume`.
- `feat: add Instantly connection with campaign sync and mailbox owner mapping` —
  `INSTANTLY` record source, `InstantlyMailbox`/`InstantlyCampaignLead`, cron
  `/internal/sync/instantly`, migrations `instantly_connection` and
  `instantly_backfill`.
- `feat(api,app): extrovert connection` — `EXTROVERT` record source,
  `ExtrovertMember`/`ExtrovertProspect`, webhook `/api/extrovert/events/:secret`, cron
  `/internal/sync/extrovert`, migrations `extrovert_connection` and `extrovert_v2_sync`.
- Extrovert engagement sync uses migration `extrovert_engagement_sync`.
- `fix(api): match every word of a contact or company search` — search splits on
  whitespace; every word must match a field.
- `fix(api): read function crons from vercel.json` — `build-func.mjs` emitted a
  hardcoded single cron, dropping rates, telemetry, retention and prune crons in
  production. Replaces the deleted `structify-crons` branch.
- `feat(db,app): add an Engaged deal stage before Demo booked` — `ENGAGED` value on
  `DealStage`, migration `deal_stage_engaged`; first open stage in the stepper, pipeline
  chart and filters.
- `feat(db,app): add an In PoC deal stage after Qualified to buy` — `IN_POC` value on
  `DealStage`, migration `deal_stage_in_poc`; open stage between `QUALIFIED_TO_BUY` and
  `DECISION_MAKER_BOUGHT_IN` in the stepper, pipeline chart and filters. Migration
  `deal_default_engaged` makes `ENGAGED` the default stage for new deals.
- `feat: triage inbox counterparties through the agent before the sync files them` —
  agent route `/internal/crm/triage-email`; a `spam` verdict creates no company or
  contact and writes a `suppressedDomain` row. Needs `AGENT_URL` and
  `AGENT_BRIDGE_SECRET` on the API.
- `fix(api): share one tick deadline so a slow calendar cannot starve the mailbox sync` —
  `SYNC_TICK` deadline flows from `runDue` into calendar, Gmail, Outlook and triage.
- `fix(api): file Instantly replies without a campaign id and make the pre-push gates
  pass`.
- `feat: file every synced email on the open deal the agent says it belongs to` —
  agent route `/internal/crm/link-deal`; the API sets `Activity.dealId` only to an id it
  offered. Backfill: `GET /internal/sync/deal-links?cursor=…` with the cron secret.
- `feat: show the agent who each synced email was sent to when it files the thread on a
  deal` — `@crm/validation/email-recipients` parses stored recipients once for the
  conversation view and the deal-link request.
- `feat(api): file Instantly sends and bounces on the contact, company, and open deal` —
  `email_sent` files an `EMAIL` activity deduped on `email_id`; bounces and unsubscribes
  mark the campaign lead and file a `NOTE`.
- `feat(api): poll Instantly sent emails onto the timeline and backfill history` — cron
  `/internal/sync/instantly-emails` reads `GET /api/v2/emails?email_type=sent`, migrations
  `instantly_email_sync` and `instantly_email_sync_lease` and
  `instantly_reply_sync`.

Rules for this branch:

- To pick up a new upstream release: `git fetch upstream && git checkout structify/release
  && git merge upstream/release`. Resolve conflicts in favour of upstream unless the two
  commits above are not yet in the release.
- When upstream ships both fixes, delete `structify/release`, point the deployment back at
  `release`, and remove this section.
- Do not add other local changes here. Send them upstream first.
