# pi-usage-bar

[npm](https://www.npmjs.com/package/@satas/pi-usage-bar) · [source](https://github.com/satas20/pi-usage-bar)

An AI subscription usage gauge for the [pi coding agent](https://github.com/badlogic/pi-mono).

Shows how much of your coding-plan quota you've used and how long until it
resets, in a widget just below the editor. Supports **Claude Pro/Max** and
**ChatGPT Plus/Pro (Codex)** — each optional, each with per-window toggles.
It also watches each vendor's public status page and prepends a color-coded
`!` marker when there's an active incident — so you know it's them, not you.

```
 ▓▓▓▓░░ 65% · 0h 11m
```

With multiple windows/providers enabled:

```
 cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h   oai ▓░░░░ 12% · 3h 4m
```

During a vendor incident:

```
 ! cld ▓▓▓▓░ 65% · 0h 11m
```

- Bar color escalates with usage: **green** < 50%, **amber** 50–85%,
  **red** > 85%.
- The countdown ticks live; usage refreshes every 2 minutes (with backoff on
  failures — these endpoints throttle aggressive polling).
- Last known values are cached, so the bar appears instantly on restart.
- Providers hide silently when credentials are missing/expired or a fetch
  fails; the whole widget hides when nothing is available.
- Provider prefixes (`cld`/`oai`) appear only when two or more providers are
  visible; window labels (`5h`/`7d`/…) appear only when a provider shows two
  or more windows.
- The `!` status marker is **red** for critical/major incidents, **amber**
  for minor, **accent** for maintenance.

## Install

```sh
pi install npm:@satas/pi-usage-bar
```

Or add it manually to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["npm:@satas/pi-usage-bar"]
}
```

To try it without installing:

```sh
git clone https://github.com/satas20/pi-usage-bar.git
pi -e ./pi-usage-bar/extensions/usage-bar.ts
```

## Configuration

On first run the extension creates `~/.pi/agent/usage-bar.json` with defaults
(Claude enabled, 5-hour window only). Edit it and restart pi; the config is
read once per session.

```jsonc
{
  "ui": {
    "show_bars": true,     // render ▓▓░░ mini-bars (false = text only)
    "show_status": true    // vendor status-page incident marker (!)
    // "bar_width": 6      // override bar width (default: 6 for a single window, 5 otherwise)
  },
  "anthropic": {
    "enabled": true,       // Claude Pro/Max via ~/.claude/.credentials.json
    "show_5h": true,       // rolling 5-hour session window
    "show_7d": false,      // weekly cap across all models
    "show_model": false    // per-model weekly windows (e.g. Fable)
    // "credentials_path": "~/.claude/.credentials.json"
  },
  "openai": {
    "enabled": false,      // ChatGPT Plus/Pro via the Codex CLI login
    "show_5h": true,
    "show_7d": false
    // "codex_auth_path": "~/.codex/auth.json"
  }
}
```

## Providers & data sources

| Provider | Credentials (first match wins) | Usage endpoint | Status endpoint | Windows |
|---|---|---|---|---|
| `anthropic` | Claude Code's `~/.claude/.credentials.json` → pi's auth store | `api.anthropic.com/api/oauth/usage` (what Claude Code's `/usage` uses) | `status.anthropic.com` | 5h session, 7d all-models, 7d per-model |
| `openai` | Codex CLI's `~/.codex/auth.json` → pi's auth store | `chatgpt.com/backend-api/wham/usage` | `status.openai.com` | 5h session, 7d weekly |

If you log in through pi itself (`/login`), everything works with zero extra
setup — the extension falls back to pi's own auth store
(`~/.pi/agent/auth.json`). All credential access is **read-only**; expired
tokens simply hide the provider until the owning CLI refreshes them.

**Security note:** each credential is read from disk and sent **only** to its
own provider's API host, over HTTPS, to fetch usage numbers. Status pages are
public Statuspage JSON endpoints fetched **without any credentials**. Nothing
else is read, stored, or transmitted. Both usage endpoints are
undocumented/internal (the same ones the vendors' own tooling uses) and may
change without notice.

## Develop

```sh
npm install         # dev deps (typescript, pi types)
npm run typecheck   # tsc --noEmit
pi -e ./extensions/usage-bar.ts   # run pi with your working copy
```

No build step — pi loads TypeScript extensions directly.

## Sibling project

Using [opencode](https://opencode.ai) too? The same gauge exists as
[`@satas/opencode-usage-bar`](https://github.com/satas20/opencode-usage-bar).

## Roadmap

- GLM coding plan (z.ai) provider.
- Anthropic/OpenAI OAuth token auto-refresh (both credential files include a
  refresh token; for now the respective CLIs keep them fresh).

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) (tested with >= 0.80)
- Node 20+ (pi's own requirement)

## Contributing

Contributions welcome — especially new providers (see the checklist in
[CONTRIBUTING.md](CONTRIBUTING.md)). The whole extension is a single file
with zero runtime dependencies.

## License

MIT
