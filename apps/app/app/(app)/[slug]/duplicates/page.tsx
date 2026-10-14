import type { Metadata } from "next";
import { Suspense } from "react";
import {
	PageShell,
	PageShellContent,
	PageShellLoading,
} from "@/components/page-shell";
import { requireSession } from "@/lib/session";
import { HydrateClient } from "@/lib/trpc/hydrate";
import { getServerQueryClient, getServerTrpc } from "@/lib/trpc/server";
import { DuplicatesReview } from "./duplicates-review";

export const metadata: Metadata = {
	title: "Duplicates",
};

export default function DuplicatesPage() {
	return (
		<PageShell>
			<PageShellContent>
				<Suspense fallback={<PageShellLoading />}>
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
