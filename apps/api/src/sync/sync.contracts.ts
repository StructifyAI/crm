import { z } from "zod";

export const dealLinkBackfillCursor = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.optional();
