/**
 * S1 — OS Sandbox actual wire-up hellgate.
 *
 * Hardens the contract between `QUANTA_SANDBOX` env → `buildCliOsSandbox` →
 * installed slot → `wrapShellArgv` so a future refactor cannot silently:
 *   - default-ON the sandbox (passthrough must be byte-identical when env
 *     unset / "default" / "off" / "")
 *   - throw on an unknown profile (must log + degrade to passthrough)
 *   - mis-prefix the spawn argv on macOS (must be
 *     `[sandbox-exec, "-p", <SBPL>, "bash", "-lc", cmd]`)
 *   - silently drop Linux sandboxing instead of routing through the
 *     available backend wrapper (`bwrap` / `landlock-cli`)
 *   - omit `degradeReason` when the operator asked for sandboxing but the
 *     backend wasn't usable
 *
 * Anti-leak invariants exercised here:
 *   - HARD_DENY runs in the permission layer BEFORE bash spawn (this file
 *     verifies the SHAPE of the wrap-time argv — the upstream HARD_DENY gate
 *     is asserted by the permission slice's own hellgate; the comment is here
 *     so a reader knows the layering).
 *   - The wrap result NEVER leaks the SBPL profile text outside the argv
 *     (the only consumer is `Bun.spawn`); the operator-facing degrade tag is
 *     an opaque stable string.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetShellSandbox,
  DEFAULT_SANDBOX_EXEC_PATH,
  getShellSandbox,
  installShellSandbox,
  type OsSandboxPolicy as SandboxPolicy,
  wrapShellArgv,
} from "@/runtime"
import { buildCliOsSandbox } from "../../../src/apps/cli/sandbox-wire"

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

const envOf = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

afterEach(() => __resetShellSandbox())

/* ================================================================== */
/*  A. buildCliOsSandbox — env → slot resolution                       */
/* ================================================================== */

describe("A. buildCliOsSandbox", () => {
  test("HELL-A1: QUANTA_SANDBOX unset → undefined (passthrough)", () => {
    const slot = buildCliOsSandbox(envOf({}))
    expect(slot).toBeUndefined()
  })

  test('HELL-A2: QUANTA_SANDBOX="default" → undefined', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "default" }))
    expect(slot).toBeUndefined()
  })

  test('HELL-A3: QUANTA_SANDBOX="off" → undefined', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "off" }))
    expect(slot).toBeUndefined()
  })

  test('HELL-A4: QUANTA_SANDBOX="" → undefined (empty string == unset)', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "" }))
    expect(slot).toBeUndefined()
  })

  test('HELL-A5: QUANTA_SANDBOX="bogus-profile" → undefined (warn, NOT throw)', () => {
    let threw = false
    let slot: ReturnType<typeof buildCliOsSandbox> | undefined
    try {
      slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "bogus-profile" }))
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(slot).toBeUndefined()
  })

  test('HELL-A6: QUANTA_SANDBOX="read-only" → slot with policy.profile=read-only', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "read-only" }))
    expect(slot).toBeDefined()
    expect(slot?.policy.profile).toBe("read-only")
  })

  test('HELL-A7: QUANTA_SANDBOX="workspace-write" → slot with policy.profile=workspace-write', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "workspace-write" }))
    expect(slot?.policy.profile).toBe("workspace-write")
  })

  test('HELL-A8: QUANTA_SANDBOX="workspace-write-net" → slot with policy.profile=workspace-write-net', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "workspace-write-net" }))
    expect(slot?.policy.profile).toBe("workspace-write-net")
  })

  test('HELL-A9: QUANTA_SANDBOX="danger-full-access" → slot with policy.profile=danger-full-access', () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "danger-full-access" }))
    expect(slot?.policy.profile).toBe("danger-full-access")
  })

  test("HELL-A10: case sensitivity — uppercase profile is NOT accepted", () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "READ-ONLY" }))
    expect(slot).toBeUndefined()
  })

  test("HELL-A11: leading/trailing whitespace NOT trimmed — unknown ⇒ passthrough", () => {
    // Explicit decision: we do NOT silently fix up dirty env values. A
    // future track may add trimming; until then a typo with whitespace
    // behaves the same as any other unknown value (warn + passthrough).
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: " read-only " }))
    expect(slot).toBeUndefined()
  })
})

