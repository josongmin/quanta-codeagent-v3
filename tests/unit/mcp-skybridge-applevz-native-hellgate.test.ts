/**
 * MCP Skybridge — **native Apple Virtualization** hellgate (ADR-0190 Phase 3.3).
 *
 * Seals the napi-rs adapter `applevz-native.ts` across 4 sections — 20 cases.
 * No real `@quanta/darwin-vz-helper` import; every test injects a fake
 * `NativeAppleVzBinding` via `cfg.binding` (or `cfg.bindingLoader`).
 * Hermetic — runs from any host.
 *
 * Clusters:
 *   A. detect availability                       (3)
 *   B. nativeAppleVzSandbox.spawn dispatch       (10)
 *   C. policy mapping shape                      (3)
 *   D. registry routing                          (4)
 *
 * 20 cases / 0 fail.
 */

import { describe, expect, test } from "bun:test"
import {
  type McpSandbox,
  McpSandboxError,
  type McpSandboxPolicy,
  type McpServerSpec,
  resolveMcpSandbox,
} from "@/mcp/skybridge"
import {
  detectNativeAppleVz,
  mapPolicyToNapi as mapPolicyToNapiVz,
  type NapiMcpVmPolicy,
  type NapiVmSpawnResult,
  type NapiVmSpawnSpec,
  type NativeAppleVzBinding,
  type NativeAppleVzConfig,
  nativeAppleVzSandbox,
} from "@/mcp/skybridge/applevz-native"

/* ------------------------------------------------------------------ */
/*  test helpers                                                       */
/* ------------------------------------------------------------------ */

interface BindingCall {
  readonly spec: NapiVmSpawnSpec
  readonly policy: NapiMcpVmPolicy
}

const makeFakeBinding = (opts?: {
  result?: NapiVmSpawnResult
  availability?: string
  spawnThrows?: Error
  availabilityThrows?: Error
}): { binding: NativeAppleVzBinding; calls: BindingCall[] } => {
  const calls: BindingCall[] = []
  const result: NapiVmSpawnResult = opts?.result ?? {
    vmId: "quanta-vz-deadbeef",
    ipcKind: "vsock",
    ipcRef: "5005",
    sandboxApplied: true,
  }
  const availability =
    opts?.availability ?? JSON.stringify({ available: true, backend: "apple-virtualization" })
  const binding: NativeAppleVzBinding = {
    spawn_vm_for_mcp(spec, policy) {
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

const loaderMissing = (): NativeAppleVzBinding | null => null

const spec = (overrides: Partial<McpServerSpec> & Pick<McpServerSpec, "id">): McpServerSpec => ({
  id: overrides.id,
  command: overrides.command ?? ["node", "server.js"],
  ...(overrides.env !== undefined ? { env: overrides.env } : {}),
  ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : { cwd: "/workspace" }),
})

const policy = (overrides: Partial<McpSandboxPolicy> = {}): McpSandboxPolicy => ({
  profile: overrides.profile ?? "microvm",
  ...(overrides.networkAllowlist !== undefined
    ? { networkAllowlist: overrides.networkAllowlist }
    : {}),
  ...(overrides.hostReadAllowlist !== undefined
    ? { hostReadAllowlist: overrides.hostReadAllowlist }
    : {}),
  ...(overrides.hostWriteAllowlist !== undefined
    ? { hostWriteAllowlist: overrides.hostWriteAllowlist }
    : {}),
  ...(overrides.memoryMb !== undefined ? { memoryMb: overrides.memoryMb } : {}),
  ...(overrides.cpuCount !== undefined ? { cpuCount: overrides.cpuCount } : {}),
  ...(overrides.maxRuntimeMs !== undefined ? { maxRuntimeMs: overrides.maxRuntimeMs } : {}),
  ...(overrides.bootImagePath !== undefined ? { bootImagePath: overrides.bootImagePath } : {}),
})

/* ================================================================== */
/*  A. detect availability (3)                                         */
/* ================================================================== */
describe("skybridge / A. detect availability (darwin-vz)", () => {
  test("HELL-VZ-1: package not loadable on darwin → detect=null + adapter availability backend=passthrough + warning", async () => {
    const r = await detectNativeAppleVz({
      bindingLoader: loaderMissing,
      platform: "darwin",
    })
    expect(r).toBeNull()
    const sb = nativeAppleVzSandbox({ bindingLoader: loaderMissing, platform: "darwin" })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.join("|").toLowerCase()).toContain("darwin-vz-not-loaded")
  })

  test("HELL-VZ-2: loadable + AVF available → detect returns backend; adapter availability='microvm'", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({ available: true, backend: "apple-virtualization" }),
    })
    const r = await detectNativeAppleVz({ binding, platform: "darwin" })
    expect(r).not.toBeNull()
    expect(r?.backend).toBe("apple-virtualization")
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    const av = await sb.availability()
    expect(av.backend).toBe("microvm")
  })

  test("HELL-VZ-3: loadable + AVF unavailable (entitlements missing) → degrade with reason", async () => {
    const { binding } = makeFakeBinding({
      availability: JSON.stringify({
        available: false,
        backend: "passthrough",
        reason: "entitlement-missing",
      }),
    })
    const r = await detectNativeAppleVz({ binding, platform: "darwin" })
    expect(r).toBeNull()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.join("|")).toContain("entitlement-missing")
  })
})

