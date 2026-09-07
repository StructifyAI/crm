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

Rules for this branch:

- To pick up a new upstream release: `git fetch upstream && git checkout structify/release
  && git merge upstream/release`. Resolve conflicts in favour of upstream unless the two
  commits above are not yet in the release.
- When upstream ships both fixes, delete `structify/release`, point the deployment back at
  `release`, and remove this section.
- Do not add other local changes here. Send them upstream first.