/* ================================================================== */
/*  B. wrap behaviour — macOS Seatbelt argv prefix                     */
/* ================================================================== */

describe("B. wrap — macOS sandbox-exec prefix", () => {
  const POLICY_RO: SandboxPolicy = { profile: "read-only" }
  const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }
  const POLICY_WWN: SandboxPolicy = { profile: "workspace-write-net" }

  test("HELL-B1: darwin + read-only → argv prefixed with sandbox-exec -p <profile>", () => {
    const out = wrapShellArgv(["bash", "-lc", "echo hi"], "/ws", POLICY_RO, {
      platform: "darwin",
      sandboxExecPath: "/usr/bin/sandbox-exec",
    })
    expect(out.sandboxApplied).toBe(true)
    expect(out.argv[0]).toBe("/usr/bin/sandbox-exec")
    expect(out.argv[1]).toBe("-p")
    // profile is index 2; the original argv tail follows.
    expect(out.argv[3]).toBe("bash")
    expect(out.argv[4]).toBe("-lc")
    expect(out.argv[5]).toBe("echo hi")
  })

  test("HELL-B2: darwin + workspace-write → file-write* on workspace subpath", () => {
    const out = wrapShellArgv(["bash", "-lc", ":"], "/ws", POLICY_WW, {
      platform: "darwin",
      sandboxExecPath: "/usr/bin/sandbox-exec",
    })
    expect(out.sandboxApplied).toBe(true)
    const profile = out.argv[2] as string
    expect(profile.includes('(allow file-write* (subpath "/ws"))')).toBe(true)
    expect(profile.includes("(deny network*)")).toBe(true)
  })

  test("HELL-B3: darwin + workspace-write-net → (allow network*)", () => {
    const out = wrapShellArgv(["bash", "-lc", ":"], "/ws", POLICY_WWN, {
      platform: "darwin",
      sandboxExecPath: "/usr/bin/sandbox-exec",
    })
    expect(out.sandboxApplied).toBe(true)
    const profile = out.argv[2] as string
    expect(profile.includes("(allow network*)")).toBe(true)
    expect(profile.includes("(deny network*)")).toBe(false)
  })

  test('HELL-B4: darwin + sandbox-exec missing (null path) → passthrough + degradeReason="sandbox-exec-missing"', () => {
    const out = wrapShellArgv(["bash", "-lc", ":"], "/ws", POLICY_RO, {
      platform: "darwin",
      sandboxExecPath: null,
    })
    expect(out.sandboxApplied).toBe(false)
    expect(out.degradeReason).toBe("sandbox-exec-missing")
    // argv MUST be the original verbatim (no sandbox-exec prefix sneaked in)
    expect(out.argv).toEqual(["bash", "-lc", ":"])
  })
})

/* ================================================================== */
/*  C. wrap behaviour — Linux backend routing                          */
/* ================================================================== */

describe("C. wrap — Linux backend routing", () => {
  test("HELL-C1: linux + bwrap available → slot prefixes argv with bwrap wrapper", async () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "read-only" }), {
      platform: "linux",
      which: async (binary) => (binary === "bwrap" ? "/usr/bin/bwrap" : null),
    })
    expect(slot).toBeDefined()
    const out = await slot!.wrap(["bash", "-lc", ":"], "/ws")
    expect(out.sandboxApplied).toBe(true)
    expect(out.degradeReason).toBeUndefined()
    expect(out.argv[0]).toBe("bwrap")
    expect(out.argv.includes("--unshare-net")).toBe(true)
    expect(out.argv.slice(-4)).toEqual(["--", "bash", "-lc", ":"])
  })

  test("HELL-C2: linux + landlock-cli fallback → slot prefixes argv and surfaces partial network degrade", async () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "workspace-write" }), {
      platform: "linux",
      which: async (binary) => (binary === "landlock-cli" ? "/usr/bin/landlock-cli" : null),
    })
    expect(slot).toBeDefined()
    const out = await slot!.wrap(["bash", "-lc", ":"], "/ws")
    expect(out.sandboxApplied).toBe(true)
    expect(out.degradeReason).toBe("landlock-network-policy-not-enforced")
    expect(out.argv[0]).toBe("landlock-cli")
    expect(out.argv.includes("--network-deferred")).toBe(false)
    expect(out.argv.slice(-4)).toEqual(["--", "bash", "-lc", ":"])
  })

  test("HELL-C3: linux + no backend → passthrough + actionable degradeReason", async () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "workspace-write" }), {
      platform: "linux",
      which: async () => null,
    })
    expect(slot).toBeDefined()
    const out = await slot!.wrap(["bash", "-lc", ":"], "/ws")
    expect(out.sandboxApplied).toBe(false)
    expect((out.degradeReason as string).startsWith("linux-bwrap-missing")).toBe(true)
    expect(out.argv).toEqual(["bash", "-lc", ":"])
  })
})

