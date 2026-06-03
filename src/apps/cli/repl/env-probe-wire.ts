/**
 * `apps/cli/repl/env-probe-wire.ts` — CLI startup bind for the env-probe slice
 * (ADR-0466 surface wire).
 *
 * WHY: `src/runtime/env-probe` ships a PURE, no-throw startup toolchain probe
 * (`runEnvProbe(exec, { enabled })`) that returns a `StartupWarning[]` so the
 * agent can ADAPT to a degraded environment ("python3 missing → skip pytest")
 * instead of blindly invoking an absent binary mid-turn. NOTHING in `@/apps`
 * imports that slice today — the slice's `ProbeExecPort` (the thing that
 * actually shells out for `<bin> --version`) is constructed ONLY at the
 * composition root, which is here. This file builds that real adapter
 * (`Bun.spawn`), env-gates the run, renders the warning list to a concise
 * multi-line notice, and emits it to the user ONCE at session start.
 *
 * Position: one-shot STARTUP surface. This is NOT a per-turn wire — the probe
 * runs once after the session deps are built (the host calls
 * {@link maybeRunEnvProbeWire} from `setupSession`). It does not touch the turn
 * loop, `recordTurn`, or any per-turn sink.
 *
 * Default-OFF byte-identical (RFC §1.2): when `QUANTA_ENABLE_ENV_PROBE !== "1"`
 * the wire returns IMMEDIATELY — zero `Bun.spawn` calls, zero allocations
 * beyond the early return, zero stream emits. Byte-identical to a deployment
 * that has no probe at all. The gate is read here and forwarded to the slice as
 * `enabled: true`; the slice's own DEFAULT-OFF guard is belt-and-suspenders.
 *
 * No-throw at the boundary: every public surface resolves (never rejects). The
 * adapter encodes spawn/timeout/io failure as `Err` (the slice runner then
 * SKIPS that check — no warning, no crash). The wire wraps `runEnvProbe` +
 * every emit in try/catch and degrades to `logger.warn` so a probe failure can
 * NEVER cascade into session bootstrap.
 *
 * No heuristics / no magic numbers: the check list is the slice's CLOSED
 * constant. The ONLY tunable here is a spawn timeout, defaulted from a NAMED
 * env knob (`QUANTA_ENV_PROBE_TIMEOUT_MS`) with a documented, conservative
 * fallback; it is injectable for tests.
 *
 * Slice posture: composition adapter. Imports `@/runtime/env-probe` (the slice
 * barrel) + `@/shared` (`errMessage`) + the structural `StreamPort`/logger
 * shapes only — NO `@/agent` loop, NO `@/permission`, NO other surface adapter.
 */

import {
  type ProbeExecError,
  type ProbeExecPort,
  type ProbeExecResult,
  runEnvProbe,
  type StartupWarning,
} from "@/runtime/env-probe"
import { errMessage, type Result } from "@/shared"

/** Structural mirror of the user-facing notice channel. The host passes the
 *  real `StreamPort` (`@/stream`); we only need `emit` of an `in_progress`
 *  event carrying a `message`, which is the established free-form
 *  user-visible notice surface. Typed structurally so this adapter does not
 *  import `@/stream` (kept off the slice-import graph). */
export interface EnvProbeNoticeSink {
  emit(event: { type: "in_progress"; timestamp: number; message?: string }): void
}

/** Structural mirror of the host logger surface we use. */
export interface EnvProbeLogger {
  warn(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
}

/** Options for {@link maybeRunEnvProbeWire}. `env`/`logger` required; `stream`
 *  optional (no TTY surface ⇒ notice goes to the logger only); the rest are
 *  test seams. */
export interface EnvProbeWireOptions {
  readonly env: NodeJS.ProcessEnv
  readonly logger: EnvProbeLogger
  /** User-facing notice sink. Absent ⇒ the rendered notice is logged via
   *  `logger.info` only (still no-throw, still one-shot). */
  readonly stream?: EnvProbeNoticeSink
  /** Override the exec port (tests inject a deterministic fake — no spawn). */
  readonly exec?: ProbeExecPort
  /** Clock for the `in_progress` event timestamp. Default: `Date.now`. */
  readonly now?: () => number
  /** Cooperative abort forwarded to the slice runner. */
  readonly signal?: AbortSignal
}

/** Result of the one-shot run. `ran` is `false` on the default-OFF path and on
 *  a caught failure (so callers/tests can assert zero-work without inspecting
 *  side effects). `warnings` is the slice output (possibly empty). */
export interface EnvProbeWireResult {
  readonly ran: boolean
  readonly warnings: readonly StartupWarning[]
}

/** Conservative default per-spawn timeout. A `--version` call that does not
 *  return within this window is treated as an `Err` (skip the check). Named
 *  knob `QUANTA_ENV_PROBE_TIMEOUT_MS` overrides; the fallback is deliberately
 *  generous (cold binaries on a loaded box) yet bounded so a hung probe never
 *  stalls startup. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** True iff the gate is the literal `"1"` (case-sensitive). Anything else
 *  (`undefined` / `"0"` / `"true"` / `""`) is OFF. */
const isGateOn = (env: NodeJS.ProcessEnv): boolean => env.QUANTA_ENABLE_ENV_PROBE === "1"

/** Parse the timeout knob. Non-positive / non-finite / unset ⇒ the documented
 *  default. No heuristic — a single explicit env integer or the constant. */
const resolveTimeoutMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env.QUANTA_ENV_PROBE_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_PROBE_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROBE_TIMEOUT_MS
  return Math.floor(n)
}

