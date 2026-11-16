// The daily token budget (spec §3): reserve, then correct. The reservation is one
// atomic statement, so concurrent calls cannot jointly pass the budget; the only
// overshoot is one call's estimation error. Mock calls reserve too.
import type { Queryable } from "../db";

/** Used when DAILY_TOKEN_BUDGET is unset. A configuration value, not a measurement. */
export const DEFAULT_DAILY_TOKEN_BUDGET = 1_000_000;

export type Reservation = { day: string; tokens: number };

export interface Budget {
  /** Null means the budget cannot take this call: stop. */
  reserve(tokens: number): Promise<Reservation | null>;
  /** Replaces a reservation's estimate with what the provider reported. */
  correct(reservation: Reservation, actualTokens: number): Promise<void>;
}

export function dailyTokenBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  if (!env.DAILY_TOKEN_BUDGET) return DEFAULT_DAILY_TOKEN_BUDGET;
  const value = Number(env.DAILY_TOKEN_BUDGET);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("DAILY_TOKEN_BUDGET must be a non-negative integer");
  }
  return value;
}

export function createBudget(
  db: Queryable,
  limit: number,
  now: () => Date = () => new Date(),
): Budget {
  return {
    async reserve(tokens) {
      const day = now().toISOString().slice(0, 10); // UTC
      // Without today's row the UPDATE below matches nothing and would read as
      // "budget exceeded" on the first call of every day.
      await db.query(
        "INSERT INTO enrichment_budget (day, tokens_used) VALUES ($1, 0) ON CONFLICT (day) DO NOTHING",
        [day],
      );
      const result = await db.query(
        `UPDATE enrichment_budget
            SET tokens_used = tokens_used + $2
          WHERE day = $1 AND tokens_used + $2 <= $3
          RETURNING tokens_used`,
        [day, tokens, limit],
      );
      return result.rowCount === 1 ? { day, tokens } : null;
    },

    async correct(reservation, actualTokens) {
      // Charged to the day of the reservation, also when the call crossed midnight.
      await db.query(
        "UPDATE enrichment_budget SET tokens_used = tokens_used + $2 WHERE day = $1",
        [reservation.day, actualTokens - reservation.tokens],
      );
    },
  };
}
