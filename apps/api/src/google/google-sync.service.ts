import { Injectable } from "@nestjs/common";
import { type Deadline, deadlineIn } from "../mailbox/deadline";
import { SYNC_TICK } from "../mailbox/mailbox-config";
import { SyncStateService } from "../mailbox/sync-state.service";
import { CalendarSyncService } from "./calendar-sync.service";
import { GmailSyncService } from "./gmail-sync.service";
import { GOOGLE_SYNC_SOURCES, type GoogleSyncSource } from "./google.constants";

@Injectable()
export class GoogleSyncService {
	constructor(
		private readonly state: SyncStateService,
		private readonly calendar: CalendarSyncService,
		private readonly gmail: GmailSyncService,
	) {}

	async runOne(userId: string, source: GoogleSyncSource, deadline: Deadline) {
		const row = await this.state.get(userId, source);
		if (!row) return null;

		return source === "calendar"
			? this.calendar.sync(row, deadline)
			: this.gmail.sync(row, deadline);
	}

	async runForUser(userId: string): Promise<void> {
		const deadline = deadlineIn(SYNC_TICK.budgetMs);

		for (const source of GOOGLE_SYNC_SOURCES) {
			await this.runOne(userId, source, deadline);
		}
	}
}
