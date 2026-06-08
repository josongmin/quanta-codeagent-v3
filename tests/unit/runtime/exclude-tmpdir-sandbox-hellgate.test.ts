/**
 * §12.6 (jun-08 long-tail) — exclude_tmpdir sandbox toggle hellgate.
 *
 * Codex `[sandbox_workspace_write].exclude_slash_tmp` parity: a config knob
 * that drops `/tmp` from the OS sandbox read scope. Locks:
 *
 *   1. DEFAULT-OFF byte-identity: absent / `excludeTmpdir:false` ⇒ the compiled
 *      Seatbelt profile is BYTE-IDENTICAL to the Codex-verbatim baseline (the
 *      `/tmp` literal is present, sexp still closes correctly).
 *   2. Behavior: `excludeTmpdir:true` ⇒ the `(literal "/tmp")` line is OMITTED
 *      AND the rest of the profile (including the block-closing paren) stays
 *      valid — only `/tmp` is removed, every other literal survives.
 *   3. e2e wire hellgate: QUANTA_SANDBOX_EXCLUDE_TMPDIR drives
 *      buildCliOsSandbox → slot.wrap → the REAL spawn argv (SBPL profile) so the
 *      knob actually reaches the kernel-facing profile, not just the type.
 *   4. knob default-OFF at the wire: unset env ⇒ argv byte-identical to the
 *      no-knob slot.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { __resetShellSandbox } from "@/runtime"
import { compileSeatbeltProfile, renderVerbatim } from "@/runtime/os-sandbox"
import { buildCliOsSandbox } from "../../../src/apps/cli/sandbox-wire"

const WS = "/ws"
const envOf = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

afterEach(() => __resetShellSandbox())

describe("§12.6 — compileSeatbeltProfile default-OFF byte-identity", () => {
  test("absent excludeTmpdir → byte-identical to Codex-verbatim fixture (read-only)", () => {
    const actual = compileSeatbeltProfile({ profile: "read-only" }, WS)
    expect(actual).toBe(renderVerbatim("read-only", WS))
    expect((actual as string).includes('(literal "/tmp")')).toBe(true)
  })

  test("excludeTmpdir:false → byte-identical to absent", () => {
    const off = compileSeatbeltProfile({ profile: "workspace-write" }, WS)
    const explicitFalse = compileSeatbeltProfile(
      { profile: "workspace-write", excludeTmpdir: false },
      WS,
    )
    expect(explicitFalse).toBe(off)
  })
})

describe("§12.6 — excludeTmpdir:true drops /tmp only", () => {
  test("the /tmp literal is removed and nothing else is", () => {
    const baseline = compileSeatbeltProfile({ profile: "workspace-write" }, WS) as string
    const excluded = compileSeatbeltProfile(
      { profile: "workspace-write", excludeTmpdir: true },
      WS,
    ) as string
    expect(baseline.includes('(literal "/tmp")')).toBe(true)
    expect(excluded.includes('(literal "/tmp")')).toBe(false)
    // Every other line is preserved: removing the one `/tmp` line is the ONLY
    // difference (the diff is exactly one line shorter and otherwise equal).
    const baseLines = baseline.split("\n").filter((l) => l !== '  (literal "/tmp")')
    expect(excluded.split("\n")).toEqual(baseLines)
  })

  test("the system-framework read block still closes correctly (valid sexp)", () => {
    const excluded = compileSeatbeltProfile(
      { profile: "read-only", excludeTmpdir: true },
      WS,
    ) as string
    // The block's final literal still carries the closing paren.
    expect(excluded.includes('(literal "/private/etc/localtime"))')).toBe(true)
    // Balanced parens overall (cheap structural sanity).
    const opens = (excluded.match(/\(/g) ?? []).length
    const closes = (excluded.match(/\)/g) ?? []).length
    expect(opens).toBe(closes)
  })

  test("/etc neighbor literal survives the /tmp removal", () => {
    const excluded = compileSeatbeltProfile(
      { profile: "read-only", excludeTmpdir: true },
      WS,
    ) as string
    expect(excluded.includes('(literal "/etc")')).toBe(true)
  })
})

/* ================================================================== */
/*  e2e wire hellgate — knob → slot.wrap → real spawn argv (SBPL)      */
/* ================================================================== */

describe("§12.6 — QUANTA_SANDBOX_EXCLUDE_TMPDIR end-to-end through sandbox-wire", () => {
  const darwinDeps = { platform: "darwin" as const, sandboxExecPath: "/usr/bin/sandbox-exec" }

  test("HELL-TMP-E2E: knob ON → the SBPL in the wrapped argv omits /tmp", async () => {
    const slot = buildCliOsSandbox(
      envOf({ QUANTA_SANDBOX: "read-only", QUANTA_SANDBOX_EXCLUDE_TMPDIR: "1" }),
      darwinDeps,
    )
    expect(slot).toBeDefined()
    expect(slot?.policy.excludeTmpdir).toBe(true)
    const wrapped = await (slot as NonNullable<typeof slot>).wrap(["bash", "-lc", "echo hi"], WS)
    // The SBPL profile is the 3rd argv element ([sandbox-exec, "-p", <SBPL>, ...]).
    const sbpl = wrapped.argv[2] ?? ""
    expect(wrapped.sandboxApplied).toBe(true)
    expect(sbpl.includes('(literal "/tmp")')).toBe(false)
    // It's still a real profile (workspace read line present).
    expect(sbpl.includes(`(subpath "${WS}")`)).toBe(true)
  })

  test("HELL-TMP-E2E2: knob OFF (unset) → wrapped argv SBPL keeps /tmp (byte-identical default)", async () => {
    const off = buildCliOsSandbox(envOf({ QUANTA_SANDBOX: "read-only" }), darwinDeps)
    expect(off?.policy.excludeTmpdir).toBeUndefined()
    const wrappedOff = await (off as NonNullable<typeof off>).wrap(["bash", "-lc", "echo hi"], WS)
    const sbplOff = wrappedOff.argv[2] ?? ""
    expect(sbplOff.includes('(literal "/tmp")')).toBe(true)
    // And the OFF profile equals the verbatim baseline (no drift from the knob).
    expect(sbplOff).toBe(renderVerbatim("read-only", WS))
  })

  test("HELL-TMP-E2E3: knob=0 → treated as OFF (keeps /tmp)", async () => {
    const slot = buildCliOsSandbox(
      envOf({ QUANTA_SANDBOX: "read-only", QUANTA_SANDBOX_EXCLUDE_TMPDIR: "0" }),
      darwinDeps,
    )
    expect(slot?.policy.excludeTmpdir).toBeUndefined()
  })
})
