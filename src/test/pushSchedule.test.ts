import { describe, it, expect } from "vitest";
import { currentSlot, scheduleMinutes, eligibleWord, hasUnhandledDelivery } from "../../supabase/functions/_shared/push-schedule";

describe("flashcards spaced throughout the day", () => {
  const schedule = { timezone: "Asia/Tokyo", start_hour: 9, end_hour: 21, cards_per_hour: 4 };
  it("allows four cards per hour evenly spaced", () => {
    expect(scheduleMinutes(4)).toEqual([0, 15, 30, 45]);
    expect(currentSlot(schedule, new Date("2026-10-27T04:15:00Z"))).toBe("2026-10-27-13-15");
    expect(currentSlot(schedule, new Date("2026-10-27T04:30:00Z"))).toBe("2026-10-27-13-30");
  });
  it("keeps one stable slot between intervals without catch-up bursts", () => {
    expect(currentSlot(schedule, new Date("2026-10-27T04:16:00Z"))).toBe("2026-10-27-13-15");
    expect(scheduleMinutes(60)).toHaveLength(60);
  });
  it("blocks another notification until the previous one is handled", () => {
    expect(hasUnhandledDelivery([{ status: "sent", reviewed_at: null }])).toBe(true);
    expect(hasUnhandledDelivery([{ status: "pending", reviewed_at: null }])).toBe(true);
    expect(hasUnhandledDelivery([{ status: "sent", reviewed_at: "2026-10-27" }])).toBe(false);
    expect(hasUnhandledDelivery([{ status: "failed", reviewed_at: null }])).toBe(false);
  });
  it("uses the selected timezone rather than UTC", () => {
    expect(currentSlot(schedule, new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-27-13-0");
    expect(currentSlot(schedule, new Date("2026-10-27T03:00:00Z"))).toBe("2026-10-27-12-0");
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