/* ================================================================== */
/*  B. nativeAppleVzSandbox.spawn dispatch (10)                       */
/* ================================================================== */
describe("skybridge / B. nativeAppleVzSandbox.spawn", () => {
  test("HELL-VZ-4: profile=off → policy-rejected (bypass profile reached native adapter); native NOT called", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "x" }), policy({ profile: "off" }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("policy-rejected")
    expect(calls).toHaveLength(0)
  })

  test("HELL-VZ-5: profile=microvm + native available → spawn_vm_for_mcp called; sandboxApplied=true", async () => {
    const { binding, calls } = makeFakeBinding({
      result: {
        vmId: "vm-abc",
        ipcKind: "vsock",
        ipcRef: "5005",
        sandboxApplied: true,
      },
    })
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    const h = await sb.spawn(spec({ id: "mcp-1" }), policy({}))
    expect(h.sandboxApplied).toBe(true)
    expect(h.backendId).toBe("vm-abc")
    expect(h.ipcChannel.kind).toBe("vsock")
    expect(h.ipcChannel.ref).toBe("5005")
    expect(calls).toHaveLength(1)
  })

  test("HELL-VZ-6: profile=container → policy-rejected (VZ doesn't do containers; fall back via registry)", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "x" }), policy({ profile: "container" }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("policy-rejected")
    expect((caught as McpSandboxError).message.toLowerCase()).toContain("container")
    expect(calls).toHaveLength(0)
  })

  test("HELL-VZ-7: policy.workspace propagated from spec.cwd into napi struct", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    await sb.spawn(spec({ id: "ws", cwd: "/home/agent/work" }), policy({}))
    expect(calls[0]?.policy.workspace).toBe("/home/agent/work")
  })

  test("HELL-VZ-8: networkAllowlist non-empty → allowNetwork=true derived in napi struct; empty → omitted", async () => {
    // Non-empty allowlist derives allowNetwork=true.
    const { binding: b1, calls: c1 } = makeFakeBinding()
    const sb1 = nativeAppleVzSandbox({ binding: b1, platform: "darwin" })
    await sb1.spawn(spec({ id: "n" }), policy({ networkAllowlist: ["api.example.com:443"] }))
    expect(c1[0]?.policy.allowNetwork).toBe(true)
    // Absent allowlist → allowNetwork field omitted (not undefined-set).
    const { binding: b2, calls: c2 } = makeFakeBinding()
    const sb2 = nativeAppleVzSandbox({ binding: b2, platform: "darwin" })
    await sb2.spawn(spec({ id: "n" }), policy({}))
    expect("allowNetwork" in (c2[0]?.policy ?? {})).toBe(false)
  })

  test("HELL-VZ-9: networkAllowlist propagated (defensive copy, same order)", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    await sb.spawn(
      spec({ id: "n" }),
      policy({ networkAllowlist: ["github.com:443", "registry.npmjs.org:443"] }),
    )
    expect(calls[0]?.policy.networkAllowlist).toEqual(["github.com:443", "registry.npmjs.org:443"])
  })

  test("HELL-VZ-10: hostReadAllowlist + hostWriteAllowlist propagated separately", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    await sb.spawn(
      spec({ id: "n" }),
      policy({
        hostReadAllowlist: ["/etc", "/usr"],
        hostWriteAllowlist: ["/workspace"],
      }),
    )
    expect(calls[0]?.policy.hostReadAllowlist).toEqual(["/etc", "/usr"])
    expect(calls[0]?.policy.hostWriteAllowlist).toEqual(["/workspace"])
  })

  test("HELL-VZ-11: memoryMb / cpuCount / maxRuntimeMs propagated (Phase 3 resource caps)", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    await sb.spawn(spec({ id: "r" }), policy({ memoryMb: 2048, cpuCount: 4, maxRuntimeMs: 30_000 }))
    expect(calls[0]?.policy.memoryMb).toBe(2048)
    expect(calls[0]?.policy.cpuCount).toBe(4)
    expect(calls[0]?.policy.maxRuntimeMs).toBe(30_000)
  })

  test("HELL-VZ-12: bootImagePath propagated (Phase 3.4 boot loader hint)", async () => {
    const { binding, calls } = makeFakeBinding()
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    await sb.spawn(spec({ id: "b" }), policy({ bootImagePath: "/var/quanta/images/skybridge.img" }))
    expect(calls[0]?.policy.bootImagePath).toBe("/var/quanta/images/skybridge.img")
  })

  test("HELL-VZ-13: native throws → wrapped as McpSandboxError('backend-unavailable') with cause", async () => {
    const { binding } = makeFakeBinding({
      spawnThrows: new Error("darwin-vz: Phase 3.3 scaffold"),
    })
    const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "t" }), policy({}))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("backend-unavailable")
    expect((caught as McpSandboxError).message.toLowerCase()).toContain("phase 3.3 scaffold")
    expect(((caught as McpSandboxError).cause as Error)?.message).toContain("Phase 3.3 scaffold")
  })
})

