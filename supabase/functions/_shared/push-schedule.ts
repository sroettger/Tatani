export type PushSchedule = { timezone: string; start_hour: number; end_hour: number; cards_per_hour: number };

export function scheduleMinutes(cardsPerHour: number): number[] {
  return Array.from({ length: cardsPerHour }, (_, i) => Math.floor(i * 60 / cardsPerHour));
}

export function currentSlot(schedule: PushSchedule, date: Date): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (hour < schedule.start_hour || hour >= schedule.end_hour) return null;
  const minutes = scheduleMinutes(schedule.cards_per_hour);
  const bucket = Math.max(0, minutes.filter(m => m <= minute).length - 1);
  return `${get("year")}-${get("month")}-${get("day")}-${hour}-${minutes[bucket]}`;
}

export function hasUnhandledDelivery(deliveries: { status: string; reviewed_at: string | null }[]): boolean {
  return deliveries.some(d => d.reviewed_at === null && (d.status === "pending" || d.status === "sent"));
}

export function eligibleWord(state: { state: string; preference: string; last_reviewed_at: string | null } | undefined, chunkStudied: boolean): boolean {
  return state?.state !== "known" && state?.preference !== "skip" && (chunkStudied || Boolean(state?.last_reviewed_at));
}