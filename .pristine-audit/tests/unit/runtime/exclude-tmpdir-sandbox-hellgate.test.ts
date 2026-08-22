/**
 * §12.6 (jun-08 long-tail) — exclude_tmpdir sandbox toggle hellgate.
 *
 * Codex `[sandbox_workspace_write].exclude_slash_tmp` parity: a config knob
 * that drops `/tmp` from the OS sandbox read scope. Locks:
 *
 *   1. DEFAULT-OFF byte-identity: absent / `excludeTmpdir:false` ⇒ the compiled
 *      Seatbelt profile is BYTE-IDENTICAL to the verbatim baseline and has no
 *      tmp deny rule.
 *   2. Behavior: `excludeTmpdir:true` ⇒ an explicit tmp read deny is added
 *      while the global read allow and the rest of the profile stay valid.
 *   3. wrap hellgate: `wrapShellArgv` embeds the compiled SBPL into the real
 *      spawn argv so the policy reaches the kernel-facing profile.
 */
import { describe, expect, test } from "bun:test"
import { compileSeatbeltProfile, renderVerbatim, wrapShellArgv } from "@/runtime/os-sandbox"

const WS = "/ws"

describe("§12.6 — compileSeatbeltProfile default-OFF byte-identity", () => {
  test("absent excludeTmpdir → byte-identical to Codex-verbatim fixture (read-only)", () => {
    const actual = compileSeatbeltProfile({ profile: "read-only" }, WS)
    expect(actual).toBe(renderVerbatim("read-only", WS))
    expect((actual as string).includes("(allow file-read*)")).toBe(true)
    expect((actual as string).includes("exclude tmp reads")).toBe(false)
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
  test("the tmp deny rule is added and nothing else is", () => {
    const baseline = compileSeatbeltProfile({ profile: "workspace-write" }, WS) as string
    const excluded = compileSeatbeltProfile(
      { profile: "workspace-write", excludeTmpdir: true },
      WS,
    ) as string
    const expectedLines = baseline.split("\n")
    expectedLines.splice(
      expectedLines.indexOf(";; workspace + extra writes"),
      0,
      ";; exclude tmp reads",
      '(deny file-read* (subpath "/tmp") (subpath "/private/tmp"))',
    )
    expect(excluded.split("\n")).toEqual(expectedLines)
  })

  test("the system-framework read block still closes correctly (valid sexp)", () => {
    const excluded = compileSeatbeltProfile(
      { profile: "read-only", excludeTmpdir: true },
      WS,
    ) as string
    expect(excluded.includes('(deny file-read* (subpath "/tmp") (subpath "/private/tmp"))')).toBe(
      true,
    )
    // Balanced parens overall (cheap structural sanity).
    const opens = (excluded.match(/\(/g) ?? []).length
    const closes = (excluded.match(/\)/g) ?? []).length
    expect(opens).toBe(closes)
  })

  test("global read allow survives the tmp deny", () => {
    const excluded = compileSeatbeltProfile(
      { profile: "read-only", excludeTmpdir: true },
      WS,
    ) as string
    expect(excluded.includes("(allow file-read*)")).toBe(true)
  })
})

/* ================================================================== */
/*  wrap hellgate — policy → real spawn argv (SBPL)                    */
/* ================================================================== */

describe("§12.6 — excludeTmpdir through wrapShellArgv", () => {
  const darwinDeps = { platform: "darwin" as const, sandboxExecPath: "/usr/bin/sandbox-exec" }

  test("HELL-TMP-E2E: policy ON → the SBPL in the wrapped argv denies tmp reads", () => {
    const wrapped = wrapShellArgv(
      ["bash", "-lc", "echo hi"],
      WS,
      { profile: "read-only", excludeTmpdir: true },
      darwinDeps,
    )
    const sbpl = wrapped.argv[2] ?? ""
    expect(wrapped.sandboxApplied).toBe(true)
    expect(sbpl.includes('(deny file-read* (subpath "/tmp") (subpath "/private/tmp"))')).toBe(true)
    // It's still a real read-only profile.
    expect(sbpl.includes("(allow file-read*)")).toBe(true)
  })

  test("HELL-TMP-E2E2: policy OFF → wrapped argv SBPL has no tmp deny (byte-identical default)", () => {
    const wrappedOff = wrapShellArgv(
      ["bash", "-lc", "echo hi"],
      WS,
      { profile: "read-only" },
      darwinDeps,
    )
    const sbplOff = wrappedOff.argv[2] ?? ""
    expect(sbplOff.includes("exclude tmp reads")).toBe(false)
    // And the OFF profile equals the verbatim baseline (no drift from the knob).
    expect(sbplOff).toBe(renderVerbatim("read-only", WS))
  })
})
