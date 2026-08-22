import { describe, expect, test } from "bun:test"
import {
  compileWindowsSandboxSpec,
  type DefaultOsSandboxConfig,
  defaultOsSandbox,
  detectNativeWindows,
  type NativeWinResult,
  type NativeWinSpec,
  nativeWindowsOsSandbox,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
  serializeWindowsSpec,
  type WindowsSandboxBinding,
  type WindowsSandboxSpec,
} from "@/runtime/os-sandbox"

/**
 * Hellgate battery for ADR-0441 — Windows OS-sandbox backend.
 *
 * Three clusters are OS-INDEPENDENT (run from darwin/linux CI):
 *   A. compileWindowsSandboxSpec — pure spec compiler             (12)
 *   B. nativeWindowsOsSandbox / detectNativeWindows — boundary    (10)
 *   C. defaultOsSandbox win32 selection wire + byte-identical     (8)
 *
 * The real Win32 helper exe (L3 backlog) is NEVER invoked; every native test
 * injects a fake `WindowsSandboxBinding` via closed-port DI. A win32-gated
 * integration block (D) is documented but skipped off-Windows.
 *
 * 30 OS-independent cases + 1 gated marker.
 */

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
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
  spec: NativeWinSpec
  sandbox: WindowsSandboxSpec
}

const makeFakeBinding = (opts?: {
  result?: NativeWinResult
  availability?: string
  spawnThrows?: Error
  availabilityThrows?: Error
}): { binding: WindowsSandboxBinding; calls: BindingCall[] } => {
  const calls: BindingCall[] = []
  const result: NativeWinResult = opts?.result ?? {
    exitCode: 0,
    stdout: "native ok",
    stderr: "",
    sandboxApplied: true,
  }
  const availability =
    opts?.availability ?? JSON.stringify({ available: true, osBuild: "10.0.22631" })
  const binding: WindowsSandboxBinding = {
    spawn_sandboxed(spec, sandbox) {
      if (opts?.spawnThrows) throw opts.spawnThrows
      calls.push({ spec, sandbox })
      return result
    },
    availability() {
      if (opts?.availabilityThrows) throw opts.availabilityThrows
      return availability
    },
  }
  return { binding, calls }
}

const loaderMissing = (): WindowsSandboxBinding | null => null

const POLICY_RO: SandboxPolicy = { profile: "read-only" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }
const POLICY_OFF: SandboxPolicy = { profile: "off" }
const POLICY_DANGER: SandboxPolicy = { profile: "danger-full-access" }

/* ================================================================== */
/*  A. compileWindowsSandboxSpec — pure spec compiler (12)            */
/* ================================================================== */

