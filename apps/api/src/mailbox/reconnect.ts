import {
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
} from "@crm/db";
import { isSyncSource, type SyncSource } from "./mailbox.constants";
import type { MailboxTokenService } from "./mailbox-token.service";
import type { SyncStateService } from "./sync-state.service";

export async function restoreParkedRows(
	deps: { tokens: MailboxTokenService; state: SyncStateService },
	userId: string,
	rows: readonly MailboxSync[],
): Promise<SyncSource[]> {
	const restored: SyncSource[] = [];

	for (const row of rows) {
		if (row.status !== GoogleSyncStatus.NEEDS_RECONNECT) continue;
		if (!isSyncSource(row.source)) continue;

		const token = await deps.tokens.refresh(userId, row.source);
		if (token.outcome !== "ok") continue;

		await deps.state.ensure(userId, row.source, {
			autoCreate: row.autoCreate,
		});

		restored.push(row.source);
	}

	return restored;
}
