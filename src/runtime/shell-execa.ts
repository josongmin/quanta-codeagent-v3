/** ADR-0192 — execa-backed sibling of {@link runShell}.
 *
 *  WHY THIS EXISTS — `src/runtime/shell.ts` hand-rolls a `Bun.spawn` wrapper
 *  with timeout, SIGTERM→SIGKILL escalation, AbortSignal forwarding, and
 *  env scrubbing. Every one of those concerns is solved by `execa` (Sindre
 *  Sorhus, 50M+ weekly downloads, 12+ years maintained). The user principle
 *  is explicit: "외부에 잘 만들어진 거 있으면 외부 거 써." This module is the
 *  lib-backed sibling — the self-impl stays for zero-dep callers and for the
 *  `onShellEvent` typed-event stream (PR-5 / ADR-0081), which execa does not
 *  surface natively.
 *
 *  CONTRACT — `runShellExeca` returns a {@link ShellResult} that is shape-
 *  compatible with {@link runShell}: `{ stdout, stderr, exitCode, timedOut }`.
 *  It accepts the SAME options the self-impl honors today (cwd / timeoutMs /
 *  signal / inheritEnv) and IGNORES `onShellEvent` — typed streaming is the
 *  self-impl's job. Existing callers that import `runShell` are NOT touched
 *  by this slice; this export is opt-in via the runtime barrel. */

import { execa, type Options, type Result } from "execa"
import { scrubEnv } from "./sandbox"
import type { ShellOptions, ShellResult } from "./types"

const DEFAULT_TIMEOUT_MS = 120_000
const FORCE_KILL_DELAY_MS = 5_000

/** execa-backed runner. Mirrors {@link runShell}'s public contract — same
 *  return shape, same options, same "never throws on non-zero exit" posture.
 *
 *  ARGV PARITY — the self-impl spawns `["bash","-lc", command]`. We do the
 *  exact same thing here (`execa("bash", ["-lc", command], …)`) rather than
 *  using execa's `shell: true` which would invoke `/bin/sh -c` and drop the
 *  `-l` (login-shell) flag, breaking PATH inheritance from `~/.bashrc` etc.
 *  on the rare hosts where it matters.
 *
 *  TIMEOUT + KILL ESCALATION — execa's `timeout` + `forceKillAfterDelay`
 *  options give us the SIGTERM-then-SIGKILL escalation the self-impl rolls
 *  by hand in {@link escalatingKill}. Default escalation delay: 5s (matches
 *  the self-impl's KILL_GRACE_MS).
 *
 *  ABORT FORWARDING — the caller's `AbortSignal` is forwarded as execa's
 *  `cancelSignal`. execa sends `SIGTERM` on abort, then escalates per the
 *  `forceKillAfterDelay` clock.
 *
 *  ERROR SHAPE — `reject: false` makes execa resolve with the Result object
 *  for both success and failure paths (instead of throwing an `ExecaError`).
 *  That guarantees we get a uniform shape to project into `ShellResult`.
 *  When the subprocess could not be spawned at all (binary not found, etc.)
 *  the Result's `exitCode` is `undefined`; we surface that as 127 (the
 *  POSIX "command not found" convention) with a non-empty stderr message. */
export const runShellExeca = async (
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> => {
  // Empty / whitespace-only command: don't even bother spawning. Mirror the
  // POSIX "command not found" surface so callers branch on exitCode.
  if (command.trim().length === 0) {
    return {
      stdout: "",
      stderr: "runShellExeca: empty command",
      exitCode: 127,
      timedOut: false,
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()
  // Scrubbed by default; opt OUT only with explicit `inheritEnv: true`. Same
  // policy as the self-impl — the env allowlist lives in src/runtime/sandbox.ts
  // and is the SINGLE source of truth.
  const env =
    options.inheritEnv === true
      ? (process.env as Record<string, string | undefined>)
      : scrubEnv()

  // exactOptional: build the options object CONDITIONALLY — omit fields the
  // caller did not pass rather than setting them to `undefined`, so execa's
  // strict option types (every field `readonly`) accept the call. We build
  // a base then spread the optional `cancelSignal` so the field is absent
  // unless the caller supplied an AbortSignal.
  const baseOpts = {
    cwd,
    env: env as Readonly<Partial<Record<string, string>>>,
    timeout: timeoutMs,
    forceKillAfterDelay: FORCE_KILL_DELAY_MS,
    killSignal: "SIGTERM" as const,
    reject: false as const,
    // execa defaults to `true` for `all` only when explicitly requested; we
    // do NOT need interleaved output — separate stdout/stderr is the
    // ShellResult contract.
    buffer: true as const,
    encoding: "utf8" as const,
    // Allow stdin inheritance to be cut off — we don't surface stdin in our
    // public ShellOptions today, so default to ignore (matches Bun.spawn's
    // implicit behavior when stdin is not piped).
    stdin: "ignore" as const,
  }
  const execaOpts: Options =
    options.signal !== undefined ? { ...baseOpts, cancelSignal: options.signal } : baseOpts

  let result: Result
  try {
    result = await execa("bash", ["-lc", command], execaOpts)
  } catch (err) {
    // With `reject: false` execa SHOULD resolve instead of throw, but if the
    // OS itself refuses to spawn (e.g. /bin/bash missing) we still land here.
    // Surface a 127 like the POSIX convention so callers can branch.
    const message = err instanceof Error ? err.message : String(err)
    return {
      stdout: "",
      stderr: `runShellExeca: spawn failed: ${message}`,
      exitCode: 127,
      timedOut: false,
    }
  }

  // execa.Result.exitCode is `undefined` when the subprocess was killed by a
  // signal or could not be spawned. We surface a numeric exit code in both
  // cases so the ShellResult contract (`exitCode: number`) is honored:
  //   - signal-killed: 128 + signal number where known, else 137 (SIGKILL
  //     convention) or 143 (SIGTERM convention). We use 137 / 143 since they
  //     are the most widely understood "killed by X" exit codes in CI scripts.
  //   - couldn't spawn: 127 (handled in the catch above; here we only see
  //     it as a defensive fallback).
  let exitCode: number
  if (typeof result.exitCode === "number") {
    exitCode = result.exitCode
  } else if (result.signal === "SIGKILL") {
    exitCode = 137
  } else if (result.signal === "SIGTERM") {
    exitCode = 143
  } else {
    exitCode = 127
  }

  // execa returns stdout/stderr as `string` when `encoding: "utf8"` and
  // `buffer: true` (both set above), but the TS type widens to include
  // `Uint8Array | undefined | string[]`. Narrow defensively.
  const stdout = stringifyStream(result.stdout)
  const stderr = stringifyStream(result.stderr)

  return {
    stdout,
    stderr,
    exitCode,
    timedOut: result.timedOut === true,
  }
}

/** Narrow execa's widened stdout/stderr type back to `string`. Under our
 *  fixed `encoding: "utf8"` + `buffer: true` settings the runtime value is
 *  always a string, but the type union includes Uint8Array / string[] /
 *  undefined for other configurations. */
const stringifyStream = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  if (value instanceof Uint8Array) return new TextDecoder("utf-8").decode(value)
  if (Array.isArray(value)) return value.map((v) => String(v)).join("\n")
  return String(value)
}
