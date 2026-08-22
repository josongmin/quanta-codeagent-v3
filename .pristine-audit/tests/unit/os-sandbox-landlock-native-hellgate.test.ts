import { describe, expect, test } from "bun:test"
import {
  defaultOsSandbox,
  detectNativeLandlock,
  mapPolicyToNapi,
  type NapiSandboxedSpawnSpec,
  type NapiSandboxPolicy,
  type NapiSpawnResult,
  type NativeLandlockBinding,
  type NativeLandlockConfig,
  nativeLandlockOsSandbox,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
} from "@/runtime/os-sandbox"

/**
 * Hellgate battery for the ADR-0175 Phase 3 native-landlock adapter.
 *
 * Closed-port DI: every test injects a fake `NativeLandlockBinding` via
 * `cfg.binding` (preferred) or `cfg.bindingLoader` (controls the "package
 * not installed" branch). The real napi-rs binding is NEVER loaded; the
 * suite is hermetic and runs from darwin.
 *
 * Clusters:
 *   A. detectNativeLandlock probe                       (4)
 *   B. nativeLandlockOsSandbox.spawn runtime dispatch   (8)
 *   C. defaultOsSandbox fallback chain                  (4)
 *   D. mapPolicyToNapi policy mapping shape             (4)
 *
 * 20 cases / 0 fail.
 */

/* ------------------------------------------------------------------ */
/*  test helpers                                                       */
/* ------------------------------------------------------------------ */

interface SpawnCall {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
}

const makeSpawner = (
  result: { exitCode: number; stdout: string; stderr: string } = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  },
): { spawner: Spawner; calls: SpawnCall[] } => {
  const calls: SpawnCall[] = []
  const spawner: Spawner = async (argv, opts) => {
    calls.push({
      argv: [...argv],
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return result
  }
  return { spawner, calls }
}

interface BindingCall {
  spec: NapiSandboxedSpawnSpec
  policy: NapiSandboxPolicy
}

/** Fake binding that records spawn calls and returns a fixed result. */
const makeFakeBinding = (opts?: {
  result?: NapiSpawnResult
  availability?: string
  spawnThrows?: Error
  availabilityThrows?: Error
}): { binding: NativeLandlockBinding; calls: BindingCall[] } => {
  const calls: BindingCall[] = []
  const result: NapiSpawnResult = opts?.result ?? {
    exitCode: 0,
    stdout: "native ok",
    stderr: "",
    sandboxApplied: true,
  }
  const availability =
    opts?.availability ??
    JSON.stringify({ available: true, kernelVersion: "6.5.0", abiSupported: 5 })
  const binding: NativeLandlockBinding = {
    spawn_sandboxed(spec, policy) {
      if (opts?.spawnThrows) throw opts.spawnThrows
      calls.push({ spec, policy })
      return result
    },
    availability() {
      if (opts?.availabilityThrows) throw opts.availabilityThrows
      return availability
    },
  }
  return { binding, calls }
}

/** Loader that simulates "package not installed" — returns null. */
const loaderMissing = (): NativeLandlockBinding | null => null

/** which that finds nothing — used to keep the Phase 2 fallback honest. */
const whichNone = async (_b: string): Promise<string | null> => null

/** which that finds bwrap only — Phase 2 fallback resolves. */
const whichBwrap = async (b: string): Promise<string | null> =>
  b === "bwrap" ? "/usr/bin/bwrap" : null

const POLICY_OFF: SandboxPolicy = { profile: "off" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }
const POLICY_DANGER: SandboxPolicy = { profile: "danger-full-access" }

/* ================================================================== */
/*  A. detectNativeLandlock (4)                                       */
/* ================================================================== */

describe("A. detectNativeLandlock — probe contract", () => {
  test("HELL-A1: package not installed (loader returns null) → null", async () => {
    const r = await detectNativeLandlock({ bindingLoader: loaderMissing })
    expect(r).toBeNull()
  })

  test("HELL-A2: binding loaded + availability=available → { abi, kernelVersion }", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({
        available: true,
        kernelVersion: "6.7.1",
        abiSupported: 6,
      }),
    })
    const r = await detectNativeLandlock({ binding })
    expect(r).toEqual({ abi: 6, kernelVersion: "6.7.1" })
  })

  test("HELL-A3: binding loaded + availability=unavailable (kernel too old) → null", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({
        available: false,
        kernelVersion: "4.19.0",
        abiSupported: 0,
        reason: "kernel-too-old",
      }),
    })
    const r = await detectNativeLandlock({ binding })
    expect(r).toBeNull()
  })

  test("HELL-A4: availability throws → null (graceful)", async () => {
    const { binding } = makeFakeBinding({
      availabilityThrows: new Error("napi binding panicked"),
    })
    const r = await detectNativeLandlock({ binding })
    expect(r).toBeNull()
  })
})

