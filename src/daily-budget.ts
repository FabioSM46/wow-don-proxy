import { DurableObject } from "cloudflare:workers";
import { spend, type Spent } from "./budget";

/**
 * The one global counter of requests sent to CurseForge today. A single instance, named
 * `global`: a Durable Object handles one call at a time, so the count is exact across every
 * Cloudflare location. It stores one small record and nothing about the clients.
 */
export class DailyBudget extends DurableObject<Env> {
  /** Counts one request; `false` once today's `limit` is reached. */
  take(limit: number): boolean {
    const kv = this.ctx.storage.kv;
    const { state, allowed } = spend(kv.get<Spent>("spent"), new Date(), limit);
    if (allowed) kv.put("spent", state);
    return allowed;
  }
}
