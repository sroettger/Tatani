export type PushSchedule = { timezone: string; start_hour: number; end_hour: number; cards_per_day: number };

export function scheduleHours(schedule: PushSchedule): number[] {
  if (schedule.cards_per_day === 1) return [schedule.start_hour];
  return Array.from({ length: schedule.cards_per_day }, (_, i) =>
    Math.round(schedule.start_hour + i * (schedule.end_hour - schedule.start_hour) / (schedule.cards_per_day - 1)));
}

export function currentSlot(schedule: PushSchedule, date: Date): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  const hour = Number(get("hour"));
  return scheduleHours(schedule).includes(hour) ? `${get("year")}-${get("month")}-${get("day")}-${hour}` : null;
}

export function eligibleWord(state: { state: string; preference: string; last_reviewed_at: string | null } | undefined, chunkStudied: boolean): boolean {
  return state?.state !== "known" && state?.preference !== "skip" && (chunkStudied || Boolean(state?.last_reviewed_at));
}