/** Best-effort first-line version parse — advisory only; never load-bearing.
 *  Returns `undefined` on any read failure or empty output. */
const readVersion = async (stdout: ReadableStream<Uint8Array>): Promise<string | undefined> => {
  try {
    const out = await new Response(stdout).text()
    const first = out.split("\n", 1)[0]?.trim()
    return first !== undefined && first.length > 0 ? first : undefined
  } catch {
    return undefined
  }
}

/** Map a settled child (exit code + timeout flag) to the slice Result. Pure
 *  branch logic, extracted to keep the port body's cognitive complexity low. */
const settleProbe = async (
  child: ReturnType<typeof Bun.spawn>,
  exitCode: number,
  timedOut: boolean,
  timeoutMs: number,
): Promise<Result<ProbeExecResult, ProbeExecError>> => {
  if (timedOut) return { ok: false, error: { kind: "timeout", detail: `> ${timeoutMs}ms` } }
  // Present-but-errored (non-zero exit) is reported as not-found (conservative).
  if (exitCode !== 0) return { ok: true, value: { found: false } }
  // `stdout` is `"pipe"` (set at spawn) so it is a ReadableStream at runtime, but
  // Bun types it as a union (number fd | stream | undefined). Guard rather than
  // cast so a future spawn-option change degrades to "found, no version" instead
  // of throwing past the no-throw boundary.
  const stdout = child.stdout
  const version = stdout instanceof ReadableStream ? await readVersion(stdout) : undefined
  return { ok: true, value: version === undefined ? { found: true } : { found: true, version } }
}

/**
 * Build the real {@link ProbeExecPort}: shell `<bin> --version` via
 * `Bun.spawn`, no-throw → `Result<ProbeExecResult, ProbeExecError>`.
 *
 * Contract:
 *   - `found: true` iff the process exits 0. A non-zero exit (binary present
 *     but errored) is reported `found: false` (the slice treats that as
 *     "absent" — conservatively surfacing a warning is the safe degradation).
 *   - spawn rejection ⇒ `Err{kind:"spawn-failed"}` (binary not on PATH).
 *   - timeout ⇒ the child is killed and `Err{kind:"timeout"}`.
 *   - any other thrown error ⇒ `Err{kind:"io-error"}`.
 * NEVER throws.
 *
 * `version` is best-effort (first line of stdout, trimmed) — advisory only;
 * the slice never gates on it.
 */
export const createProbeExecPort = (timeoutMs: number): ProbeExecPort => {
  return async (
    argv: readonly [string, ...string[]],
  ): Promise<Result<ProbeExecResult, ProbeExecError>> => {
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    } catch (e) {
      // PATH miss / EACCES etc. — binary not invocable.
      return { ok: false, error: { kind: "spawn-failed", detail: errMessage(e) } }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* best-effort kill; .exited still settles */
      }
    }, timeoutMs)
    try {
      const exitCode = await child.exited
      return await settleProbe(child, exitCode, timedOut, timeoutMs)
    } catch (e) {
      return { ok: false, error: { kind: "io-error", detail: errMessage(e) } }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Render the warning list to a concise multi-line user notice. Returns
 *  `undefined` for an empty list (caller emits nothing). Pure string. */
export const renderStartupNotice = (warnings: readonly StartupWarning[]): string | undefined => {
  if (warnings.length === 0) return undefined
  const lines = warnings.map((w) => {
    const badge = w.severity === "warn" ? "!" : "i"
    return `  [${badge}] ${w.target} (${w.kind}): ${w.degradationHint}`
  })
  return `environment probe — ${warnings.length} startup warning(s):\n${lines.join("\n")}`
}

/**
 * One-shot CLI startup bind for the env-probe slice. See file-level JSDoc for
 * the gate + default-OFF + no-throw guarantees.
 *
 * DEFAULT-OFF: `QUANTA_ENABLE_ENV_PROBE !== "1"` ⇒ returns `{ ran:false,
 * warnings:[] }` IMMEDIATELY — no exec port built, no spawn, no emit.
 *
 * ON: builds the real `Bun.spawn` adapter (unless `opts.exec` is injected),
 * runs the slice probe, renders the notice, and emits it via the stream
 * (`in_progress` message) + a structured `logger.info`. Every step is caught;
 * failure degrades to `logger.warn` + `{ ran:false }`.
 */
export const maybeRunEnvProbeWire = async (
  opts: EnvProbeWireOptions,
): Promise<EnvProbeWireResult> => {
  if (!isGateOn(opts.env)) return { ran: false, warnings: [] }

  const exec = opts.exec ?? createProbeExecPort(resolveTimeoutMs(opts.env))
  const now = opts.now ?? Date.now

  let warnings: readonly StartupWarning[]
  try {
    warnings = await runEnvProbe(exec, {
      enabled: true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (e) {
    // The slice runner is no-throw by contract; this guards a programmer-bug
    // regression so startup is never taken down by the probe.
    opts.logger.warn("env-probe.failed", { reason: errMessage(e) })
    return { ran: false, warnings: [] }
  }

  const notice = renderStartupNotice(warnings)
  if (notice !== undefined) {
    try {
      opts.logger.info("env-probe.warnings", { count: warnings.length })
      opts.stream?.emit({ type: "in_progress", timestamp: now(), message: notice })
    } catch (e) {
      // Emit failure must not undo the (successful) probe; report + continue.
      opts.logger.warn("env-probe.emit-failed", { reason: errMessage(e) })
    }
  }
  return { ran: true, warnings }
}
