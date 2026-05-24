import { describe, expect, test } from "bun:test"
import {
  compileLinuxSandboxArgv,
  detectLinuxSandboxBackend,
  LANDLOCK_CLI_NETWORK_DEFERRED_MARKER,
  linuxOsSandbox,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
} from "@/runtime/os-sandbox"

/**
 * Hellgate battery for the Linux OS-sandbox slice (ADR-0159). Mirrors the
 * `os-sandbox-hellgate` + `os-sandbox-bubblewrap-hellgate` patterns:
 *
 *  - Fake spawner injected via `OsSandboxConfig.spawner` — no real `bwrap` /
 *    `landlock-cli` spawn ever happens, the suite is fully hermetic and
 *    runnable from darwin.
 *  - Fake `which` injected via `OsSandboxConfig.which` — backend probing is
 *    deterministic.
 *  - Closed-port DI throughout — no module-level monkey patching.
 *
 * Clusters: A (pure-compile bubblewrap-arm), B (pure-compile landlock-cli-arm),
 * C (backend detect), D (spawn runtime dispatch). 21 cases / 0 fail.
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

/** which: resolves only `bwrap`. */
const whichBwrapOnly = async (b: string): Promise<string | null> =>
  b === "bwrap" ? "/usr/bin/bwrap" : null

/** which: resolves only `landlock-cli`. */
const whichLandlockCliOnly = async (b: string): Promise<string | null> =>
  b === "landlock-cli" ? "/usr/local/bin/landlock-cli" : null

/** which: resolves both — bubblewrap should win the auto-detect race. */
const whichBoth = async (b: string): Promise<string | null> => {
  if (b === "bwrap") return "/usr/bin/bwrap"
  if (b === "landlock-cli") return "/usr/local/bin/landlock-cli"
  return null
}

/** which: resolves nothing. */
const whichNone = async (_b: string): Promise<string | null> => null

const POLICY_OFF: SandboxPolicy = { profile: "off" }
const POLICY_RO: SandboxPolicy = { profile: "read-only" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }
const POLICY_DANGER: SandboxPolicy = { profile: "danger-full-access" }

/* ================================================================== */
/*  A. compileLinuxSandboxArgv — bubblewrap arm (8)                   */
/* ================================================================== */