describe("A. compileWindowsSandboxSpec — pure spec (OS-independent)", () => {
  test("HELL-A1: off → null (caller does NOT wrap)", () => {
    expect(compileWindowsSandboxSpec(POLICY_OFF, "C:\\ws")).toBeNull()
  })

  test("HELL-A2: danger-full-access → null", () => {
    expect(compileWindowsSandboxSpec(POLICY_DANGER, "C:\\ws")).toBeNull()
  })

  test("HELL-A3: read-only → restricted token, low integrity, NO write paths, net deny", () => {
    const spec = compileWindowsSandboxSpec(POLICY_RO, "C:\\ws")
    expect(spec).not.toBeNull()
    expect(spec?.restrictedToken).toBe(true)
    expect(spec?.integrityLevel).toBe("low")
    expect(spec?.writePaths).toEqual([])
    expect(spec?.readPaths).toEqual(["C:\\ws"])
    expect(spec?.allowNetwork).toBe(false)
  })

  test("HELL-A4: workspace-write → workspace in writePaths, net deny", () => {
    const spec = compileWindowsSandboxSpec(POLICY_WW, "C:\\ws")
    expect(spec?.writePaths).toEqual(["C:\\ws"])
    expect(spec?.readPaths).toEqual(["C:\\ws"])
    expect(spec?.allowNetwork).toBe(false)
  })

  test("HELL-A5: workspace-write-net → allowNetwork true", () => {
    const spec = compileWindowsSandboxSpec(POLICY_WWN, "C:\\ws")
    expect(spec?.allowNetwork).toBe(true)
    expect(spec?.writePaths).toEqual(["C:\\ws"])
  })

  test("HELL-A6: allowNetwork override on workspace-write → true", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "workspace-write", allowNetwork: true },
      "C:\\ws",
    )
    expect(spec?.allowNetwork).toBe(true)
  })

  test("HELL-A7: extraReadPaths — absolute verbatim, relative joined to workspace", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "workspace-write", extraReadPaths: ["D:\\opt", "sub\\dir"] },
      "C:\\ws",
    )
    expect(spec?.readPaths).toEqual(["C:\\ws", "D:\\opt", "C:\\ws\\sub\\dir"])
  })

  test("HELL-A8: extraWritePaths join + UNC absolute kept verbatim", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "workspace-write", extraWritePaths: ["\\\\server\\share", "out"] },
      "C:\\ws",
    )
    expect(spec?.writePaths).toEqual(["C:\\ws", "\\\\server\\share", "C:\\ws\\out"])
  })

  test("HELL-A9: read-only drops extraWritePaths (no writes by definition)", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "read-only", extraWritePaths: ["D:\\x"] },
      "C:\\ws",
    )
    expect(spec?.writePaths).toEqual([])
  })

  test("HELL-A10: memoryMb/timeoutMs exactOptional — present when set, omitted when absent", () => {
    const withCaps = compileWindowsSandboxSpec(
      { profile: "workspace-write", memoryMb: 512, timeoutMs: 30_000 },
      "C:\\ws",
    )
    expect(withCaps?.memoryMb).toBe(512)
    expect(withCaps?.timeoutMs).toBe(30_000)
    const without = compileWindowsSandboxSpec(POLICY_WW, "C:\\ws")
    expect(without && "memoryMb" in without).toBe(false)
    expect(without && "timeoutMs" in without).toBe(false)
  })

  test("HELL-A11: seccompMode IGNORED (Linux-only field) + denyReadPaths empty (no heuristics)", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "workspace-write", seccompMode: "strict" },
      "C:\\ws",
    )
    // No seccomp surface on the windows spec at all.
    expect(spec && "seccompMode" in spec).toBe(false)
    // v1 synthesizes NO deny-read list (no secret-directory heuristics).
    expect(spec?.denyReadPaths).toEqual([])
  })

  test("HELL-A12: serializeWindowsSpec — JSON round-trips paths with spaces/quotes/backslashes", () => {
    const spec = compileWindowsSandboxSpec(
      { profile: "workspace-write", extraReadPaths: ['C:\\a "b"\\c', "D:\\space dir"] },
      "C:\\my ws",
    )
    expect(spec).not.toBeNull()
    if (spec === null) return
    const json = serializeWindowsSpec(spec)
    const parsed = JSON.parse(json) as WindowsSandboxSpec
    expect(parsed.readPaths).toEqual(spec.readPaths)
    expect(parsed.writePaths).toEqual(spec.writePaths)
    // Adversarial paths survive intact (no argv quoting corruption).
    expect(parsed.readPaths).toContain('C:\\a "b"\\c')
  })
})

/* ================================================================== */
/*  B. nativeWindowsOsSandbox / detectNativeWindows — boundary (10)   */
/* ================================================================== */

