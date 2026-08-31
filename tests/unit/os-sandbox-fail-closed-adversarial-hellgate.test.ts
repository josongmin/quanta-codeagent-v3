/**
 * ★ HELLGATE (SECOND LAYER, ADVERSARIAL) — OS-sandbox fail-closed policy-shape
 * exhaustion.
 *
 * The FIRST layer (os-sandbox-fail-closed-refusal-hellgate.test.ts) proved that
 * for the three RESTRICTIVE profiles, an unavailable backend ⇒ typed refusal
 * (spawner never called) across the linux / default(darwin/win32/other) /
 * native ports, plus off/danger passthrough. It used only a BARE policy
 * (`{ profile }`).
 *
 * This SECOND layer fills the gap the first left open:
 *
 *   S1 POLICY-SHAPE × UNAVAILABLE-BACKEND MATRIX — every RESTRICTIVE profile
 *      carrying every optional field (extraReadPaths / extraWritePaths /
 *      allowNetwork / timeoutMs / memoryMb / seccompMode / excludeTmpdir, and
 *      a "kitchen-sink" all-set policy) MUST still refuse. No enriched policy
 *      shape can slip past the refusal into a silent unsandboxed run.
 *   S2 ARGV / BIND-PATH INJECTION — hostile paths in extraReadPaths /
 *      extraWritePaths (spaces, quotes, `$(...)`, `;rm -rf`, newlines, `..`
 *      traversal) NEVER cause the spawner to be invoked on an unavailable
 *      backend. The injection can't turn a refusal into an exec.
 *   S3 HOSTILE SPAWNER — even a spawner that would have "succeeded loudly"
 *      (exit 0 + sentinel) is NEVER reached; the exit-126 / empty-stdout
 *      refusal contract holds regardless of what the spawner would do.
 *   S4 EVERY-BACKEND-UNAVAILABLE BRANCH — darwin(no sandbox-exec) /
 *      linux(no native, no bwrap) / linux(native binding=null direct) /
 *      win32(no helper) / unsupported-platform, each × a rich policy, all
 *      refuse with the branch-specific reason and NO spawn.
 *   S5 NATIVE-BINDING DEGRADE PROPAGATES — a native binding whose spawn
 *      returns a DEGRADED result (sandboxApplied:false) does NOT surface as a
 *      clean sandboxed run.
 *   S6 PARTIAL AVAILABILITY (only wrong tool present) — a which() that resolves
 *      a DIFFERENT binary than the platform needs still refuses (e.g. darwin
 *      with only bwrap present, linux with only sandbox-exec present).
 *   S7 PROPERTY — across {profile × platform × which-availability}, the spawner
 *      is invoked ⇔ (profile is off/danger) OR (the platform's REQUIRED backend
 *      is present). No restrictive-profile + missing-backend combo ever spawns.
 *
 * Hermetic — a fake spawner is injected. The load-bearing assertion is
 * BEHAVIORAL: the injected spawner's calls array stays empty AND its would-be
 * sentinel stdout never surfaces.
 *
 * Source under test: src/runtime/os-sandbox/{default,linux,landlock-native,refusal}.ts.
 */

import { describe, expect, test } from "bun:test"
import {
  defaultOsSandbox,
  linuxOsSandbox,
  nativeLandlockOsSandbox,
  SANDBOX_UNAVAILABLE_EXIT_CODE,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
} from "@/runtime/os-sandbox"

interface SpawnCall {
  argv: string[]
  cwd: string
}
/** A spawner that, if EVER reached, LOOKS like a successful unsandboxed run
 *  (exit 0 + a sentinel). A fail-closed port must never reach it for a
 *  restrictive profile + unavailable backend — no matter the policy shape. */
const makeSentinelSpawner = (): { spawner: Spawner; calls: SpawnCall[] } => {
  const calls: SpawnCall[] = []
  const spawner: Spawner = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts.cwd })
    return { exitCode: 0, stdout: "RAN-UNSANDBOXED", stderr: "" }
  }
  return { spawner, calls }
}