/* ================================================================== */
/*  C. policy mapping shape (3)                                        */
/* ================================================================== */
describe("skybridge / C. mapPolicyToNapiVz — policy mapping contract", () => {
  test("HELL-VZ-14: exactOptional — absent fields omitted (not undefined-set) in napi struct", () => {
    const p: McpSandboxPolicy = { profile: "microvm" }
    const napi = mapPolicyToNapiVz(p, "/ws")
    expect("allowNetwork" in napi).toBe(false)
    expect("memoryMb" in napi).toBe(false)
    expect("cpuCount" in napi).toBe(false)
    expect("maxRuntimeMs" in napi).toBe(false)
    expect("bootImagePath" in napi).toBe(false)
    // Required-array fields defaulted to [] (napi-rs Option<Vec<_>> rough-edge).
    expect(napi.networkAllowlist).toEqual([])
    expect(napi.hostReadAllowlist).toEqual([])
    expect(napi.hostWriteAllowlist).toEqual([])
  })

  test("HELL-VZ-15: ipcKind from napi result → correctly mapped (vsock | stdio | named-pipe)", async () => {
    const cases: Array<{ napi: string; expected: "vsock" | "stdio" | "named-pipe" }> = [
      { napi: "vsock", expected: "vsock" },
      { napi: "stdio-over-ssh", expected: "stdio" },
      { napi: "passthrough", expected: "named-pipe" },
      { napi: "weird-future-kind", expected: "named-pipe" }, // unknown → safe default
    ]
    for (const c of cases) {
      const { binding } = makeFakeBinding({
        result: {
          vmId: "v",
          ipcKind: c.napi,
          ipcRef: "ref",
          sandboxApplied: true,
        },
      })
      const sb = nativeAppleVzSandbox({ binding, platform: "darwin" })
      const h = await sb.spawn(spec({ id: "k" }), policy({}))
      expect(h.ipcChannel.kind).toBe(c.expected)
      expect(h.ipcChannel.ref).toBe("ref")
    }
  })

  test("HELL-VZ-16: degradeReason from napi result preserved in handle (omitted when absent)", async () => {
    // Present case
    const { binding: b1 } = makeFakeBinding({
      result: {
        vmId: "v",
        ipcKind: "vsock",
        ipcRef: "p",
        sandboxApplied: false,
        degradeReason: "vz-phase3.3-scaffold",
      },
    })
    const sb1 = nativeAppleVzSandbox({ binding: b1, platform: "darwin" })
    const h1 = await sb1.spawn(spec({ id: "d" }), policy({}))
    expect(h1.sandboxApplied).toBe(false)
    expect(h1.degradeReason).toBe("vz-phase3.3-scaffold")
    // Absent case
    const { binding: b2 } = makeFakeBinding({
      result: { vmId: "v", ipcKind: "vsock", ipcRef: "p", sandboxApplied: true },
    })
    const sb2 = nativeAppleVzSandbox({ binding: b2, platform: "darwin" })
    const h2 = await sb2.spawn(spec({ id: "d" }), policy({}))
    expect("degradeReason" in h2).toBe(false)
  })
})

