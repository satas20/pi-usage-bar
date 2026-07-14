/**
 * pi-usage-bar — AI subscription usage gauge for the pi coding agent.
 *
 * Renders a compact usage strip in the footer status line:
 *
 *   ▓▓▓▓░░ 65% · 0h 11m                                  (one window)
 *   cld ▓▓▓▓░ 65% · 0h 11m  7d ▓░░░░ 19% · 1d 11h │ oai ▓░░░░ 12% · 3h 4m
 *   ! cld ▓▓▓▓░ 65% · 0h 11m                             (anthropic incident)
 *
 * Providers:
 *   anthropic — Claude Pro/Max via the OAuth token in ~/.claude/.credentials.json
 *   openai    — ChatGPT Plus/Pro via the Codex CLI login in ~/.codex/auth.json
 *
 * When a provider's public status page reports an incident, a colored `!`
 * marker appears next to its prefix (red = major/critical, amber = minor,
 * accent = maintenance). Disable with `"show_status": false` under `"ui"`.
 *
 * Configured via ~/.pi/agent/usage-bar.json (auto-created with defaults on
 * first run; read once per session). Tokens are read-only and only ever sent
 * to their own provider's API host.
 *
 * Install:  pi install npm:@satas/pi-usage-bar
 * Try it:   pi -e ./extensions/usage-bar.ts
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const POLL_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "usage-bar.json");
const CACHE_FILE = join(AGENT_DIR, "usage-bar-cache.json");
const WIDGET_KEY = "usage-bar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which quota window a value belongs to; toggled per provider in config. */
type WindowCategory = "5h" | "7d" | "model";

/** Provider health from the vendor's public status page (Statuspage schema). */
type StatusIndicator = "none" | "minor" | "major" | "critical" | "maintenance";

type UsageWindow = {
  category: WindowCategory;
  /** short display label, e.g. "5h", "7d", "Fable" */
  label: string;
  /** 0–100 percent of the window used */
  percent: number;
  /** epoch ms when the window resets */
  resetsAt: number;
};

type ProviderId = "anthropic" | "openai";

type ProviderConfig = {
  enabled: boolean;
  show: Record<WindowCategory, boolean>;
  /** anthropic: path to .credentials.json */
  credentialsPath?: string;
  /** openai: path to Codex auth.json */
  codexAuthPath?: string;
};

type UsageBarConfig = {
  showBars: boolean;
  showStatus: boolean;
  barWidth?: number;
  providers: Record<ProviderId, ProviderConfig>;
};

type Provider = {
  id: ProviderId;
  /** short prefix shown when multiple providers are visible */
  short: string;
  /** vendor status page JSON endpoint (Statuspage `status.json`); optional */
  statusUrl?: string;
  fetchUsage(cfg: ProviderConfig): Promise<UsageWindow[] | null>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string) {
  return p === "~"
    ? homedir()
    : p.startsWith("~/")
      ? join(homedir(), p.slice(2))
      : p;
}

function fmtDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Decode a JWT's `exp` claim (unix seconds) without verifying. 0 on failure. */
function jwtExp(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      exp?: number;
    };
    return typeof claims.exp === "number" ? claims.exp : 0;
  } catch {
    return 0;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch a vendor's overall status from its public Statuspage JSON endpoint.
 *  Returns the `indicator` ("none" when healthy), or `null` when the fetch
 *  itself failed — so a network blip never clears a known incident. */
async function fetchStatus(url: string): Promise<StatusIndicator | null> {
  const data = (await fetchJson(url, {})) as {
    status?: { indicator?: string };
  } | null;
  if (!data?.status) return null;
  const indicator = data.status.indicator;
  return indicator === "minor" ||
    indicator === "major" ||
    indicator === "critical" ||
    indicator === "maintenance"
    ? indicator
    : "none";
}

// ---------------------------------------------------------------------------
// pi auth store (fallback credential source)
// ---------------------------------------------------------------------------

type PiAuthEntry = {
  type?: string;
  access?: string;
  expires?: number; // epoch ms; 0 = no expiry
  accountId?: string;
};

/** Read a provider's entry from pi's own auth store (`/login` in pi).
 *  Returns null when missing/unreadable. */
async function piAuth(id: string): Promise<PiAuthEntry | null> {
  try {
    const auth = JSON.parse(
      await readFile(join(AGENT_DIR, "auth.json"), "utf8"),
    ) as Record<string, PiAuthEntry>;
    return auth[id] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Claude Pro/Max — Anthropic's OAuth usage endpoint (same one Claude Code's
 *  `/usage` uses). Token from ~/.claude/.credentials.json, falling back to
 *  pi's own auth store; read-only; sent only to api.anthropic.com. */
const anthropicProvider: Provider = {
  id: "anthropic",
  short: "cld",
  statusUrl: "https://status.anthropic.com/api/v2/status.json",
  async fetchUsage(cfg) {
    let token: string | undefined;
    try {
      const path = expandTilde(
        cfg.credentialsPath ?? join(homedir(), ".claude", ".credentials.json"),
      );
      const creds = JSON.parse(await readFile(path, "utf8")) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      };
      const oauth = creds.claudeAiOauth;
      if (
        oauth?.accessToken &&
        !(oauth.expiresAt && Date.now() >= oauth.expiresAt)
      )
        token = oauth.accessToken;
    } catch {
      // fall through to pi's auth store
    }
    if (!token) {
      const entry = await piAuth("anthropic");
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires))
        token = entry.access;
    }
    if (!token) return null;

    const data = (await fetchJson("https://api.anthropic.com/api/oauth/usage", {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    })) as {
      limits?: Array<{
        kind?: string;
        percent?: number;
        resets_at?: string;
        scope?: { model?: { display_name?: string | null } | null } | null;
      }>;
    } | null;
    if (!data || !Array.isArray(data.limits)) return null;

    const windows: UsageWindow[] = [];
    for (const limit of data.limits) {
      if (
        !limit ||
        typeof limit.percent !== "number" ||
        !Number.isFinite(limit.percent)
      )
        continue;
      if (!limit.kind || !limit.resets_at) continue;
      const resetsAt = Date.parse(limit.resets_at);
      if (Number.isNaN(resetsAt)) continue;
      const category: WindowCategory =
        limit.kind === "session"
          ? "5h"
          : limit.kind === "weekly_all"
            ? "7d"
            : "model";
      const label =
        category === "model"
          ? (limit.scope?.model?.display_name ?? "model")
          : category;
      windows.push({ category, label, percent: limit.percent, resetsAt });
    }
    // Session window first, then the rest in API order.
    windows.sort(
      (a, b) => Number(b.category === "5h") - Number(a.category === "5h"),
    );
    return windows.length > 0 ? windows : null;
  },
};

/** ChatGPT Plus/Pro (Codex) — reads the Codex CLI login and asks the wham
 *  usage endpoint. Read-only: never refreshes/rewrites auth.json; when the
 *  token is expired we simply hide (Codex CLI refreshes the file itself). */
