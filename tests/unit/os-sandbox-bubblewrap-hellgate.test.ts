import { describe, expect, test } from "bun:test"
import {
  compileBubblewrapArgs,
  defaultOsSandbox,
  type SandboxPolicy,
  type Spawner,
  spawnViaBubblewrap,
} from "@/runtime/os-sandbox"

/* ------------------------------------------------------------------ */
/*  test helpers                                                      */
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

/** which: resolves bwrap, nothing else. */
const whichBwrapOnly = async (b: string): Promise<string | null> =>
  b === "bwrap" ? "/usr/bin/bwrap" : null

/** which: resolves nothing. */
const whichNone = async (_b: string): Promise<string | null> => null

const POLICY_RO: SandboxPolicy = { profile: "read-only" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }
const POLICY_OFF: SandboxPolicy = { profile: "off" }
const POLICY_DANGER: SandboxPolicy = { profile: "danger-full-access" }

/* ================================================================== */
/*  A. compileBubblewrapArgs — pure compilation (5)                   */
/* ================================================================== */

describe("A. compileBubblewrapArgs — pure", () => {
  test("HELL-BW-A1: profile=read-only → --ro-bind workspace + --unshare-net", () => {
    const args = compileBubblewrapArgs(POLICY_RO, "/ws")
    expect(args).not.toBeNull()
    const a = args as string[]
    // Workspace must appear as a --ro-bind pair (RO).
    const wsRoIdx = a.findIndex(
      (tok, i) => tok === "--ro-bind" && a[i + 1] === "/ws" && a[i + 2] === "/ws",
    )
    expect(wsRoIdx).toBeGreaterThan(-1)
    // Must NOT have --bind for workspace (read-only).
    const wsRwIdx = a.findIndex(
      (tok, i) => tok === "--bind" && a[i + 1] === "/ws" && a[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBe(-1)
    // Network unshared.
    expect(a.includes("--unshare-net")).toBe(true)
  })

  test("HELL-BW-A2: profile=workspace-write → --bind workspace + --unshare-net", () => {
    const args = compileBubblewrapArgs(POLICY_WW, "/ws") as string[]
    const wsRwIdx = args.findIndex(
      (tok, i) => tok === "--bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBeGreaterThan(-1)
    expect(args.includes("--unshare-net")).toBe(true)
    // workspace-write gets /proc and /dev for interactive tools.
    expect(args.includes("--proc")).toBe(true)
    expect(args.includes("--dev")).toBe(true)
  })

  test("HELL-BW-A3: profile=workspace-write-net → NO --unshare-net", () => {
    const args = compileBubblewrapArgs(POLICY_WWN, "/ws") as string[]
    expect(args.includes("--unshare-net")).toBe(false)
    // Still binds workspace RW.
    const wsRwIdx = args.findIndex(
      (tok, i) => tok === "--bind" && args[i + 1] === "/ws" && args[i + 2] === "/ws",
    )
    expect(wsRwIdx).toBeGreaterThan(-1)
  })

  test("HELL-BW-A4: profile=off / danger-full-access → returns null", () => {
    expect(compileBubblewrapArgs(POLICY_OFF, "/ws")).toBeNull()
    expect(compileBubblewrapArgs(POLICY_DANGER, "/ws")).toBeNull()
  })

  test("HELL-BW-A5: extraReadPaths→--ro-bind / extraWritePaths→--bind (per path)", () => {
    const args = compileBubblewrapArgs(
      {
        profile: "workspace-write",
        extraReadPaths: ["/opt/extra", "/var/log/x"],
        extraWritePaths: ["/tmp/buildcache"],
      },
      "/ws",
    ) as string[]
    // Each extra read appears as --ro-bind p p.
    for (const p of ["/opt/extra", "/var/log/x"]) {
      const idx = args.findIndex(
        (tok, i) => tok === "--ro-bind" && args[i + 1] === p && args[i + 2] === p,
      )
      expect(idx).toBeGreaterThan(-1)
    }
    // Each extra write appears as --bind p p.
    const writeIdx = args.findIndex(
      (tok, i) =>
        tok === "--bind" && args[i + 1] === "/tmp/buildcache" && args[i + 2] === "/tmp/buildcache",
    )
    expect(writeIdx).toBeGreaterThan(-1)
  })
})

/* ================================================================== */
/*  B. spawnViaBubblewrap — runtime dispatch (3)                      */
/* ================================================================== */

describe("B. spawnViaBubblewrap — runtime", () => {
  test("HELL-BW-B6: happy → argv = bwrap + policy args + -- + original command", async () => {
    const { spawner, calls } = makeSpawner()
    const r = await spawnViaBubblewrap({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_WW, spawner)
    const call = calls[0] as SpawnCall
    expect(call.argv[0]).toBe("bwrap")
    // Must contain a -- separator before the user command.
    const dashIdx = call.argv.indexOf("--")
    expect(dashIdx).toBeGreaterThan(0)
    expect(call.argv.slice(dashIdx + 1)).toEqual(["echo", "hi"])
    expect(r.sandboxApplied).toBe(true)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-BW-B7: profile=off → bypass, spawner called with original command, sandboxApplied=false", async () => {
    const { spawner, calls } = makeSpawner()
    const r = await spawnViaBubblewrap({ command: ["true"], cwd: "/ws" }, POLICY_OFF, spawner)
    expect((calls[0] as SpawnCall).argv).toEqual(["true"])
    expect(r.sandboxApplied).toBe(false)
    // off ⇒ NO degradeReason (user explicit opt-out).
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-BW-B8: spawner throws → exitCode 127 + typed degradation message", async () => {
    const spawner: Spawner = async () => {
      throw new Error("boom")
    }
    const r = await spawnViaBubblewrap({ command: ["x"], cwd: "/ws" }, POLICY_WW, spawner)
    expect(r.exitCode).toBe(127)
    expect(r.stderr.includes("spawn-failed")).toBe(true)
    expect(r.stderr.includes("boom")).toBe(true)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("spawn-failed")
  })
})

/* ================================================================== */
/*  C. defaultOsSandbox Linux integration (3)                         */
/* ================================================================== */

describe("C. defaultOsSandbox Linux integration", () => {
  test("HELL-BW-C9: linux + bwrap present → backend=bubblewrap, sandboxApplied=true", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({
      spawner,
      platform: "linux",
      which: whichBwrapOnly,
    })
    const av = await sb.availability()
    expect(av.backend).toBe("bubblewrap")
    expect(av.warnings).toEqual([])

    const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_WW)
    const call = calls[0] as SpawnCall
    expect(call.argv[0]).toBe("bwrap")
    expect(r.sandboxApplied).toBe(true)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-BW-C10: linux + bwrap missing → backend=passthrough + install-bubblewrap warning", async () => {
    const sb = defaultOsSandbox({ platform: "linux", which: whichNone })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.length).toBe(1)
    expect((av.warnings[0] as string).includes("install bubblewrap")).toBe(true)

    const { spawner, calls } = makeSpawner()
    const sb2 = defaultOsSandbox({ spawner, platform: "linux", which: whichNone })
    const r = await sb2.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    // Degraded passthrough: original argv, sandboxApplied=false, install hint.
    expect((calls[0] as SpawnCall).argv).toEqual(["x"])
    expect(r.sandboxApplied).toBe(false)
    expect((r.degradeReason as string).startsWith("linux-bwrap-missing")).toBe(true)
  })

  test("HELL-BW-C11: linux + danger profile → passthrough regardless of bwrap availability", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({
      spawner,
      platform: "linux",
      which: whichBwrapOnly,
    })
    const r = await sb.spawn({ command: ["rm", "-rf"], cwd: "/ws" }, POLICY_DANGER)
    // Original argv preserved — no bwrap wrap even though bwrap is present.
    expect((calls[0] as SpawnCall).argv).toEqual(["rm", "-rf"])
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
  })
})
