/**
 * MCP Skybridge — Lima/AppleVZ microVM hellgate (ADR-0160 Phase 2).
 *
 * Seals the external-binary microVM adapter pair across 5 sections — 18 cases.
 * No real subprocess is touched; `which`/`spawner`/`runner` are caller-DI fakes.
 *
 * Sections:
 *   A. detectLima (3)                 — which-found / which-empty / fake injection
 *   B. compileLimaConfig (6)          — workspace mount / network / memory / runtime
 *                                       cap / runArgs shape / deterministic vmName
 *   C. limaMicroVmSandbox.spawn (5)   — backend-unavailable / vm-start / vm-running
 *                                       skip / spawner-throw / stop()
 *   D. appleVzMicroVmSandbox (2)      — vz present → microvm / absent → passthrough
 *   E. registry routing (2)           — autoDetectMicrovm picks Lima / no backend
 *                                       degrades to passthrough
 */

import { describe, expect, test } from "bun:test"
import {
  appleVzMicroVmSandbox,
  compileLimaConfig,
  detectLima,
  limaMicroVmSandbox,
  limaVmName,
  type McpSandboxConfig,
  McpSandboxError,
  type McpSandboxPolicy,
  type McpServerSpec,
  resolveMcpSandboxAsync,
  type SkybridgeRunner,
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
  readonly stopCounts: Map<number, number>
  nextPid: number
  throwOn: boolean
  throwMessage: string
}

