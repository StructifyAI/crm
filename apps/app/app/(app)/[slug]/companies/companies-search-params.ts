import { createListSearchParams } from "@/components/data-table/list-search-params";

export const companiesSearchParams = createListSearchParams({
	defaultSort: "createdAt",
	defaultDir: "desc",
	facetIds: ["owner", "enrichment", "activity", "icp"] as const,
});
