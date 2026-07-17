import type { SandboxedSpawnResult } from "./types"

/**
 * DOF-40 — fail-closed refusal for a REQUESTED-but-UNAVAILABLE OS sandbox.
 *
 * SECURITY BOUNDARY. When a caller asks for a RESTRICTIVE sandbox profile
 * (`read-only` / `workspace-write` / `workspace-write-net`) but the host
 * backend cannot enforce it (no `bwrap`, no `landlock-cli`, no native
 * Landlock, no `sandbox-exec`, no Windows helper, unsupported platform), the
 * port MUST NOT run the command unsandboxed while reporting
 * `sandboxApplied: false`. That is fail-OPEN: the side effects (writes,
 * network) already happened by the time the caller inspects the flag.
 *
 * This helper builds the fail-CLOSED result: a TYPED REFUSAL that the caller
 * receives WITHOUT the command ever being spawned. Call sites MUST return this
 * INSTEAD of invoking the spawner — the whole point is that the process never
 * runs.
 *
 * Contract of the returned {@link SandboxedSpawnResult}:
 *   - `exitCode`        = {@link SANDBOX_UNAVAILABLE_EXIT_CODE} (126 — the
 *                          POSIX "command found but not executable / permission"
 *                          code; the codebase already treats exit-126 as a
 *                          denied-exec signal, see `SandboxDenialSignal`).
 *   - `stdout`          = "" (nothing ran, so nothing was produced).
 *   - `stderr`          = a stable, actionable refusal string.
 *   - `sandboxApplied`  = false (the sandbox was NOT applied) …
 *   - `degradeReason`   = the typed reason, PRESENT. Consumers that fail-closed
 *                          on `!sandboxApplied || degradeReason` (e.g.
 *                          `shell.ts`, `sandbox-wire.ts`) already reject on this
 *                          shape; the difference vs the old passthrough is the
 *                          command NEVER RAN.
 *
 * Distinguishing this from the old degraded-passthrough at the type level is
 * intentionally NOT done via a new field (keeps the port shape byte-stable for
 * `off`/`danger` results); the load-bearing invariant is behavioral: the
 * spawner is not called, stdout is empty, and exitCode is the refusal code.
 */
export const SANDBOX_UNAVAILABLE_EXIT_CODE = 126

/** Human-readable, actionable install hints keyed by reason. Kept here so the
 *  refusal stderr is stable across the linux/default/native call sites. */
const REFUSAL_HINT: Readonly<Record<string, string>> = {
  "linux-bwrap-missing": "install bubblewrap (apt/dnf/pacman) or landlock-cli",
  "sandbox-exec-missing": "sandbox-exec not found on PATH (macOS)",
  "win32-sandbox-helper-missing": "install quanta-win-sandbox.exe for isolation",
  "profile-uncompilable": "the requested profile could not be compiled",
  "native-binding-unavailable": "@quanta/linux-sandbox-native not loaded",
}

/**
 * Build the fail-closed refusal result for a requested sandbox that cannot be
 * honored. Pure — performs NO spawn, NO I/O. `reason` is the STABLE typed tag
 * that flows onto `degradeReason` (consumers gate on it); an optional
 * per-platform hint suffix is appended to `stderr` when known.
 */
export const sandboxUnavailableRefusal = (reason: string): SandboxedSpawnResult => {
  const hint = REFUSAL_HINT[reason]
  const stderr =
    hint !== undefined
      ? `sandbox-unavailable: requested sandbox could not be enforced (${reason}) — command REFUSED (not run). ${hint}`
      : `sandbox-unavailable: requested sandbox could not be enforced (${reason}) — command REFUSED (not run).`
  return {
    exitCode: SANDBOX_UNAVAILABLE_EXIT_CODE,
    stdout: "",
    stderr,
    sandboxApplied: false,
    degradeReason: reason,
  }
}
