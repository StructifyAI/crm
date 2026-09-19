import { ActivityType, db } from "@crm/db";

export type EmailFilingOutcome =
	| { filed: true; alreadyFiled: boolean; deal: string }
	| { filed: false; reason: string };

export async function fileEmailToDeal(input: {
	activityId: string;
	dealId: string;
}): Promise<EmailFilingOutcome> {
	const activity = await db.activity.findUnique({
		where: { id: input.activityId },
		select: {
			type: true,
			emailThreadId: true,
			dealId: true,
			companyId: true,
			occurredAt: true,
			createdAt: true,
			contact: { select: { companyId: true } },
			deal: { select: { name: true } },
		},
	});

	if (
		!activity ||
		activity.type !== ActivityType.EMAIL ||
		!activity.emailThreadId
	) {
		return { filed: false, reason: "No synced email activity has that id." };
	}

	if (activity.dealId) {
		return activity.dealId === input.dealId
			? {
					filed: true,
					alreadyFiled: true,
					deal: activity.deal?.name ?? input.dealId,
				}
			: {
					filed: false,
					reason: `This email is already filed to "${activity.deal?.name ?? activity.dealId}". A rep moves it, not you.`,
				};
	}

	const deal = await db.deal.findUnique({
		where: { id: input.dealId },
		select: { name: true, companyId: true, archivedAt: true },
	});

	if (!deal) return { filed: false, reason: "No such deal." };
	if (deal.archivedAt) {
		return { filed: false, reason: `"${deal.name}" is archived.` };
	}

	const companyId = activity.companyId ?? activity.contact?.companyId ?? null;
	if (companyId !== deal.companyId) {
		return {
			filed: false,
			reason: `"${deal.name}" belongs to a different company than the people on this email.`,
		};
	}

	const at = activity.occurredAt ?? activity.createdAt;

	await db.$transaction([
		db.activity.updateMany({
			where: { id: input.activityId, dealId: null },
			data: { dealId: input.dealId },
		}),
		db.deal.updateMany({
			where: {
				id: input.dealId,
				OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }],
			},
			data: { lastActivityAt: at },
		}),
	]);

	return { filed: true, alreadyFiled: false, deal: deal.name };
}
