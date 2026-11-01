import { describe, expect, it } from "vitest";
import { buildNotificationQuiz } from "../../supabase/functions/_shared/push-quiz";
import { eligibleWord } from "../../supabase/functions/_shared/push-schedule";

describe("single-notification multiple choice", () => {
  it("has two distinct answers with a server-side correct index", () => {
    const quiz = buildNotificationQuiz("猫", ["猫", "犬", "犬", " 猫 "], () => 0);
    expect(quiz).toEqual({ options: ["猫", "犬"], correctIndex: 0 });
  });
  it("randomizes the correct answer position", () => {
    expect(buildNotificationQuiz("猫", ["犬"], () => 0.9)).toEqual({ options: ["犬", "猫"], correctIndex: 1 });
  });
  it("does not invent an answer when there is no distinct distractor", () => {
    expect(buildNotificationQuiz("猫", ["猫", " 猫 ", ""])).toBeNull();
  });
  it("does not send correctly recalled cards before their next review", () => {
    expect(eligibleWord({ state: "known", preference: "study", last_reviewed_at: "2026-11-01", srs_due_at: "2026-11-04T00:00:00Z" }, true, Date.parse("2026-11-02T00:00:00Z"))).toBe(false);
  });
  it("includes known cards again once their review is due", () => {
    expect(eligibleWord({ state: "known", preference: "study", last_reviewed_at: "2026-11-01", srs_due_at: "2026-11-04T00:00:00Z" }, true, Date.parse("2026-11-04T00:00:00Z"))).toBe(true);
  });
});