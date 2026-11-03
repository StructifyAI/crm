import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@crm/db";
import { parseLinkedinCampaignSpec } from "@crm/validation/linkedin-ads-api";
import { LinkedinAdsClient } from "../src/linkedin-ads/linkedin-ads.client";
import { LINKEDIN_ADS } from "../src/linkedin-ads/linkedin-ads-config";

const [command, specPath] = process.argv.slice(2);

function client(): LinkedinAdsClient {
	const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
	const clientId = process.env.LINKEDIN_CLIENT_ID;
	if (!accessToken || !clientId) {
		throw new Error("Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_CLIENT_ID.");
	}
	return new LinkedinAdsClient({
		accessToken,
		clientId,
		clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
	});
}

async function createDraft(path: string): Promise<void> {
	const file = resolve(path);
	const spec = parseLinkedinCampaignSpec(
		Bun.YAML.parse(await Bun.file(file).text()),
	);
	const linkedin = client();
	const start = new Date(Date.now() + LINKEDIN_ADS.reporting.dayMs);
	const group = await linkedin.createCampaignGroup(spec.campaignGroup, start);
	console.log(`campaign group ${group}`);
	const campaign = await linkedin.createCampaign(
		spec.campaign,
		`urn:li:sponsoredCampaignGroup:${group}`,
		start,
	);
	console.log(`campaign urn:li:sponsoredCampaign:${campaign}`);
	const image = await linkedin.uploadImage(
		spec.creative.organization,
		Bun.file(resolve(file, "..", spec.creative.imagePath)),
	);
	const creative = await linkedin.createCreative(
		spec.creative,
		`urn:li:sponsoredCampaign:${campaign}`,
		image,
	);
	console.log(`creative ${creative}`);
}

async function token(): Promise<void> {
	const result = await client().introspectToken();
	const expires = result.expires_at
		? new Date(result.expires_at * 1_000).toISOString()
		: "unknown";
	console.log(
		`active ${result.active}, scopes ${result.scope ?? ""}, expires ${expires}`,
	);
}

type CompanyRow = {
	name: string;
	domain: string | null;
	linkedinUrl: string | null;
};

function csv(rows: CompanyRow[]): string {
	const cell = (value: string | null) =>
		`"${(value ?? "").replaceAll('"', '""')}"`;
	return [
		"companyname,companywebsite,linkedincompanypageurl",
		...rows.map((row) =>
			[cell(row.name), cell(row.domain), cell(row.linkedinUrl)].join(","),
		),
	].join("\n");
}

async function exportLists(outDir: string): Promise<void> {
	const select = { name: true, domain: true, linkedinUrl: true };
	const customer = {
		deals: {
			some: { stage: LINKEDIN_ADS.lists.customerStage, archivedAt: null },
		},
	};
	const [targets, customers] = await Promise.all([
		db.company.findMany({
			where: {
				archivedAt: null,
				icp: LINKEDIN_ADS.lists.targetIcp,
				NOT: customer,
			},
			select,
			orderBy: { name: "asc" },
		}),
		db.company.findMany({
			where: { archivedAt: null, ...customer },
			select,
			orderBy: { name: "asc" },
		}),
	]);
	const dir = resolve(outDir);
	await mkdir(dir, { recursive: true });
	await Bun.write(resolve(dir, "linkedin-target-companies.csv"), csv(targets));
	await Bun.write(
		resolve(dir, "linkedin-customer-exclusions.csv"),
		csv(customers),
	);
	console.log(
		`targets ${targets.length}, customers ${customers.length}, written to ${dir}`,
	);
	await db.$disconnect();
}

if (command === "create" && specPath) await createDraft(specPath);
else if (command === "token") await token();
else if (command === "lists" && specPath) await exportLists(specPath);
else {
	console.error(
		"Usage: bun scripts/linkedin-ads.ts create <spec.yaml> | token | lists <out-dir>",
	);
	process.exit(1);
}
