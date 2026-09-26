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
	const data: Pick<
		Prisma.AppSettingUncheckedCreateInput,
		"granolaSyncedAt" | "granolaSyncResume"
	> = {};
	if (update.granolaSyncedAt) data.granolaSyncedAt = update.granolaSyncedAt;
	if (update.granolaSyncResume !== undefined) {
		data.granolaSyncResume = update.granolaSyncResume ?? Prisma.JsonNull;
	}

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, ...data },
		update: data,
	});
}
