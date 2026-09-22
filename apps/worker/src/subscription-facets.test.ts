import { describe, expect, it } from "vitest";
import { subscriptionFacetsQueryPlan } from "./subscription-facets";

describe("subscription facets query plan", () => {
  it("keeps every aggregate owner-scoped", () => {
    const plan = subscriptionFacetsQueryPlan("usr_facets_owner", "2026-09-14");

    for (const [name, query] of Object.entries(plan)) {
      expect(query.sql).toContain("user_id = ?");
      expect(query.params).toEqual(name === "counts" ? ["2026-09-14", "usr_facets_owner"] : ["usr_facets_owner"]);
    }
    expect(plan.counts.sql).toContain("public_hidden = 0");
    expect(plan.categories.sql).toContain("GROUP BY category");
    expect(plan.tags.sql).toContain("GROUP BY tag");
  });
});
