"use client";

import TrashCan from "@carbon/icons-react/es/TrashCan";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { Button } from "@crm/ui/components/button";
import { Icon } from "@crm/ui/components/icon";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@crm/ui/components/select";
import { StatusIndicator } from "@crm/ui/components/status-indicator";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { LocalRelativeTime } from "@/components/local-date-time";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";
import { CopyValue } from "../../copy-value";

type Status = {
	connected: boolean;
	webhookUrl: string | null;
	hasApiKey: boolean;
	lastEventAt: string | null;
	lastSyncAt: string | null;
	lastSyncError: string | null;
	prospectCount: number;
	memberCount: number;
};

type Member = {
	id: string;
	name: string;
	email: string | null;
	linkedinUrl: string | null;
	ownerId: string | null;
	ownerName: string | null;
	ownerEmail: string | null;
	lastSeenAt: string;
};

export function ExtrovertConnection({
	status,
	members: initialMembers,
	crmMembers,
	webhookUrl,
}: {
	status: Status;
	members: Member[];
	crmMembers: { id: string; name: string; email: string }[];
	webhookUrl: string | null;
}) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const router = useRouter();
	const [members, setMembers] = useState(initialMembers);
	const [apiKey, setApiKey] = useState("");
	const [confirming, setConfirming] = useState(false);
	const connect = useMutation(
		trpc.extrovert.connect.mutationOptions({
			onSuccess: async () => {
				await cache.extrovert();
				toast.success(
					status.connected ? "Webhook URL rotated." : "Extrovert connected.",
				);
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const disconnect = useMutation(
		trpc.extrovert.disconnect.mutationOptions({
			onSuccess: async () => {
				await cache.extrovert();
				setConfirming(false);
				toast.success("Extrovert disconnected.");
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const saveApiKey = useMutation(
		trpc.extrovert.setApiKey.mutationOptions({
			onSuccess: async () => {
				await cache.extrovert();
				setApiKey("");
				toast.success("API key saved.");
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const clearApiKey = useMutation(
		trpc.extrovert.clearApiKey.mutationOptions({
			onSuccess: async () => {
				await cache.extrovert();
				toast.success("API key removed.");
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const sync = useMutation(
		trpc.extrovert.sync.mutationOptions({
			onSuccess: async (result) => {
				await cache.extrovert();
				if (result.error) toast.error(result.error);
				else
					toast.success(
						`Synced ${result.prospects} prospects from ${result.campaigns} campaigns`,
					);
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const setOwner = useMutation(
		trpc.extrovert.setMemberOwner.mutationOptions({
			onSuccess: (member) => {
				setMembers((rows) =>
					rows.map((row) => (row.id === member.id ? member : row)),
				);
				toast.success("Member owner updated.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const removeMember = useMutation(
		trpc.extrovert.removeMember.mutationOptions({
			onSuccess: (_, input) => {
				setMembers((rows) => rows.filter((row) => row.id !== input.id));
				toast.success("Member removed.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	if (!status.connected) {
		return (
			<Button disabled={connect.isPending} onClick={() => connect.mutate()}>
				{connect.isPending ? "Connecting…" : "Connect Extrovert"}
			</Button>
		);
	}

	return (
		<>
			<section className="flex flex-col gap-4 px-(--spacing-block-inline) py-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="font-medium text-sm">Webhook</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							In Extrovert, open Integrations -&gt; Webhooks, paste this URL,
							method POST, body{" "}
							<code>
								{'{"linkedinUrl": "{{linkedinUrl}}", "campaignName": "<name>"}'}
							</code>
							.
						</p>
					</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => connect.mutate()}
						>
							Rotate URL
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirming(true)}
						>
							Disconnect
						</Button>
					</div>
				</div>
				<div className="flex items-center gap-1 rounded-md border px-3 py-2 font-mono text-xs">
					<span className="min-w-0 flex-1 break-all">{webhookUrl}</span>
					{webhookUrl ? (
						<CopyValue value={webhookUrl} label="Webhook URL" />
					) : null}
				</div>
			</section>
			<section className="flex flex-col gap-4 px-(--spacing-block-inline) py-5">
				<div>
					<h2 className="font-medium text-sm">Prospect sync</h2>
					<p className="mt-1 text-muted-foreground text-xs">
						Import prospects and LinkedIn engagement from campaigns.
					</p>
				</div>
				{status.hasApiKey ? (
					<>
						<div className="flex flex-wrap items-center gap-3">
							<p className="text-sm">API key saved</p>
							{status.lastSyncAt ? (
								<p className="text-muted-foreground text-sm">
									Last synced <LocalRelativeTime date={status.lastSyncAt} />
								</p>
							) : null}
							<p className="text-muted-foreground text-sm">
								{status.prospectCount} prospects
							</p>
							{status.lastSyncError ? (
								<StatusIndicator tone="error" label={status.lastSyncError} />
							) : null}
						</div>
						<div className="flex gap-2">
							<Button disabled={sync.isPending} onClick={() => sync.mutate()}>
								{sync.isPending ? "Syncing…" : "Sync now"}
							</Button>
							<Button variant="outline" onClick={() => clearApiKey.mutate()}>
								Remove key
							</Button>
						</div>
					</>
				) : (
					<form
						className="flex max-w-md flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							saveApiKey.mutate({ apiKey });
						}}
					>
						<input
							className="rounded-md border px-3 py-2 text-sm"
							type="password"
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
							placeholder="Paste your Extrovert API key"
							aria-label="Extrovert API key"
						/>
						<Button
							type="submit"
							disabled={!apiKey.trim() || saveApiKey.isPending}
						>
							Save API key
						</Button>
					</form>
				)}
			</section>
			<section className="flex flex-col gap-4 px-(--spacing-block-inline) py-5">
				<div>
					<h2 className="font-medium text-sm">Campaign owners</h2>
					<p className="mt-1 text-muted-foreground text-xs">
						Map Extrovert members to CRM owners. Email matching maps members
						automatically.
					</p>
				</div>
				<div className="overflow-hidden rounded-lg border">
					{members.length === 0 ? (
						<p className="px-4 py-4 text-muted-foreground text-sm">
							Members appear here after the first sync.
						</p>
					) : (
						<div className="divide-y">
							{members.map((member) => (
								<div
									className="flex items-center gap-4 px-4 py-3"
									key={member.id}
								>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-sm">
											{member.name}
										</p>
										<p className="text-muted-foreground text-xs">
											{member.email ?? member.linkedinUrl ?? "No email"}
										</p>
									</div>
									<Select
										value={member.ownerId ?? "unassigned"}
										onValueChange={(ownerId) =>
											setOwner.mutate({
												id: member.id,
												ownerId: ownerId === "unassigned" ? null : ownerId,
											})
										}
									>
										<SelectTrigger
											className="w-48"
											aria-label={`Owner for ${member.name}`}
										>
											<SelectValue placeholder="Unassigned" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="unassigned">Unassigned</SelectItem>
											{crmMembers.map((crmMember) => (
												<SelectItem value={crmMember.id} key={crmMember.id}>
													{crmMember.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Remove ${member.name}`}
										onClick={() => removeMember.mutate({ id: member.id })}
									>
										<Icon icon={TrashCan} />
									</Button>
								</div>
							))}
						</div>
					)}
				</div>
			</section>
			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect Extrovert?</AlertDialogTitle>
						<AlertDialogDescription>
							Extrovert webhooks stop being accepted. Member mappings stay
							saved.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button variant="destructive" onClick={() => disconnect.mutate()}>
							Disconnect
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
