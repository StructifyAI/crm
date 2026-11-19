import { type Db, Prisma as PrismaNamespace } from "@crm/db";
import type { CompanyDomainBackfillRow } from "@crm/validation/company-domain-backfill";
import { Injectable } from "@nestjs/common";
import { normalizeDomain } from "../companies/domain";
import { InjectDatabase } from "../database/database.constants";

@Injectable()
export class CompanyDomainBackfillService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async backfill(rows: CompanyDomainBackfillRow[]): Promise<{
		updated: number;
		skipped: number;
	}> {
		const byCompany = new Map(rows.map((row) => [row.companyId, row]));
		const ids = [...byCompany.keys()];
		if (ids.length === 0) return { updated: 0, skipped: 0 };

		const companies = await this.db.company.findMany({
			where: { id: { in: ids }, archivedAt: null },
			select: { id: true, domain: true, website: true },
		});
		const byId = new Map(companies.map((company) => [company.id, company]));

		let skipped = 0;
		const writes: {
			id: string;
			domain: string;
			previousDomain: string | null;
			website: string;
		}[] = [];

		for (const id of ids) {
			const row = byCompany.get(id);
			const company = byId.get(id);
			if (!row || !company) {
				skipped += 1;
				continue;
			}

			const domain = normalizeDomain(row.domain);
			const previousDomain =
				row.previousDomain === null
					? null
					: normalizeDomain(row.previousDomain);
			const websiteDomain = normalizeDomain(row.website);
			const currentWebsiteDomain = normalizeDomain(company.website);

			if (
				!domain ||
				(row.previousDomain !== null && previousDomain === null) ||
				company.domain !== previousDomain ||
				websiteDomain !== domain ||
				!company.website ||
				currentWebsiteDomain !== domain
			) {
				skipped += 1;
				continue;
			}

			writes.push({
				id,
				domain,
				previousDomain,
				website: company.website,
			});
		}

		if (writes.length === 0) return { updated: 0, skipped };

		const domains = [...new Set(writes.map((write) => write.domain))];
		const taken = await this.db.company.findMany({
			where: { archivedAt: null, domain: { in: domains } },
			select: { id: true, domain: true },
		});
		const ownerByDomain = new Map(
			taken.flatMap((company) =>
				company.domain ? [[company.domain, company.id] as const] : [],
			),
		);

		let updated = 0;
		const seenDomains = new Set<string>();

		for (const write of writes) {
			const owner = ownerByDomain.get(write.domain);
			if ((owner && owner !== write.id) || seenDomains.has(write.domain)) {
				skipped += 1;
				continue;
			}
			seenDomains.add(write.domain);

			let result: { count: number };
			try {
				result = await this.db.company.updateMany({
					where: {
						id: write.id,
						domain: write.previousDomain,
						website: write.website,
						archivedAt: null,
					},
					data: { domain: write.domain },
				});
			} catch (cause) {
				if (
					cause instanceof PrismaNamespace.PrismaClientKnownRequestError &&
					cause.code === "P2002"
				) {
					skipped += 1;
					continue;
				}
				throw cause;
			}

			if (result.count === 1) updated += 1;
			else skipped += 1;
		}

		return { updated, skipped };
	}
}