describe("A. compileLinuxSandboxArgv — bubblewrap arm (pure)", () => {
  test("HELL-LX-A1: bwrap + read-only → --ro-bind ws + --unshare-net", () => {
    const args = compileLinuxSandboxArgv(POLICY_RO, "/ws", "bubblewrap")
    expect(args.length).toBeGreaterThan(0)
    expect(args.includes("--unshare-net")).toBe(true)
    // workspace appears as ro-bind pair (not --bind).
    const wsRoIdx = args.findIndex(
      (tok, i) => tok === "--ro-bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRoIdx).toBeGreaterThan(-1)
    const wsRwIdx = args.findIndex(
      (tok, i) => tok === "--bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBe(-1)
  })

  test("HELL-LX-A2: bwrap + workspace-write → --bind ws + --unshare-net + /proc + /dev", () => {
    const args = compileLinuxSandboxArgv(POLICY_WW, "/ws", "bubblewrap")
    const wsRwIdx = args.findIndex(
      (tok, i) => tok === "--bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBeGreaterThan(-1)
    expect(args.includes("--unshare-net")).toBe(true)
    expect(args.includes("/proc")).toBe(true)
    expect(args.includes("/dev")).toBe(true)
  })

  test("HELL-LX-A3: bwrap + workspace-write-net → no --unshare-net", () => {
    const args = compileLinuxSandboxArgv(POLICY_WWN, "/ws", "bubblewrap")
    expect(args.includes("--unshare-net")).toBe(false)
    // workspace still --bind (RW).
    const wsRwIdx = args.findIndex(
      (tok, i) => tok === "--bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBeGreaterThan(-1)
  })

  test("HELL-LX-A4: bwrap + allowNetwork=true on read-only → no --unshare-net", () => {
    const args = compileLinuxSandboxArgv(
      { profile: "read-only", allowNetwork: true },
      "/ws",
      "bubblewrap",
    )
    expect(args.includes("--unshare-net")).toBe(false)
  })

  test("HELL-LX-A5: bwrap + extraReadPaths → --ro-bind p p per absolute path", () => {
    const args = compileLinuxSandboxArgv(
      { profile: "read-only", extraReadPaths: ["/opt/extra", "/var/log/x"] },
      "/ws",
      "bubblewrap",
    )
    const extraIdx1 = args.findIndex(
      (tok, i) =>
        tok === "--ro-bind" && args[i + 1] === "/opt/extra" && args[i + 2] === "/opt/extra",
    )
    const extraIdx2 = args.findIndex(
      (tok, i) =>
        tok === "--ro-bind" && args[i + 1] === "/var/log/x" && args[i + 2] === "/var/log/x",
    )
    expect(extraIdx1).toBeGreaterThan(-1)
    expect(extraIdx2).toBeGreaterThan(-1)
  })

  test("HELL-LX-A6: bwrap + extraWritePaths → --bind p p per absolute path", () => {
    const args = compileLinuxSandboxArgv(
      { profile: "workspace-write", extraWritePaths: ["/tmp/buildcache"] },
      "/ws",
      "bubblewrap",
    )
    const idx = args.findIndex(
      (tok, i) =>
        tok === "--bind" && args[i + 1] === "/tmp/buildcache" && args[i + 2] === "/tmp/buildcache",
    )
    expect(idx).toBeGreaterThan(-1)
  })

  test("HELL-LX-A7: profile=off → empty array (no compilation)", () => {
    expect(compileLinuxSandboxArgv(POLICY_OFF, "/ws", "bubblewrap")).toEqual([])
    expect(compileLinuxSandboxArgv(POLICY_OFF, "/ws", "landlock-cli")).toEqual([])
  })

  test("HELL-LX-A8: profile=danger-full-access → empty array (no compilation)", () => {
    expect(compileLinuxSandboxArgv(POLICY_DANGER, "/ws", "bubblewrap")).toEqual([])
    expect(compileLinuxSandboxArgv(POLICY_DANGER, "/ws", "landlock-cli")).toEqual([])
  })
})

/* ================================================================== */
/*  B. compileLinuxSandboxArgv — landlock-cli arm (4)                 */
/* ================================================================== */

describe("B. compileLinuxSandboxArgv — landlock-cli arm (pure)", () => {
  test("HELL-LX-B9: landlock-cli + read-only → --ro-paths includes workspace", () => {
    const args = compileLinuxSandboxArgv(POLICY_RO, "/ws", "landlock-cli")
    const roIdx = args.indexOf("--ro-paths")
    expect(roIdx).toBeGreaterThan(-1)
    const roList = args[roIdx + 1]
    expect(typeof roList).toBe("string")
    expect((roList as string).split(",").includes("/ws")).toBe(true)
    // No --rw-paths on read-only.
    expect(args.includes("--rw-paths")).toBe(false)
  })

  test("HELL-LX-B10: landlock-cli + workspace-write → --rw-paths includes workspace", () => {
    const args = compileLinuxSandboxArgv(POLICY_WW, "/ws", "landlock-cli")
    const rwIdx = args.indexOf("--rw-paths")
    expect(rwIdx).toBeGreaterThan(-1)
    const rwList = args[rwIdx + 1]
    expect((rwList as string).split(",").includes("/ws")).toBe(true)
  })

  test("HELL-LX-B11: landlock-cli + network deny → emits deferred marker", () => {
    // workspace-write → network deny per default; marker present.
    const args = compileLinuxSandboxArgv(POLICY_WW, "/ws", "landlock-cli")
    expect(args.includes(LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)).toBe(true)
    // workspace-write-net → network allowed; marker absent.
    const argsNet = compileLinuxSandboxArgv(POLICY_WWN, "/ws", "landlock-cli")
    expect(argsNet.includes(LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)).toBe(false)
  })

  test("HELL-LX-B12: landlock-cli + extras merged into ro/rw lists", () => {
    const args = compileLinuxSandboxArgv(
      {
        profile: "workspace-write",
        extraReadPaths: ["/opt/extra"],
        extraWritePaths: ["/tmp/cache"],
      },
      "/ws",
      "landlock-cli",
    )
    const roIdx = args.indexOf("--ro-paths")
    const rwIdx = args.indexOf("--rw-paths")
    expect((args[roIdx + 1] as string).split(",").includes("/opt/extra")).toBe(true)
    expect((args[rwIdx + 1] as string).split(",").includes("/tmp/cache")).toBe(true)
    expect((args[rwIdx + 1] as string).split(",").includes("/ws")).toBe(true)
  })
})

/* ================================================================== */
/*  C. detectLinuxSandboxBackend (4)                                  */
/* ================================================================== */

describe("C. detectLinuxSandboxBackend — backend probe", () => {
  test("HELL-LX-C13: bwrap on PATH → 'bubblewrap'", async () => {
    const got = await detectLinuxSandboxBackend({ which: whichBwrapOnly })
    expect(got).toBe("bubblewrap")
  })

  test("HELL-LX-C14: only landlock-cli on PATH → 'landlock-cli'", async () => {
    const got = await detectLinuxSandboxBackend({ which: whichLandlockCliOnly })
    expect(got).toBe("landlock-cli")
  })

  test("HELL-LX-C15: neither on PATH → null", async () => {
    const got = await detectLinuxSandboxBackend({ which: whichNone })
    expect(got).toBeNull()
  })

  test("HELL-LX-C16: both on PATH → bubblewrap wins (preferred)", async () => {
    const got = await detectLinuxSandboxBackend({ which: whichBoth })
    expect(got).toBe("bubblewrap")
  })
})

/* ================================================================== */
/*  D. linuxOsSandbox.spawn — dispatch (5)                            */
/* ================================================================== */

describe("D. linuxOsSandbox.spawn — dispatch", () => {
  test("HELL-LX-D17: profile=off → passthrough, no degradeReason, sandboxApplied=false", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichBwrapOnly })
    const r = await sb.spawn({ command: ["bash", "-lc", "echo hi"], cwd: "/ws" }, POLICY_OFF)
    expect(calls.length).toBe(1)
    expect((calls[0] as SpawnCall).argv).toEqual(["bash", "-lc", "echo hi"])
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
    // exactOptional: key OMITTED entirely.
    expect(Object.hasOwn(r, "degradeReason")).toBe(false)
  })

  test("HELL-LX-D18: workspace-write + bwrap → argv prefixed `bwrap ... --`", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichBwrapOnly })
    const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_WW)
    const call = calls[0] as SpawnCall
    expect(call.argv[0]).toBe("bwrap")
    // userCommand at the tail, preceded by "--".
    const sepIdx = call.argv.indexOf("--")
    expect(sepIdx).toBeGreaterThan(0)
    expect(call.argv.slice(sepIdx + 1)).toEqual(["echo", "hi"])
    expect(r.sandboxApplied).toBe(true)
    expect(Object.hasOwn(r, "degradeReason")).toBe(false)
  })

  test("HELL-LX-D19: neither backend → degraded passthrough + 'linux-bwrap-missing'", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    expect((calls[0] as SpawnCall).argv).toEqual(["x"])
    expect(r.sandboxApplied).toBe(false)
    expect((r.degradeReason as string).startsWith("linux-bwrap-missing")).toBe(true)
  })

  test("HELL-LX-D20: spawner throws → exit 127 + stderr describes failure", async () => {
    const spawner: Spawner = async () => {
      throw new Error("boom")
    }
    const sb = linuxOsSandbox({ spawner, which: whichBwrapOnly })
    const r: SandboxedSpawnResult = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    expect(r.exitCode).toBe(127)
    expect(r.stderr.includes("spawn-failed")).toBe(true)
    expect(r.stderr.includes("boom")).toBe(true)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("spawn-failed")
  })

  test("HELL-LX-D21: signal forwarded into spawner opts (bwrap path)", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichBwrapOnly })
    const ac = new AbortController()
    await sb.spawn({ command: ["x"], cwd: "/ws", signal: ac.signal }, POLICY_WW)
    expect((calls[0] as SpawnCall).signal).toBe(ac.signal)
  })

  test("HELL-LX-D22: landlock-cli backend + network-deny policy → degradeReason surfaced", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichLandlockCliOnly })
    const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_WW)
    // argv prefixed with landlock-cli, marker filtered out before spawn.
    const call = calls[0] as SpawnCall
    expect(call.argv[0]).toBe("landlock-cli")
    expect(call.argv.includes(LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)).toBe(false)
    expect(r.sandboxApplied).toBe(true)
    expect(r.degradeReason).toBe("landlock-network-policy-not-enforced")
  })
})
