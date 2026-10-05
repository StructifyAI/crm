import { describe, expect, it } from "bun:test";
import {
	attachValues,
	coerceValue,
	columnFor,
	type FieldDefinitionWithOptions,
	FieldValueError,
	type FieldValueWithOptions,
	type FieldWriter,
	fieldKeyFromLabel,
	readValue,
	recordColumn,
	serializeField,
	serializeFieldFor,
	usesOptions,
	writeValues,
} from "../src/fields";

function definition(
	over: Partial<FieldDefinitionWithOptions> = {},
): FieldDefinitionWithOptions {
	return {
		id: "def-1",
		entity: "COMPANY",
		key: "runs_on",
		label: "Runs on",
		type: "TEXT",
		agentFilled: true,
		agentBrief: null,
		required: false,
		showOnSheet: true,
		showOnTable: false,
		position: 0,
		archivedAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		options: [],
		...over,
	} as FieldDefinitionWithOptions;
}

function value(
	over: Partial<FieldValueWithOptions> = {},
): FieldValueWithOptions {
	return {
		id: "val-1",
		fieldId: "def-1",
		companyId: "company-1",
		contactId: null,
		dealId: null,
		text: null,
		number: null,
		date: null,
		bool: null,
		optionId: null,
		options: [],
		userId: null,
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...over,
	} as FieldValueWithOptions;
}

describe("fieldKeyFromLabel", () => {
	it("slugs a label", () => {
		expect(fieldKeyFromLabel("Runs on")).toBe("runs_on");
		expect(fieldKeyFromLabel("  ICP Tier  ")).toBe("icp_tier");
		expect(fieldKeyFromLabel("Who's signing?")).toBe("whos_signing");
	});

	it("never starts with a digit", () => {
		expect(fieldKeyFromLabel("2026 renewal")).toBe("f_2026_renewal");
	});

	it("steps around keys the record shape already uses", () => {
		expect(fieldKeyFromLabel("id")).toBe("id_field");
		expect(fieldKeyFromLabel("Owner")).toBe("owner_field");
	});

	it("steps around the sentinel the fields sheet opens the create form with", () => {
		expect(fieldKeyFromLabel("New")).toBe("new_field");
	});
});

describe("columnFor", () => {
	it("routes every type to one storage column", () => {
		expect(columnFor("TEXT")).toBe("text");
		expect(columnFor("LONG_TEXT")).toBe("text");
		expect(columnFor("EMAIL")).toBe("text");
		expect(columnFor("NUMBER")).toBe("number");
		expect(columnFor("DATE")).toBe("date");
		expect(columnFor("CHECKBOX")).toBe("bool");
		expect(columnFor("SELECT")).toBe("optionId");
		expect(columnFor("MULTI_SELECT")).toBe("optionIds");
		expect(columnFor("USER")).toBe("userId");
	});
});

describe("recordColumn", () => {
	it("maps an entity to its foreign key", () => {
		expect(recordColumn("COMPANY")).toBe("companyId");
		expect(recordColumn("CONTACT")).toBe("contactId");
		expect(recordColumn("DEAL")).toBe("dealId");
	});
});

describe("usesOptions", () => {
	it("recognizes select and multi-select fields", () => {
		expect(usesOptions("SELECT")).toBe(true);
		expect(usesOptions("MULTI_SELECT")).toBe(true);
		expect(usesOptions("TEXT")).toBe(false);
	});
});

