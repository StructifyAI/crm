# LinkedIn Ads

The LinkedIn Advertising API, REST, `LinkedIn-Version` set in
`src/linkedin-ads/linkedin-ads-config.ts`. Ad account `560505488` only.

## Rules

- API only. No browser automation of linkedin.com or Campaign Manager.
- Alex's member token only.
- Every campaign group, campaign and creative is created as `DRAFT`. Alex
  activates campaigns and changes budgets in Campaign Manager. The spec caps
  `dailyBudgetUsd` at 25.
- Aggregate campaign analytics only. No member-level data is read, stored or
  logged, and no LinkedIn data goes to an LLM or back into the CRM.

## Environment

`LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ACCESS_TOKEN`. See
`.env.example`. The token expires 60 days after it is issued.

## Draft a campaign

```sh
bun scripts/linkedin-ads.ts create linkedin-ads/use-case-catalog.yaml
```

Creates one campaign group, one campaign and one single-image creative from the
YAML spec. Targeting values are LinkedIn URNs; look them up with
`/rest/adTargetingEntities`. The image path is relative to the spec file.

## Check the token

```sh
bun scripts/linkedin-ads.ts token
```

## Daily report

`GET /internal/sync/linkedin-ads`, daily at 08:00 UTC. It upserts the last 7
days of impressions, clicks, spend and website conversions per campaign into
`linkedinAdsCampaignDay`. It also introspects the token and sends a Slack DM to
`LINKEDIN_ADS.token.alertSlackEmail` every day from 7 days before expiry.

## Company lists

```sh
bun scripts/linkedin-ads.ts lists ./out
```

Writes `linkedin-target-companies.csv` (ICP companies with no closed-won deal)
and `linkedin-customer-exclusions.csv` (companies with a closed-won deal) in
LinkedIn's company list template. API upload needs the `rw_dmp_segments`
scope, which comes with LinkedIn's Audiences product. Until the app has it,
upload the CSVs in Campaign Manager → Audiences → Create → Company list.

Contact list uploads are not built. They stay off until the privacy policy
update is confirmed.
