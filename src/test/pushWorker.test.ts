import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";

function worker(ok = true) {
  let background: (payload: unknown) => unknown = () => {};
  let click: (event: unknown) => unknown = () => {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue({ ok, json: async () => ({ correct: false, meaning: "猫" }) });
  const entries = new Map<string, any>();
  const register = vi.fn().mockResolvedValue(undefined);
  const listeners: Record<string, any> = {};
  const context = {
    URL, AbortController, setTimeout, clearTimeout, importScripts: () => {}, fetch,
    firebase: { initializeApp: () => {}, messaging: () => ({ onBackgroundMessage: (handler: typeof background) => { background = handler; } }) },
    self: { TataniPushOutbox: { createOutbox: () => outbox }, location: "https://example.test/firebase-messaging-sw.js", registration: { showNotification, sync: { register } }, clients: { openWindow }, addEventListener: (type: string, handler: typeof click) => { listeners[type] = handler; if (type === "notificationclick") click = handler; } },
  };
  const shared: any = { self: {}, fetch, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync("public/push-answer-outbox.js", "utf8"), shared);
  const outbox = shared.self.TataniPushOutbox.createOutbox({
    add: async (entry: any) => { if (!entries.has(entry.id)) entries.set(entry.id, entry); },
    list: async () => [...entries.values()], remove: async (id: string) => entries.delete(id),
  }, fetch);
  vm.runInNewContext(readFileSync("public/firebase-messaging-sw.js", "utf8"), context);
  const data = { delivery_id: "delivery", word: "Katze", quiz_options: '["猫","犬"]', path: "/notifications/review/delivery", token: "secret", api: "https://example.test/review", l_correct: "正解", l_incorrect: "不正解" };
  return { background, click, data, showNotification, openWindow, fetch, entries, register, listeners };
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
  it("submits \"I don't know\" as answer -1", async () => {
    const w = worker();
    await w.background({ data: w.data });
    expect(w.showNotification.mock.calls[0][1].actions.map((a: { action: string }) => a.action)).toEqual(["answer_0", "answer_1", "answer_dk"]);
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_dk", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ action: "quiz_answer", delivery_id: "delivery", token: "secret", answer: -1 });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("retains the selected answer offline instead of opening the website", async () => {
    const w = worker(false);
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_0", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(w.openWindow).not.toHaveBeenCalled();
    expect(w.entries.get("delivery").answer).toBe(0);
    expect(w.register).toHaveBeenCalledWith("tatani-push-answers");
    expect(w.showNotification.mock.calls[0][1].data.stage).toBe("queued");
  });
  it("shows a durable local acknowledgement before a slow response resolves", async () => {
    const w = worker();
    let resolve: (result: unknown) => void = () => {};
    w.fetch.mockImplementation(() => new Promise(r => { resolve = r; }));
    let task = Promise.resolve();
    w.click({ action: "answer_1", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<void>) => { task = p; } });
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalled());
    expect(w.entries.get("delivery").answer).toBe(1);
    expect(w.showNotification.mock.calls[0][1].data.stage).toBe("queued");
    expect(w.openWindow).not.toHaveBeenCalled();
    resolve({ ok: true, json: async () => ({ correct: true, meaning: "犬" }) });
    await task;
    expect(w.entries.size).toBe(0);
    expect(w.showNotification.mock.calls[1][1].data.stage).toBe("done");
  });
  it("retries the original choice on a worker wake and clears it only after success", async () => {
    const w = worker(false);
    let task = Promise.resolve();
    const waitUntil = (p: Promise<void>) => { task = p; };
    w.click({ action: "answer_1", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil });
    await task;
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({ correct: false, meaning: "猫" }) });
    w.listeners.message({ data: { type: "FLUSH_PUSH_ANSWERS" }, waitUntil });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[1][1].body).answer).toBe(1);
    expect(w.entries.size).toBe(0);
  });
  it("never overwrites the first saved choice with a repeated click", async () => {
    const w = worker(false);
    let task = Promise.resolve();
    for (const action of ["answer_0", "answer_1"]) {
      w.click({ action, notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<void>) => { task = p; } });
      await task;
    }
    expect(w.entries.get("delivery").answer).toBe(0);
    expect(JSON.parse(w.fetch.mock.calls[1][1].body).answer).toBe(0);
  });
  it("bounds slow requests to ten seconds without dropping the saved answer", async () => {
    vi.useFakeTimers();
    try {
      const w = worker();
      w.fetch.mockImplementation((_: unknown, options: any) => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("timeout")));
      }));
      let task = Promise.resolve();
      w.click({ action: "answer_0", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<void>) => { task = p; } });
      await vi.advanceTimersByTimeAsync(10000);
      await task;
      expect(w.entries.get("delivery").answer).toBe(0);
      expect(w.openWindow).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("stops retrying an expired card without claiming it was graded", async () => {
    const w = worker();
    w.fetch.mockResolvedValue({ ok: false, status: 410 } as any);
    let task = Promise.resolve();
    w.click({ action: "answer_0", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<void>) => { task = p; } });
    await task;
    expect(w.entries.size).toBe(0);
    expect(w.showNotification.mock.calls[1][1].data.stage).toBe("failed");
    expect(w.openWindow).not.toHaveBeenCalled();
  });
});