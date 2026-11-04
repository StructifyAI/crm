import { describe, expect, it } from "bun:test";
import {
	firstNamesCompatible,
	matchByPhone,
	parseName,
	phoneDigits,
	profileKey,
	sameLinkedinProfile,
	trailingId,
} from "../src/contact-match";

describe("contact name matching", () => {
	it("drops middle initials and suffixes after a comma", () => {
		expect(parseName("Michael A.", "Moyer")).toEqual({
			first: "michael",
			surname: "moyer",
			generation: null,
		});
		expect(parseName("Michael", "Moyer")).toEqual({
			first: "michael",
			surname: "moyer",
			generation: null,
		});
		expect(parseName("Chris", "Bello, DBA").surname).toBe("bello");
		expect(parseName("Chris", "Bello, C.P.M.").surname).toBe("bello");
	});

	it("keeps generation suffixes before dropping comma suffixes", () => {
		expect(parseName("Al", "Bello Jr.")).toEqual({
			first: "al",
			surname: "bello",
			generation: "jr",
		});
		expect(parseName("Al", "Bello, Jr.")).toEqual({
			first: "al",
			surname: "bello",
			generation: "jr",
		});
	});

	it("matches compatible first names by prefix and nickname in both directions", () => {
		expect(firstNamesCompatible("Michael", "Mike")).toBe(true);
		expect(firstNamesCompatible("Mike", "Michael")).toBe(true);
		expect(firstNamesCompatible("Nathen", "Nate")).toBe(true);
		expect(firstNamesCompatible("Brandon", "Bran")).toBe(true);
		expect(firstNamesCompatible("Al", "Alan")).toBe(false);
	});
});

describe("LinkedIn profile matching", () => {
	it("normalizes the profile slug", () => {
		expect(
			profileKey("https://www.linkedin.com/in/Nate-A-8161B068/?trk=profile"),
		).toBe("nate-a-8161b068");
		expect(profileKey("linkedin.com/in/nate%2Da%2D8161b068/")).toBe(
			"nate-a-8161b068",
		);
	});

	it("matches equivalent trailing ids without matching unrelated suffixes", () => {
		expect(trailingId("nate-a-8161b068")).toBe("8161b068");
		expect(trailingId("john-smith")).toBeNull();
		expect(trailingId("john-smith-2")).toBeNull();
		expect(
			sameLinkedinProfile(
				"https://linkedin.com/in/nate-a-8161b068",
				"https://www.linkedin.com/in/nate-ankrom-8161b068",
			),
		).toBe(true);
		expect(
			sameLinkedinProfile(
				"https://linkedin.com/in/john-smith",
				"https://linkedin.com/in/john-smith-2",
			),
		).toBe(false);
	});
});

function phoneDb(rows: { contacts: unknown[]; companies: unknown[] }) {
	const queries: { sql: string; values: unknown[] }[] = [];
	const db = {
		$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			queries.push({ sql, values });
			return sql.includes('FROM "company"') ? rows.companies : rows.contacts;
		},
	};
	return { db: db as unknown as Parameters<typeof matchByPhone>[0], queries };
}

describe("phone matching", () => {
	it("compares digits without a leading country code", () => {
		expect(phoneDigits("+1 (281) 732-0665")).toBe("2817320665");
		expect(phoneDigits("281.732.0665")).toBe("2817320665");
		expect(phoneDigits(null)).toBe("");
	});

	it("matches the one contact with the number", async () => {
		const { db, queries } = phoneDb({
			contacts: [{ id: "contact-1", companyId: "company-1" }],
			companies: [],
		});

		expect(await matchByPhone(db, "+12817320665")).toEqual({
			companyId: "company-1",
			contactId: "contact-1",
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]?.values).toEqual(["2817320665"]);
	});

	it("matches only the company when its contacts share a line", async () => {
		const { db } = phoneDb({
			contacts: [
				{ id: "contact-1", companyId: "company-1" },
				{ id: "contact-2", companyId: "company-1" },
			],
			companies: [],
		});

		expect(await matchByPhone(db, "+16024374005")).toEqual({
			companyId: "company-1",
			contactId: null,
		});
	});

	it("does not pick between contacts at different companies", async () => {
		const { db } = phoneDb({
			contacts: [
				{ id: "contact-1", companyId: "company-1" },
				{ id: "contact-2", companyId: "company-2" },
			],
			companies: [{ id: "company-3" }],
		});

		expect(await matchByPhone(db, "+16024374005")).toEqual({
			companyId: null,
			contactId: null,
		});
	});

	it("falls back to the company main line", async () => {
		const { db } = phoneDb({ contacts: [], companies: [{ id: "company-1" }] });

		expect(await matchByPhone(db, "+16024374005")).toEqual({
			companyId: "company-1",
			contactId: null,
		});
	});

	it("ignores a short number without querying", async () => {
		const { db, queries } = phoneDb({ contacts: [], companies: [] });

		expect(await matchByPhone(db, "5551234")).toEqual({
			companyId: null,
			contactId: null,
		});
		expect(queries).toHaveLength(0);
	});
});
