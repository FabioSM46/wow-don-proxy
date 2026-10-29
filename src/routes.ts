// The closed list of CurseForge calls WoW-don makes. A request that does not match one of
// these exactly is rejected before anything reaches CurseForge, and the upstream request is
// rebuilt from the validated values: the client's path, query and body are never forwarded.

export const WOW_GAME_ID = 1;

/** Largest id CurseForge uses for mods, files, categories and version types (int32). */
const MAX_ID = 2_147_483_647;
/** Largest fingerprint (uint32). */
const MAX_FINGERPRINT = 4_294_967_295;
/** CurseForge rejects searches with `index + pageSize` beyond this value. */
const MAX_SEARCH_RESULTS = 10_000;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_FILTER = 200;
/** Ids per POST body: a large addon folder sends one fingerprint per addon folder. */
export const MAX_IDS = 10_000;

/** How the proxy checks that a response belongs to World of Warcraft. */
export type GameCheck =
  /** The request already scopes CurseForge to WoW (`gameId=1` in the path or query). */
  | "scoped"
  /** `data` is one object whose `gameId` must be WoW, otherwise 404. */
  | "object"
  /** `data` is a list: every item must be WoW, otherwise 404. */
  | "list"
  /** `data` is a list: items of other games are dropped. */
  | "filter"
  /** The response has no `gameId`: the mod is looked up first and must be WoW. */
  | "mod-lookup";

export interface Route {
  /** Stable name for logs. */
  name: string;
  method: "GET" | "POST";
  /** Path and query sent to CurseForge, built only from validated values. */
  upstreamPath: string;
  body?: string;
  check: GameCheck;
  /** For `mod-lookup`: the mod whose game is checked. */
  modId?: number;
}

export class InvalidRequest extends Error {}

export type Match = Route | "not-found" | "method-not-allowed";

function id(segment: string | undefined, max = MAX_ID): number | null {
  if (segment === undefined || !/^[1-9][0-9]{0,9}$/.test(segment)) return null;
  const value = Number(segment);
  return value <= max ? value : null;
}

function bounded(value: string, min: number, max: number): number {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new InvalidRequest("invalid number");
  const n = Number(value);
  if (n < min || n > max) throw new InvalidRequest("number out of range");
  return n;
}

/** The query as a map; repeated or unknown parameters are an error. */
function query(url: URL, allowed: readonly string[]): Map<string, string> {
  const params = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || params.has(name)) {
      throw new InvalidRequest("unexpected query parameter");
    }
    params.set(name, value);
  }
  return params;
}

function noQuery(url: URL): void {
  if (url.search !== "") throw new InvalidRequest("unexpected query");
}

function requireGameId(params: Map<string, string>): void {
  if (params.get("gameId") !== String(WOW_GAME_ID)) throw new InvalidRequest("gameId must be 1");
}

function search(url: URL): Route {
  const params = query(url, [
    "gameId",
    "searchFilter",
    "categoryId",
    "gameVersionTypeId",
    "sortField",
    "sortOrder",
    "index",
    "pageSize",
  ]);
  requireGameId(params);
  const out = new URLSearchParams({ gameId: String(WOW_GAME_ID) });
  const filter = params.get("searchFilter");
  if (filter !== undefined) {
    if (filter.length > MAX_SEARCH_FILTER || /[\u0000-\u001f\u007f]/.test(filter)) {
      throw new InvalidRequest("invalid searchFilter");
    }
    out.set("searchFilter", filter);
  }
  for (const name of ["categoryId", "gameVersionTypeId"]) {
    const value = params.get(name);
    if (value !== undefined) out.set(name, String(bounded(value, 1, MAX_ID)));
  }
  const sortField = params.get("sortField");
  if (sortField !== undefined) out.set("sortField", String(bounded(sortField, 1, 20)));
  const sortOrder = params.get("sortOrder");
  if (sortOrder !== undefined) {
    if (sortOrder !== "asc" && sortOrder !== "desc") throw new InvalidRequest("invalid sortOrder");
    out.set("sortOrder", sortOrder);
  }
  const index = bounded(params.get("index") ?? "0", 0, MAX_SEARCH_RESULTS - 1);
  const pageSize = bounded(params.get("pageSize") ?? String(MAX_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  if (index + pageSize > MAX_SEARCH_RESULTS) throw new InvalidRequest("index beyond the limit");
  if (params.has("index")) out.set("index", String(index));
  if (params.has("pageSize")) out.set("pageSize", String(pageSize));
  return { name: "search", method: "GET", upstreamPath: `/v1/mods/search?${out}`, check: "scoped" };
}

function modFiles(url: URL, modId: number): Route {
  const params = query(url, ["gameVersionTypeId", "index", "pageSize"]);
  const out = new URLSearchParams();
  const versionType = params.get("gameVersionTypeId");
  if (versionType !== undefined) out.set("gameVersionTypeId", String(bounded(versionType, 1, MAX_ID)));
  const index = params.get("index");
  if (index !== undefined) out.set("index", String(bounded(index, 0, MAX_SEARCH_RESULTS - 1)));
  const pageSize = params.get("pageSize");
  if (pageSize !== undefined) out.set("pageSize", String(bounded(pageSize, 1, MAX_PAGE_SIZE)));
  const suffix = out.size > 0 ? `?${out}` : "";
  return { name: "mod-files", method: "GET", upstreamPath: `/v1/mods/${modId}/files${suffix}`, check: "list" };
}

/** A JSON body `{ <field>: [ids] }` with nothing else, re-serialized. */
export function idsBody(raw: string, field: string, max: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequest("body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequest("body is not an object");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== field) throw new InvalidRequest("unexpected body fields");
  const ids = (parsed as Record<string, unknown>)[field];
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
    throw new InvalidRequest("invalid id list");
  }
  for (const value of ids) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
      throw new InvalidRequest("invalid id");
    }
  }
  return JSON.stringify({ [field]: ids });
}

