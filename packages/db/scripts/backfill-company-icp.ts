// Usage: bun packages/db/scripts/backfill-company-icp.ts [--dry] [--out file.csv]
import { writeFile } from "node:fs/promises";
import { db } from "../src/client";
import { recomputeCompanyIcp } from "../src/company-icp";

const args = process.argv.slice(2);
let dry = false;
let out: string | undefined;
for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (arg === "--dry") {
		dry = true;
		continue;
	}
	if (arg === "--out") {
		out = args[index + 1];
		if (!out) throw new Error("--out needs a file path.");
		index += 1;
		continue;
	}
	throw new Error("Use --dry and --out file.csv.");
}

const quote = (value: string | number | null) => {
	const text = value === null ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

try {
	const changes = await recomputeCompanyIcp(db, { archivedAt: null }, { dry });
	const file = out ?? `company-icp-changes-${new Date().toISOString()}.csv`;
	const csv = [
		"id,name,old_icp,new_icp,naics,employee_range,employee_count,country_code,country",
		...changes.map((change) =>
			[
				change.id,
				change.name,
				change.oldIcp,
				change.newIcp,
				change.naics,
				change.employeeRange,
				change.employeeCount,
				change.countryCode,
				change.country,
			]
				.map(quote)
				.join(","),
		),
	].join("\n");

	await writeFile(file, `${csv}\n`, "utf8");
	const distribution = await db.company.groupBy({
		by: ["icp"],
		where: { archivedAt: null },
		_count: { _all: true },
	});

	console.log(`Changed ${changes.length} companies.`);
	console.log(`CSV: ${file}`);
	console.log(
		"Distribution:",
		Object.fromEntries(
			distribution.map((group) => [group.icp, group._count._all]),
		),
	);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await db.$disconnect();
}