/* ================================================================== */
/*  B. nativeLandlockOsSandbox.spawn (8)                              */
/* ================================================================== */

describe("B. nativeLandlockOsSandbox — spawn runtime dispatch", () => {
  test("HELL-B5: profile=off → passthrough; sandboxApplied=false; no degradeReason", async () => {
    const { spawner, calls } = makeSpawner({ exitCode: 0, stdout: "off out", stderr: "" })
    const { binding } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding, spawner })
    const r = await sandbox.spawn({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_OFF)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
    expect(r.stdout).toBe("off out")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(["echo", "hi"])
  })

  test("HELL-B6: profile=workspace-write + binding loaded → spawn_sandboxed called with mapped policy", async () => {
    const { binding, calls } = makeFakeBinding({
      result: { exitCode: 0, stdout: "out", stderr: "err", sandboxApplied: true },
    })
    const sandbox = nativeLandlockOsSandbox({ binding })
    const r = await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.policy.profile).toBe("workspace-write")
    expect(calls[0]?.policy.workspace).toBe("/ws")
  })

  test("HELL-B7: binding throws → wrapped result + degradeReason=native-binding-threw", async () => {
    const { binding } = makeFakeBinding({ spawnThrows: new Error("kernel rejected ruleset") })
    const sandbox = nativeLandlockOsSandbox({ binding })
    const r = await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("native-binding-threw")
    expect(r.stderr).toContain("kernel rejected ruleset")
    expect(r.exitCode).toBe(127)
  })

  test("HELL-B8: spec.signal preserved in passthrough path (off profile)", async () => {
    const { spawner, calls } = makeSpawner()
    const { binding } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding, spawner })
    const ctrl = new AbortController()
    await sandbox.spawn({ command: ["x"], cwd: "/ws", signal: ctrl.signal }, POLICY_OFF)
    expect(calls[0]?.signal).toBe(ctrl.signal)
  })

  test("HELL-B9: extraReadPaths flow through to napi policy", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = {
      profile: "workspace-write",
      extraReadPaths: ["/opt/data", "/usr/local/include"],
    }
    await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, policy)
    expect(calls[0]?.policy.extraReadPaths).toEqual(["/opt/data", "/usr/local/include"])
  })

  test("HELL-B10: allowNetwork override propagates into napi policy", async () => {
    const { binding, calls } = makeFakeBinding()
    const sandbox = nativeLandlockOsSandbox({ binding })
    const policy: SandboxPolicy = { profile: "workspace-write", allowNetwork: true }
    await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, policy)
    expect(calls[0]?.policy.allowNetwork).toBe(true)
  })

  test("HELL-B11: NapiSpawnResult → SandboxedSpawnResult mapping (all 5 fields)", async () => {
    const { binding } = makeFakeBinding({
      result: {
        exitCode: 7,
        stdout: "OUT",
        stderr: "ERR",
        sandboxApplied: true,
        degradeReason: "net-deferred",
      },
    })
    const sandbox = nativeLandlockOsSandbox({ binding })
    const r: SandboxedSpawnResult = await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.exitCode).toBe(7)
    expect(r.stdout).toBe("OUT")
    expect(r.stderr).toBe("ERR")
    expect(r.sandboxApplied).toBe(true)
    expect(r.degradeReason).toBe("net-deferred")
  })

  test("HELL-B12: degradeReason absent in napi result → omitted (not undefined) in mapped result", async () => {
    const { binding } = makeFakeBinding({
      result: { exitCode: 0, stdout: "", stderr: "", sandboxApplied: true },
    })
    const sandbox = nativeLandlockOsSandbox({ binding })
    const r = await sandbox.spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect("degradeReason" in r).toBe(false)
  })
})

