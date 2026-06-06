/**
 * RFC jun-6 — hellgate for the sandbox-block DISCRIMINANT
 * (`classifySandboxDenial`). The LOAD-BEARING test here is the FALSE-POSITIVE
 * guard: a normal non-sandbox EPERM (or a `sandboxApplied:false` result) must
 * NEVER be mis-detected as a high-confidence sandbox block.
 *
 * Determinism: the classifier is a pure function — no clock, no env, no IO.
 */
import { describe, expect, test } from "bun:test"
import {
  classifySandboxDenial,
  type SandboxBackend,
  type SandboxedSpawnResult,
} from "@/runtime/os-sandbox"
import { __test } from "@/runtime/os-sandbox/denial-classify"

const base = (over: Partial<SandboxedSpawnResult>): SandboxedSpawnResult => ({
  exitCode: 1,
  stdout: "",
  stderr: "",
  sandboxApplied: true,
  ...over,
})

describe("classifySandboxDenial — discriminant (block vs degrade vs normal)", () => {
  test("Seatbelt deny stderr (applied) → seatbelt-deny, high", () => {
    const r = base({
      exitCode: 1,
      stderr: "Sandbox: bash(123) deny(1) file-write-data /etc/passwd",
    })
    const d = classifySandboxDenial(r, "seatbelt")
    expect(d).toEqual({ kind: "sandbox-blocked", signal: "seatbelt-deny", confidence: "high" })
  })

  test("seccomp SIGSYS exit (applied, landlock+seccomp) → seccomp-sigsys, high", () => {
    const r = base({ exitCode: __test.SIGSYS_EXIT, stderr: "Bad system call" })
    const d = classifySandboxDenial(r, "landlock+seccomp")
    expect(d).toEqual({ kind: "sandbox-blocked", signal: "seccomp-sigsys", confidence: "high" })
  })

  test("exit-126 denied-exec (applied) → exit-126, high", () => {
    const r = base({ exitCode: __test.EXIT_CANNOT_EXECUTE, stderr: "cannot execute binary" })
    const d = classifySandboxDenial(r, "landlock+seccomp")
    expect(d).toEqual({ kind: "sandbox-blocked", signal: "exit-126", confidence: "high" })
  })

  test("Landlock bare EPERM (applied) → landlock-eperm, LOW (suggestion)", () => {
    const r = base({ exitCode: 1, stderr: "open('/etc/x'): EPERM" })
    const d = classifySandboxDenial(r, "landlock+seccomp")
    expect(d).toEqual({ kind: "sandbox-blocked", signal: "landlock-eperm", confidence: "low" })
  })

  test("Windows access-denied (applied) → windows-access, LOW", () => {
    const r = base({ exitCode: 5, stderr: "Access is denied." })
    const d = classifySandboxDenial(r, "windows-restricted-token")
    expect(d).toEqual({ kind: "sandbox-blocked", signal: "windows-access", confidence: "low" })
  })

  test("degraded result (sandboxApplied:false + degradeReason) → NOT a block", () => {
    const r = base({
      sandboxApplied: false,
      exitCode: 1,
      degradeReason: "native-binding-unavailable",
      stderr: "Sandbox: deny(1) file-write-data /x",
    })
    expect(classifySandboxDenial(r, "landlock+seccomp")).toBeUndefined()
  })
})

describe("classifySandboxDenial — FALSE-POSITIVE GUARD (the load-bearing case)", () => {
  test("normal non-sandbox EPERM (applied, no high-confidence signal) is NOT high", () => {
    // chmod on a root-owned file: a genuine permission error unrelated to the
    // jail. At the exitCode level it is indistinguishable from a Landlock FS
    // denial — so it may be classified LOW, but MUST NOT be high (no
    // auto-escalation), and the user can decline.
    const r = base({
      exitCode: 1,
      stderr: "chmod: changing permissions of '/root/x': Operation not permitted",
    })
    const d = classifySandboxDenial(r, "landlock+seccomp")
    expect(d?.confidence).not.toBe("high")
  })

  test("sandboxApplied:false NEVER classifies, even when stderr quotes a Seatbelt deny line", () => {
    // A command that itself prints "Sandbox: ... deny" must not be mis-detected
    // when the sandbox was never applied.
    const r = base({
      sandboxApplied: false,
      exitCode: 1,
      stderr: "Sandbox: bash(1) deny(1) file-write-data /x",
    })
    expect(classifySandboxDenial(r, "seatbelt")).toBeUndefined()
  })

  test("a command that merely MENTIONS 'deny' in stderr (seatbelt, applied) is NOT matched (substring guard)", () => {
    // The grep-style match must be LINE-ANCHORED PREFIX, not a free substring.
    const r = base({
      exitCode: 2,
      stderr: "error: access deny rules failed to parse in user config",
    })
    expect(classifySandboxDenial(r, "seatbelt")).toBeUndefined()
  })

  test("hasSeatbeltDenyPrefix requires a deny token on the Sandbox: banner", () => {
    expect(__test.hasSeatbeltDenyPrefix("Sandbox: bash(1) allow file-read /x")).toBe(false)
    expect(__test.hasSeatbeltDenyPrefix("Sandbox: bash(1) deny(1) file-write /x")).toBe(true)
  })

  test("hasSeatbeltDenyPrefix is prefix-anchored, never a mid-line substring", () => {
    expect(__test.hasSeatbeltDenyPrefix("my output mentions Sandbox: deny somewhere")).toBe(false)
    expect(__test.hasSeatbeltDenyPrefix("   Sandbox: deny(1) file-write /x")).toBe(true) // leading ws ok
  })

  test("zero exit is never a denial regardless of stderr / signal", () => {
    const r = base({ exitCode: 0, stderr: "Sandbox: bash(1) deny(1) file-write /x" })
    expect(classifySandboxDenial(r, "seatbelt")).toBeUndefined()
  })

  test("unrecognised nonzero exit (under-detect) → undefined, NOT a block", () => {
    // grep found nothing / npm errored — nothing to do with the sandbox.
    const r = base({ exitCode: 1, stderr: "npm ERR! missing script: build" })
    expect(classifySandboxDenial(r, "landlock+seccomp")).toBeUndefined()
  })

  test("SIGSYS exit only counts under landlock+seccomp backend (not passthrough)", () => {
    const r = base({ exitCode: __test.SIGSYS_EXIT })
    expect(classifySandboxDenial(r, "passthrough")).toBeUndefined()
  })

  test("exit-126 under passthrough backend is NOT a block", () => {
    const r = base({ exitCode: __test.EXIT_CANNOT_EXECUTE })
    expect(classifySandboxDenial(r, "passthrough")).toBeUndefined()
  })
})

describe("classifySandboxDenial — backend isolation", () => {
  const backends: SandboxBackend[] = [
    "seatbelt",
    "bubblewrap",
    "landlock+seccomp",
    "windows-restricted-token",
    "passthrough",
  ]
  test("a clean success (exit 0) on every backend → undefined", () => {
    for (const b of backends) {
      expect(classifySandboxDenial(base({ exitCode: 0 }), b)).toBeUndefined()
    }
  })
})
