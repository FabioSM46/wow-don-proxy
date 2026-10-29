# Security model

WoW-don is a desktop app: anything shipped inside it, including an API key, can be read by
whoever installs it. This Worker exists so that the CurseForge API key is never shipped.

## What is guaranteed

- **The key never leaves Cloudflare.** It is a Worker secret (`wrangler secret put`), set by
  the operator and never written in this repository, in WoW-don or in any build. The Worker
  sends it only to `https://api.curseforge.com` in the `x-api-key` header. It is never put
  in a response, an error or a log line. Cloudflare traces do not record that header.
- **Only WoW-don's calls exist.** The Worker answers ten read-only routes (below). Any other
  path, method, query parameter or body field is rejected before CurseForge is contacted.
  The upstream request is rebuilt from validated values: the client's path, query and body
  are never forwarded as they are.
- **Only World of Warcraft data comes back.** `gameId=1` is forced where CurseForge accepts
  it. Where it does not (mods, files and descriptions looked up by id), the Worker checks the
  `gameId` of what CurseForge returns and answers 404 for any other game.
- **Nothing is stored.** No cache (CurseForge's third-party terms forbid caching API data),
  `Cache-Control: no-store` on every response, no database. Logs hold one line per request
  (route, status, duration) without query strings, client addresses or header values.

## What is not possible

**No server can prove that a request comes from WoW-don.** A secret or a signature inside
the app can be extracted, and desktop systems have no app attestation. The Worker checks the
`wow-don/<version>` user agent and rejects anything a browser sends (`Origin`,
`Sec-Fetch-Site`, no CORS), but these filter stray traffic: they are not authentication.

The design therefore assumes that anyone can call the Worker and limits what that is worth:
read-only access to CurseForge's public WoW catalogue, through ten fixed routes, never the
key, at a bounded volume:

- **Per client**: `RATE_LIMITER` allows 120 requests a minute per client address and
  Cloudflare location. WoW-don batches its lookups (up to 100 ids per call) and downloads
  zips from the CDN, so a real user stays far below it.
- **Globally**: `DAILY_LIMIT` (30,000) caps the requests sent to CurseForge per UTC day,
  counted by one Durable Object (`DailyBudget`) across every client and location. Past it
  every request gets `503 daily_limit` until 00:00 UTC. Only valid requests about to reach
  CurseForge spend it. Whatever anyone does, the key's traffic never exceeds this volume.

What this does not bound is the Worker's own quota (100,000 requests a day on the free plan):
a refused request still runs the Worker. A flood from many addresses can exhaust it, and the
Worker then stops answering until 00:00 UTC. That is an outage, not a cost and not a risk to
the key. Stopping such traffic before the Worker would need a WAF rate-limiting rule, which
applies only on a custom domain, not on `workers.dev`.

## Use by other builds

The Worker serves the official WoW-don builds. A fork or a different app must use its own
CurseForge key and its own deployment of this Worker, not this one.

## Routes

| Method | Path | Check |
| ------ | ---- | ----- |
| GET  | `/v1/mods/search?gameId=1&…` | `gameId` forced; known parameters only, bounded |
| GET  | `/v1/categories?gameId=1` | `gameId` forced |
| GET  | `/v1/games/1/version-types` | WoW only |
| GET  | `/v1/mods/{modId}` | result must be WoW |
| GET  | `/v1/mods/{modId}/description` | the mod is looked up first and must be WoW |
| GET  | `/v1/mods/{modId}/files?gameVersionTypeId&index&pageSize` | every file must be WoW |
| GET  | `/v1/mods/{modId}/files/{fileId}` | result must be WoW |
| POST | `/v1/mods` `{"modIds":[…]}` | other games dropped |
| POST | `/v1/mods/files` `{"fileIds":[…]}` | other games dropped |
| POST | `/v1/fingerprints/1` `{"fingerprints":[…]}` | WoW only |

Downloads do not go through the Worker: the zips are on CurseForge's CDN, which needs no key.

## Operating

- **Kill switch**: set `PROXY_ENABLED` to anything but `true` and every request gets 503.
- **Daily cap**: `DAILY_LIMIT` in `wrangler.jsonc`, a positive integer; anything else makes
  every request 503. Requests refused by it log `"limited": "daily"`.
- **Key rotation**: `wrangler secret put CURSEFORGE_API_KEY` with the new key, then revoke
  the old one in the CurseForge console. WoW-don needs no new release.
- **A rejected key** shows as `upstream rejected the key` at error level in Workers Logs;
  clients only see `502 upstream_error`.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/FabioSM46/wow-don-proxy/security/advisories/new)
rather than a public issue.
