/** Today's spending of the global daily budget, as the `DailyBudget` object stores it. */
export interface Spent {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  count: number;
}

/** The UTC day of `now`: the budget resets at 00:00 UTC, like the Workers free-plan limits. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Counts one request against `limit`. A count from an earlier day starts again from zero;
 * once the limit is reached the request is refused and the count stays where it is.
 */
export function spend(spent: Spent | undefined, now: Date, limit: number): { state: Spent; allowed: boolean } {
  const day = utcDay(now);
  const count = spent?.day === day ? spent.count : 0;
  if (count >= limit) return { state: { day, count }, allowed: false };
  return { state: { day, count: count + 1 }, allowed: true };
}

/** `DAILY_LIMIT` as a positive integer, or `undefined` when it is missing or malformed. */
export function dailyLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}