describe("coerceValue", () => {
	it("trims text", () => {
		expect(coerceValue(definition(), "  AWS ")).toEqual({ text: "AWS" });
	});

	it("clears an optional field when the value is blank", () => {
		expect(coerceValue(definition(), "   ")).toEqual({ text: null });
		expect(coerceValue(definition(), null)).toEqual({ text: null });
	});

	it("refuses to clear a required field", () => {
		expect(() => coerceValue(definition({ required: true }), "")).toThrow(
			FieldValueError,
		);
	});

	it("takes numbers as numbers or strings", () => {
		const numeric = definition({ type: "NUMBER" });
		expect(Number(coerceValue(numeric, "240").number)).toBe(240);
		expect(Number(coerceValue(numeric, 240).number)).toBe(240);
		expect(() => coerceValue(numeric, "many")).toThrow(FieldValueError);
	});

	it("reads a plain date as UTC midnight", () => {
		const dated = definition({ type: "DATE" });
		const parsed = coerceValue(dated, "2027-03-31").date as Date;
		expect(parsed.toISOString()).toBe("2027-03-31T00:00:00.000Z");
		expect(() => coerceValue(dated, "whenever")).toThrow(FieldValueError);
	});

	it("takes a checkbox as a boolean or its string", () => {
		const checkbox = definition({ type: "CHECKBOX" });
		expect(coerceValue(checkbox, true)).toEqual({ bool: true });
		expect(coerceValue(checkbox, "false")).toEqual({ bool: false });
		expect(() => coerceValue(checkbox, "maybe")).toThrow(FieldValueError);
	});

	it("resolves a select by id or by label, and rejects anything else", () => {
		const select = definition({
			type: "SELECT",
			options: [
				{
					id: "opt-aws",
					fieldId: "def-1",
					label: "AWS",
					position: 0,
					archivedAt: null,
				},
			],
		} as Partial<FieldDefinitionWithOptions>);

		expect(coerceValue(select, "opt-aws")).toEqual({ optionId: "opt-aws" });
		expect(coerceValue(select, "aws")).toEqual({ optionId: "opt-aws" });
		expect(() => coerceValue(select, "Fly.io")).toThrow(FieldValueError);
	});

	it("resolves multi-select labels and IDs, removes duplicates, and accepts one string", () => {
		const multiSelect = definition({
			type: "MULTI_SELECT",
			options: [
				{
					id: "opt-cnc",
					fieldId: "def-1",
					label: "CNC machining",
					position: 0,
					archivedAt: null,
				},
				{
					id: "opt-weld",
					fieldId: "def-1",
					label: "Welding",
					position: 1,
					archivedAt: null,
				},
			],
		});

		expect(
			coerceValue(multiSelect, ["cnc machining", "opt-weld", "CNC MACHINING"]),
		).toEqual({ optionIds: ["opt-cnc", "opt-weld"] });
		expect(coerceValue(multiSelect, "Welding")).toEqual({
			optionIds: ["opt-weld"],
		});
	});

	it("names an unknown multi-select option", () => {
		const multiSelect = definition({
			type: "MULTI_SELECT",
			options: [],
		});

		expect(() => coerceValue(multiSelect, ["Laser cutting"])).toThrow(
			'Runs on has no option "Laser cutting".',
		);
	});

	it("treats an empty multi-select as blank and checks required fields", () => {
		const multiSelect = definition({ type: "MULTI_SELECT" });

		expect(coerceValue(multiSelect, [])).toEqual({ optionIds: null });
		expect(() => coerceValue({ ...multiSelect, required: true }, [])).toThrow(
			FieldValueError,
		);
	});

	it("deletes a multi-select value when the selection is cleared", async () => {
		const deleted: unknown[] = [];
		const writer = {
			fieldValue: {
				deleteMany: async (args) => {
					deleted.push(args);
					return { count: 1 };
				},
				upsert: async () => {
					throw new Error("A blank selection does not upsert.");
				},
			},
			user: { findMany: async () => [] },
		} as unknown as FieldWriter;

		await writeValues(
			writer,
			"COMPANY",
			"company-1",
			[definition({ type: "MULTI_SELECT" })],
			{ runs_on: [] },
		);

		expect(deleted).toEqual([
			{ where: { fieldId: "def-1", companyId: "company-1" } },
		]);
	});
});

describe("readValue", () => {
	it("reads each type back out of its column", () => {
		expect(readValue(definition(), value({ text: "AWS" }))).toBe("AWS");
		expect(
			readValue(definition({ type: "CHECKBOX" }), value({ bool: true })),
		).toBe(true);
		expect(
			readValue(
				definition({ type: "DATE" }),
				value({ date: new Date("2027-03-31T00:00:00.000Z") }),
			),
		).toBe("2027-03-31T00:00:00.000Z");
	});

	it("is null when the record has no row", () => {
		expect(readValue(definition(), undefined)).toBeNull();
	});

	it("reads multi-select option IDs in option order", () => {
		expect(
			readValue(
				definition({ type: "MULTI_SELECT" }),
				value({
					options: [
						{ optionId: "second", option: { position: 1 } },
						{ optionId: "first", option: { position: 0 } },
					],
				}),
			),
		).toEqual(["first", "second"]);
	});
});

describe("serializeField", () => {
	it("drops archived options and orders the rest", () => {
		const serialized = serializeField(
			definition({
				type: "SELECT",
				options: [
					{
						id: "b",
						fieldId: "def-1",
						label: "Azure",
						position: 1,
						archivedAt: null,
					},
					{
						id: "a",
						fieldId: "def-1",
						label: "AWS",
						position: 0,
						archivedAt: null,
					},
					{
						id: "c",
						fieldId: "def-1",
						label: "Heroku",
						position: 2,
						archivedAt: new Date(),
					},
				],
			} as Partial<FieldDefinitionWithOptions>),
		);

		expect(serialized.options.map((option) => option.label)).toEqual([
			"AWS",
			"Azure",
		]);
	});

	it("keeps retired options visible for selected multi-select values", () => {
		const serialized = serializeFieldFor(
			definition({
				type: "MULTI_SELECT",
				options: [
					{
						id: "active",
						fieldId: "def-1",
						label: "CNC machining",
						position: 0,
						archivedAt: null,
					},
					{
						id: "retired",
						fieldId: "def-1",
						label: "Welding",
						position: 1,
						archivedAt: new Date(),
					},
				],
			}),
			["retired"],
		);

		expect(serialized.options.map((option) => option.id)).toEqual([
			"active",
			"retired",
		]);
		expect(
			serialized.options.find((option) => option.id === "retired"),
		).toMatchObject({
			archived: true,
		});
	});
});

describe("attachValues", () => {
	it("orders by position, hides archived fields and fills in values", () => {
		const fields = attachValues(
			[
				definition({ id: "second", key: "seats", position: 1 }),
				definition({ id: "first", key: "runs_on", position: 0 }),
				definition({
					id: "gone",
					key: "old",
					position: 2,
					archivedAt: new Date(),
				}),
			],
			[value({ fieldId: "first", text: "AWS" })],
		);

		expect(fields.map((field) => field.key)).toEqual(["runs_on", "seats"]);
		expect(fields[0]?.value).toBe("AWS");
		expect(fields[1]?.value).toBeNull();
	});
});
