import { describe, expect, test } from "bun:test"
import {
  defaultOsSandbox,
  linuxOsSandbox,
  nativeLandlockOsSandbox,
  SANDBOX_UNAVAILABLE_EXIT_CODE,
  type SandboxedSpawnResult,
  type SandboxPolicy,
  type Spawner,
  sandboxUnavailableRefusal,
} from "@/runtime/os-sandbox"

/**
 * DOF-40 — FAIL-CLOSED proof for the OS-sandbox port.
 *
 * SECURITY INVARIANT under test: when a caller REQUESTS a restrictive sandbox
 * profile (`read-only` / `workspace-write` / `workspace-write-net`) but the
 * host backend cannot enforce it, the port MUST refuse the spawn (typed
 * refusal, command NOT run) — it MUST NOT run the command unsandboxed while
 * reporting `sandboxApplied: false`. The old behavior was fail-OPEN: it ran the
 * command and only tagged a `degradeReason`, so the side effects (writes /
 * network) already happened by the time the caller inspected the flag.
 *
 * The whole battery is hermetic — a fake spawner is injected via
 * `OsSandboxConfig.spawner`. The load-bearing assertion is BEHAVIORAL: the
 * injected spawner is NEVER CALLED (calls.length === 0) AND its would-be stdout
 * ("RAN-UNSANDBOXED") never surfaces on the result. A paired control proves the
 * happy path (backend present) still spawns.
 */

interface SpawnCall {
  argv: string[]
  cwd: string
}

/** Spawner that, IF EVER CALLED, would look like a successful unsandboxed run
 *  (exit 0 + a sentinel stdout). A fail-closed port must never call it for an
 *  unavailable-backend + restrictive-profile combo. */
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

/** Assert a result is the fail-closed refusal shape AND that no command ran. */
const assertRefused = (r: SandboxedSpawnResult, calls: SpawnCall[], reason: string): void => {
  // (1) spawner never invoked ⇒ NO host side effect could have occurred.
  expect(calls.length).toBe(0)
  // (2) typed refusal exit code (not a real command's exit).
  expect(r.exitCode).toBe(SANDBOX_UNAVAILABLE_EXIT_CODE)
  expect(r.exitCode).toBe(126)
  // (3) NOT a silent unsandboxed run: the sentinel stdout never surfaces.
  expect(r.stdout).toBe("")
  expect(r.stdout.includes("RAN-UNSANDBOXED")).toBe(false)
  // (4) honestly reported as not-applied + typed reason.
  expect(r.sandboxApplied).toBe(false)
  expect(r.degradeReason).toBe(reason)
  expect(r.stderr.includes("REFUSED")).toBe(true)
}

/* ================================================================== */
/*  A. pure refusal helper                                            */
/* ================================================================== */

describe("A. sandboxUnavailableRefusal — pure typed refusal", () => {
  test("REFUSE-A1: refusal carries exit 126, empty stdout, degradeReason, no spawn", () => {
    const r = sandboxUnavailableRefusal("linux-bwrap-missing")
    expect(r.exitCode).toBe(126)
    expect(r.stdout).toBe("")
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("linux-bwrap-missing")
    expect(r.stderr.includes("REFUSED")).toBe(true)
    expect(r.stderr.includes("bubblewrap")).toBe(true)
  })
})

/* ================================================================== */
/*  B. FAIL-CLOSED control — unavailable backend + restrictive profile */
/* ================================================================== */

describe("B. FAIL-CLOSED: requested sandbox + unavailable backend ⇒ refusal (linux port)", () => {
  for (const profile of RESTRICTIVE) {
    test(`REFUSE-B[${profile}]: linuxOsSandbox, no backend ⇒ command REFUSED (not run)`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = linuxOsSandbox({ spawner, which: whichNone })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "linux-bwrap-missing")
    })
  }
})

describe("B. FAIL-CLOSED: requested sandbox + unavailable backend ⇒ refusal (default port)", () => {
  for (const profile of RESTRICTIVE) {
    test(`REFUSE-B-linux[${profile}]: defaultOsSandbox linux, no bwrap ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "linux", which: whichSandboxExecOnly })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "linux-bwrap-missing")
    })

    test(`REFUSE-B-darwin[${profile}]: defaultOsSandbox darwin, no sandbox-exec ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "darwin", which: whichNone })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "sandbox-exec-missing")
    })

    test(`REFUSE-B-win32[${profile}]: defaultOsSandbox win32, no helper ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "win32", which: whichNone })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "win32-sandbox-helper-missing")
    })

    test(`REFUSE-B-other[${profile}]: defaultOsSandbox unsupported platform ⇒ REFUSED`, async () => {
      const { spawner, calls } = makeSentinelSpawner()
      const sb = defaultOsSandbox({ spawner, platform: "sunos", which: whichNone })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "unsupported-platform:sunos")
    })

    test(`REFUSE-B-native[${profile}]: nativeLandlockOsSandbox, binding=null ⇒ REFUSED (direct-caller hole)`, async () => {
      // The native adapter is EXPORTED and callable directly; a direct caller
      // passing a null binding must NOT get a silent unsandboxed run.
      const { spawner, calls } = makeSentinelSpawner()
      const sb = nativeLandlockOsSandbox({ spawner, bindingLoader: () => null })
      const r = await sb.spawn({ command: ["touch", "/tmp/pwned"], cwd: "/ws" }, { profile })
      assertRefused(r, calls, "native-binding-unavailable")
    })
  }
})

/* ================================================================== */
/*  C. PAIRED CONTROL — backend PRESENT ⇒ command DOES run sandboxed  */
/* ================================================================== */

describe("C. paired control: backend present ⇒ spawner IS called (not a blanket refuse)", () => {
  test("REFUSE-C1: linux + bwrap present ⇒ command spawned under bwrap, sandboxApplied=true", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichBwrapOnly })
    const r = await sb.spawn(
      { command: ["echo", "hi"], cwd: "/ws" },
      { profile: "workspace-write" },
    )
    // The spawner WAS called — the refusal is specific to the unavailable case.
    expect(calls.length).toBe(1)
    expect((calls[0] as SpawnCall).argv[0]).toBe("bwrap")
    expect(r.sandboxApplied).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  test("REFUSE-C2: off/danger profiles STILL passthrough (byte-stable, not refused)", async () => {
    const { spawner, calls } = makeSentinelSpawner()
    const sb = linuxOsSandbox({ spawner, which: whichNone })
    const off = await sb.spawn({ command: ["echo", "hi"], cwd: "/ws" }, { profile: "off" })
    const danger = await sb.spawn(
      { command: ["echo", "hi"], cwd: "/ws" },
      { profile: "danger-full-access" },
    )
    // off/danger explicitly opted OUT of sandboxing ⇒ they run, no degradeReason.
    expect(calls.length).toBe(2)
    expect(off.sandboxApplied).toBe(false)
    expect(off.degradeReason).toBeUndefined()
    expect(off.exitCode).toBe(0)
    expect(danger.sandboxApplied).toBe(false)
    expect(danger.degradeReason).toBeUndefined()
  })
})
