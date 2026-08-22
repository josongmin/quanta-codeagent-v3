import { describe, expect, test } from "bun:test"
import {
  mapPolicyToNapi,
  type NapiSandboxedSpawnSpec,
  type NapiSandboxPolicy,
  type NapiSpawnResult,
  type NativeLandlockBinding,
  nativeLandlockOsSandbox,
  type SandboxPolicy,
} from "@/runtime/os-sandbox"

/**
 * Hellgate battery for ADR-0191 Phase 3.2 strict seccomp + rlimit/alarm
 * wire (TS slice). The native binding is faked end-to-end via the
 * closed-port DI seam (`cfg.binding`); no Rust code is exercised here
 * (cargo build verify covers the Rust path on darwin, GitHub Actions
 * matrix in Phase 3.3 covers Linux runtime).
 *
 * Coverage:
 *   1.  policy.seccompMode default "strict" → forwarded
 *   2.  explicit "lax" → forwarded
 *   3.  explicit "strict" + workspace-write → forwarded
 *   4.  policy with no seccompMode field → binding sees "strict"
 *   5.  memoryMb set → forwarded
 *   6.  timeoutMs set → forwarded
 *   7.  rlimit fields absent → binding sees no memoryMb/timeoutMs keys
 *   8.  memoryMb + workspace-write profile combination
 *   9.  seccompMode forwarded even on "off" profile (no-op, documents
 *       passthrough behaviour)
 *   10. Existing Phase 3.1 hellgate untouched (sanity import check)
 *   11. Phase 2 bwrap fallback chain unaffected — seccompMode not
 *       referenced when binding is null
 *   12. Default behaviour: explicit `policy.seccompMode === undefined`
 *       → binding sees "strict"
 *
 * 12 cases / 0 fail.
 */

/* ------------------------------------------------------------------ */
/*  test helpers                                                       */
/* ------------------------------------------------------------------ */

interface BindingCall {
  spec: NapiSandboxedSpawnSpec
  policy: NapiSandboxPolicy
}

const makeFakeBinding = (): { binding: NativeLandlockBinding; calls: BindingCall[] } => {
  const calls: BindingCall[] = []
  const result: NapiSpawnResult = {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    sandboxApplied: true,
  }
  const binding: NativeLandlockBinding = {
    spawn_sandboxed(spec, policy) {
      calls.push({ spec, policy })
      return result
    },
    availability() {
      return JSON.stringify({
        available: true,
        kernelVersion: "6.7.1",
        abiSupported: 5,
      })
    },
  }
  return { binding, calls }
}

const WS = "/ws"

/* ================================================================== */
/*  1–4. seccompMode default + forwarding                              */
/* ================================================================== */

describe("strict-seccomp: seccompMode forwarding (1–4, 12)", () => {
  test("HELL-S1: policy.seccompMode absent → binding receives 'strict' (default)", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write" }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.policy.seccompMode).toBe("strict")
  })

  test("HELL-S2: explicit seccompMode='lax' → forwarded verbatim", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write", seccompMode: "lax" }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.seccompMode).toBe("lax")
  })

  test("HELL-S3: explicit seccompMode='strict' + workspace-write → forwarded", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = {
      profile: "workspace-write",
      seccompMode: "strict",
    }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.seccompMode).toBe("strict")
    expect(calls[0]?.policy.profile).toBe("workspace-write")
  })

  test("HELL-S4: policy without seccompMode key (compile-time absent) → binding sees 'strict'", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    // policy literal with NO seccompMode key at all (not undefined-set)
    const policy: SandboxPolicy = { profile: "read-only" }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.seccompMode).toBe("strict")
  })

  test("HELL-S12: explicit policy.seccompMode left undefined via conditional → binding sees 'strict'", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    // Caller composes the policy with a runtime-conditional spread that
    // resolves to NO `seccompMode` key (exactOptional contract). The
    // adapter must still default to "strict" on the wire.
    const want: "lax" | "strict" | undefined = undefined
    const policy: SandboxPolicy = {
      profile: "workspace-write",
      ...(want !== undefined ? { seccompMode: want } : {}),
    }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.seccompMode).toBe("strict")
  })
})

/* ================================================================== */
/*  5–8. rlimit + memory forwarding                                    */
/* ================================================================== */

describe("strict-seccomp: rlimit / memory forwarding (5–8)", () => {
  test("HELL-S5: memoryMb set → forwarded to binding as napi field", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write", memoryMb: 512 }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.memoryMb).toBe(512)
  })

  test("HELL-S6: timeoutMs set → forwarded", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write", timeoutMs: 10_000 }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.timeoutMs).toBe(10_000)
  })

  test("HELL-S7: both rlimit fields absent → binding sees no memoryMb/timeoutMs keys", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write" }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    const napi = calls[0]?.policy
    expect(napi).toBeDefined()
    if (!napi) throw new Error("unreachable")
    expect("memoryMb" in napi).toBe(false)
    expect("timeoutMs" in napi).toBe(false)
  })

  test("HELL-S8: memoryMb + workspace-write profile mapped correctly together", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = {
      profile: "workspace-write",
      memoryMb: 1024,
      extraReadPaths: ["/usr/local"],
    }
    await sandbox.spawn({ command: ["cmd"], cwd: WS }, policy)
    expect(calls[0]?.policy.profile).toBe("workspace-write")
    expect(calls[0]?.policy.memoryMb).toBe(1024)
    expect(calls[0]?.policy.extraReadPaths).toEqual(["/usr/local"])
    expect(calls[0]?.policy.seccompMode).toBe("strict")
  })
})

/* ================================================================== */
/*  9–11. cross-cutting invariants                                     */
/* ================================================================== */

describe("strict-seccomp: cross-cutting invariants (9–11)", () => {
  test("HELL-S9: seccompMode in mapping output even when profile=off (documents intent; binding not called)", () => {
    // mapPolicyToNapi is pure — it emits seccompMode regardless of
    // profile. The runtime dispatcher short-circuits "off" before
    // touching the binding, but the mapping contract still pins the
    // field so the adapter wire is uniform.
    const napi = mapPolicyToNapi({ profile: "off" }, WS)
    expect(napi.seccompMode).toBe("strict")
    expect(napi.profile).toBe("off")
  })

  test("HELL-S10: Phase 3.1 hellgate types still importable (sanity)", () => {
    // If the type names re-export from index.ts break, this file would
    // fail to type-check. We're proving the surface is additive.
    const dummy: NapiSandboxPolicy = {
      profile: "workspace-write",
      workspace: WS,
      extraReadPaths: [],
      extraWritePaths: [],
      seccompMode: "strict",
    }
    expect(dummy.seccompMode).toBe("strict")
    expect(dummy.profile).toBe("workspace-write")
  })

  test("HELL-S11: binding null (bwrap fallback path) → seccompMode never observed; passthrough still works", async () => {
    // bindingLoader returns null → adapter takes the degraded
    // passthrough path. We verify (a) the call shape doesn't throw, and
    // (b) the result carries the documented degradeReason.
    const sandbox = nativeLandlockOsSandbox({ bindingLoader: () => null })
    const r = await sandbox.spawn(
      { command: ["true"], cwd: WS },
      { profile: "workspace-write", seccompMode: "strict" },
    )
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("native-binding-unavailable")
  })
})
