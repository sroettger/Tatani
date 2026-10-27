import { describe, it, expect } from "vitest";
import { currentSlot, scheduleHours, eligibleWord } from "../../supabase/functions/_shared/push-schedule";

describe("flashcards spaced throughout the day", () => {
  const schedule = { timezone: "Asia/Tokyo", start_hour: 9, end_hour: 21, cards_per_day: 4 };
  it("spreads four notifications between 09:00 and 21:00", () => {
    expect(scheduleHours(schedule)).toEqual([9, 13, 17, 21]);
  });
  it("uses the selected timezone rather than UTC", () => {
    expect(currentSlot(schedule, new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-27-13");
    expect(currentSlot(schedule, new Date("2026-10-27T03:00:00Z"))).toBeNull();
  });
  it("does not send outside the chosen hours", () => {
    expect(currentSlot(schedule, new Date("2026-10-27T13:00:00Z"))).toBeNull();
  });
  it("uses studied words rather than unstudied chunk words", () => {
    expect(eligibleWord(undefined, false)).toBe(false);
    expect(eligibleWord(undefined, true)).toBe(true);
    expect(eligibleWord({ state: "unknown", preference: "study", last_reviewed_at: "2026-10-27" }, false)).toBe(true);
  });
  it("excludes known and skipped words", () => {
    expect(eligibleWord({ state: "known", preference: "study", last_reviewed_at: null }, true)).toBe(false);
    expect(eligibleWord({ state: "unknown", preference: "skip", last_reviewed_at: null }, true)).toBe(false);
  });
});