/* ================================================================== */
/*  D. wrap behaviour — explicit opt-out arms                          */
/* ================================================================== */

describe("D. wrap — off / danger-full-access opt-out", () => {
  test('HELL-D1: profile="off" → passthrough, NO degradeReason', () => {
    const out = wrapShellArgv(
      ["bash", "-lc", ":"],
      "/ws",
      { profile: "off" },
      {
        platform: "darwin",
        sandboxExecPath: "/usr/bin/sandbox-exec",
      },
    )
    expect(out.sandboxApplied).toBe(false)
    expect(out.degradeReason).toBeUndefined()
    expect(out.argv).toEqual(["bash", "-lc", ":"])
  })

  test('HELL-D2: profile="danger-full-access" → passthrough, NO degradeReason', () => {
    const out = wrapShellArgv(
      ["bash", "-lc", ":"],
      "/ws",
      { profile: "danger-full-access" },
      {
        platform: "darwin",
        sandboxExecPath: "/usr/bin/sandbox-exec",
      },
    )
    expect(out.sandboxApplied).toBe(false)
    expect(out.degradeReason).toBeUndefined()
  })
})

/* ================================================================== */
/*  E. unsupported platform — passthrough + tagged degradation         */
/* ================================================================== */

describe("E. wrap — unsupported platform", () => {
  test("HELL-E1: win32 + read-only → passthrough + tagged unsupported-platform", () => {
    const out = wrapShellArgv(
      ["bash", "-lc", ":"],
      "/ws",
      { profile: "read-only" },
      {
        platform: "win32",
      },
    )
    expect(out.sandboxApplied).toBe(false)
    expect(out.degradeReason).toBe("unsupported-platform:win32")
  })
})

/* ================================================================== */
/*  F. holder slot lifecycle                                            */
/* ================================================================== */

describe("F. shell-sandbox-holder", () => {
  test("HELL-F1: getShellSandbox returns undefined when nothing installed", () => {
    __resetShellSandbox()
    expect(getShellSandbox()).toBeUndefined()
  })

  test("HELL-F2: install + retrieve round-trip preserves policy", () => {
    const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "read-only" }))
    expect(slot).toBeDefined()
    if (slot === undefined) return
    installShellSandbox(slot)
    const got = getShellSandbox()
    expect(got).toBeDefined()
    expect(got?.policy.profile).toBe("read-only")
  })

  test("HELL-F3: __resetShellSandbox clears the slot", () => {
    installShellSandbox(buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "workspace-write" })))
    expect(getShellSandbox()).toBeDefined()
    __resetShellSandbox()
    expect(getShellSandbox()).toBeUndefined()
  })
})

/* ================================================================== */
/*  G. profile arms compile (closed-enum coverage)                     */
/* ================================================================== */

describe("G. closed-enum profile coverage", () => {
  const ACTIVE = [
    "read-only",
    "workspace-write",
    "workspace-write-net",
    "danger-full-access",
  ] as const
  for (const profile of ACTIVE) {
    test(`HELL-G[${profile}]: env value → slot.policy.profile round-trips`, () => {
      const slot = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: profile }))
      expect(slot).toBeDefined()
      expect(slot?.policy.profile).toBe(profile)
    })
  }
})

/* ================================================================== */
/*  H. default sandbox-exec path constant                              */
/* ================================================================== */

describe("H. DEFAULT_SANDBOX_EXEC_PATH constant", () => {
  test("HELL-H1: matches macOS canonical sandbox-exec location", () => {
    // Hard-pinned: changing this path is a typed change ALL callers see.
    expect(DEFAULT_SANDBOX_EXEC_PATH).toBe("/usr/bin/sandbox-exec")
  })
})
