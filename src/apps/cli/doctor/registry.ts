/**
 * `/doctor` check-registry (RFC jun-6-doctor-selfcheck §4.3, §4.5) — PURE.
 *
 * `DOCTOR_CHECKS` is a frozen, ordered, total registry: adding a check = one
 * `{ id, run }` entry. `runDoctor` runs every check ISOLATED — a check (or its
 * probe) that throws yields its OWN `fail` result (attributed to the entry's
 * bound `id`) and never aborts the sweep (the per-check `.catch(failResult)`).
 */

import { errMessage } from "@/shared"
import type { Check, CheckFn, CheckResult, DoctorProbes } from "./types"
import { MIN_TERMINAL_COLUMNS } from "./types"

/** Near-expiry window: a token valid but inside this window ⇒ `warn`.
 *  Surfaced by the probe (`tokenExpiringSoon`); the constant documents intent. */

const authCheck: CheckFn = async (probes) => {
  const a = await probes.auth()
  // A token is "present" iff the probe reported an expiry verdict (expired or
  // not) or the near-expiry flag — `tokenExpired === undefined` means no token.
  const hasToken = a.tokenExpired !== undefined || a.tokenExpiringSoon === true
  if (a.tokenExpired === true) {
    return {
      id: "auth",
      status: "fail",
      detail: `${a.provider}: token expired`,
      remedy: "run `/login --chatgpt` to refresh, or set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`",
    }
  }
  if (!a.keyPresent && !hasToken) {
    return {
      id: "auth",
      status: "fail",
      detail: `${a.provider}: no API key and no token`,
      remedy: "run `/login --chatgpt` or set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`",
    }
  }
  if (a.tokenExpiringSoon === true) {
    return {
      id: "auth",
      status: "warn",
      detail: `${a.provider}: token expiring soon`,
      remedy: "run `/login --chatgpt` to refresh before it expires",
    }
  }
  return {
    id: "auth",
    status: "ok",
    detail:
      a.effectiveTransport !== undefined
        ? `${a.provider} · transport=${a.effectiveTransport}${a.transportReason !== undefined ? ` (${a.transportReason})` : ""}`
        : a.provider,
  }
}

const terminalCheck: CheckFn = async (probes) => {
  const t = probes.terminal()
  if (t.isTTY && !t.rawModeAvailable) {
    return {
      id: "terminal",
      status: "fail",
      detail: "raw-mode unavailable",
      remedy: "interactive prompts won't work; run in a real terminal (not a pipe/CI shell)",
    }
  }
  if (!t.isTTY) {
    return {
      id: "terminal",
      status: "warn",
      detail: "stdout is not a TTY (piped/redirected)",
      remedy: "interactive prompts are disabled when output is piped",
    }
  }
  if (t.columns < MIN_TERMINAL_COLUMNS) {
    return {
      id: "terminal",
      status: "warn",
      detail: `terminal width ${t.columns} < ${MIN_TERMINAL_COLUMNS}`,
      remedy: "widen the terminal so panels render without wrapping",
    }
  }
  return { id: "terminal", status: "ok", detail: `TTY · ${t.columns} cols` }
}

const mcpCheck: CheckFn = async (probes) => {
  const servers = await probes.mcp()
  if (servers.length === 0) {
    return { id: "mcp", status: "ok", detail: "no MCP servers configured" }
  }
  const failed = servers.filter((s) => !s.connected)
  if (failed.length > 0) {
    const first = failed[0] as (typeof failed)[number]
    const why = first.error !== undefined ? `: ${first.error}` : ""
    return {
      id: "mcp",
      status: "fail",
      detail: `server "${first.name}" failed${why}`,
      remedy: `check the command/args for "${first.name}" in .mcp.json`,
    }
  }
  const totalTools = servers.reduce((n, s) => n + (s.toolCount ?? 0), 0)
  return {
    id: "mcp",
    status: "ok",
    detail: `${servers.length} server(s) connected · ${totalTools} tool(s)`,
  }
}