const whichNone = async (_b: string): Promise<string | null> => null
const whichBwrapOnly = async (b: string): Promise<string | null> =>
  b === "bwrap" ? "/usr/bin/bwrap" : null
const whichSandboxExecOnly = async (b: string): Promise<string | null> =>
  b === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null

const RESTRICTIVE: ReadonlyArray<SandboxPolicy["profile"]> = [
  "read-only",
  "workspace-write",
  "workspace-write-net",
]

/** Assert the fail-closed refusal shape AND that nothing ran. */
const assertRefused = (r: SandboxedSpawnResult, calls: SpawnCall[]): void => {
  expect(calls.length).toBe(0) // spawner NEVER reached ⇒ no host side effect
  expect(r.exitCode).toBe(SANDBOX_UNAVAILABLE_EXIT_CODE)
  expect(r.exitCode).toBe(126)
  expect(r.stdout).toBe("") // the sentinel never surfaces
  expect(r.stdout.includes("RAN-UNSANDBOXED")).toBe(false)
  expect(r.sandboxApplied).toBe(false)
  expect(typeof r.degradeReason).toBe("string")
  expect(r.stderr.includes("REFUSED")).toBe(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — every optional policy field × restrictive profile × unavailable backend.
// ─────────────────────────────────────────────────────────────────────────────
describe("S1 policy-shape matrix — every enriched policy still refuses (no silent run)", () => {
  const SHAPE_VARIANTS: ReadonlyArray<{ name: string; extra: Partial<SandboxPolicy> }> = [
    { name: "extraReadPaths", extra: { extraReadPaths: ["/etc", "/var/log"] } },
    { name: "extraWritePaths", extra: { extraWritePaths: ["/ws/out", "/tmp/scratch"] } },
    { name: "allowNetwork:true", extra: { allowNetwork: true } },
    { name: "allowNetwork:false", extra: { allowNetwork: false } },
    { name: "timeoutMs", extra: { timeoutMs: 5_000 } },
    { name: "memoryMb", extra: { memoryMb: 512 } },
    { name: "seccompMode:strict", extra: { seccompMode: "strict" } },
    { name: "seccompMode:lax", extra: { seccompMode: "lax" } },
    { name: "excludeTmpdir:true", extra: { excludeTmpdir: true } },
    {
      name: "kitchen-sink (ALL fields set)",
      extra: {
        extraReadPaths: ["/etc"],
        extraWritePaths: ["/ws"],
        allowNetwork: true,
        timeoutMs: 9_000,
        memoryMb: 256,
        seccompMode: "strict",
        excludeTmpdir: true,
      },
    },
  ]

  for (const profile of RESTRICTIVE) {
    for (const { name, extra } of SHAPE_VARIANTS) {
      test(`linux/no-backend + ${profile} + ${name} ⇒ REFUSED`, async () => {
        const { spawner, calls } = makeSentinelSpawner()
        const sb = linuxOsSandbox({ spawner, which: whichNone })
        const policy: SandboxPolicy = { profile, ...extra }
        const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, policy)
        assertRefused(r, calls)
        expect(r.degradeReason).toBe("linux-bwrap-missing")
      })

      test(`default/darwin/no-sandbox-exec + ${profile} + ${name} ⇒ REFUSED`, async () => {
        const { spawner, calls } = makeSentinelSpawner()
        const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichNone })
        const policy: SandboxPolicy = { profile, ...extra }
        const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, policy)
        assertRefused(r, calls)
        expect(r.degradeReason).toBe("sandbox-exec-missing")
      })
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// S2 — argv / bind-path injection cannot flip a refusal into a spawn.
// ─────────────────────────────────────────────────────────────────────────────
describe("S2 bind-path injection — hostile paths never reach the spawner (still refused)", () => {
  const HOSTILE_PATHS: ReadonlyArray<string> = [
    "/ws/$(rm -rf /)",
    "/ws/`id`",
    "/ws; rm -rf /",
    '/ws/"quoted"/path',
    "/ws/with a space/x",
    "/ws/newline\n/etc/passwd",
    "../../../../etc/shadow",
    "/ws/--option-injection",
    "/ws/'; DROP TABLE --",
  ]

  for (const profile of RESTRICTIVE) {
    test(`linux/no-backend + ${profile} + hostile extraReadPaths/extraWritePaths ⇒ REFUSED, no spawn`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = linuxOsSandbox({ spawner, which: whichNone })
      const r = await sb.spawn(
        { command: ["cat", "/etc/passwd"], cwd: "/ws" },
        { profile, extraReadPaths: HOSTILE_PATHS, extraWritePaths: HOSTILE_PATHS },
      )
      assertRefused(r, calls)
      // No hostile path leaked into any (nonexistent) spawn argv.
      expect(calls).toHaveLength(0)
    })
  }

  test("hostile COMMAND argv also never runs on an unavailable backend", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "win32", which: whichNone })
    const r = await sb.spawn(
      { command: ["cmd", "/c", "del /f /q C:\\ & echo pwned"], cwd: "C:/ws" },
      { profile: "workspace-write" },
    )
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("win32-sandbox-helper-missing")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S3 — hostile spawner is never reached (contract independent of spawner).
// ─────────────────────────────────────────────────────────────────────────────
describe("S3 hostile spawner — refusal contract holds no matter what the spawner would do", () => {
  test("a spawner that would EXIT 0 LOUD is never invoked ⇒ exit-126 + empty stdout", async () => {
    // Even a spawner primed to fake success (worst-case fail-open illusion) can't
    // manufacture a run — the port returns before touching it.
    const calls: SpawnCall[] = []
    const loudSpawner: Spawner = async (argv, opts) => {
      calls.push({ argv: [...argv], cwd: opts.cwd })
      return { exitCode: 0, stdout: "TOTALLY-FINE-RAN-EVERYTHING", stderr: "" }
    }
    const sb = linuxOsSandbox({ spawner: loudSpawner, which: whichNone })
    const r = await sb.spawn({ command: ["evil"], cwd: "/ws" }, { profile: "read-only" })
    expect(calls.length).toBe(0)
    expect(r.exitCode).toBe(126)
    expect(r.stdout).toBe("")
    expect(r.stdout).not.toContain("RAN-EVERYTHING")
  })

  test("a spawner that would THROW is also never invoked (refusal precedes any spawn attempt)", async () => {
    let invoked = false
    const throwingSpawner: Spawner = async () => {
      invoked = true
      throw new Error("spawner blew up")
    }
    const sb = defaultOsSandbox({ spawner: throwingSpawner, platform: "linux", which: whichNone })
    // Must not throw — the refusal returns a typed result before the spawner.
    const r = await sb.spawn({ command: ["evil"], cwd: "/ws" }, { profile: "workspace-write" })
    expect(invoked).toBe(false)
    expect(r.exitCode).toBe(126)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S4 — every unavailable-backend branch × a rich policy.
// ─────────────────────────────────────────────────────────────────────────────
describe("S4 every unavailable branch refuses with its branch reason (rich policy)", () => {
  const RICH: SandboxPolicy = {
    profile: "workspace-write-net",
    extraReadPaths: ["/etc"],
    extraWritePaths: ["/ws"],
    allowNetwork: true,
    memoryMb: 128,
    seccompMode: "strict",
  }

  test("darwin no sandbox-exec ⇒ sandbox-exec-missing", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, RICH)
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("sandbox-exec-missing")
  })

  test("linux no native + no bwrap ⇒ linux-bwrap-missing", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "linux", which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, RICH)
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("linux-bwrap-missing")
  })

  test("native landlock adapter, binding loader ⇒ null (direct caller) ⇒ native-binding-unavailable", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = nativeLandlockOsSandbox({ spawner, bindingLoader: () => null })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, RICH)
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("native-binding-unavailable")
  })

  test("win32 no helper ⇒ win32-sandbox-helper-missing", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "win32", which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "C:/ws" }, RICH)
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("win32-sandbox-helper-missing")
  })

  test("unsupported platform (freebsd) ⇒ unsupported-platform:freebsd", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = defaultOsSandbox({ spawner, platform: "freebsd", which: whichNone })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, RICH)
    assertRefused(r, calls)
    expect(r.degradeReason).toBe("unsupported-platform:freebsd")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S5 — native binding that degrades must not read as a clean sandboxed run.
