import {
	PageShell,
	PageShellContent,
	PageShellDescription,
	PageShellHeader,
	PageShellHeading,
	PageShellLoading,
	PageShellTitle,
} from "@crm/ui/components/page-shell";
import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSession } from "@/lib/session";
import { HydrateClient } from "@/lib/trpc/hydrate";
import { getServerQueryClient, getServerTrpc } from "@/lib/trpc/server";
import { DuplicatesReview } from "./duplicates-review";

export const metadata: Metadata = {
	title: "Duplicates",
};

export default function DuplicatesPage() {
	return (
		<PageShell className="min-h-0">
			<PageShellHeader>
				<PageShellHeading>
					<PageShellTitle>Duplicates</PageShellTitle>
					<PageShellDescription>
						Possible duplicate records, side by side.
					</PageShellDescription>
				</PageShellHeading>
			</PageShellHeader>

			<PageShellContent className="min-h-0">
				<Suspense fallback={<PageShellLoading shape="table" />}>
					<DuplicatesContent />
				</Suspense>
			</PageShellContent>
		</PageShell>
	);
}

async function DuplicatesContent() {
	await requireSession();
	const trpc = getServerTrpc();
	await getServerQueryClient().prefetchInfiniteQuery(
		trpc.duplicates.list.infiniteQueryOptions(
			{ kind: "CONTACT" },
			{ getNextPageParam: (page) => page.nextCursor ?? undefined },
		),
	);

	return (
		<HydrateClient>
			<DuplicatesReview />
		</HydrateClient>
	);
}
