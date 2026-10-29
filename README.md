# wow-don-proxy

A Cloudflare Worker that lets [WoW-don](https://github.com/FabioSM46/wow-don) reach the
CurseForge API without shipping the API key in the app. The key lives only in the Worker's
secrets; the app calls the Worker, which answers a closed list of read-only, World of
Warcraft-only routes. See [SECURITY.md](SECURITY.md) for the model and its limits.

It is meant for the official WoW-don builds only: forks and other apps must deploy their own
copy with their own CurseForge key.

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm typecheck   # also fails when worker-configuration.d.ts is stale: run `pnpm types`
pnpm test
```

Tests replace CurseForge with a fake and never use a real key.

## Deploying

Done by the operator, from this folder (the Worker's name comes from `wrangler.jsonc`):

```sh
pnpm exec wrangler login
pnpm exec wrangler deploy
pnpm exec wrangler secret put CURSEFORGE_API_KEY   # prompts for the value, no quotes
```

The Worker runs at `https://wow-don-proxy.fabiosm46.workers.dev`; WoW-don's backend calls it
there (WoW-don decision D44). Deploy first, then set the secret: `wrangler secret put` on a
Worker that does not exist yet creates an empty placeholder.

## License

GPL-3.0-or-later, like WoW-don.
