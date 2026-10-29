import { dailyLimit, utcDay } from "./budget";
import { InvalidRequest, match, POST_BODIES, idsBody, WOW_GAME_ID, type Route } from "./routes";

export const UPSTREAM = "https://api.curseforge.com";
/** WoW-don's backend sends `wow-don/<version>`. A filter for stray traffic, not authentication. */
const APP_USER_AGENT = /^wow-don\/[0-9A-Za-z.+-]{1,40}$/;
const MAX_REQUEST_BODY = 256 * 1024;
const MAX_UPSTREAM_BODY = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

export type Upstream = (input: string, init: RequestInit) => Promise<Response>;

type Log = Record<string, string | number>;

/**
 * The UTC day on which this isolate saw the daily budget spent. Not request state: a shortcut
 * that only ever refuses, so that once the cap is reached a flood stops calling the counter
 * (whose own daily request quota would otherwise go with it). Lost on eviction, then relearned.
 */
let spentOn: string | undefined;

class TooLarge extends Error {}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function error(status: number, code: string): Response {
  return json(status, { error: code });
}

/** The body as text, failing once it passes `max` bytes instead of buffering all of it. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function isWow(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { gameId?: unknown }).gameId === WOW_GAME_ID;
}

type Fetched = { kind: "ok"; body: { data?: unknown } & Record<string, unknown> } | { kind: "status"; response: Response };

async function call(upstream: Upstream, key: string, route: Route, log: Log): Promise<Fetched> {
  const init: RequestInit = {
    method: route.method,
    headers: {
      accept: "application/json",
      "x-api-key": key,
      ...(route.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: route.body,
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  let response: Response;
  try {
    response = await upstream(`${UPSTREAM}${route.upstreamPath}`, init);
  } catch {
    log.upstream = "unreachable";
    return { kind: "status", response: error(502, "upstream_unavailable") };
  }
  log.upstream = response.status;
  if (response.status !== 200) {
    await response.body?.cancel();
    switch (response.status) {
      case 400:
        return { kind: "status", response: error(400, "invalid_request") };
      case 404:
        return { kind: "status", response: error(404, "not_found") };
      case 429:
        return { kind: "status", response: error(429, "rate_limited") };
      case 401:
      case 403:
        // The key was rejected or revoked: an operator problem, never the client's.
        console.error(JSON.stringify({ message: "upstream rejected the key", status: response.status }));
        return { kind: "status", response: error(502, "upstream_error") };
      default:
        return { kind: "status", response: error(502, "upstream_error") };
    }
  }
  try {
    const parsed: unknown = JSON.parse(await readCapped(response.body, MAX_UPSTREAM_BODY));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return { kind: "ok", body: parsed as Record<string, unknown> };
  } catch {
    log.upstream = "invalid_response";
    return { kind: "status", response: error(502, "upstream_error") };
  }
}

/** The response after checking that everything in it is World of Warcraft. */
async function forward(upstream: Upstream, key: string, route: Route, log: Log): Promise<Response> {
  if (route.check === "mod-lookup") {
    const lookup = await call(upstream, key, { name: "mod", method: "GET", upstreamPath: `/v1/mods/${route.modId}`, check: "object" }, log);
    if (lookup.kind === "status") return lookup.response;
    if (!isWow(lookup.body.data)) return error(404, "not_found");
  }
  const fetched = await call(upstream, key, route, log);
  if (fetched.kind === "status") return fetched.response;
  const body = fetched.body;
  switch (route.check) {
    case "object":
      if (!isWow(body.data)) return error(404, "not_found");
      break;
    case "list":
      if (!Array.isArray(body.data) || !body.data.every(isWow)) return error(404, "not_found");
      break;
    case "filter":
      if (!Array.isArray(body.data)) return error(502, "upstream_error");
      body.data = body.data.filter(isWow);
      break;
    case "scoped":
    case "mod-lookup":
      break;
  }
  return json(200, body);
}

async function route(request: Request, env: Env, upstream: Upstream, log: Log): Promise<Response> {
  if (String(env.PROXY_ENABLED) !== "true") return error(503, "disabled");

  // Browsers always send Origin or Sec-Fetch-* on the requests a web page makes; the app's
  // backend never does. No CORS headers are ever sent either.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return error(403, "forbidden");
  }
  if (!APP_USER_AGENT.test(request.headers.get("user-agent") ?? "")) return error(403, "forbidden");

  const url = new URL(request.url);
  let matched;
  try {
    matched = match(request.method, url);
  } catch (e) {
    if (e instanceof InvalidRequest) return error(400, "invalid_request");
    throw e;
  }
  if (matched === "not-found") return error(404, "not_found");
  if (matched === "method-not-allowed") return error(405, "method_not_allowed");
  log.route = matched.name;

  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: client });
  if (!success) return error(429, "rate_limited");

  if (matched.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(;|$)/i.test(type)) return error(415, "unsupported_media_type");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BODY) return error(413, "too_large");
    let raw: string;
    try {
      raw = await readCapped(request.body, MAX_REQUEST_BODY);
    } catch (e) {
      if (e instanceof TooLarge) return error(413, "too_large");
      return error(400, "invalid_request");
    }
    const spec = POST_BODIES[matched.name];
    if (spec === undefined) throw new Error(`no body spec for ${matched.name}`);
    try {
      matched.body = idsBody(raw, spec.field, spec.max);
    } catch (e) {
      if (e instanceof InvalidRequest) return error(400, "invalid_request");
      throw e;
    }
  } else if (request.body !== null) {
    return error(400, "invalid_request");
  }

  const key = env.CURSEFORGE_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    console.error(JSON.stringify({ message: "CURSEFORGE_API_KEY is not set" }));
    return error(503, "unavailable");
  }

  // Last, so that only valid requests about to reach CurseForge spend the global budget, and
  // a single client is held back by RATE_LIMITER before it can drain it.
  const limit = dailyLimit(env.DAILY_LIMIT);
  if (limit === undefined) {
    console.error(JSON.stringify({ message: "DAILY_LIMIT is not a positive integer" }));
    return error(503, "unavailable");
  }
  const today = utcDay(new Date());
  if (spentOn === today || !(await env.DAILY_BUDGET.getByName("global").take(limit))) {
    spentOn = today;
    log.limited = "daily";
    return error(503, "daily_limit");
  }
  return forward(upstream, key.trim(), matched, log);
}

/** Tests only: forgets the day the budget was seen spent. */
export function forgetSpentBudget(): void {
  spentOn = undefined;
}

/**
 * Handles one request. `upstream` is the fetch used to reach CurseForge, replaced in tests.
 * Logs one line per request with no query string, client address or header values.
 */
export async function handle(request: Request, env: Env, upstream: Upstream): Promise<Response> {
  const started = Date.now();
  const log: Log = { message: "request", method: request.method };
  let response: Response;
  try {
    response = await route(request, env, upstream, log);
  } catch (e) {
    console.error(JSON.stringify({ message: "unhandled error", error: e instanceof Error ? e.name : "unknown" }));
    response = error(500, "internal_error");
  }
  log.status = response.status;
  log.ms = Date.now() - started;
  console.log(JSON.stringify(log));
  return response;
}