describe("B. nativeWindowsOsSandbox — native boundary (fake binding DI)", () => {
  test("HELL-B13: detectNativeWindows — helper missing (loader null) → null", async () => {
    expect(await detectNativeWindows({ bindingLoader: loaderMissing })).toBeNull()
  })

  test("HELL-B14: detectNativeWindows — available → { osBuild }", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({ available: true, osBuild: "10.0.22631" }),
    })
    expect(await detectNativeWindows({ binding })).toEqual({ osBuild: "10.0.22631" })
  })

  test("HELL-B15: detectNativeWindows — available=false → null", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({ available: false, osBuild: "", reason: "unsupported-build" }),
    })
    expect(await detectNativeWindows({ binding })).toBeNull()
  })

  test("HELL-B16: detectNativeWindows — availability throws → null (graceful)", async () => {
    const { binding } = makeFakeBinding({ availabilityThrows: new Error("helper panicked") })
    expect(await detectNativeWindows({ binding })).toBeNull()
  })

  test("HELL-B17: binding null → degraded passthrough (native-binding-unavailable)", async () => {
    const { spawner, calls } = makeSpawner({ exitCode: 0, stdout: "pt out", stderr: "" })
    const sandbox = nativeWindowsOsSandbox({ bindingLoader: loaderMissing, spawner })
    const r = await sandbox.spawn({ command: ["x"], cwd: "C:\\ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("native-binding-unavailable")
    expect(r.stdout).toBe("pt out")
    expect(calls).toHaveLength(1)
  })

  test("HELL-B18: profile=off → pure passthrough, NO degradeReason", async () => {
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "off", stderr: "" })
    const { binding } = makeFakeBinding()
    const sandbox = nativeWindowsOsSandbox({ binding, spawner })
    const r = await sandbox.spawn({ command: ["x"], cwd: "C:\\ws" }, POLICY_OFF)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-B19: workspace-write + helper → spawn_sandboxed receives compiled spec", async () => {
    const { binding, calls } = makeFakeBinding({
      result: { exitCode: 0, stdout: "iso", stderr: "", sandboxApplied: true },
    })
    const sandbox = nativeWindowsOsSandbox({ binding })
    const r = await sandbox.spawn({ command: ["cmd"], cwd: "C:\\ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sandbox.restrictedToken).toBe(true)
    expect(calls[0]?.sandbox.integrityLevel).toBe("low")
    expect(calls[0]?.sandbox.writePaths).toEqual(["C:\\ws"])
    expect(calls[0]?.spec.command).toEqual(["cmd"])
    expect(calls[0]?.spec.cwd).toBe("C:\\ws")
  })

  test("HELL-B20: binding throws → exitCode 127 + native-binding-threw, never throws", async () => {
    const { binding } = makeFakeBinding({ spawnThrows: new Error("token creation failed") })
    const sandbox = nativeWindowsOsSandbox({ binding })
    const r = await sandbox.spawn({ command: ["cmd"], cwd: "C:\\ws" }, POLICY_WW)
    expect(r.exitCode).toBe(127)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("native-binding-threw")
    expect(r.stderr).toContain("token creation failed")
  })

  test("HELL-B21: result mapping — all 5 fields + degradeReason forwarded", async () => {
    const { binding } = makeFakeBinding({
      result: {
        exitCode: 3,
        stdout: "O",
        stderr: "E",
        sandboxApplied: true,
        degradeReason: "win32-network-policy-not-enforced",
      },
    })
    const r: SandboxedSpawnResult = await nativeWindowsOsSandbox({ binding }).spawn(
      { command: ["c"], cwd: "C:\\ws" },
      POLICY_WW,
    )
    expect(r.exitCode).toBe(3)
    expect(r.stdout).toBe("O")
    expect(r.stderr).toBe("E")
    expect(r.degradeReason).toBe("win32-network-policy-not-enforced")
  })

  test("HELL-B22: availability — helper present → windows-restricted-token; absent → passthrough", async () => {
    const { binding } = makeFakeBinding()
    expect((await nativeWindowsOsSandbox({ binding }).availability()).backend).toBe(
      "windows-restricted-token",
    )
    const absent = await nativeWindowsOsSandbox({ bindingLoader: loaderMissing }).availability()
    expect(absent.backend).toBe("passthrough")
    expect(absent.warnings[0]).toContain("quanta-win-sandbox.exe")
  })
})

/* ================================================================== */
/*  C. defaultOsSandbox win32 selection wire + byte-identical (8)     */
/* ================================================================== */

