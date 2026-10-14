import type { Prisma } from "@crm/db";
import { TOLL_FREE_PHONE_PREFIXES } from "./contact-phone-config";
import { blankToNull } from "./values";

function phoneDigits(value: string | null | undefined): string {
	const digits = value?.replace(/\D/g, "") ?? "";
	return digits.startsWith("1") ? digits.slice(1) : digits;
}

function isTollFree(value: string): boolean {
	const prefix = phoneDigits(value).slice(0, 3);
	return (TOLL_FREE_PHONE_PREFIXES as readonly string[]).includes(prefix);
}

function samePhone(left: string, right: string | null | undefined): boolean {
	const leftDigits = phoneDigits(left);
	return leftDigits !== "" && leftDigits === phoneDigits(right);
}

export async function contactPhoneForStorage(
	tx: Prisma.TransactionClient,
	companyId: string | null,
	value: string | null | undefined,
): Promise<string | null> {
	const phone = blankToNull(value ?? "");
	if (!phone) return null;
	const company = companyId
		? await tx.company.findUnique({
				where: { id: companyId },
				select: { id: true, phone: true },
			})
		: null;
	if (isTollFree(phone)) {
		if (company && !company.phone?.trim()) {
			await tx.company.update({
				where: { id: company.id },
				data: { phone },
			});
		}
		return null;
	}
	return samePhone(phone, company?.phone) ? null : phone;
}
