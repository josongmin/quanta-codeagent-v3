import { describe, expect, test } from "bun:test"
import {
  compileSeatbeltProfile,
  defaultOsSandbox,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
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

const whichOk = async (b: string): Promise<string | null> =>
  b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null
const whichNone = async (_b: string): Promise<string | null> => null

const POLICY_OFF: SandboxPolicy = { profile: "off" }
const POLICY_RO: SandboxPolicy = { profile: "read-only" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }
const POLICY_DANGER: SandboxPolicy = { profile: "danger-full-access" }

/* ================================================================== */
/*  A. compileSeatbeltProfile pure (6)                                */
/* ================================================================== */

describe("A. compileSeatbeltProfile — pure profile compilation", () => {
  test("HELL-A1: profile=read-only → no file-write* line + deny network*", () => {
    const txt = compileSeatbeltProfile(POLICY_RO, "/ws")
    expect(txt).not.toBeNull()
    const s = txt as string
    // No file-write* allow line anywhere (the "no writes" invariant).
    expect(/\(allow file-write\*/.test(s)).toBe(false)
    expect(s.includes("(deny network*)")).toBe(true)
    expect(s.includes("(allow network*)")).toBe(false)
  })

  test("HELL-A2: profile=workspace-write → file-write* with workspace subpath only", () => {
    const txt = compileSeatbeltProfile(POLICY_WW, "/ws")
    const s = txt as string
    expect(/\(allow file-write\* \(subpath "\/ws"\)\)/.test(s)).toBe(true)
    // No allow-network on plain workspace-write.
    expect(s.includes("(deny network*)")).toBe(true)
  })

  test("HELL-A3: profile=workspace-write-net → has (allow network*)", () => {
    const txt = compileSeatbeltProfile(POLICY_WWN, "/ws")
    const s = txt as string
    expect(s.includes("(allow network*)")).toBe(true)
    expect(s.includes("(deny network*)")).toBe(false)
  })

  test("HELL-A4: extraReadPaths included as subpath lines", () => {
    const txt = compileSeatbeltProfile(
      { profile: "read-only", extraReadPaths: ["/opt/extra", "/var/log/x"] },
      "/ws",
    )
    const s = txt as string
    expect(s.includes('(subpath "/opt/extra")')).toBe(true)
    expect(s.includes('(subpath "/var/log/x")')).toBe(true)
  })

  test("HELL-A5: extraWritePaths included", () => {
    const txt = compileSeatbeltProfile(
      { profile: "workspace-write", extraWritePaths: ["/tmp/buildcache"] },
      "/ws",
    )
    const s = txt as string
    // The write line must contain the extra write subpath.
    const writeLine = s.split("\n").find((l) => l.startsWith("(allow file-write*"))
    expect(writeLine).toBeDefined()
    expect((writeLine as string).includes('(subpath "/tmp/buildcache")')).toBe(true)
  })

  test("HELL-A6: profile=off / danger-full-access → returns null", () => {
    expect(compileSeatbeltProfile(POLICY_OFF, "/ws")).toBeNull()
    expect(compileSeatbeltProfile(POLICY_DANGER, "/ws")).toBeNull()
  })
})

/* ================================================================== */
/*  B. defaultOsSandbox.spawn (8)                                     */
/* ================================================================== */

describe("B. defaultOsSandbox.spawn — runtime dispatch", () => {
  test("HELL-B7: profile=off → spawner called with original argv; no sandbox wrap", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r = await sb.spawn({ command: ["bash", "-lc", "echo hi"], cwd: "/ws" }, POLICY_OFF)
    expect(calls.length).toBe(1)
    expect((calls[0] as SpawnCall).argv).toEqual(["bash", "-lc", "echo hi"])
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-B8: profile=danger-full-access → same as off (no degradeReason)", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r = await sb.spawn({ command: ["true"], cwd: "/ws" }, POLICY_DANGER)
    expect((calls[0] as SpawnCall).argv).toEqual(["true"])
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-B9: darwin + seatbelt + workspace-write → argv prefixed sandbox-exec -p <profile>", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, POLICY_WW)
    const call = calls[0] as SpawnCall
    expect(call.argv[0]).toBe("/usr/bin/sandbox-exec")
    expect(call.argv[1]).toBe("-p")
    expect(typeof call.argv[2]).toBe("string")
    expect((call.argv[2] as string).startsWith("(version 1)")).toBe(true)
    expect(call.argv.slice(3)).toEqual(["echo", "hi"])
    expect(r.sandboxApplied).toBe(true)
    expect(r.degradeReason).toBeUndefined()
  })

  test("HELL-B10: darwin + sandbox-exec missing → degraded passthrough", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    expect((calls[0] as SpawnCall).argv).toEqual(["x"])
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("sandbox-exec-missing")
  })

  test("HELL-B11: linux + bwrap missing → Phase 2 degraded passthrough", async () => {
    // whichOk only resolves sandbox-exec; bwrap is not found → degrade.
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "linux", which: whichOk })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    expect((calls[0] as SpawnCall).argv).toEqual(["x"])
    expect(r.sandboxApplied).toBe(false)
    expect((r.degradeReason as string).startsWith("linux-bwrap-missing")).toBe(true)
  })

  test("HELL-B12: spawner throws → exitCode 127 + stderr describes failure", async () => {
    const spawner: Spawner = async () => {
      throw new Error("boom")
    }
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_WW)
    expect(r.exitCode).toBe(127)
    expect(r.stderr.includes("spawn-failed")).toBe(true)
    expect(r.stderr.includes("boom")).toBe(true)
    expect(r.sandboxApplied).toBe(false)
  })

  test("HELL-B13: signal forwarded into spawner opts", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const ac = new AbortController()
    await sb.spawn({ command: ["x"], cwd: "/ws", signal: ac.signal }, POLICY_WW)
    expect((calls[0] as SpawnCall).signal).toBe(ac.signal)
  })

  test("HELL-B14: env forwarded into spawner opts", async () => {
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    await sb.spawn({ command: ["x"], cwd: "/ws", env: { FOO: "bar" } }, POLICY_WW)
    const c = calls[0] as SpawnCall
    expect(c.env).toEqual({ FOO: "bar" })
  })
})

