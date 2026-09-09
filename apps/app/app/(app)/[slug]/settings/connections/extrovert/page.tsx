import ExtrovertLogo from "@crm/ui/components/brand-logos/extrovert";
import type { Metadata } from "next";
import { Suspense } from "react";
import { LocalRelativeTime } from "@/components/local-date-time";
import { API_URL } from "@/lib/env";
import { requireSession } from "@/lib/session";
import { getServerQueryClient, getServerTrpc } from "@/lib/trpc/server";
import { ExtrovertConnection } from "./extrovert-connection";

export const metadata: Metadata = { title: "Extrovert" };

export default function ExtrovertPage(
	_props: PageProps<"/[slug]/settings/connections/extrovert">,
) {
	return (
		<Suspense fallback={null}>
			<ExtrovertPageContent />
		</Suspense>
	);
}

async function ExtrovertPageContent() {
	await requireSession();
	const queryClient = getServerQueryClient();
	const trpc = getServerTrpc();
	const status = await queryClient.fetchQuery(
		trpc.extrovert.status.queryOptions(),
	);

	if (!status.connected) {
		return (
			<main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto px-(--spacing-page-inline) pt-(--spacing-page-top) pb-(--spacing-page-bottom)">
				<div className="flex w-full max-w-(--container-narrow) flex-col gap-6 text-center">
					<div className="flex flex-col items-center gap-3">
						<ExtrovertLogo className="size-10" />
						<h1 className="font-medium text-2xl tracking-tight">Extrovert</h1>
						<p className="text-muted-foreground text-sm leading-relaxed">
							Bring LinkedIn campaign activity into your CRM.
						</p>
					</div>
					<div className="flex justify-center">
						<ExtrovertConnection
							status={status}
							members={[]}
							crmMembers={[]}
							webhookUrl={null}
						/>
					</div>
				</div>
			</main>
		);
	}

	const [extrovertMembers, crmMembers] = await Promise.all([
		queryClient.fetchQuery(trpc.extrovert.listMembers.queryOptions()),
		queryClient.fetchQuery(
			trpc.workspace.members.queryOptions({
				q: "",
				sort: "",
				dir: "asc",
				page: 1,
				pageSize: 100,
				role: [],
			}),
		),
	]);

	return (
		<main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-(--spacing-page-inline) pt-(--spacing-page-top) pb-(--spacing-page-bottom)">
			<div className="mx-auto flex w-full max-w-(--container-page) flex-col divide-y">
				<header className="flex items-center gap-3 px-(--spacing-block-inline) pb-5">
					<ExtrovertLogo className="size-6" />
					<h1 className="font-medium text-xl">Extrovert</h1>
					<span className="ml-auto text-muted-foreground text-sm">
						Connected
					</span>
				</header>
				<section className="flex items-center justify-between gap-4 px-(--spacing-block-inline) py-5">
					<div>
						<h2 className="font-medium text-sm">Liveness</h2>
						<p className="text-muted-foreground text-sm">
							{status.lastEventAt ? (
								<>
									Last event arrived{" "}
									<LocalRelativeTime date={status.lastEventAt} />
								</>
							) : (
								"No events yet"
							)}
						</p>
					</div>
				</section>
				<ExtrovertConnection
					status={status}
					members={extrovertMembers}
					crmMembers={crmMembers.rows.map((member) => ({
						id: member.userId,
						name: member.name,
						email: member.email,
					}))}
					webhookUrl={`${API_URL}${status.webhookUrl}`}
				/>
			</div>
		</main>
	);
}
