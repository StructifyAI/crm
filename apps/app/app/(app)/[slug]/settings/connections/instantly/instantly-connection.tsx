"use client";

import Add from "@carbon/icons-react/es/Add";
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
import { Input } from "@crm/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@crm/ui/components/select";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";
import { CopyValue } from "../../copy-value";

type Status = {
	connected: boolean;
	webhookPath: string | null;
	lastEventAt: string | null;
	canManage: boolean;
	mailboxes: { total: number; mapped: number };
};

type Mailbox = {
	id: string;
	emailAccount: string;
	ownerId: string | null;
	ownerName: string | null;
	ownerEmail: string | null;
	lastSeenAt: string | null;
};

type Member = { id: string; name: string; email: string };

export function InstantlyConnection({
	status,
	members,
	mailboxes: initialMailboxes,
	webhookUrl,
}: {
	status: Status;
	members: Member[];
	mailboxes: Mailbox[];
	webhookUrl: string | null;
}) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const router = useRouter();
	const [mailboxes, setMailboxes] = useState(initialMailboxes);
	const [emailAccount, setEmailAccount] = useState("");
	const [confirming, setConfirming] = useState(false);
	const connect = useMutation(
		trpc.instantly.connect.mutationOptions({
			onSuccess: async () => {
				await cache.instantly();
				toast.success(
					status.connected ? "Webhook URL rotated." : "Instantly connected.",
				);
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const disconnect = useMutation(
		trpc.instantly.disconnect.mutationOptions({
			onSuccess: async () => {
				await cache.instantly();
				setConfirming(false);
				toast.success("Instantly disconnected.");
				router.refresh();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const addMailbox = useMutation(
		trpc.instantly.addMailbox.mutationOptions({
			onSuccess: (mailbox) => {
				setMailboxes((rows) =>
					[...rows.filter((row) => row.id !== mailbox.id), mailbox].sort(
						(a, b) => a.emailAccount.localeCompare(b.emailAccount),
					),
				);
				setEmailAccount("");
				toast.success("Mailbox added.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const setOwner = useMutation(
		trpc.instantly.setMailboxOwner.mutationOptions({
			onSuccess: (mailbox) => {
				setMailboxes((rows) =>
					rows.map((row) => (row.id === mailbox.id ? mailbox : row)),
				);
				toast.success("Mailbox owner updated.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const removeMailbox = useMutation(
		trpc.instantly.removeMailbox.mutationOptions({
			onSuccess: (_, input) => {
				setMailboxes((rows) => rows.filter((row) => row.id !== input.id));
				toast.success("Mailbox removed.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	if (!status.connected) {
		return (
			<div className="flex flex-col items-center gap-3">
				<Button
					disabled={!status.canManage || connect.isPending}
					onClick={() => connect.mutate()}
				>
					{connect.isPending ? "Connecting…" : "Connect Instantly"}
				</Button>
				{!status.canManage ? (
					<p className="text-muted-foreground text-xs">
						Only an owner or an admin can connect Instantly.
					</p>
				) : null}
			</div>
		);
	}

	const mappedMailboxes = mailboxes.filter((mailbox) => mailbox.ownerId).length;

	return (
		<>
			<section className="flex flex-col gap-4 px-(--spacing-block-inline) py-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="font-medium text-sm">Webhook</h2>
						<p className="mt-1 text-muted-foreground text-xs">
							In Instantly go to Settings → Integrations → Webhooks, add this
							URL and choose All events.
						</p>
					</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!status.canManage || connect.isPending}
							onClick={() => connect.mutate()}
						>
							Rotate URL
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!status.canManage || disconnect.isPending}
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
					<h2 className="font-medium text-sm">Who owns new contacts</h2>
					<p className="mt-1 text-muted-foreground text-xs">
						A contact created from a reply is owned by whoever owns the mailbox
						it replied to. Unmapped mailboxes create unowned contacts.
					</p>
				</div>
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm">
						{mappedMailboxes} of {mailboxes.length} mapped
					</p>
					<form
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							addMailbox.mutate({ emailAccount });
						}}
					>
						<Input
							type="email"
							value={emailAccount}
							onChange={(event) => setEmailAccount(event.target.value)}
							placeholder="email account"
							aria-label="Email account"
						/>
						<Button
							type="submit"
							size="sm"
							disabled={!emailAccount || addMailbox.isPending}
						>
							<Icon icon={Add} />
							Add mailbox
						</Button>
					</form>
				</div>
				<div className="overflow-hidden rounded-lg border">
					{mailboxes.length === 0 ? (
						<p className="px-4 py-4 text-muted-foreground text-sm">
							Mailboxes appear here on their own after their first event.
						</p>
					) : (
						<div className="divide-y">
							{mailboxes.map((mailbox) => (
								<div
									className="flex items-center gap-4 px-4 py-3"
									key={mailbox.id}
								>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-sm">
											{mailbox.emailAccount}
										</p>
										<p className="text-muted-foreground text-xs">
											{mailbox.lastSeenAt
												? `Last seen ${new Date(mailbox.lastSeenAt).toLocaleString()}`
												: "Added manually"}
										</p>
									</div>
									<Select
										value={mailbox.ownerId ?? "unassigned"}
										onValueChange={(ownerId) =>
											setOwner.mutate({
												id: mailbox.id,
												ownerId: ownerId === "unassigned" ? null : ownerId,
											})
										}
									>
										<SelectTrigger
											className="w-48"
											aria-label={`Owner for ${mailbox.emailAccount}`}
										>
											<SelectValue placeholder="Unassigned" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="unassigned">Unassigned</SelectItem>
											{members.map((member) => (
												<SelectItem value={member.id} key={member.id}>
													{member.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Remove ${mailbox.emailAccount}`}
										onClick={() => removeMailbox.mutate({ id: mailbox.id })}
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
						<AlertDialogTitle>Disconnect Instantly?</AlertDialogTitle>
						<AlertDialogDescription>
							Instantly webhooks stop being accepted. Mailbox mappings stay
							saved.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<Button
							variant="destructive"
							disabled={disconnect.isPending}
							onClick={() => disconnect.mutate()}
						>
							Disconnect
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
