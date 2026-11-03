import { describe, expect, it } from "vitest";
import { eligibleWord } from "../../supabase/functions/_shared/push-schedule";

describe("notification word selection", () => {
  it("does not send correctly recalled cards before their next review", () => {
    expect(eligibleWord({ state: "known", preference: "study", last_reviewed_at: "2026-11-01", srs_due_at: "2026-11-04T00:00:00Z" }, true, Date.parse("2026-11-02T00:00:00Z"))).toBe(false);
  });
  it("includes known cards again once their review is due", () => {
    expect(eligibleWord({ state: "known", preference: "study", last_reviewed_at: "2026-11-01", srs_due_at: "2026-11-04T00:00:00Z" }, true, Date.parse("2026-11-04T00:00:00Z"))).toBe(true);
  });
});
