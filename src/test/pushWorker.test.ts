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
  const data = { delivery_id: "delivery", word: "Katze", quiz_options: '["知ってる","わからない"]', path: "/notifications/review/delivery", token: "secret", api: "https://example.test/review", l_know: "知ってる", l_dont_know: "わからない", l_correct: "正解", l_incorrect: "不正解" };
  return { background, click, data, showNotification, openWindow, fetch, entries, register, listeners };
}

describe("notification quiz actions", () => {
  it("displays foreground test pushes through the same quiz worker", async () => {
    const w = worker();
    let task: Promise<unknown> = Promise.resolve();
    w.listeners.message({ data: { type: "SHOW_PUSH_QUIZ", data: { ...w.data, word: "食べる", reading: "たべる", l_dont_know: "わからない" } }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(w.showNotification).toHaveBeenCalledTimes(1);
    expect(w.showNotification.mock.calls[0][0]).toBe("食べる (たべる)");
    expect(w.showNotification.mock.calls[0][1]).toMatchObject({ tag: "delivery", data: { stage: "quiz" }, actions: [{ action: "answer_0", title: "知ってる" }, { action: "answer_1", title: "わからない" }] });
  });
  it("answers current self-check payloads without legacy quiz_options and shows the translation", async () => {
    const w = worker();
    const { quiz_options, ...data } = w.data;
    await w.background({ data });
    expect(w.showNotification.mock.calls[0][1].data.stage).toBe("quiz");
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_1", notification: { data: w.showNotification.mock.calls[0][1].data, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body).answer).toBe(1);
    expect(w.entries.size).toBe(0);
    expect(w.showNotification.mock.calls[2][1]).toMatchObject({ body: "Katze — 猫", data: { stage: "done" }, renotify: true });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("handles self-check notifications incorrectly marked prompt by an older worker", async () => {
    const w = worker();
    const { quiz_options, ...data } = w.data;
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_0", notification: { data: { ...data, stage: "prompt" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body).answer).toBe(0);
    expect(w.showNotification.mock.calls[1][1]).toMatchObject({ body: "Katze — 猫", data: { stage: "done" } });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("submits the selected answer without a self-reported grade and alerts with the translation", async () => {
    const w = worker();
    await w.background({ data: w.data });
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_1", notification: { data: { ...w.data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ action: "quiz_answer", delivery_id: "delivery", token: "secret", answer: 1 });
    expect(w.showNotification.mock.calls[0][1].tag).toBe("delivery");
    expect(w.showNotification.mock.calls[1][1]).toMatchObject({ tag: "delivery", renotify: false, body: "わからない" });
    expect(w.showNotification.mock.calls[2]).toEqual(["不正解", expect.objectContaining({ tag: "delivery", renotify: true, requireInteraction: true, body: "Katze — 猫", data: expect.objectContaining({ stage: "done" }) })]);
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("keeps the legacy meaning quiz with an extra \"I don't know\" for older deliveries", async () => {
    const w = worker();
    const legacy = { ...w.data, quiz_options: '["猫","犬"]' };
    delete legacy.l_know;
    await w.background({ data: legacy });
    expect(w.showNotification.mock.calls[0][1].actions.map((a: { action: string }) => a.action)).toEqual(["answer_0", "answer_1", "answer_dk"]);
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_dk", notification: { data: { ...legacy, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ action: "quiz_answer", delivery_id: "delivery", token: "secret", answer: -1 });
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it("acknowledges \"I know\" with its own label and answer 0", async () => {
    const w = worker();
    w.fetch.mockResolvedValue({ ok: true, json: async () => ({ correct: true, meaning: "to eat" }) });
    w.data.word = "食べる";
    const data = { ...w.data, reading: "たべる" };
    await w.background({ data: w.data });
    let task: Promise<unknown> = Promise.resolve();
    w.click({ action: "answer_0", notification: { data: { ...data, stage: "quiz" }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { task = p; } });
    await task;
    expect(JSON.parse(w.fetch.mock.calls[0][1].body)).toEqual({ action: "quiz_answer", delivery_id: "delivery", token: "secret", answer: 0 });
    expect(w.showNotification.mock.calls[1][1].body).toBe("知ってる");
    expect(w.showNotification.mock.calls[2]).toEqual(["正解", expect.objectContaining({ renotify: true, requireInteraction: true, body: "食べる (たべる) — to eat" })]);
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
    expect(w.showNotification.mock.calls[1][1]).toMatchObject({ renotify: true, body: "Katze — 猫", data: { stage: "done" } });
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
  it("displays the episode example sentence in the notification prompt when provided", async () => {
    const w = worker();
    await w.background({ data: { ...w.data, word: "魔法", reading: "まほう", example: "そんな魔法は見たことがない。" } });
    expect(w.showNotification).toHaveBeenCalledTimes(1);
    expect(w.showNotification.mock.calls[0][0]).toBe("魔法 (まほう)");
    expect(w.showNotification.mock.calls[0][1]).toMatchObject({
      body: "そんな魔法は見たことがない。",
      tag: "delivery",
      actions: [{ action: "answer_0", title: "知ってる" }, { action: "answer_1", title: "わからない" }],
    });
  });
});