const configCheck: CheckFn = async (probes) => {
  const c = probes.config()
  if (!c.loaded) {
    return {
      id: "config",
      status: "fail",
      detail:
        c.error !== undefined ? `runtimeConfig() failed: ${c.error}` : "runtimeConfig() failed",
      remedy: "fix the offending env var / config value reported above",
    }
  }
  if (c.warnings.length > 0) {
    return {
      id: "config",
      status: "warn",
      detail: c.warnings.join("; "),
      remedy: "a knob is set but has no effect — unset it or wire the missing handler",
    }
  }
  return { id: "config", status: "ok", detail: "runtimeConfig() validated" }
}

const stateDbCheck: CheckFn = async (probes) => {
  const s = await probes.stateDb()
  if (!s.sessionsReadable || !s.indexValid) {
    const what = !s.sessionsReadable ? "session store" : "session index"
    const why = s.error !== undefined ? `: ${s.error}` : ""
    return {
      id: "state-db",
      status: "fail",
      detail: `${what} unreadable${why}`,
      remedy: "the on-disk store is corrupt; remove or move the affected file to recover",
    }
  }
  if (s.memoryReadable === false) {
    return {
      id: "state-db",
      status: "warn",
      detail: "memory DB unreadable",
      remedy: "long-term memory is unavailable; remove the corrupt memory DB to rebuild",
    }
  }
  return { id: "state-db", status: "ok", detail: "sessions + index readable" }
}

/** UUX-4-05 — aggregate session-store health. `state-db` only proves the
 *  index read returns; THIS check surfaces the store the read silently
 *  degrades over (per-file corrupt/unreadable classification from
 *  `checkSessionStoreHealth`, injected as the `storeHealth` probe).
 *  Verdict mapping: `corrupt` (nothing loads) ⇒ fail; `degraded` (some
 *  files lost) ⇒ warn; `healthy`/`empty` ⇒ ok. The remedy carries the
 *  store module's own operator recovery guidance verbatim — actionable,
 *  not generic. */
const storeHealthCheck: CheckFn = async (probes) => {
  const s = await probes.storeHealth()
  const bad = s.corrupt + s.unreadable
  if (s.verdict === "corrupt") {
    return {
      id: "store-health",
      status: "fail",
      detail: `session store aggregately corrupt: ${bad}/${s.total} files failed to load`,
      remedy: s.guidance ?? "back up the store directory, then move the corrupt files aside",
    }
  }
  if (s.verdict === "degraded") {
    return {
      id: "store-health",
      status: "warn",
      detail: `session store degraded: ${bad}/${s.total} files failed to load (${s.ok} still load)`,
      remedy: s.guidance ?? "back up the store directory, then move the corrupt files aside",
    }
  }
  if (s.verdict === "empty") {
    return { id: "store-health", status: "ok", detail: "no session files yet" }
  }
  return {
    id: "store-health",
    status: "ok",
    detail: `${s.ok} session file${s.ok === 1 ? "" : "s"} readable`,
  }
}

/** Frozen, ordered registry. Order is part of the contract (stable report).
 *  Each entry binds its `id` to the fn so the throw-before-result attribution
 *  can never drift from the fn's own self-reported id (no parallel id array). */
export const DOCTOR_CHECKS: readonly Check[] = Object.freeze([
  { id: "auth", run: authCheck },
  { id: "terminal", run: terminalCheck },
  { id: "mcp", run: mcpCheck },
  { id: "config", run: configCheck },
  { id: "state-db", run: stateDbCheck },
  { id: "store-health", run: storeHealthCheck },
])

const failResult = (id: string, err: unknown): CheckResult => ({
  id,
  status: "fail",
  detail: errMessage(err),
  remedy: "this check could not complete; the error above is the cause",
})

/**
 * Run every check, isolated. A check that throws (or whose probe throws)
 * becomes its own `fail` result (attributed to the entry's own `id`); the
 * remaining checks still run + render.
 */
export async function runDoctor(probes: DoctorProbes): Promise<readonly CheckResult[]> {
  return Promise.all(
    DOCTOR_CHECKS.map((check) => check.run(probes).catch((e) => failResult(check.id, e))),
  )
}

/** Exit code: non-zero iff any check `fail`ed (`warn` is exit 0 — CI-friendly). */
export const doctorExitCode = (results: readonly CheckResult[]): number =>
  results.some((r) => r.status === "fail") ? 1 : 0
