import { describe, expect, test } from "bun:test"
import { compileSeatbeltProfile } from "@/runtime/os-sandbox/seatbelt"
import type { SandboxPolicy } from "@/runtime/os-sandbox/types"

/**
 * OC-4 / S7. The fc `seatbelt-verbatim` entry advertised strict read-narrowing
 * knobs, but the two production callers (`wrap-argv.ts`, `default.ts`) invoked
 * `compileSeatbeltProfile(policy, cwd)` with NO strict arg, so the knobs were
 * unreachable and the baseline emitted a global `(allow file-read*)` — a
 * sandboxed command could read `~/.ssh`. The knobs now flow via `policy.strict`,
 * which both call sites already thread.
 *
 * Runtime-UNVERIFIED (no `sandbox-exec` here): asserts the emitted SBPL, not
 * enforced behaviour.
 */
const base = (extra: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  profile: "workspace-write",
  ...extra,
})

describe("seatbelt read boundary (OC-4/S7)", () => {
  test("default (no strict): byte-identical global read — the baseline is unchanged", () => {
    const p = compileSeatbeltProfile(base(), "/work")
    expect(p).not.toBeNull()
    expect(p).toContain("(allow file-read*)\n") // the bare global read line survives
    expect(p).not.toContain("(allow file-read-metadata)")
  })

  test("policy.strict.readWorkspaceOnly narrows content reads and keeps metadata global", () => {
    const p = compileSeatbeltProfile(base({ strict: { readWorkspaceOnly: true } }), "/work") ?? ""
    // dyld still resolves:
    expect(p).toContain("(allow file-read-metadata)")
    // content reads are subpath-scoped, NOT the bare global:
    expect(p).not.toMatch(/^\(allow file-read\*\)$/m)
    expect(p).toContain('(allow file-read* (subpath "/work")')
    expect(p).toContain('(subpath "/usr")')
    expect(p).not.toContain('(subpath "/Users")') // $HOME is not content-readable
  })

  test("WIRING: policy.strict reaches the compiler exactly as the call sites pass it", () => {
    // both wrap-argv.ts and default.ts call compileSeatbeltProfile(policy, cwd) —
    // no third arg — so a knob is only reachable through policy.strict. Prove the
    // 2-arg call shape honours it (the exact production call shape).
    const withKnob = compileSeatbeltProfile(base({ strict: { denyNetworkAlways: true } }), "/work")
    expect(withKnob).toContain("(deny network*)")
    expect(withKnob).not.toContain("(allow network*)")
  })

  test("strict is still byte-identical to the legacy opts param when both absent", () => {
    const viaNothing = compileSeatbeltProfile(base(), "/work")
    const viaEmptyOpts = compileSeatbeltProfile(base(), "/work", {})
    expect(viaNothing).toBe(viaEmptyOpts)
  })
})