/* ================================================================== */
/*  C. availability (3)                                               */
/* ================================================================== */

describe("C. defaultOsSandbox.availability — backend detection", () => {
  test("HELL-C15: darwin + seatbelt present → backend=seatbelt, no warnings", async () => {
    const sb = defaultOsSandbox({ platform: "darwin", which: whichOk })
    const av = await sb.availability()
    expect(av.backend).toBe("seatbelt")
    expect(av.warnings).toEqual([])
  })

  test("HELL-C16: linux + bwrap missing → backend=passthrough + install-bubblewrap warning", async () => {
    const sb = defaultOsSandbox({ platform: "linux", which: whichOk })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.length).toBe(1)
    expect((av.warnings[0] as string).includes("install bubblewrap")).toBe(true)
  })

  test("HELL-C17: win32 (no helper) → backend=passthrough + actionable helper warning (ADR-0441)", async () => {
    // ADR-0441 — win32 is now a recognized platform. Without the
    // quanta-win-sandbox.exe helper it still degrades to passthrough, but the
    // warning is actionable (install the helper) rather than "unsupported".
    const sb = defaultOsSandbox({ platform: "win32", which: whichOk })
    const av = await sb.availability()
    expect(av.backend).toBe("passthrough")
    expect(av.warnings.length).toBe(1)
    expect((av.warnings[0] as string).includes("quanta-win-sandbox.exe")).toBe(true)
  })
})

/* ================================================================== */
/*  D. Policy edge cases (5)                                          */
/* ================================================================== */

describe("D. policy edge cases", () => {
  test("HELL-D18: extraReadPaths with absolute path → preserved verbatim", () => {
    const txt = compileSeatbeltProfile(
      { profile: "read-only", extraReadPaths: ["/abs/preserved/exactly"] },
      "/ws",
    )
    const s = txt as string
    expect(s.includes('(subpath "/abs/preserved/exactly")')).toBe(true)
    // Must NOT have been joined to /ws.
    expect(s.includes('(subpath "/ws/abs/preserved/exactly")')).toBe(false)
  })

  test("HELL-D19: extraReadPaths with relative path → resolved against workspace", () => {
    const txt = compileSeatbeltProfile(
      { profile: "read-only", extraReadPaths: ["rel/path"] },
      "/ws",
    )
    const s = txt as string
    expect(s.includes('(subpath "/ws/rel/path")')).toBe(true)
  })

  test("HELL-D20: allowNetwork override on read-only → adds (allow network*)", () => {
    const txt = compileSeatbeltProfile({ profile: "read-only", allowNetwork: true }, "/ws")
    const s = txt as string
    expect(s.includes("(allow network*)")).toBe(true)
    expect(s.includes("(deny network*)")).toBe(false)
  })

  test("HELL-D21: profile=off → no compilation attempt; spawn passthrough", async () => {
    expect(compileSeatbeltProfile(POLICY_OFF, "/ws")).toBeNull()
    const { spawner, calls } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, POLICY_OFF)
    // Spawner saw the bare argv — no sandbox-exec wrap.
    expect((calls[0] as SpawnCall).argv).toEqual(["x"])
    expect(r.sandboxApplied).toBe(false)
  })

  test("HELL-D22: compiled output byte-identical for same input (determinism)", () => {
    const policy: SandboxPolicy = {
      profile: "workspace-write",
      extraReadPaths: ["/a", "rel"],
      extraWritePaths: ["/b"],
    }
    const a = compileSeatbeltProfile(policy, "/ws")
    const b = compileSeatbeltProfile(policy, "/ws")
    expect(a).toBe(b)
    expect(a).toEqual(b)
  })
})

/* ================================================================== */
/*  E. degradation result shape sanity (bonus)                        */
/* ================================================================== */

describe("E. result shape", () => {
  test("HELL-E23: sandboxApplied=true result MUST NOT carry degradeReason", async () => {
    const { spawner } = makeSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichOk })
    const r: SandboxedSpawnResult = await sb.spawn(
      { command: ["echo", "hi"], cwd: "/ws" },
      POLICY_WW,
    )
    expect(r.sandboxApplied).toBe(true)
    // exactOptional: key omitted entirely.
    expect(Object.hasOwn(r, "degradeReason")).toBe(false)
  })
})
