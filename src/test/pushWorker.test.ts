import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

function worker(ok = true) {
  let background: (payload: unknown) => unknown = () => {};
  let click: (event: unknown) => unknown = () => {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue({ ok, json: async () => ({ correct: false, meaning: "猫" }) });
  const context = {
    URL, importScripts: () => {}, fetch,
    firebase: { initializeApp: () => {}, messaging: () => ({ onBackgroundMessage: (handler: typeof background) => { background = handler; } }) },
    self: { location: "https://example.test/firebase-messaging-sw.js", registration: { showNotification }, clients: { openWindow }, addEventListener: (_: string, handler: typeof click) => { click = handler; } },
  };
  vm.runInNewContext(readFileSync("public/firebase-messaging-sw.js", "utf8"), context);
  const data = { delivery_id: "delivery", word: "Katze", quiz_options: '["猫","犬"]', path: "/notifications/review/delivery", token: "secret", api: "https://example.test/review", l_correct: "正解", l_incorrect: "不正解" };
  return { background, click, data, showNotification, openWindow, fetch };
}

describe("notification quiz actions", () => {
  it("submits the selected answer without a self-reported grade and keeps one silent notification", async () => {
    const w = worker();
    await w.background({ data: w.data });
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_1", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ action: "quiz_answer", delivery_id: "delivery", token: "secret", answer: 1 });
    expect(w.showNotification.mock.calls[0][1].tag).toBe("delivery");
    expect(w.showNotification.mock.calls[1][1]).toMatchObject({ tag: "delivery", renotify: false });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("opens the same quiz as fallback if background grading fails", async () => {
    const w = worker(false);
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_0", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(w.openWindow).toHaveBeenCalledWith(w.data.path);
    expect(w.showNotification).not.toHaveBeenCalled();
  });
});