const openaiProvider: Provider = {
  id: "openai",
  short: "oai",
  statusUrl: "https://status.openai.com/api/v2/status.json",
  async fetchUsage(cfg) {
    let accessToken: string | undefined;
    let accountId: string | undefined;
    try {
      const path = expandTilde(
        cfg.codexAuthPath ?? join(homedir(), ".codex", "auth.json"),
      );
      const auth = JSON.parse(await readFile(path, "utf8")) as {
        tokens?: {
          access_token?: string;
          id_token?: string;
          account_id?: string;
        };
      };
      const tokens = auth.tokens;
      // Expiry lives in the id_token JWT; skip when (nearly) expired.
      const exp = tokens?.id_token ? jwtExp(tokens.id_token) : 0;
      if (
        tokens?.access_token &&
        !(exp > 0 && exp * 1000 <= Date.now() + 60_000)
      ) {
        accessToken = tokens.access_token;
        accountId = tokens.account_id;
      }
    } catch {
      // fall through to pi's auth store
    }
    if (!accessToken) {
      const entry = await piAuth("openai-codex");
      if (entry?.access && !(entry.expires && Date.now() >= entry.expires)) {
        accessToken = entry.access;
        accountId = entry.accountId;
      }
    }
    if (!accessToken) return null;

    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "codex-cli",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;

    const data = (await fetchJson(
      "https://chatgpt.com/backend-api/wham/usage",
      headers,
    )) as {
      rate_limit?: {
        primary_window?: WhamWindow | null;
        secondary_window?: WhamWindow | null;
      };
    } | null;
    if (!data?.rate_limit) return null;

    // Classify by window duration when present (some accounts return the
    // weekly window as primary_window), falling back to position.
    const windows: UsageWindow[] = [];
    const primary = parseWhamWindow(data.rate_limit.primary_window, "5h");
    if (primary) windows.push(primary);
    const secondary = parseWhamWindow(data.rate_limit.secondary_window, "7d");
    if (secondary) windows.push(secondary);
    windows.sort(
      (a, b) => Number(b.category === "5h") - Number(a.category === "5h"),
    );
    return windows.length > 0 ? windows : null;
  },
};

type WhamWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

function parseWhamWindow(
  w: WhamWindow | null | undefined,
  fallback: WindowCategory,
): UsageWindow | null {
  if (
    !w ||
    typeof w.used_percent !== "number" ||
    !Number.isFinite(w.used_percent)
  )
    return null;
  let resetsAt: number | undefined;
  if (typeof w.reset_at === "number") resetsAt = w.reset_at * 1000;
  else if (typeof w.reset_after_seconds === "number")
    resetsAt = Date.now() + w.reset_after_seconds * 1000;
  if (!resetsAt || !Number.isFinite(resetsAt)) return null;
  const category: WindowCategory =
    typeof w.limit_window_seconds === "number" && w.limit_window_seconds > 0
      ? w.limit_window_seconds <= 21_600 // ≤ 6h → session window
        ? "5h"
        : "7d"
      : fallback;
  return { category, label: category, percent: w.used_percent, resetsAt };
}

const providers: Provider[] = [anthropicProvider, openaiProvider];