/* ================================================================== */
/*  C. defaultOsSandbox fallback chain (4)                            */
/* ================================================================== */

describe("C. defaultOsSandbox — Linux fallback chain (ADR-0175)", () => {
  test("HELL-C13: linux + native loaded → uses native (Tier 1)", async () => {
    const { binding, calls } = makeFakeBinding({
      result: { exitCode: 0, stdout: "native!", stderr: "", sandboxApplied: true },
    })
    const { spawner } = makeSpawner()
    const cfg: NativeLandlockConfig = {
      platform: "linux",
      binding,
      spawner,
      which: whichBwrap, // Phase 2 also resolvable — proves native wins.
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.stdout).toBe("native!")
    expect(r.sandboxApplied).toBe(true)
    expect(calls).toHaveLength(1) // binding actually invoked
  })

  test("HELL-C14: linux + native fails to load → falls to Phase 2 bubblewrap", async () => {
    const { spawner, calls } = makeSpawner({
      exitCode: 0,
      stdout: "bwrap out",
      stderr: "",
    })
    const cfg: NativeLandlockConfig = {
      platform: "linux",
      bindingLoader: loaderMissing,
      spawner,
      which: whichBwrap,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(true)
    // argv[0] should be bwrap (Phase 2 spawn).
    expect(calls[0]?.argv[0]).toBe("bwrap")
  })

  test("HELL-C15: linux + native missing + bwrap missing → degraded passthrough", async () => {
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "", stderr: "" })
    const cfg: NativeLandlockConfig = {
      platform: "linux",
      bindingLoader: loaderMissing,
      spawner,
      which: whichNone,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toContain("linux-bwrap-missing")
  })

  test("HELL-C16: non-linux (darwin) → Seatbelt branch unchanged (no native call)", async () => {
    const { binding, calls } = makeFakeBinding()
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "darwin", stderr: "" })
    const whichSandboxExec = async (b: string): Promise<string | null> =>
      b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null
    const cfg: NativeLandlockConfig = {
      platform: "darwin",
      binding, // present but should NOT be used on darwin
      spawner,
      which: whichSandboxExec,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(true)
    expect(calls).toHaveLength(0) // native binding not invoked on darwin
  })
})

/* ================================================================== */
/*  D. mapPolicyToNapi shape (4)                                      */
/* ================================================================== */

describe("D. mapPolicyToNapi — policy mapping contract", () => {
  test("HELL-D17: extraReadPaths preserved (array copy, same order)", () => {
    const p: SandboxPolicy = {
      profile: "workspace-write",
      extraReadPaths: ["/a", "/b", "/c"],
    }
    const napi = mapPolicyToNapi(p, "/ws")
    expect(napi.extraReadPaths).toEqual(["/a", "/b", "/c"])
    expect(napi.extraReadPaths).not.toBe(p.extraReadPaths) // defensive copy
  })

  test("HELL-D18: timeoutMs propagated (camelCase TS → camelCase napi-boundary)", () => {
    const p: SandboxPolicy = { profile: "workspace-write", timeoutMs: 5_000 }
    const napi = mapPolicyToNapi(p, "/ws")
    expect(napi.timeoutMs).toBe(5_000)
  })

  test("HELL-D19: profile string forwarded verbatim (closed enum)", () => {
    expect(mapPolicyToNapi({ profile: "read-only" }, "/ws").profile).toBe("read-only")
    expect(mapPolicyToNapi(POLICY_WW, "/ws").profile).toBe("workspace-write")
    expect(mapPolicyToNapi(POLICY_WWN, "/ws").profile).toBe("workspace-write-net")
    expect(mapPolicyToNapi(POLICY_DANGER, "/ws").profile).toBe("danger-full-access")
  })

  test("HELL-D20: absent optional fields omitted (exactOptional — not present as undefined)", () => {
    const p: SandboxPolicy = { profile: "workspace-write" }
    const napi = mapPolicyToNapi(p, "/ws")
    expect("allowNetwork" in napi).toBe(false)
    expect("timeoutMs" in napi).toBe(false)
    expect(napi.extraReadPaths).toEqual([]) // defaulted to [], not absent
    expect(napi.extraWritePaths).toEqual([])
  })
})
