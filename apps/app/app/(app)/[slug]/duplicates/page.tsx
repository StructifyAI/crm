import type { Metadata } from "next";
import { PageShell, PageShellContent } from "@/components/page-shell";
import { requireSession } from "@/lib/session";
import { HydrateClient } from "@/lib/trpc/hydrate";
import { getServerQueryClient, getServerTrpc } from "@/lib/trpc/server";
import { DuplicatesReview } from "./duplicates-review";

export const metadata: Metadata = {
	title: "Duplicates",
};

export default async function DuplicatesPage() {
	await requireSession();
	const trpc = getServerTrpc();
	await getServerQueryClient().prefetchInfiniteQuery(
		trpc.duplicates.list.infiniteQueryOptions(
			{ kind: "CONTACT" },
			{ getNextPageParam: (page) => page.nextCursor ?? undefined },
		),
	);

	return (
		<PageShell>
			<PageShellContent>
				<HydrateClient>
					<DuplicatesReview />
				</HydrateClient>
			</PageShellContent>
		</PageShell>
	);
}
