import { z } from "zod";

export const backfillCursor = z.string().trim().min(1).max(64).optional();
