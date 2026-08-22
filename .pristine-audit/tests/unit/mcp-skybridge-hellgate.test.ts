/**
 * MCP Skybridge — hellgate (ADR-0155).
 *
 * Seals the typed policy + closed `McpSandbox` port + passthrough adapter +
 * Phase 2 stubs + registry across 5 sections — 18 cases total. Uses a fake
 * `SkybridgeSpawner` so the test depends on zero real subprocesses.
 *
 * Sections:
 *   A. Policy type / port compile (4)
 *   B. passthroughMcpSandbox.spawn   (8)
 *   C. availability + registry       (3)
 *   D. Phase-2 stubs                 (2)
 *   E. Registry off short-circuit    (1)
 */

import { describe, expect, test } from "bun:test"
import {
  containerMcpSandbox,
  type McpSandbox,
  type McpSandboxConfig,
  McpSandboxError,
  type McpSandboxHandle,
  type McpSandboxPolicy,
  type McpServerSpec,
  microvmMcpSandbox,
  passthroughMcpSandbox,
  resolveMcpSandbox,
  type SkybridgeProfile,
  type SkybridgeSpawner,
  type SkybridgeSpawnHandle,
} from "@/mcp/skybridge"

// ────────────────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────────────────

interface SpawnCall {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
}

interface FakeSpawnerState {
  readonly calls: SpawnCall[]
  /** Each spawn returns a handle; `stopCounts[pid]` increments on stop call. */
  readonly stopCounts: Map<number, number>
  nextPid: number
  throwOn: boolean
  throwMessage: string
}

const makeFakeSpawner = (): { spawner: SkybridgeSpawner; state: FakeSpawnerState } => {
  const state: FakeSpawnerState = {
    calls: [],
    stopCounts: new Map<number, number>(),
    nextPid: 1000,
    throwOn: false,
    throwMessage: "boom",
  }
  const spawner: SkybridgeSpawner = async (argv, opts) => {
    state.calls.push({ argv, cwd: opts.cwd, env: opts.env })
    if (state.throwOn) throw new Error(state.throwMessage)
    const pid = state.nextPid++
    const handle: SkybridgeSpawnHandle = {
      pid,
      stop: async () => {
        state.stopCounts.set(pid, (state.stopCounts.get(pid) ?? 0) + 1)
      },
    }
    return handle
  }
  return { spawner, state }
}

const spec = (overrides: Partial<McpServerSpec> & Pick<McpServerSpec, "id">): McpServerSpec => ({
  id: overrides.id,
  command: overrides.command ?? ["bun", "server.ts"],
  ...(overrides.env !== undefined ? { env: overrides.env } : {}),
  ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
})

const policy = (profile: SkybridgeProfile): McpSandboxPolicy => ({ profile })

