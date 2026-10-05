"use client";

import { Button } from "@crm/ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@crm/ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@crm/ui/components/popover";
import { Spinner } from "@crm/ui/components/spinner";
import { useState } from "react";
import { PROPERTY_LABEL, PROPERTY_ROW } from "@/components/detail-sheet";

const CONTROL =
	"h-8 w-full justify-start border border-transparent px-2 font-normal hover:border-input hover:bg-muted/40";

export function InlineMultiSelectField({
	label,
	value,
	options,
	onSave,
	saving = false,
}: {
	label: string;
	value: string[];
	options: { id: string; label: string; archived?: boolean }[];
	onSave: (next: string[]) => void;
	saving?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const selectedLabels = options
		.filter((option) => value.includes(option.id))
		.map((option) => option.label);
	const selectedActive = value.filter(
		(id) => !options.some((option) => option.id === id && option.archived),
	);

	return (
		<div className={`${PROPERTY_ROW} items-center`}>
			<span className={PROPERTY_LABEL}>{label}</span>
			<div className="flex min-w-0 items-center gap-1.5">
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							role="combobox"
							aria-label={label}
							aria-expanded={open}
							className={CONTROL}
							disabled={saving}
						>
							{saving ? <Spinner /> : null}
							<span
								className={
									selectedLabels.length > 0
										? "truncate"
										: "truncate text-muted-foreground"
								}
							>
								{selectedLabels.length > 0 ? selectedLabels.join(", ") : "None"}
							</span>
						</Button>
					</PopoverTrigger>
					<PopoverContent
						align="start"
						size="fit"
						className="w-(--radix-popover-trigger-width) min-w-64"
					>
						<Command>
							<CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
							<CommandList>
								<CommandEmpty>Nothing matches.</CommandEmpty>
								<CommandGroup>
									{options.map((option) => {
										const checked = value.includes(option.id);

										return (
											<CommandItem
												key={option.id}
												value={`${option.label} ${option.id}`}
												data-checked={checked}
												disabled={saving || (option.archived && !checked)}
												onSelect={() =>
													onSave(
														checked
															? selectedActive.filter((id) => id !== option.id)
															: option.archived
																? selectedActive
																: [...selectedActive, option.id],
													)
												}
											>
												<span className="truncate">{option.label}</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			</div>
		</div>
	);
}
