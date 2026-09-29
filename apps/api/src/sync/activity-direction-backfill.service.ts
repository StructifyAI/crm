import { type Db } from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

@Injectable()
export class ActivityDirectionBackfillService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async backfill(): Promise<{ updated: number }> {
		const updated = await this.db.$executeRaw`
			UPDATE "activity"
			SET "direction" = CASE
				WHEN "meta"->>'eventType' = 'email_sent' THEN 'OUT'::"ContactDirection"
				ELSE 'IN'::"ContactDirection"
			END
			WHERE "direction" IS NULL
				AND "type" = 'EMAIL'
				AND "emailThreadId" IS NULL
				AND "meta"->>'eventType' IN ('email_sent', 'reply_received')
		`;
		return { updated };
	}
}