// ---------------------------------------------------------------------------
// Config — ~/.pi/agent/usage-bar.json, auto-created with defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_JSON = `{
  "ui": {
    "show_bars": true,
    "show_status": true
  },
  "anthropic": {
    "enabled": true,
    "show_5h": true,
    "show_7d": false,
    "show_model": false
  },
  "openai": {
    "enabled": false,
    "show_5h": true,
    "show_7d": false
  }
}
`;

function defaultConfig(): UsageBarConfig {
  const show = (): Record<WindowCategory, boolean> => ({
    "5h": true,
    "7d": false,
    model: false,
  });
  return {
    showBars: true,
    showStatus: true,
    providers: {
      anthropic: { enabled: true, show: show() },
      openai: { enabled: false, show: show() },
    },
  };
}

type JsonTable = Record<string, unknown>;

function asTable(v: unknown): JsonTable {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonTable)
    : {};
}

function bool(v: unknown, fallback: boolean) {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseConfig(raw: string): UsageBarConfig {
  const root = asTable(JSON.parse(raw));
  const cfg = defaultConfig();

  const ui = asTable(root["ui"]);
  cfg.showBars = bool(ui["show_bars"], cfg.showBars);
  cfg.showStatus = bool(ui["show_status"], cfg.showStatus);
  const rawWidth = ui["bar_width"];
  if (
    typeof rawWidth === "number" &&
    Number.isFinite(rawWidth) &&
    rawWidth >= 1
  )
    cfg.barWidth = Math.min(40, Math.floor(rawWidth));

  for (const id of ["anthropic", "openai"] as ProviderId[]) {
    const t = asTable(root[id]);
    const p = cfg.providers[id];
    p.enabled = bool(t["enabled"], p.enabled);
    p.show["5h"] = bool(t["show_5h"], p.show["5h"]);
    p.show["7d"] = bool(t["show_7d"], p.show["7d"]);
    p.show.model = bool(t["show_model"], p.show.model);
    if (id === "anthropic") p.credentialsPath = str(t["credentials_path"]);
    if (id === "openai") p.codexAuthPath = str(t["codex_auth_path"]);
  }
  return cfg;
}

/** Load ~/.pi/agent/usage-bar.json, creating it with defaults on first run.
 *  Any failure falls back to defaults without touching an existing file. */
async function loadConfig(): Promise<UsageBarConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    try {
      return parseConfig(raw);
    } catch {
      return defaultConfig(); // malformed JSON — keep the file, use defaults
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      try {
        await mkdir(AGENT_DIR, { recursive: true });
        await writeFile(CONFIG_FILE, DEFAULT_CONFIG_JSON, { flag: "wx" });
      } catch {
        // ignore — config stays default in memory
      }
    }
    return defaultConfig();
  }
}

// ---------------------------------------------------------------------------
// Cache — last known windows, so the bar appears instantly on restart
// ---------------------------------------------------------------------------

type UsageCache = Partial<Record<ProviderId, UsageWindow[]>>;

async function readCache(): Promise<UsageCache> {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, "utf8")) as UsageCache;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function writeCache(cache: UsageCache): Promise<void> {
  try {
    await mkdir(AGENT_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // best-effort — cache is an optimization only
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // One pending poll timer per provider (replaced on every reschedule).
  const timers = new Map<ProviderId, ReturnType<typeof setTimeout>>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  // Bumped on every start/stop; in-flight polls from a previous session
  // compare against it and bail instead of rendering into a stale UI or
  // rescheduling themselves (which would double the polling forever).
  let generation = 0;
  let started = false;
  let lastLine: string | undefined;

  const stop = (ctx?: ExtensionContext) => {
    generation++;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    started = false;
    lastLine = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(WIDGET_KEY, undefined);
  };

  pi.on("session_shutdown", async (_event, ctx) => stop(ctx));

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return; // print/RPC mode — no UI to render into
    if (started) return; // session switch within the same runtime
    started = true;
    const gen = ++generation;

    const config = await loadConfig();
    const enabled = providers.filter((p) => config.providers[p.id].enabled);
    if (enabled.length === 0) return; // nothing to poll or render

    const byProvider: UsageCache = {};
    // Usage is seeded from the cache so the bar appears instantly; status is
    // deliberately not cached across restarts (incidents are short-lived, and
    // the first poll lands seconds after startup anyway). The seed is filtered
    // through the *current* config so stale window kinds don't flash.
    const cached = await readCache();
    for (const p of enabled) {
      const windows = cached[p.id];
      if (Array.isArray(windows))
        byProvider[p.id] = windows.filter(
          (w) => config.providers[p.id].show[w.category],
        );
    }
    if (gen !== generation) return; // stopped while awaiting
    const byStatus: Partial<Record<ProviderId, StatusIndicator>> = {};

    // -- rendering ----------------------------------------------------------

    const render = () => {
      if (gen !== generation) return; // session ended — never touch stale UI
      const theme = ctx.ui.theme;
      const now = Date.now();

      type Group = {
        short: string;
        status: StatusIndicator;
        windows: UsageWindow[];
      };
      const groups: Group[] = [];
      for (const p of enabled) {
        // Drop windows that have reset since the last poll.
        const windows = (byProvider[p.id] ?? []).filter(
          (w) => w.resetsAt > now,
        );
        if (windows.length > 0)
          groups.push({
            short: p.short,
            status: byStatus[p.id] ?? "none",
            windows,
          });
      }

      if (groups.length === 0) {
        if (lastLine !== undefined) {
          lastLine = undefined;
          ctx.ui.setStatus(WIDGET_KEY, undefined);
        }
        return;
      }

      const totalWindows = groups.reduce((sum, g) => sum + g.windows.length, 0);
      const barWidth = config.barWidth ?? (totalWindows === 1 ? 6 : 5);
      const multiProvider = groups.length >= 2;

      const pctOf = (w: UsageWindow) =>
        Math.min(100, Math.max(0, Math.round(w.percent)));
      const colorOf = (w: UsageWindow) => {
        const pct = pctOf(w);
        if (pct > 85) return "error" as const;
        if (pct >= 50) return "warning" as const;
        return "success" as const;
      };
      // Status marker color: red for severe incidents, amber for minor,
      // accent for scheduled maintenance.
      const statusColor = (s: StatusIndicator) =>
        s === "critical" || s === "major"
          ? ("error" as const)
          : s === "minor"
            ? ("warning" as const)
            : ("accent" as const);

      const parts: string[] = [];
      for (const g of groups) {
        const seg: string[] = [];
        if (config.showStatus && g.status !== "none")
          seg.push(theme.fg(statusColor(g.status), "!"));
        if (multiProvider) seg.push(theme.fg("muted", g.short));
        for (const w of g.windows) {
          const win: string[] = [];
          if (g.windows.length >= 2) win.push(theme.fg("muted", w.label));
          if (config.showBars) {
            const filled = Math.min(
              barWidth,
              Math.max(0, Math.round((pctOf(w) / 100) * barWidth)),
            );
            // Skip zero-length spans — theme.fg("", …) would emit bare ANSI codes.
            const bar =
              (filled > 0 ? theme.fg(colorOf(w), "▓".repeat(filled)) : "") +
              (filled < barWidth
                ? theme.fg("dim", "░".repeat(barWidth - filled))
                : "");
            win.push(bar);
          }
          win.push(theme.fg("text", `${pctOf(w)}%`));
          win.push(theme.fg("muted", `· ${fmtDuration(w.resetsAt - now)}`));
          seg.push(win.join(" "));
        }
        parts.push(seg.join(" "));
      }

      // Single spaces: pi's status-line sanitizer collapses runs of spaces.
      const line = parts.join(" │ ");
      if (line !== lastLine) {
        lastLine = line;
        ctx.ui.setStatus(WIDGET_KEY, line);
      }
    };

    // -- polling ------------------------------------------------------------

    for (const p of enabled) {
      const cfg = config.providers[p.id];
      const poll = async () => {
        // Fetch usage and status concurrently; status pages are CDN-backed
        // and never throttle, so we poll them on the same cadence as usage.
        const statusP =
          config.showStatus && p.statusUrl ? fetchStatus(p.statusUrl) : null;
        const [all, status] = await Promise.all([p.fetchUsage(cfg), statusP]);
        if (gen !== generation) return; // session ended while fetching
        if (all) {
          const windows = all.filter(
            (w) => cfg.show[w.category] && w.resetsAt > Date.now(),
          );
          byProvider[p.id] = windows;
          void writeCache(byProvider);
        }
        // `null` means the status fetch failed — keep the last known indicator.
        if (status !== null) byStatus[p.id] = status;
        render();
        // Back off when the usage fetch failed (e.g. 429 — these endpoints
        // throttle aggressive polling).
        timers.set(p.id, setTimeout(poll, all ? POLL_MS : POLL_MS * 3));
      };
      void poll();
    }

    // Live countdown; setStatus is only called when the rendered line changes
    // (at most about once a minute outside of poll updates).
    ticker = setInterval(render, 1_000);
    render();
  });
}
