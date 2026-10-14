import { EnrichmentStatus, type Prisma } from "@crm/db";
import { recomputeCompanyIcp } from "@crm/db/company-icp";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { EnrichmentLogService } from "../crm/enrichment-log.service";
import {
	domainFromEmail,
	domainLabel,
	isNearDomain,
	normalizeDomain,
} from "./domain";

type DomainCandidate = { id: string; domain: string };

@Injectable()
export class CompanyDirectoryService {
	private readonly logger = new Logger(CompanyDirectoryService.name);

	constructor(
		private readonly agent: AgentTriggerService,
		@Optional() private readonly enrichmentLog?: EnrichmentLogService,
	) {}

	async companyForEmail(
		email: string,
		options: { ownerId?: string | null; create?: boolean } = {},
	): Promise<string | null> {
		const domain = domainFromEmail(email);
		if (!domain) return null;
		if (options.create === false) {
			return this.agent.withCrmEvents(async (tx) => {
				const existing = await tx.company.findFirst({
					where: {
						archivedAt: null,
						OR: [{ domain }, { alternateDomains: { some: { domain } } }],
					},
					select: { id: true },
				});
				return existing?.id ?? null;
			});
		}

		const outcome = await this.agent.withCrmEvents(async (tx, emit) => {
			await lockIdempotencyKey(tx, `company-directory:${domain}`);
			const existing = await tx.company.findFirst({
				where: {
					archivedAt: null,
					OR: [{ domain }, { alternateDomains: { some: { domain } } }],
				},
				select: { id: true },
			});
			if (existing)
				return {
					id: existing.id,
					created: false as const,
					nearDomain: null,
				};

			const near = await this.nearDomainCompany(tx, domain);
			if (near) {
				await tx.companyDomain.upsert({
					where: {
						companyId_domain: { companyId: near.id, domain },
					},
					create: { companyId: near.id, domain, needsReview: true },
					update: { needsReview: true },
				});
				return {
					id: near.id,
					created: false as const,
					nearDomain: near.domain,
				};
			}

			const company = await tx.company.create({
				data: {
					name: domain,
					domain,
					website: `https://${domain}`,
					enrichmentStatus: EnrichmentStatus.PENDING,
					ownerId: options.ownerId ?? null,
				},
				select: { id: true, name: true, domain: true, createdAt: true },
			});
			await recomputeCompanyIcp(tx, { id: company.id });
			await emit({
				type: "company.created",
				record: { kind: "company", id: company.id },
				occurredAt: company.createdAt,
				data: { name: company.name, domain: company.domain },
			});
			return { id: company.id, created: true as const, nearDomain: null };
		});
		if (outcome.nearDomain) {
			await this.enrichmentLog?.record({
				companyId: outcome.id,
				subject: "Possible alternate company domain",
				body: `Added ${domain} as a possible alternate to ${outcome.nearDomain}. Review this domain.`,
				meta: {
					source: "company-directory",
					domain,
				},
			});
			this.logger.log({
				message: "Possible alternate company domain added",
				companyId: outcome.id,
				domain,
				matchedDomain: outcome.nearDomain,
			});
			return outcome.id;
		}
		if (!outcome.created) return outcome.id;

		await this.agent.companyCreated(
			outcome.id,
			`Created from an email domain (${domain}) — it has no name but the domain`,
		);

		this.logger.log({
			message: "Company created from an email domain",
			companyId: outcome.id,
			domain,
		});

		return outcome.id;
	}

	async existingCompanyForIdentity(input: {
		domain?: string | null;
		name?: string | null;
	}): Promise<string | null> {
		const domain = normalizeDomain(input.domain);
		const name = input.name?.trim();
		if (!domain && !name) return null;
		return this.agent.withCrmEvents(async (tx) => {
			const company = await tx.company.findFirst({
				where: {
					archivedAt: null,
					OR: [
						...(domain
							? [{ domain }, { alternateDomains: { some: { domain } } }]
							: []),
						...(name
							? [{ name: { equals: name, mode: "insensitive" as const } }]
							: []),
					],
				},
				select: { id: true },
			});
			return company?.id ?? null;
		});
	}

	private async nearDomainCompany(
		tx: Prisma.TransactionClient,
		domain: string,
	): Promise<{ id: string; domain: string } | null> {
		const label = domainLabel(domain);
		const candidates = await tx.$queryRaw<DomainCandidate[]>`
			SELECT c."id", c."domain"
			FROM "company" c
			WHERE c."archivedAt" IS NULL
				AND c."domain" IS NOT NULL
				AND (
					char_length(c."domain") BETWEEN ${domain.length - 1} AND ${domain.length + 1}
					OR split_part(lower(c."domain"), '.', 1) = ${label}
				)
			UNION
			SELECT c."id", d."domain"
			FROM "companyDomain" d
			JOIN "company" c ON c."id" = d."companyId"
			WHERE c."archivedAt" IS NULL
				AND (
					char_length(d."domain") BETWEEN ${domain.length - 1} AND ${domain.length + 1}
					OR split_part(lower(d."domain"), '.', 1) = ${label}
				)
			ORDER BY "id", "domain"
		`;
		const close = candidates.filter((candidate) => {
			const candidateDomain = candidate.domain.toLowerCase();
			return (
				candidateDomain !== domain && isNearDomain(domain, candidateDomain)
			);
		});
		const companyIds = [...new Set(close.map(({ id }) => id))];
		if (companyIds.length !== 1) return null;
		const match = close.find(({ id }) => id === companyIds[0]);
		return match ?? null;
	}
}
