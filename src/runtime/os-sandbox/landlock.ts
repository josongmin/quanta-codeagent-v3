import { compileBubblewrapArgs } from "./bubblewrap"
import type { SandboxedSpawnResult, SandboxedSpawnSpec, SandboxPolicy, Spawner } from "./types"

/**
 * Linux sandbox backend — **Phase 2: bubblewrap shell-out** (ADR-0150).
 *
 * Phase 1 (ADR-0136) was an explicit not-implemented stub: every Linux spawn
 * degraded to passthrough with `degradeReason: "landlock-not-implemented"`.
 *
 * Phase 2 replaces the stub with a `bwrap` shell-out adapter:
 *  - Same denylist semantics as Seatbelt (same 5-arm closed `SandboxProfile`).
 *  - Available on most Linux distros (`apt install bubblewrap`,
 *    `dnf install bubblewrap`, `pacman -S bubblewrap`).
 *  - No native binding maintenance (vs napi-rs landlock = N-week effort +
 *    per-arch builds + kernel ABI drift).
 *  - When `bwrap` is missing on PATH: typed degradation
 *    `"linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)"` — honest,
 *    actionable error.
 *
 * Phase 3 (a future ADR) may introduce native Landlock FFI when a stable
 * Rust binding lands; the policy → backend boundary is intentionally narrow
 * so backend swap is local to this file + bubblewrap.ts.
 *
 * The file name remains `landlock.ts` because the public symbol
 * (`spawnViaLandlock`) is the Linux entry point in {@link default.ts}; the
 * underlying mechanism is an implementation detail. The new bubblewrap-
 * specific helper symbols are exported alongside the legacy names.
 */

/**
 * Probe whether `bwrap` (bubblewrap) is on PATH. Closed-port `which` injection
 * keeps this testable from darwin hosts.
 */
export const isBubblewrapAvailable = async (
  which: (b: string) => Promise<string | null>,
): Promise<boolean> => {
  const path = await which("bwrap")
  return path !== null
}

/**
 * Phase 1 legacy alias. Always returns false (the Phase 1 contract — no
 * Linux sandbox available out of the box). Phase 2 callers should prefer
 * {@link isBubblewrapAvailable}. Kept for byte-identical back-compat with
 * any external import that may exist.
 */
export const isLandlockAvailable = async (): Promise<boolean> => {
  return false
}

/**
 * Phase 2 entry point. Compile a bubblewrap policy from the SandboxPolicy
 * and spawn under `bwrap`. If the profile compiles to `null` (off /
 * danger-full-access), passthrough verbatim. If `bwrap` itself isn't on
 * PATH the caller should have short-circuited via
 * {@link isBubblewrapAvailable} — this function does NOT re-probe (avoids
 * double `which` cost per spawn).
 */
export const spawnViaBubblewrap = async (
  spec: SandboxedSpawnSpec,
  policy: SandboxPolicy,
  spawner: Spawner,
): Promise<SandboxedSpawnResult> => {
  const policyArgs = compileBubblewrapArgs(policy, spec.cwd)

  // off / danger-full-access — passthrough, no sandbox applied, NO
  // degradeReason (caller explicitly opted out).
  if (policyArgs === null) {
    return runDirect(spec, spawner, { sandboxApplied: false })
  }

  const argv: string[] = ["bwrap", ...policyArgs, "--", ...spec.command]
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner(argv, opts)
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      sandboxApplied: true,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: "spawn-failed",
    }
  }
}

/**
 * Phase 1 legacy alias. Routes to {@link spawnViaBubblewrap} for Phase 2 —
 * existing call sites get the bubblewrap implementation transparently. The
 * caller in {@link default.ts} now dispatches on `isBubblewrapAvailable`
 * directly; this alias exists for any external import.
 */
export const spawnViaLandlock = async (
  spec: SandboxedSpawnSpec,
  policy: SandboxPolicy,
  spawner: Spawner,
): Promise<SandboxedSpawnResult> => {
  return spawnViaBubblewrap(spec, policy, spawner)
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

/** Run `spec.command` directly through the spawner — no bwrap prefix. Used
 *  when the profile is off/danger and the caller still wants the result
 *  shape (exitCode/stdout/stderr) without applying a sandbox. Mirrors the
 *  `passthrough()` helper in default.ts but local to this file to keep the
 *  port boundary thin. */
const runDirect = async (
  spec: SandboxedSpawnSpec,
  spawner: Spawner,
  meta: { sandboxApplied: boolean; degradeReason?: string },
): Promise<SandboxedSpawnResult> => {
  const argv: string[] = [...spec.command]
  const opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal } = {
    cwd: spec.cwd,
    ...(spec.env ? { env: { ...spec.env } } : {}),
    ...(spec.signal ? { signal: spec.signal } : {}),
  }
  try {
    const r = await spawner(argv, opts)
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      sandboxApplied: meta.sandboxApplied,
      ...(meta.degradeReason !== undefined ? { degradeReason: meta.degradeReason } : {}),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: meta.degradeReason ?? "spawn-failed",
    }
  }
}