/**
 * The route for `method` and `url`. POST routes are returned without `body`: the caller
 * reads the body (with a size limit) and fills it with {@link idsBody}.
 */
export function match(method: string, url: URL): Match {
  const segments = url.pathname.split("/");
  // "/v1/mods/123" → ["", "v1", "mods", "123"]
  if (segments[0] !== "" || segments[1] !== "v1") return "not-found";
  const rest = segments.slice(2);
  const get = method === "GET";
  const post = method === "POST";
  const only = (allowed: boolean, route: () => Route): Match =>
    allowed ? route() : "method-not-allowed";

  switch (rest.length) {
    case 1:
      if (rest[0] === "categories") {
        return only(get, () => {
          const params = query(url, ["gameId"]);
          requireGameId(params);
          return { name: "categories", method: "GET", upstreamPath: `/v1/categories?gameId=${WOW_GAME_ID}`, check: "scoped" };
        });
      }
      if (rest[0] === "mods") {
        return only(post, () => {
          noQuery(url);
          return { name: "mods", method: "POST", upstreamPath: "/v1/mods", check: "filter" };
        });
      }
      return "not-found";
    case 2: {
      if (rest[0] === "mods" && rest[1] === "search") return only(get, () => search(url));
      if (rest[0] === "mods" && rest[1] === "files") {
        return only(post, () => {
          noQuery(url);
          return { name: "files", method: "POST", upstreamPath: "/v1/mods/files", check: "filter" };
        });
      }
      if (rest[0] === "fingerprints" && rest[1] === String(WOW_GAME_ID)) {
        return only(post, () => {
          noQuery(url);
          return { name: "fingerprints", method: "POST", upstreamPath: `/v1/fingerprints/${WOW_GAME_ID}`, check: "scoped" };
        });
      }
      const modId = rest[0] === "mods" ? id(rest[1]) : null;
      if (modId !== null) {
        return only(get, () => {
          noQuery(url);
          return { name: "mod", method: "GET", upstreamPath: `/v1/mods/${modId}`, check: "object" };
        });
      }
      return "not-found";
    }
    case 3: {
      if (rest[0] === "games" && rest[1] === String(WOW_GAME_ID) && rest[2] === "version-types") {
        return only(get, () => {
          noQuery(url);
          return { name: "version-types", method: "GET", upstreamPath: `/v1/games/${WOW_GAME_ID}/version-types`, check: "scoped" };
        });
      }
      const modId = rest[0] === "mods" ? id(rest[1]) : null;
      if (modId !== null && rest[2] === "description") {
        return only(get, () => {
          noQuery(url);
          return { name: "description", method: "GET", upstreamPath: `/v1/mods/${modId}/description`, check: "mod-lookup", modId };
        });
      }
      if (modId !== null && rest[2] === "files") return only(get, () => modFiles(url, modId));
      return "not-found";
    }
    case 4: {
      const modId = rest[0] === "mods" ? id(rest[1]) : null;
      const fileId = rest[2] === "files" ? id(rest[3]) : null;
      if (modId !== null && fileId !== null) {
        return only(get, () => {
          noQuery(url);
          return { name: "file", method: "GET", upstreamPath: `/v1/mods/${modId}/files/${fileId}`, check: "object" };
        });
      }
      return "not-found";
    }
    default:
      return "not-found";
  }
}

/** The POST body field and id bound of each POST route. */
export const POST_BODIES: Record<string, { field: string; max: number }> = {
  mods: { field: "modIds", max: MAX_ID },
  files: { field: "fileIds", max: MAX_ID },
  fingerprints: { field: "fingerprints", max: MAX_FINGERPRINT },
};