// ─────────────────────────────────────────────────────────────────────────────
describe("S5 native binding degrade — sandboxApplied:false is honored, not masked", () => {
  test("a binding whose spawn returns a DEGRADED result surfaces sandboxApplied:false", async () => {
    // A binding that loads but returns a degraded result (couldn't actually
    // enforce) must NOT be reported as sandboxApplied:true.
    const degradingBinding = {
      spawn_sandboxed: () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        sandboxApplied: false,
        degradeReason: "kernel-abi-too-old",
      }),
      availability: () =>
        JSON.stringify({ available: true, kernelVersion: "5.10", abiSupported: 1 }),
    }
    const sb = nativeLandlockOsSandbox({ binding: degradingBinding })
    const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, { profile: "read-only" })
    // Whatever the exit, the honesty invariant is: not falsely sandboxApplied.
    expect(r.sandboxApplied).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S6 — only the WRONG backend present still refuses (partial availability).
// ─────────────────────────────────────────────────────────────────────────────
describe("S6 partial availability — wrong-tool-only still refuses", () => {
  for (const profile of RESTRICTIVE) {
    test(`darwin with ONLY bwrap present (no sandbox-exec) + ${profile} ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichBwrapOnly })
      const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, { profile })
      assertRefused(r, calls)
      expect(r.degradeReason).toBe("sandbox-exec-missing")
    })

    test(`linux with ONLY sandbox-exec present (no bwrap/native) + ${profile} ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "linux", which: whichSandboxExecOnly })
      const r = await sb.spawn({ command: ["x"], cwd: "/ws" }, { profile })
      assertRefused(r, calls)
      expect(r.degradeReason).toBe("linux-bwrap-missing")
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// S7 — PROPERTY: spawn ⇔ (off/danger) OR (required backend present).
// ─────────────────────────────────────────────────────────────────────────────
describe("S7 property — no restrictive-profile + missing-backend ever spawns", () => {
  const ALL_PROFILES: ReadonlyArray<SandboxPolicy["profile"]> = [
    "off",
    "read-only",
    "workspace-write",
    "workspace-write-net",
    "danger-full-access",
  ]

  const assertPolicyOutcome = (
    result: Awaited<ReturnType<ReturnType<typeof linuxOsSandbox>["spawn"]>>,
    calls: readonly unknown[],
    profile: SandboxPolicy["profile"],
    backendPresent: boolean,
  ): void => {
    const isOptOut = profile === "off" || profile === "danger-full-access"
    const shouldSpawn = isOptOut || backendPresent
    expect(calls.length > 0).toBe(shouldSpawn)
    if (!shouldSpawn) {
      expect(result.exitCode).toBe(126)
      expect(result.stdout).toBe("")
      expect(result.sandboxApplied).toBe(false)
    }
    if (isOptOut) {
      expect(result.sandboxApplied).toBe(false)
      expect(result.degradeReason).toBeUndefined()
    }
  }

  test("linux fuzz {profile × bwrap-present?}: spawn IFF off/danger OR bwrap present", async () => {
    for (const profile of ALL_PROFILES) {
      for (const bwrapPresent of [true, false]) {
        const { spawner, calls } = makeSentinelSpawner()
        const which = bwrapPresent ? whichBwrapOnly : whichNone
        const sb = linuxOsSandbox({ spawner, which })
        const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, { profile })
        assertPolicyOutcome(r, calls, profile, bwrapPresent)
      }
    }
  })

  test("darwin fuzz {profile × sandbox-exec-present?}: spawn IFF off/danger OR sandbox-exec present", async () => {
    for (const profile of ALL_PROFILES) {
      for (const present of [true, false]) {
        const { spawner, calls } = makeSentinelSpawner()
        const which = present ? whichSandboxExecOnly : whichNone
        const sb = defaultOsSandbox({ spawner, platform: "darwin", which })
        const r = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, { profile })
        assertPolicyOutcome(r, calls, profile, present)
      }
    }
  })
})
