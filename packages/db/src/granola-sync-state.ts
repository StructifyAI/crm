import type { Db } from "./client";
import { Prisma } from "./generated/prisma/client";
import { SETTINGS_ID } from "./settings";

export async function readGranolaSyncState(db: Db): Promise<{
	granolaSyncedAt: Date | null;
	granolaSyncResume: Prisma.JsonValue | null;
}> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { granolaSyncedAt: true, granolaSyncResume: true },
	});

	return {
		granolaSyncedAt: row?.granolaSyncedAt ?? null,
		granolaSyncResume: row?.granolaSyncResume ?? null,
	};
}

export async function writeGranolaSyncState(
	db: Db,
	update: {
		granolaSyncedAt?: Date;
		granolaSyncResume?: Prisma.InputJsonValue | null;
	},
): Promise<void> {
	const data = {
		...(update.granolaSyncedAt
			? { granolaSyncedAt: update.granolaSyncedAt }
			: {}),
		...(update.granolaSyncResume !== undefined
			? {
					granolaSyncResume: update.granolaSyncResume ?? Prisma.JsonNull,
				}
			: {}),
	};

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, ...data },
		update: data,
	});
}