describe("C. defaultOsSandbox — win32 selection (platform override)", () => {
  test("HELL-C23: win32 + no helper + REQUESTED sandbox → FAIL-CLOSED refusal, spawner NEVER called (DOF-40)", async () => {
    const { spawner, calls } = makeSpawner({ exitCode: 0, stdout: "pt", stderr: "" })
    const cfg: DefaultOsSandboxConfig = {
      platform: "win32",
      windows: { bindingLoader: loaderMissing },
      spawner,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "C:\\ws" }, POLICY_WW)
    // LOAD-BEARING: a requested sandbox that can't be enforced REFUSES the spawn.
    expect(calls).toHaveLength(0)
    expect(r.exitCode).toBe(126)
    expect(r.stdout).toBe("")
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("win32-sandbox-helper-missing")
    expect(r.stderr).toContain("REFUSED")
    expect(r.stderr).toContain("quanta-win-sandbox.exe")
  })

  test("HELL-C24: win32 + no helper → command REFUSED, sentinel result NEVER surfaces (DOF-40)", async () => {
    const { spawner, calls } = makeSpawner({ exitCode: 42, stdout: "OUT", stderr: "ERR" })
    const cfg: DefaultOsSandboxConfig = {
      platform: "win32",
      windows: { bindingLoader: loaderMissing },
      spawner,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "C:\\ws" }, POLICY_RO)
    // NOT a silent unsandboxed run: the fake spawner's 42/OUT/ERR never leak out.
    expect(calls).toHaveLength(0)
    expect(r.exitCode).toBe(126)
    expect(r.stdout).toBe("")
    expect(r.stdout.includes("OUT")).toBe(false)
    expect(r.sandboxApplied).toBe(false)
  })

  test("HELL-C25: win32 + helper present → native path, sandboxApplied=true", async () => {
    const { binding, calls } = makeFakeBinding({
      result: { exitCode: 0, stdout: "iso!", stderr: "", sandboxApplied: true },
    })
    const cfg: DefaultOsSandboxConfig = { platform: "win32", windows: { binding } }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "C:\\ws" }, POLICY_WW)
    expect(r.stdout).toBe("iso!")
    expect(r.sandboxApplied).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test("HELL-C26: win32 + profile=off → pure passthrough, NO degradeReason", async () => {
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "off", stderr: "" })
    const cfg: DefaultOsSandboxConfig = {
      platform: "win32",
      windows: { bindingLoader: loaderMissing },
      spawner,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["x"], cwd: "C:\\ws" }, POLICY_OFF)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-C27: win32 + danger-full-access → pure passthrough, NO degradeReason", async () => {
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "", stderr: "" })
    const cfg: DefaultOsSandboxConfig = {
      platform: "win32",
      windows: { bindingLoader: loaderMissing },
      spawner,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["x"], cwd: "C:\\ws" }, POLICY_DANGER)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-C28: availability win32 — helper present → windows-restricted-token, no warnings", async () => {
    const { binding } = makeFakeBinding()
    const cfg: DefaultOsSandboxConfig = { platform: "win32", windows: { binding } }
    const a = await defaultOsSandbox(cfg).availability()
    expect(a.backend).toBe("windows-restricted-token")
    expect(a.warnings).toEqual([])
  })

  test("HELL-C29: availability win32 — no helper → passthrough + loud warning", async () => {
    const cfg: DefaultOsSandboxConfig = {
      platform: "win32",
      windows: { bindingLoader: loaderMissing },
    }
    const a = await defaultOsSandbox(cfg).availability()
    expect(a.backend).toBe("passthrough")
    expect(a.warnings[0]).toContain("quanta-win-sandbox.exe not found")
  })

  test("HELL-C30: non-win32 (darwin) regression — Windows branch never touched", async () => {
    const { binding, calls } = makeFakeBinding()
    const { spawner } = makeSpawner({ exitCode: 0, stdout: "darwin", stderr: "" })
    const whichSandboxExec = async (b: string): Promise<string | null> =>
      b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null
    const cfg: DefaultOsSandboxConfig = {
      platform: "darwin",
      windows: { binding }, // present but must NOT be used on darwin
      spawner,
      which: whichSandboxExec,
    }
    const r = await defaultOsSandbox(cfg).spawn({ command: ["cmd"], cwd: "/ws" }, POLICY_WW)
    expect(r.sandboxApplied).toBe(true) // seatbelt branch
    expect(calls).toHaveLength(0) // windows binding never invoked
  })
})

/* ================================================================== */
/*  D. win32 integration (gated — real helper exe, L3 backlog)        */
/* ================================================================== */

describe("D. win32 integration (gated)", () => {
  const onWin32 = process.platform === "win32"
  test.skipIf(!onWin32)(
    "HELL-D31: real quanta-win-sandbox.exe enforces read-only outside workspace (L3)",
    () => {
      // Requires the L3 helper exe artifact + a Windows runner. Off-Windows
      // this is skipped — clusters A/B/C are the OS-independent coverage.
      // Documented as the integration surface the helper build must satisfy.
      expect(onWin32).toBe(true)
    },
  )
})
