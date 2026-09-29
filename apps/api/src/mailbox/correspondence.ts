import { EmailClassification, type Prisma } from "@crm/db";

export type CorrespondenceSpan = {
	messageCount: number;
	firstMessageAt: Date;
	lastMessageAt: Date;
};

export async function correspondenceSpan(
	tx: Prisma.TransactionClient,
	threadId: string,
): Promise<CorrespondenceSpan | null> {
	const [all, human] = await Promise.all([
		tx.emailMessage.count({ where: { threadId } }),
		tx.emailMessage.aggregate({
			where: {
				threadId,
				OR: [
					{
						classification: {
							in: [EmailClassification.OURS, EmailClassification.THEIRS],
						},
					},
					{ classification: null, correspondence: true },
				],
			},
			_min: { sentAt: true },
			_max: { sentAt: true },
		}),
	]);

	if (!human._min.sentAt || !human._max.sentAt) return null;

	return {
		messageCount: all,
		firstMessageAt: human._min.sentAt,
		lastMessageAt: human._max.sentAt,
	};
}