const makeFakeSpawner = (): { spawner: SkybridgeSpawner; state: FakeSpawnerState } => {
  const state: FakeSpawnerState = {
    calls: [],
    stopCounts: new Map<number, number>(),
    nextPid: 4000,
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

interface RunCall {
  readonly argv: ReadonlyArray<string>
}
interface FakeRunnerState {
  readonly calls: RunCall[]
  /** Sequenced responses keyed by argv-first-two — covers `lima list --json` + `lima start <vm>`. */
  responses: ReadonlyArray<{ exitCode: number; stdout: string; stderr: string }>
  cursor: number
  throwOnStart: boolean
}

const makeFakeRunner = (
  responses: ReadonlyArray<{ exitCode: number; stdout: string; stderr: string }>,
): { runner: SkybridgeRunner; state: FakeRunnerState } => {
  const state: FakeRunnerState = {
    calls: [],
    responses,
    cursor: 0,
    throwOnStart: false,
  }
  const runner: SkybridgeRunner = async (argv) => {
    state.calls.push({ argv })
    if (state.throwOnStart && argv[1] === "start") {
      throw new Error("lima start exec failed")
    }
    const r = state.responses[state.cursor] ?? { exitCode: 0, stdout: "", stderr: "" }
    state.cursor++
    return r
  }
  return { runner, state }
}

const makeFakeWhich = (
  found: Record<string, string | null>,
): NonNullable<McpSandboxConfig["which"]> => {
  return async (bin: string) => {
    if (Object.hasOwn(found, bin)) return found[bin] ?? null
    return null
  }
}

const spec = (overrides: Partial<McpServerSpec> & Pick<McpServerSpec, "id">): McpServerSpec => ({
  id: overrides.id,
  command: overrides.command ?? ["bun", "server.ts"],
  ...(overrides.env !== undefined ? { env: overrides.env } : {}),
  ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
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
  ...(overrides.maxRuntimeMs !== undefined ? { maxRuntimeMs: overrides.maxRuntimeMs } : {}),
  ...(overrides.memoryMb !== undefined ? { memoryMb: overrides.memoryMb } : {}),
})

// ────────────────────────────────────────────────────────────────────────────
// A. detectLima (3)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / A. detectLima", () => {
  test("HELL-LIMA-1: which returns absolute path → detectLima returns same path", async () => {
    const which = makeFakeWhich({ lima: "/opt/homebrew/bin/lima" })
    const found = await detectLima({ which })
    expect(found).toBe("/opt/homebrew/bin/lima")
  })

  test("HELL-LIMA-2: cfg without which → detectLima returns null (no fallback child_process import)", async () => {
    // Phase-1 plane-cleanliness: when `which` is not wired we MUST return
    // null, not import node:child_process implicitly.
    const found = await detectLima({})
    expect(found).toBeNull()
  })

  test("HELL-LIMA-3: which returns null → detectLima returns null", async () => {
    const which = makeFakeWhich({ lima: null })
    const found = await detectLima({ which })
    expect(found).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. compileLimaConfig (6)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / B. compileLimaConfig", () => {
  test("HELL-LIMA-4: hostReadAllowlist → mounts entries with writable:false; hostWriteAllowlist → writable:true", () => {
    const { limayaml } = compileLimaConfig(
      policy({
        hostReadAllowlist: ["/etc", "/usr"],
        hostWriteAllowlist: ["/workspace"],
      }),
      spec({ id: "s" }),
    )
    expect(limayaml).toContain(`location: "/etc"`)
    expect(limayaml).toContain(`location: "/usr"`)
    expect(limayaml).toContain(`location: "/workspace"`)
    expect(limayaml).toContain("writable: false")
    expect(limayaml).toContain("writable: true")
    // No default "/" mount when allowlist provided.
    expect(limayaml).not.toContain(`location: "/"\n    writable: false`)
  })

  test("HELL-LIMA-5: networkAllowlist → networks: section with allowed-host comments", () => {
    const { limayaml } = compileLimaConfig(
      policy({ networkAllowlist: ["github.com:443", "registry.npmjs.org:443"] }),
      spec({ id: "s" }),
    )
    expect(limayaml).toContain("networks:")
    expect(limayaml).toContain("# allowed: github.com:443")
    expect(limayaml).toContain("# allowed: registry.npmjs.org:443")
    expect(limayaml).toContain("lima: user-v2")
    // Empty network allowlist → no networks: section.
    const { limayaml: y2 } = compileLimaConfig(policy({}), spec({ id: "s" }))
    expect(y2).not.toContain("networks:")
  })

  test("HELL-LIMA-6: memoryMb propagates into YAML; default = 512 MiB", () => {
    const { limayaml: yDefault } = compileLimaConfig(policy({}), spec({ id: "s" }))
    expect(yDefault).toContain(`memory: "512MiB"`)
    const { limayaml: y2048 } = compileLimaConfig(policy({ memoryMb: 2048 }), spec({ id: "s" }))
    expect(y2048).toContain(`memory: "2048MiB"`)
  })

  test("HELL-LIMA-7: maxRuntimeMs → runArgs gets `timeout <s>` prefix; absent → no prefix", () => {
    const noCap = compileLimaConfig(policy({}), spec({ id: "s", command: ["bun", "x.ts"] }))
    expect(noCap.runArgs[0]).toBe("lima")
    expect(noCap.runArgs.includes("timeout")).toBe(false)
    const withCap = compileLimaConfig(
      policy({ maxRuntimeMs: 30_000 }),
      spec({ id: "s", command: ["bun", "x.ts"] }),
    )
    expect(withCap.runArgs[0]).toBe("timeout")
    expect(withCap.runArgs[1]).toBe("30s")
    expect(withCap.runArgs[2]).toBe("lima")
    // Sub-second cap clamps to >=1s (Math.max(1, …)).
    const tiny = compileLimaConfig(
      policy({ maxRuntimeMs: 250 }),
      spec({ id: "s", command: ["bun"] }),
    )
    expect(tiny.runArgs[1]).toBe("1s")
  })

  test("HELL-LIMA-8: runArgs shape = ['lima','shell',<vm>,'--', ...command]", () => {
    const r = compileLimaConfig(
      policy({}),
      spec({ id: "github-mcp", command: ["node", "srv.js", "--port", "0"] }),
    )
    expect(r.runArgs[0]).toBe("lima")
    expect(r.runArgs[1]).toBe("shell")
    expect(r.runArgs[2]).toBe(limaVmName("github-mcp"))
    expect(r.runArgs[3]).toBe("--")
    expect(r.runArgs[4]).toBe("node")
    expect(r.runArgs[5]).toBe("srv.js")
    expect(r.runArgs[6]).toBe("--port")
    expect(r.runArgs[7]).toBe("0")
  })

  test("HELL-LIMA-9: limaVmName is deterministic — same id → same name; different id → different name; name is filesystem-friendly", () => {
    const a1 = limaVmName("github-mcp")
    const a2 = limaVmName("github-mcp")
    const b = limaVmName("notion-mcp")
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1.startsWith("quanta-skybridge-")).toBe(true)
    // Lowercase + hyphens + hex tag only.
    expect(/^quanta-skybridge-[0-9a-f]{8}$/.test(a1)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. limaMicroVmSandbox.spawn (5)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / C. limaMicroVmSandbox.spawn", () => {
  test("HELL-LIMA-10: lima absent → spawn throws McpSandboxError('backend-unavailable')", async () => {
    const which = makeFakeWhich({ lima: null })
    const { spawner } = makeFakeSpawner()
    const sb = limaMicroVmSandbox({ which, spawner })
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "s" }), policy({}))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("backend-unavailable")
    expect((caught as McpSandboxError).message.toLowerCase()).toContain("lima")
  })

  test("HELL-LIMA-11: VM not running → `lima start` is invoked before shell-spawn", async () => {
    const which = makeFakeWhich({ lima: "/usr/local/bin/lima" })
    // list --json: empty → not running. start: ok.
    const { runner, state: rstate } = makeFakeRunner([
      { exitCode: 0, stdout: "", stderr: "" }, // list
      { exitCode: 0, stdout: "", stderr: "" }, // start
    ])
    const { spawner, state: sstate } = makeFakeSpawner()
    const sb = limaMicroVmSandbox({ which, spawner, runner })
    const h = await sb.spawn(spec({ id: "needs-start" }), policy({}))
    // Two runner calls in order: list then start.
    expect(rstate.calls.length).toBe(2)
    expect(rstate.calls[0]?.argv[0]).toBe("lima")
    expect(rstate.calls[0]?.argv[1]).toBe("list")
    expect(rstate.calls[1]?.argv[0]).toBe("lima")
    expect(rstate.calls[1]?.argv[1]).toBe("start")
    expect(rstate.calls[1]?.argv[2]).toBe(limaVmName("needs-start"))
    // Spawner sees ["lima","shell",<vm>,"--", ...command].
    expect(sstate.calls.length).toBe(1)
    expect(sstate.calls[0]?.argv[0]).toBe("lima")
    expect(sstate.calls[0]?.argv[1]).toBe("shell")
    expect(h.sandboxApplied).toBe(true)
    expect(h.backendId).toBe(limaVmName("needs-start"))
    expect(h.ipcChannel.kind).toBe("named-pipe")
    expect(h.ipcChannel.ref).toBe(`lima-socket:${limaVmName("needs-start")}`)
  })

  test("HELL-LIMA-12: VM already running → `lima start` is SKIPPED", async () => {
    const vmName = limaVmName("already-up")
    const which = makeFakeWhich({ lima: "/usr/local/bin/lima" })
    // list --json: returns one line with our vm + status=Running.
    const listLine = JSON.stringify({ name: vmName, status: "Running" })
    const { runner, state: rstate } = makeFakeRunner([
      { exitCode: 0, stdout: `${listLine}\n`, stderr: "" },
    ])
    const { spawner } = makeFakeSpawner()
    const sb = limaMicroVmSandbox({ which, spawner, runner })
    await sb.spawn(spec({ id: "already-up" }), policy({}))
    // Only the list call — no start.
    expect(rstate.calls.length).toBe(1)
    expect(rstate.calls[0]?.argv[1]).toBe("list")
  })

  test("HELL-LIMA-13: spawner throws → spawn rethrows McpSandboxError('spawn-failed') with cause", async () => {
    const which = makeFakeWhich({ lima: "/usr/local/bin/lima" })
    const { runner } = makeFakeRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ])
    const { spawner, state } = makeFakeSpawner()
    state.throwOn = true
    state.throwMessage = "exec ENOENT"
    const sb = limaMicroVmSandbox({ which, spawner, runner })
    let caught: unknown
    try {
      await sb.spawn(spec({ id: "boom" }), policy({}))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("spawn-failed")
    expect((caught as McpSandboxError).message).toContain("exec ENOENT")
    // cause is the original Error.
    expect(((caught as McpSandboxError).cause as Error)?.message).toBe("exec ENOENT")
  })

  test("HELL-LIMA-14: handle.stop() invokes the inner spawner stop; second call is no-op (idempotent)", async () => {
    const which = makeFakeWhich({ lima: "/usr/local/bin/lima" })
    const { runner } = makeFakeRunner([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ])
    const { spawner, state } = makeFakeSpawner()
    const sb = limaMicroVmSandbox({ which, spawner, runner })
    const h = await sb.spawn(spec({ id: "stoppable" }), policy({}))
    expect(state.stopCounts.size).toBe(0)
    await h.stop()
    expect([...state.stopCounts.values()][0]).toBe(1)
    // Idempotent: inner stop NOT called twice.
    await h.stop()
    expect([...state.stopCounts.values()][0]).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. appleVzMicroVmSandbox (2)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / D. appleVzMicroVmSandbox", () => {
  test("HELL-LIMA-15: vz present on darwin → availability='microvm' + spawn succeeds", async () => {
    const which = makeFakeWhich({ vz: "/opt/homebrew/bin/vz" })
    const { spawner, state } = makeFakeSpawner()
    const sb = appleVzMicroVmSandbox({ which, spawner, platform: "darwin" })
    const av = await sb.availability()
    expect(av.backend).toBe("microvm")
    const h = await sb.spawn(spec({ id: "vz-ok", command: ["node", "x.js"] }), policy({}))
    expect(h.sandboxApplied).toBe(true)
    expect(state.calls.length).toBe(1)
    expect(state.calls[0]?.argv[0]).toBe("vz")
    expect(state.calls[0]?.argv[1]).toBe("shell")
    expect(h.ipcChannel.kind).toBe("named-pipe")
    expect(h.ipcChannel.ref.startsWith("vz-socket:")).toBe(true)
  })

  test("HELL-LIMA-16: vz absent OR non-darwin → backend-unavailable on spawn; availability='passthrough'", async () => {
    // darwin + vz missing → backend-unavailable
    const w1 = makeFakeWhich({ vz: null })
    const { spawner: s1 } = makeFakeSpawner()
    const sb1 = appleVzMicroVmSandbox({ which: w1, spawner: s1, platform: "darwin" })
    let caught: unknown
    try {
      await sb1.spawn(spec({ id: "x" }), policy({}))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(McpSandboxError)
    expect((caught as McpSandboxError).code).toBe("backend-unavailable")
    expect((await sb1.availability()).backend).toBe("passthrough")

    // linux + vz "present" → still backend-unavailable (darwin-only gate).
    const w2 = makeFakeWhich({ vz: "/somewhere/vz" })
    const { spawner: s2 } = makeFakeSpawner()
    const sb2 = appleVzMicroVmSandbox({ which: w2, spawner: s2, platform: "linux" })
    let caught2: unknown
    try {
      await sb2.spawn(spec({ id: "x" }), policy({}))
    } catch (e) {
      caught2 = e
    }
    expect(caught2).toBeInstanceOf(McpSandboxError)
    expect((caught2 as McpSandboxError).code).toBe("backend-unavailable")
    expect((caught2 as McpSandboxError).message.toLowerCase()).toContain("darwin")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. registry routing (2)
// ────────────────────────────────────────────────────────────────────────────
describe("skybridge / E. registry routing (autoDetectMicrovm)", () => {
  test("HELL-LIMA-17: profile=microvm + autoDetect + Lima present (vz absent) → Lima backend picked", async () => {
    // vz: null, lima: present. Apple-VZ tried first (returns passthrough avail), Lima wins.
    const which = makeFakeWhich({ vz: null, lima: "/usr/local/bin/lima" })
    const { spawner } = makeFakeSpawner()
    const { runner } = makeFakeRunner([
      { exitCode: 0, stdout: "", stderr: "" }, // list
      { exitCode: 0, stdout: "", stderr: "" }, // start
    ])
    const sb = await resolveMcpSandboxAsync(policy({}), {
      autoDetectMicrovm: true,
      which,
      spawner,
      runner,
      platform: "linux",
    })
    const av = await sb.availability()
    expect(av.backend).toBe("microvm")
    // Spawn should route through Lima (named-pipe ref starts with lima-socket:).
    const h = await sb.spawn(spec({ id: "routed" }), policy({}))
    expect(h.ipcChannel.ref.startsWith("lima-socket:")).toBe(true)
  })

  test("HELL-LIMA-18: profile=microvm but neither vz nor lima available → degrade to passthrough (no throw)", async () => {
    const which = makeFakeWhich({ vz: null, lima: null })
    const { spawner } = makeFakeSpawner()
    const sb = await resolveMcpSandboxAsync(policy({}), {
      autoDetectMicrovm: true,
      which,
      spawner,
      platform: "linux",
    })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    // And spawn STILL succeeds (passthrough degrade) with sandboxApplied=false + phase2 reason.
    const h = await sb.spawn(spec({ id: "deg" }), policy({}))
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toBe("phase2-not-implemented")
  })
})
