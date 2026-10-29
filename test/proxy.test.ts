import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyLimit, spend, utcDay, type Spent } from "../src/budget";
import { forgetSpentBudget, handle, UPSTREAM, type Upstream } from "../src/proxy";

const KEY = "test-key-not-real";
const UA = "wow-don/0.1.0";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake `DailyBudget` with the real counting rule, keeping its record in memory. */
function budget(start?: Spent): { binding: unknown; names: string[]; spent: () => Spent | undefined } {
  let stored = start;
  const names: string[] = [];
  const binding = {
    getByName(name: string) {
      names.push(name);
      return {
        take: async (limit: number) => {
          const { state, allowed } = spend(stored, new Date(), limit);
          if (allowed) stored = state;
          return allowed;
        },
      };
    },
  };
  return { binding, names, spent: () => stored };
}

function env(overrides: Partial<Record<keyof Env, unknown>> = {}, allowed = true): Env {
  return {
    CURSEFORGE_API_KEY: KEY,
    PROXY_ENABLED: "true",
    DAILY_LIMIT: "30000",
    DAILY_BUDGET: budget().binding,
    RATE_LIMITER: { limit: async () => ({ success: allowed }) },
    ...overrides,
  } as Env;
}

/** A fake CurseForge answering every call with the next queued response. */
function upstream(...responses: (Response | Error)[]): { fn: Upstream; calls: Call[] } {
  const calls: Call[] = [];
  const fn: Upstream = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected upstream call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://proxy.example.com${path}`, { headers: { "user-agent": UA, ...headers } });
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://proxy.example.com${path}`, {
    method: "POST",
    body,
    headers: { "user-agent": UA, "content-type": "application/json", ...headers },
  });
}

let logs: string[];

