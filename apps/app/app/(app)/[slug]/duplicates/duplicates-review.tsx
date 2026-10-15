"use client";

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@crm/ui/components/empty";
import { Spinner } from "@crm/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";

type DuplicateKind = "CONTACT" | "COMPANY";

type RecordSummary = {
	id: string;
	name: string;
	email: string | null;
	emails: string[];
	linkedinUrl: string | null;
	companyName: string | null;
	title: string | null;
	domain: string | null;
	dealCount: number;
	activityCount: number;
	createdAt: Date | string;
};

type Candidate = {
	id: string;
	kind: DuplicateKind;
	reason: string;
	createdAt: Date | string;
	a: RecordSummary;
	b: RecordSummary;
};

function RecordCard({
	record,
	pending,
	onKeep,
}: {
	record: RecordSummary;
	pending: boolean;
	onKeep: () => void;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{record.name || "Unnamed record"}</CardTitle>
				<CardDescription>
					{record.companyName ?? record.domain ?? "Company not set"}
				</CardDescription>
			</CardHeader>
			<CardContent className="gap-2 text-sm">
				{record.emails.length ? (
					<p className="break-all">{record.emails.join(", ")}</p>
				) : null}
				{record.title ? <p>{record.title}</p> : null}
				{record.linkedinUrl ? (
					<p className="break-all text-muted-foreground">
						{record.linkedinUrl}
					</p>
				) : null}
				<p className="text-muted-foreground">
					{record.dealCount} {record.dealCount === 1 ? "deal" : "deals"} ·{" "}
					{record.activityCount}{" "}
					{record.activityCount === 1 ? "activity" : "activities"}
				</p>
				<div className="flex justify-end">
					<Button onClick={onKeep} disabled={pending}>
						{pending ? <Spinner data-icon="inline-start" /> : null}
						Keep this one
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function CandidatePair({
	candidate,
	pending,
	onKeep,
	onDismiss,
}: {
	candidate: Candidate;
	pending: boolean;
	onKeep: (keepId: string) => void;
	onDismiss: () => void;
}) {
	return (
		<article
			className="flex flex-col gap-3"
			aria-label={`Duplicate pair: ${candidate.a.name} and ${candidate.b.name}`}
		>
			<div className="flex items-center justify-between gap-3">
				<Badge variant="secondary">{candidate.reason}</Badge>
				<span className="text-xs text-muted-foreground">
					{new Date(candidate.createdAt).toLocaleDateString()}
				</span>
			</div>
			<div className="grid gap-3 md:grid-cols-2">
				<RecordCard
					record={candidate.a}
					pending={pending}
					onKeep={() => onKeep(candidate.a.id)}
				/>
				<RecordCard
					record={candidate.b}
					pending={pending}
					onKeep={() => onKeep(candidate.b.id)}
				/>
			</div>
			<div className="flex justify-center">
				<Button variant="outline" onClick={onDismiss} disabled={pending}>
					Not duplicates
				</Button>
			</div>
		</article>
	);
}

export function DuplicatesReview() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const [kind, setKind] = useState<DuplicateKind>("CONTACT");
	const query = useInfiniteQuery({
		...trpc.duplicates.list.infiniteQueryOptions(
			{ kind },
			{ getNextPageParam: (page) => page.nextCursor ?? undefined },
		),
	});
	const candidates = query.data?.pages.flatMap((page) => page.items) ?? [];
	const merge = useMutation(
		trpc.duplicates.merge.mutationOptions({
			onSuccess: () => toast.success("Duplicate records merged."),
			onError: (error) => toast.error(error.message),
			onSettled: () =>
				queryClient.invalidateQueries({
					queryKey: trpc.duplicates.list.pathKey(),
				}),
		}),
	);
	const dismiss = useMutation(
		trpc.duplicates.dismiss.mutationOptions({
			onSuccess: () => toast.success("Duplicate pair dismissed."),
			onError: (error) => toast.error(error.message),
			onSettled: () =>
				queryClient.invalidateQueries({
					queryKey: trpc.duplicates.list.pathKey(),
				}),
		}),
	);
	const pending = merge.isPending || dismiss.isPending;

	return (
		<div className="flex flex-col gap-6">
			<header className="flex flex-col gap-2">
				<h1 className="text-2xl font-medium tracking-tight">Duplicates</h1>
				<p className="text-sm text-muted-foreground">
					Review records that may describe the same person or company.
				</p>
			</header>
			<Tabs
				value={kind}
				onValueChange={(value) => {
					if (value === "CONTACT" || value === "COMPANY") setKind(value);
				}}
			>
				<TabsList>
					<TabsTrigger value="CONTACT">Contacts</TabsTrigger>
					<TabsTrigger value="COMPANY">Companies</TabsTrigger>
				</TabsList>
			</Tabs>
			{query.isPending ? (
				<div className="flex justify-center py-12" aria-busy="true">
					<Spinner size="lg" />
				</div>
			) : query.isError ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Could not load duplicates</EmptyTitle>
						<EmptyDescription>{query.error.message}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : candidates.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>No duplicates to review</EmptyTitle>
						<EmptyDescription>
							New duplicate candidates will appear here.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex flex-col gap-8">
					{candidates.map((candidate) => (
						<CandidatePair
							key={candidate.id}
							candidate={candidate}
							pending={pending}
							onKeep={(keepId) => merge.mutate({ id: candidate.id, keepId })}
							onDismiss={() => dismiss.mutate({ id: candidate.id })}
						/>
					))}
					{query.hasNextPage ? (
						<div className="flex justify-center">
							<Button
								variant="outline"
								onClick={() => void query.fetchNextPage()}
								disabled={query.isFetchingNextPage}
							>
								{query.isFetchingNextPage ? (
									<Spinner data-icon="inline-start" />
								) : null}
								Load more
							</Button>
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