// ────────────────────────────────────────────────────────────────────────────
// A. POLICY TYPE / PORT COMPILE (4)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / A. policy type + port", () => {
  test("HELL-1: SkybridgeProfile is the 4-arm closed union (compile-level)", () => {
    // Exhaustive switch over the union — compiler enforces all 4 arms.
    const all: ReadonlyArray<SkybridgeProfile> = ["off", "process-isolated", "container", "microvm"]
    const seen = new Set<string>()
    for (const p of all) {
      switch (p) {
        case "off":
          seen.add(p)
          break
        case "process-isolated":
          seen.add(p)
          break
        case "container":
          seen.add(p)
          break
        case "microvm":
          seen.add(p)
          break
      }
    }
    expect(seen.size).toBe(4)
  })

  test("HELL-2: McpSandboxPolicy with all optionals absent is constructible (exactOptional)", () => {
    // Bare-minimum policy. No `field: undefined` shape — exactOptional
    // requires omitted fields to be absent.
    const p: McpSandboxPolicy = { profile: "off" }
    expect(p.profile).toBe("off")
    // None of the optionals are reflected as `undefined` keys when omitted.
    // (Object.hasOwn check — exactOptional surface contract.)
    expect(Object.hasOwn(p, "networkAllowlist")).toBe(false)
    expect(Object.hasOwn(p, "hostReadAllowlist")).toBe(false)
    expect(Object.hasOwn(p, "hostWriteAllowlist")).toBe(false)
    expect(Object.hasOwn(p, "maxRuntimeMs")).toBe(false)
    expect(Object.hasOwn(p, "memoryMb")).toBe(false)
  })

  test("HELL-3: handle.degradeReason is OMITTED (not undefined-set) when sandboxApplied=true", async () => {
    const { spawner } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s" }), policy("process-isolated"))
    expect(h.sandboxApplied).toBe(true)
    // exactOptional honesty: key must be absent, not `undefined`-set.
    expect(Object.hasOwn(h, "degradeReason")).toBe(false)
  })

  test("HELL-4: McpSandboxError.code is the closed 4-arm union", () => {
    const arms: ReadonlyArray<
      "backend-unavailable" | "policy-rejected" | "spawn-failed" | "ipc-failed"
    > = ["backend-unavailable", "policy-rejected", "spawn-failed", "ipc-failed"]
    const seen = new Set<string>()
    for (const code of arms) {
      const e = new McpSandboxError(code, "msg")
      expect(e.code).toBe(code)
      expect(e instanceof Error).toBe(true)
      seen.add(e.code)
    }
    expect(seen.size).toBe(4)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. passthroughMcpSandbox.spawn (8)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / B. passthrough.spawn", () => {
  test("HELL-5: profile=off → spawner called; sandboxApplied=false; degradeReason OMITTED", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s1" }), policy("off"))
    expect(state.calls.length).toBe(1)
    expect(h.sandboxApplied).toBe(false)
    expect(Object.hasOwn(h, "degradeReason")).toBe(false)
    expect(h.profile).toBe("off")
    expect(h.serverId).toBe("s1")
    expect(h.ipcChannel.kind).toBe("stdio")
  })

  test("HELL-6: profile=process-isolated → spawner called; sandboxApplied=true (OS process boundary IS a real layer)", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s2" }), policy("process-isolated"))
    expect(state.calls.length).toBe(1)
    expect(h.sandboxApplied).toBe(true)
    expect(Object.hasOwn(h, "degradeReason")).toBe(false)
  })

  test("HELL-7: profile=container → sandboxApplied=false; degradeReason='phase2-not-implemented'; spawner STILL called (MCP must work)", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s3" }), policy("container"))
    expect(state.calls.length).toBe(1) // spawn still happens
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toBe("phase2-not-implemented")
  })

  test("HELL-8: profile=microvm → same shape as container (degraded but spawned)", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s4" }), policy("microvm"))
    expect(state.calls.length).toBe(1)
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toBe("phase2-not-implemented")
    expect(h.profile).toBe("microvm")
  })

  test("HELL-9: spec.env propagated verbatim to spawner", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    await sb.spawn(spec({ id: "s5", env: { FOO: "bar", BAZ: "qux" } }), policy("process-isolated"))
    const call = state.calls[0]
    expect(call).toBeDefined()
    expect(call?.env).toEqual({ FOO: "bar", BAZ: "qux" })
  })

  test("HELL-10: spec.cwd propagated verbatim to spawner", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    await sb.spawn(spec({ id: "s6", cwd: "/tmp/work" }), policy("process-isolated"))
    expect(state.calls[0]?.cwd).toBe("/tmp/work")
    // And omitted cwd is propagated as undefined (not present).
    const { spawner: sp2, state: st2 } = makeFakeSpawner()
    const sb2 = passthroughMcpSandbox({ spawner: sp2 })
    await sb2.spawn(spec({ id: "s6b" }), policy("process-isolated"))
    expect(st2.calls[0]?.cwd).toBeUndefined()
  })

  test("HELL-11: spawner throws → handle returned with backendId='error' + sandboxApplied=false + typed degradeReason (no-throw contract)", async () => {
    const { spawner, state } = makeFakeSpawner()
    state.throwOn = true
    state.throwMessage = "exec EACCES"
    const sb = passthroughMcpSandbox({ spawner })
    // Must NOT throw — the no-throw contract collapses backend failure to
    // a typed-shape return.
    const h = await sb.spawn(spec({ id: "s7" }), policy("process-isolated"))
    expect(h.backendId).toBe("error")
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toContain("spawn-failed")
    expect(h.degradeReason).toContain("exec EACCES")
    expect(h.ipcChannel.ref).toBe("error")
  })

  test("HELL-12: handle.stop() → spawner-returned stop() called once; second call no-op (idempotent)", async () => {
    const { spawner, state } = makeFakeSpawner()
    const sb = passthroughMcpSandbox({ spawner })
    const h = await sb.spawn(spec({ id: "s8" }), policy("process-isolated"))
    const pid = Number(h.backendId)
    expect(state.stopCounts.get(pid)).toBeUndefined()
    await h.stop()
    expect(state.stopCounts.get(pid)).toBe(1)
    // Second stop is a no-op at the adapter boundary — inner spawner stop
    // is NOT called again.
    await h.stop()
    expect(state.stopCounts.get(pid)).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. AVAILABILITY + REGISTRY (3)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / C. availability + registry", () => {
  test("HELL-13: passthrough.availability → backend='passthrough' + Phase-2-warning", async () => {
    const sb = passthroughMcpSandbox()
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.length).toBeGreaterThanOrEqual(1)
    expect(av.warnings.some((w) => w.toLowerCase().includes("phase 2"))).toBe(true)
  })

  test("HELL-14: resolveMcpSandbox with profile=container but NO containerSandbox wired → degrades to passthrough", async () => {
    const sb = resolveMcpSandbox(policy("container"))
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough") // degraded
  })

  test("HELL-15: resolveMcpSandbox with profile=container AND containerSandbox wired → returns THAT backend", async () => {
    const wired: McpSandbox = {
      async spawn(_s, _p): Promise<McpSandboxHandle> {
        return {
          serverId: _s.id,
          profile: "container",
          backendId: "wired-1",
          sandboxApplied: true,
          ipcChannel: { kind: "stdio", ref: "wired-1" },
          stop: async () => undefined,
        }
      },
      async availability() {
        return { backend: "container", warnings: [] }
      },
    }
    const sb = resolveMcpSandbox(policy("container"), { containerSandbox: wired })
    const av = await sb.availability()
    expect(av.backend).toBe("container")
    const h = await sb.spawn(spec({ id: "x" }), policy("container"))
    expect(h.backendId).toBe("wired-1")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. PHASE-2 STUBS (2)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / D. Phase-2 stubs", () => {
  test("HELL-16: containerMcpSandbox.spawn → throws McpSandboxError('backend-unavailable', …)", async () => {
    const sb = containerMcpSandbox()
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "x" }), policy("container"))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("backend-unavailable")
    expect((caught as McpSandboxError).message).toContain("container")
    const av = await sb.availability()
    expect(av.backend).toBe("container")
    expect(av.warnings.length).toBeGreaterThanOrEqual(1)
  })

  test("HELL-17: microvmMcpSandbox.spawn → throws McpSandboxError('backend-unavailable', …)", async () => {
    const sb = microvmMcpSandbox()
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "x" }), policy("microvm"))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("backend-unavailable")
    expect((caught as McpSandboxError).message).toContain("microvm")
    const av = await sb.availability()
    expect(av.backend).toBe("microvm")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. REGISTRY off short-circuit (1)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / E. registry off short-circuit", () => {
  test("HELL-18: resolveMcpSandbox with profile=off → returns passthrough regardless of wired Phase-2 adapters", async () => {
    // Both Phase-2 adapters wired — but profile=off means we MUST short-
    // circuit to passthrough. The caller's explicit opt-out wins.
    const wiredContainer: McpSandbox = {
      async spawn() {
        throw new McpSandboxError("backend-unavailable", "should not be called")
      },
      async availability() {
        return { backend: "container", warnings: [] }
      },
    }
    const wiredMicrovm: McpSandbox = {
      async spawn() {
        throw new McpSandboxError("backend-unavailable", "should not be called")
      },
      async availability() {
        return { backend: "microvm", warnings: [] }
      },
    }
    const _cfg: McpSandboxConfig = {} // shape compile-check, unused below
    void _cfg
    const sb = resolveMcpSandbox(policy("off"), {
      containerSandbox: wiredContainer,
      microvmSandbox: wiredMicrovm,
    })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    // And the wired backends are NOT invoked.
    const { spawner, state } = makeFakeSpawner()
    const sb2 = resolveMcpSandbox(policy("off"), {
      containerSandbox: wiredContainer,
      microvmSandbox: wiredMicrovm,
      spawner,
    })
    const h = await sb2.spawn(spec({ id: "off-spec" }), policy("off"))
    expect(h.profile).toBe("off")
    expect(h.sandboxApplied).toBe(false)
    expect(state.calls.length).toBe(1) // passthrough did the spawn
  })
})
