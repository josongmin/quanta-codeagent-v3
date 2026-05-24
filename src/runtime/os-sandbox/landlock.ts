import type { SandboxedSpawnResult, SandboxedSpawnSpec, SandboxPolicy, Spawner } from "./types"

/**
 * Linux Landlock + seccomp implementation. **Phase 1 stub.**
 *
 * Production wire on Linux would require either:
 *  - a native binding (`napi-rs landlock` or similar) — N-week effort + ongoing
 *    binding maintenance against kernel ABI drift, OR
 *  - shelling out to `bwrap` (bubblewrap) / `firejail` — adds a system
 *    dependency we don't want to require for first-cut.
 *
 * Phase 1 = explicit "not implemented": {@link spawnViaLandlock} runs the
 * command *unsandboxed* and reports it via `sandboxApplied: false` +
 * `degradeReason: "landlock-not-implemented"`. This keeps the surface honest
 * (no silent "sandbox claimed but didn't fire") and matches our prior-art
 * pattern from ADR-0006 (`DockerSandbox` throws, never silently degrades).
 *
 * We intentionally diverge from the throw-pattern *here* — the os-sandbox
 * port's contract is NO-THROW (callers spec a policy + the port decides),
 * so degradation surfaces as a typed result field instead. Equally
 * honest, programmatic to detect.
 */
export const isLandlockAvailable = async (): Promise<boolean> => {
  // Phase 1: always false. Phase 2 ADR will probe `/proc/self/status`
  // for Landlock support + napi binding presence.
  return false
}

/**
 * Run `spec.command` on Linux. Phase 1 = degraded passthrough (executes the
 * command via the injected spawner with NO sandbox applied), tagging the
 * result so callers can detect + audit.
 */
export const spawnViaLandlock = async (
  spec: SandboxedSpawnSpec,
  _policy: SandboxPolicy,
  spawner: Spawner,
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
      sandboxApplied: false,
      degradeReason: "landlock-not-implemented",
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      exitCode: 127,
      stdout: "",
      stderr: `spawn-failed: ${msg}`,
      sandboxApplied: false,
      degradeReason: "landlock-not-implemented",
    }
  }
}