/* ================================================================== */
/*  D. registry routing (4)                                            */
/* ================================================================== */
describe("skybridge / D. registry routing (native AVF tier)", () => {
  const fakeWired = (label: string): McpSandbox => ({
    async spawn(s, p) {
      return {
        serverId: s.id,
        profile: p.profile,
        backendId: `${label}-${s.id}`,
        sandboxApplied: true,
        ipcChannel: { kind: "vsock", ref: label },
        stop: async () => {},
      }
    },
    async availability() {
      return { backend: "microvm", warnings: [`source:${label}`] }
    },
  })

  test("HELL-VZ-17: profile=microvm + nativeAppleVzSandbox wired → routed to native (priority over microvmSandbox)", async () => {
    const native = fakeWired("native")
    const lima = fakeWired("lima")
    const sb = resolveMcpSandbox(policy({}), {
      nativeAppleVzSandbox: native,
      microvmSandbox: lima,
    })
    const h = await sb.spawn(spec({ id: "r" }), policy({}))
    expect(h.backendId).toBe("native-r")
  })

  test("HELL-VZ-18: profile=microvm + ONLY microvmSandbox wired (no native) → routed to Lima/external (Phase 2)", async () => {
    const lima = fakeWired("lima")
    const sb = resolveMcpSandbox(policy({}), { microvmSandbox: lima })
    const h = await sb.spawn(spec({ id: "r" }), policy({}))
    expect(h.backendId).toBe("lima-r")
  })

  test("HELL-VZ-19: profile=microvm + nothing wired → degraded passthrough (sandboxApplied=false, never throws)", async () => {
    const sb = resolveMcpSandbox(policy({}))
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    const h = await sb.spawn(spec({ id: "d" }), policy({}))
    expect(h.sandboxApplied).toBe(false)
    // degradeReason is set by passthrough adapter when profile !== "off".
    expect(h.degradeReason).toBeDefined()
  })

  test("HELL-VZ-20: profile=off short-circuits — nativeAppleVzSandbox is NOT consulted even when wired (caller-injection wins)", async () => {
    // Wire BOTH a fake native + a fake spawner; profile="off" must route to
    // passthrough (Rule 1) and NEVER invoke the native adapter. This proves
    // the caller-injection rule against the off short-circuit.
    let nativeCalled = false
    const native: McpSandbox = {
      async spawn(s, p) {
        nativeCalled = true
        return {
          serverId: s.id,
          profile: p.profile,
          backendId: "native-spawn-was-called",
          sandboxApplied: true,
          ipcChannel: { kind: "vsock", ref: "x" },
          stop: async () => {},
        }
      },
      async availability() {
        return { backend: "microvm", warnings: [] }
      },
    }
    const spawner = async (
      _argv: ReadonlyArray<string>,
      _opts: { cwd?: string; env?: Readonly<Record<string, string>> },
    ) => ({ pid: 9999, stop: async () => {} })
    const sb = resolveMcpSandbox(policy({ profile: "off" }), {
      nativeAppleVzSandbox: native,
      spawner,
    })
    const h = await sb.spawn(spec({ id: "off" }), policy({ profile: "off" }))
    // Native MUST NOT have been called.
    expect(nativeCalled).toBe(false)
    // Passthrough's "off" arm: sandboxApplied=false, degradeReason OMITTED
    // (explicit opt-out, not a degradation — passthrough.ts:104 returns reason=null).
    expect(h.sandboxApplied).toBe(false)
    expect("degradeReason" in h).toBe(false)
    expect(h.backendId).toBe("9999") // passthrough buildHandle uses raw.pid
  })
})

// Silence unused-import warning for NativeAppleVzConfig — exported type
// surface validation only.
type _Verify = NativeAppleVzConfig
