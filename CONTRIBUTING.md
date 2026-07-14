# Contributing to pi-usage-bar

Thanks for your interest! This is a small, focused extension — the whole thing
is one file (`extensions/usage-bar.ts`) with zero runtime dependencies, so
most contributions are quick to make and quick to review.

## Prerequisites

- Node 20+
- The [pi coding agent](https://github.com/badlogic/pi-mono) to test the UI
  integration

## Setup

```sh
git clone https://github.com/satas20/pi-usage-bar.git
cd pi-usage-bar
npm install
```

## Development loop

No build step — pi loads TypeScript extensions directly (via jiti). Run pi
with your working copy:

```sh
pi -e ./extensions/usage-bar.ts
```

The extension's config lives in `~/.pi/agent/usage-bar.json` — enable the
providers you have credentials for. Config is read once per session, so
restart pi after changing it.

Before opening a PR, make sure the gate passes:

```sh
npm run typecheck   # tsc --noEmit
```

## Project layout

| Path | Purpose |
|---|---|
| `extensions/usage-bar.ts` | The entire extension: types, providers, config, rendering |
| `package.json` | npm metadata + `"pi": { "extensions": ["./extensions"] }` |

Inside `extensions/usage-bar.ts`, top to bottom: helpers → pi auth store
fallback → providers → config (defaults, parsing, loading) → cache → the
extension entry (session lifecycle, polling, rendering).

## Extension lifecycle rules

pi has strict rules for extensions, and this one follows them:

- **Nothing starts in the factory.** Timers and polling start on
  `session_start` and are torn down on `session_shutdown` (idempotent
  `stop()`).
- **Headless-safe.** `ctx.hasUI` is checked before anything else; in
  `pi -p` / CI runs the extension is a complete no-op.
- **Footer status, not widget.** The bar renders via `ctx.ui.setStatus(...)`
  as the last line of pi's footer (below pwd and stats), and is cleared on
  shutdown. `setStatus` sanitizes by collapsing multiple spaces, so the
  multi-provider separator is `│` instead of raw spaces.

## Adding a provider

The most valuable contribution! Each provider is a small object implementing:

```ts
type Provider = {
  id: ProviderId          // add your id to the ProviderId union
  short: string           // 3-letter prefix, e.g. "cld", "oai"
  statusUrl?: string      // optional: a Statuspage-style status.json endpoint
  fetchUsage(cfg: ProviderConfig): Promise<UsageWindow[] | null>
}
```

Checklist:

1. Add the id to the `ProviderId` union.
2. Implement the provider object; return `UsageWindow[]` (each window has a
   `category` of `"5h" | "7d" | "model" | "mo"`, a `percent` 0–100, and `resetsAt`
   epoch ms) or `null` when credentials are missing/expired or the fetch fails.
3. Add it to the `providers` array.
4. Add a section to `DEFAULT_CONFIG_JSON`, an entry in `defaultConfig()`, and
   any provider-specific keys to `parseConfig()`.
5. Document it in the README's config example and providers table.

Ground rules for providers:

- **Read-only credentials.** Never write, refresh, or rewrite another tool's
  auth files. If a token is expired, return `null` — the provider simply hides.
- **Tokens go only to their own vendor's API host**, over HTTPS. No
  third-party hosts, no telemetry, nothing else.
- **Fail silently.** Any error → `null`. The bar must never break the TUI.
- **Be gentle with endpoints.** These are undocumented/internal APIs that
  throttle aggressive polling; the shared poll loop (2 min + backoff) already
  handles cadence — don't add extra requests per poll.
- **Zero runtime dependencies.** Node builtins and `fetch` only.

## Pull requests

- Keep PRs small and focused (one fix/feature per PR).
- Commit style: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`.
- Describe how you tested (which providers/plans you ran it against, or that
  you verified the fallback paths).
- CI runs `typecheck` on every PR; it must pass.

## Reporting bugs

Open an issue at
[github.com/satas20/pi-usage-bar/issues](https://github.com/satas20/pi-usage-bar/issues)
with your pi version, extension version, `usage-bar.json` (it contains no
secrets), and what the bar showed vs. what you expected.