beforeEach(() => {
  forgetSpentBudget();
  logs = [];
  const capture = (line: unknown) => logs.push(String(line));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the key", () => {
  it("is sent to CurseForge only in the x-api-key header", async () => {
    const up = upstream(ok({ data: [] }));
    const response = await handle(get("/v1/games/1/version-types"), env(), up.fn);
    expect(response.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    const call = up.calls[0]!;
    expect(call.url).toBe(`${UPSTREAM}/v1/games/1/version-types`);
    expect(new Headers(call.init.headers).get("x-api-key")).toBe(KEY);
    expect(call.init.redirect).toBe("manual");
  });

  it("never appears in responses or logs, whatever happens", async () => {
    const cases: [Request, (Response | Error)[]][] = [
      [get("/v1/mods/1"), [ok({ data: { id: 1, gameId: 1 } })]],
      [get("/v1/mods/1"), [new Response("no", { status: 403 })]],
      [get("/v1/mods/1"), [new Response("boom", { status: 500 })]],
      [get("/v1/mods/1"), [new Error(KEY)]],
      [get("/v1/mods/1"), [new Response("not json", { status: 200 })]],
      [get("/v1/nope"), []],
    ];
    for (const [request, responses] of cases) {
      const response = await handle(request, env(), upstream(...responses).fn);
      expect(await response.text()).not.toContain(KEY);
      expect([...response.headers.values()].join(" ")).not.toContain(KEY);
    }
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("missing gives 503 without calling CurseForge", async () => {
    const up = upstream();
    const response = await handle(get("/v1/mods/1"), env({ CURSEFORGE_API_KEY: "" }), up.fn);
    expect(response.status).toBe(503);
    expect(up.calls).toHaveLength(0);
  });

  it("rejected by CurseForge is a 502, never forwarded as a key problem", async () => {
    const response = await handle(get("/v1/mods/1"), env(), upstream(new Response("", { status: 401 })).fn);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_error" });
  });
});

describe("who can call", () => {
  it("rejects browsers", async () => {
    const browsers: Record<string, string>[] = [{ origin: "https://evil.example.com" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of browsers) {
      const up = upstream();
      const response = await handle(get("/v1/mods/1", headers), env(), up.fn);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(up.calls).toHaveLength(0);
    }
  });

  it("rejects clients that are not WoW-don", async () => {
    for (const ua of ["", "curl/8.0", "wow-don/", "Mozilla/5.0 wow-don/1.0"]) {
      const up = upstream();
      const response = await handle(get("/v1/mods/1", { "user-agent": ua }), env(), up.fn);
      expect(response.status).toBe(403);
      expect(up.calls).toHaveLength(0);
    }
  });

  it("applies the rate limit before calling CurseForge", async () => {
    const up = upstream();
    const response = await handle(get("/v1/mods/1"), env({}, false), up.fn);
    expect(response.status).toBe(429);
    expect(up.calls).toHaveLength(0);
  });

  it("honours the kill switch", async () => {
    const up = upstream();
    const response = await handle(get("/v1/mods/1"), env({ PROXY_ENABLED: "false" }), up.fn);
    expect(response.status).toBe(503);
    expect(up.calls).toHaveLength(0);
  });
});

describe("the closed list of calls", () => {
  it.each([
    ["/v1/categories?gameId=1", "/v1/categories?gameId=1"],
    ["/v1/games/1/version-types", "/v1/games/1/version-types"],
    [
      "/v1/mods/search?gameId=1&searchFilter=deadly+boss+%26+mods&gameVersionTypeId=517&sortField=2&sortOrder=desc&index=50&pageSize=50",
      "/v1/mods/search?gameId=1&searchFilter=deadly+boss+%26+mods&gameVersionTypeId=517&sortField=2&sortOrder=desc&index=50&pageSize=50",
    ],
    ["/v1/mods/search?gameId=1", "/v1/mods/search?gameId=1"],
  ])("forwards GET %s", async (path, expected) => {
    const up = upstream(ok({ data: [] }));
    const response = await handle(get(path), env(), up.fn);
    expect(response.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${UPSTREAM}${expected}`);
  });

  it("forwards the mod files page with its parameters", async () => {
    const up = upstream(ok({ data: [{ id: 5, gameId: 1 }], pagination: { index: 0 } }));
    const response = await handle(get("/v1/mods/42/files?gameVersionTypeId=517&index=0&pageSize=50"), env(), up.fn);
    expect(response.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${UPSTREAM}/v1/mods/42/files?gameVersionTypeId=517&index=0&pageSize=50`);
    expect(await response.json()).toEqual({ data: [{ id: 5, gameId: 1 }], pagination: { index: 0 } });
  });

  it.each([
    ["/v1/fingerprints/1", '{"fingerprints":[123,4294967295]}'],
    ["/v1/mods", '{"modIds":[1,2]}'],
    ["/v1/mods/files", '{"fileIds":[10,20]}'],
  ])("forwards POST %s with a rebuilt body", async (path, body) => {
    const up = upstream(ok({ data: [] }));
    const response = await handle(post(path, ` ${body}\n`), env(), up.fn);
    expect(response.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${UPSTREAM}${path}`);
    expect(up.calls[0]!.init.body).toBe(body);
  });

  it.each([
    "/",
    "/v1",
    "/v2/mods/1",
    "/v1/mods/0",
    "/v1/mods/01",
    "/v1/mods/abc",
    "/v1/mods/99999999999",
    "/v1/mods/1/files/1/download-url",
    "/v1/games",
    "/v1/games/432/version-types",
    "/v1/fingerprints/432",
    "/v1/minecraft/version",
    "/v1/mods/1/",
  ])("does not know %s", async (path) => {
    const up = upstream();
    const response = await handle(get(path), env(), up.fn);
    expect(response.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it.each([
    "/v1/categories",
    "/v1/categories?gameId=432",
    "/v1/categories?gameId=1&classId=5",
    "/v1/mods/search",
    "/v1/mods/search?gameId=432",
    "/v1/mods/search?gameId=1&gameId=432",
    "/v1/mods/search?gameId=1&slug=x",
    "/v1/mods/search?gameId=1&pageSize=51",
    "/v1/mods/search?gameId=1&index=9999&pageSize=50",
    "/v1/mods/search?gameId=1&sortOrder=up",
    "/v1/mods/search?gameId=1&categoryId=-1",
    "/v1/mods/search?gameId=1&categoryId=1e3",
    `/v1/mods/search?gameId=1&searchFilter=${"a".repeat(201)}`,
    "/v1/mods/search?gameId=1&searchFilter=%0A",
    "/v1/mods/1?x=1",
    "/v1/mods/1/files?pageSize=500",
  ])("rejects the invalid request %s", async (path) => {
    const up = upstream();
    const response = await handle(get(path), env(), up.fn);
    expect(response.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("rejects the wrong method", async () => {
    for (const request of [
      post("/v1/mods/1", "{}"),
      get("/v1/fingerprints/1"),
      new Request("https://proxy.example.com/v1/mods/1", { method: "DELETE", headers: { "user-agent": UA } }),
    ]) {
      const up = upstream();
      expect((await handle(request, env(), up.fn)).status).toBe(405);
      expect(up.calls).toHaveLength(0);
    }
  });

  it.each([
    '{"modIds":[]}',
    '{"modIds":[1],"extra":1}',
    '{"modIds":["1"]}',
    '{"modIds":[1.5]}',
    '{"modIds":[-1]}',
    '{"modIds":[2147483648]}',
    '{"fileIds":[1]}',
    "[1]",
    "not json",
    `{"modIds":[${Array.from({ length: 10_001 }, (_, i) => i + 1).join(",")}]}`,
  ])("rejects the POST body %s", async (body) => {
    const up = upstream();
    const response = await handle(post("/v1/mods", body), env(), up.fn);
    expect(response.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("rejects a body over the size limit and one that is not JSON", async () => {
    const big = post("/v1/fingerprints/1", `{"fingerprints":[${"1,".repeat(200_000)}1]}`);
    expect((await handle(big, env(), upstream().fn)).status).toBe(413);
    const text = post("/v1/mods", '{"modIds":[1]}', { "content-type": "text/plain" });
    expect((await handle(text, env(), upstream().fn)).status).toBe(415);
  });
});

describe("only World of Warcraft comes back", () => {
  it("hides a mod of another game", async () => {
    const response = await handle(get("/v1/mods/7"), env(), upstream(ok({ data: { id: 7, gameId: 432 } })).fn);
    expect(response.status).toBe(404);
  });

  it("hides a mod whose game is missing", async () => {
    const response = await handle(get("/v1/mods/7"), env(), upstream(ok({ data: { id: 7 } })).fn);
    expect(response.status).toBe(404);
  });

  it("hides a file of another game", async () => {
    const response = await handle(get("/v1/mods/7/files/8"), env(), upstream(ok({ data: { id: 8, gameId: 432 } })).fn);
    expect(response.status).toBe(404);
  });

  it("hides the file list of another game", async () => {
    const response = await handle(
      get("/v1/mods/7/files"),
      env(),
      upstream(ok({ data: [{ id: 1, gameId: 1 }, { id: 2, gameId: 432 }] })).fn,
    );
    expect(response.status).toBe(404);
  });

  it("drops other games from POST lists", async () => {
    const response = await handle(
      post("/v1/mods", '{"modIds":[1,2]}'),
      env(),
      upstream(ok({ data: [{ id: 1, gameId: 1 }, { id: 2, gameId: 432 }] })).fn,
    );
    expect(await response.json()).toEqual({ data: [{ id: 1, gameId: 1 }] });
  });

  it("checks the mod before returning its description", async () => {
    const up = upstream(ok({ data: { id: 7, gameId: 1 } }), ok({ data: "<p>hi</p>" }));
    const response = await handle(get("/v1/mods/7/description"), env(), up.fn);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: "<p>hi</p>" });
    expect(up.calls.map((c) => c.url)).toEqual([`${UPSTREAM}/v1/mods/7`, `${UPSTREAM}/v1/mods/7/description`]);

    const other = upstream(ok({ data: { id: 7, gameId: 432 } }));
    expect((await handle(get("/v1/mods/7/description"), env(), other.fn)).status).toBe(404);
    expect(other.calls).toHaveLength(1);
  });
});

describe("responses", () => {
  it("are JSON, never cached, without CORS or upstream headers", async () => {
    const upstreamResponse = new Response(JSON.stringify({ data: { id: 1, gameId: 1 } }), {
      status: 200,
      headers: { "set-cookie": "a=b", "x-upstream": "1" },
    });
    const response = await handle(get("/v1/mods/1"), env(), upstream(upstreamResponse).fn);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([
    [400, 400],
    [404, 404],
    [429, 429],
    [302, 502],
    [500, 502],
    [503, 502],
  ])("map upstream status %i to %i", async (status, expected) => {
    const response = await handle(get("/v1/mods/1"), env(), upstream(new Response("x", { status })).fn);
    expect(response.status).toBe(expected);
  });

  it("turn an unreachable CurseForge into 502", async () => {
    const response = await handle(get("/v1/mods/1"), env(), upstream(new Error("down")).fn);
    expect(response.status).toBe(502);
  });

  it("log one line with no query string or client data", async () => {
    await handle(
      get("/v1/mods/search?gameId=1&searchFilter=secret+words", { "cf-connecting-ip": "192.0.2.1" }),
      env(),
      upstream(ok({ data: [] })).fn,
    );
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]!);
    expect(line).toMatchObject({ message: "request", method: "GET", route: "search", status: 200, upstream: 200 });
    expect(logs[0]).not.toContain("secret");
    expect(logs[0]).not.toContain("192.0.2.1");
    expect(logs[0]).not.toContain(UA);
  });
});

describe("the daily budget", () => {
  const today = utcDay(new Date());

  it("lets requests through and counts each one on the single global counter", async () => {
    const counter = budget();
    const up = upstream(ok({ data: [] }), ok({ data: [] }));
    const e = env({ DAILY_BUDGET: counter.binding });
    expect((await handle(get("/v1/games/1/version-types"), e, up.fn)).status).toBe(200);
    expect((await handle(get("/v1/games/1/version-types"), e, up.fn)).status).toBe(200);
    expect(counter.spent()).toEqual({ day: today, count: 2 });
    expect(counter.names).toEqual(["global", "global"]);
  });

  it("answers 503 without reaching CurseForge once today's limit is spent", async () => {
    const counter = budget({ day: today, count: 3 });
    const up = upstream();
    const response = await handle(get("/v1/mods/1"), env({ DAILY_LIMIT: "3", DAILY_BUDGET: counter.binding }), up.fn);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daily_limit" });
    expect(up.calls).toHaveLength(0);
    expect(counter.spent()).toEqual({ day: today, count: 3 });
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: 503, limited: "daily" });
  });

  it("stops asking the counter once it has refused today", async () => {
    const counter = budget({ day: today, count: 1 });
    const e = env({ DAILY_LIMIT: "1", DAILY_BUDGET: counter.binding });
    expect((await handle(get("/v1/mods/1"), e, upstream().fn)).status).toBe(503);
    expect((await handle(get("/v1/mods/1"), e, upstream().fn)).status).toBe(503);
    expect(counter.names).toHaveLength(1);
  });

  it("is not spent by requests refused before CurseForge", async () => {
    const counter = budget();
    const e = (overrides: Partial<Record<keyof Env, unknown>> = {}, allowed = true) =>
      env({ DAILY_BUDGET: counter.binding, ...overrides }, allowed);
    const up = upstream();
    await handle(get("/v1/mods/1", { origin: "https://example.com" }), e(), up.fn);
    await handle(get("/v1/mods/1", { "user-agent": "curl/8.0" }), e(), up.fn);
    await handle(get("/v1/nope"), e(), up.fn);
    await handle(get("/v1/mods/1"), e({}, false), up.fn);
    await handle(get("/v1/mods/1"), e({ PROXY_ENABLED: "false" }), up.fn);
    await handle(get("/v1/mods/1"), e({ CURSEFORGE_API_KEY: "" }), up.fn);
    expect(counter.names).toHaveLength(0);
    expect(counter.spent()).toBeUndefined();
  });

  it.each([undefined, "", "0", "-5", "1.5", "abc", "1e3", "01"])(
    "fails closed on DAILY_LIMIT %j",
    async (value) => {
      const counter = budget();
      const up = upstream();
      const response = await handle(get("/v1/mods/1"), env({ DAILY_LIMIT: value, DAILY_BUDGET: counter.binding }), up.fn);
      expect(response.status).toBe(503);
      expect(up.calls).toHaveLength(0);
      expect(counter.names).toHaveLength(0);
    },
  );
});

describe("spend", () => {
  const now = new Date("2026-10-29T23:59:59Z");

  it("counts up to the limit and then refuses", () => {
    expect(spend(undefined, now, 2)).toEqual({ state: { day: "2026-10-29", count: 1 }, allowed: true });
    expect(spend({ day: "2026-10-29", count: 1 }, now, 2)).toEqual({ state: { day: "2026-10-29", count: 2 }, allowed: true });
    expect(spend({ day: "2026-10-29", count: 2 }, now, 2)).toEqual({ state: { day: "2026-10-29", count: 2 }, allowed: false });
  });

  it("starts again at 00:00 UTC", () => {
    const next = new Date("2026-10-30T00:00:00Z");
    expect(spend({ day: "2026-10-29", count: 2 }, next, 2)).toEqual({ state: { day: "2026-10-30", count: 1 }, allowed: true });
  });

  it("reads DAILY_LIMIT only as a positive integer", () => {
    expect(dailyLimit("30000")).toBe(30000);
    expect(dailyLimit("1")).toBe(1);
    expect(dailyLimit(30000)).toBeUndefined();
    expect(dailyLimit("0")).toBeUndefined();
  });
});
