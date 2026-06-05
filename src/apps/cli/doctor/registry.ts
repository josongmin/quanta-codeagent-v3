/**
 * `/doctor` check-registry (RFC jun-6-doctor-selfcheck §4.3, §4.5) — PURE.
 *
 * `DOCTOR_CHECKS` is a frozen, ordered, total registry: adding a check = one
 * array entry + one `Check` fn. `runDoctor` runs every check ISOLATED — a
 * check (or its probe) that throws yields its OWN `fail` result and never
 * aborts the sweep (the per-check `.catch(failResult)`).
 */

import { errMessage } from "@/shared"
import type { Check, CheckResult, DoctorProbes } from "./types"
import { MIN_TERMINAL_COLUMNS } from "./types"

/** Near-expiry window: a token valid but inside this window ⇒ `warn`.
 *  Surfaced by the probe (`tokenExpiringSoon`); the constant documents intent. */

const authCheck: Check = async (probes) => {
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
  return { id: "auth", status: "ok", detail: a.provider }
}

const terminalCheck: Check = async (probes) => {
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

const mcpCheck: Check = async (probes) => {
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

const configCheck: Check = async (probes) => {
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

const stateDbCheck: Check = async (probes) => {
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

/** Frozen, ordered registry. Order is part of the contract (stable report). */
export const DOCTOR_CHECKS: readonly Check[] = Object.freeze([
  authCheck,
  terminalCheck,
  mcpCheck,
  configCheck,
  stateDbCheck,
])

/** Stable id sequence, aligned with {@link DOCTOR_CHECKS} order — used to
 *  attribute a `fail` when a check throws before producing a result. */
const CHECK_IDS: readonly string[] = Object.freeze([
  "auth",
  "terminal",
  "mcp",
  "config",
  "state-db",
])

const failResult = (id: string, err: unknown): CheckResult => ({
  id,
  status: "fail",
  detail: errMessage(err),
  remedy: "this check could not complete; the error above is the cause",
})

/**
 * Run every check, isolated. A check that throws (or whose probe throws)
 * becomes its own `fail` result; the remaining checks still run + render.
 */
export async function runDoctor(probes: DoctorProbes): Promise<readonly CheckResult[]> {
  return Promise.all(
    DOCTOR_CHECKS.map((check, i) =>
      check(probes).catch((e) => failResult(CHECK_IDS[i] ?? `check-${i}`, e)),
    ),
  )
}

/** Exit code: non-zero iff any check `fail`ed (`warn` is exit 0 — CI-friendly). */
export const doctorExitCode = (results: readonly CheckResult[]): number =>
  results.some((r) => r.status === "fail") ? 1 : 0
