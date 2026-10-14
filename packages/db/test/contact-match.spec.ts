import { describe, expect, it } from "bun:test";
import {
	firstNamesCompatible,
	parseName,
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
