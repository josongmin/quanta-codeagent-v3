import { describe, expect, test } from "bun:test"
import { buildGrepArgv } from "@/tool/grep"

// HELLGATE — grep flag surface (P21.3/P23/P24).
//
// The grep tool maps model-supplied flags onto a ripgrep argv that is then
// `parts.join(" ")`-ed into a shell command. Every new flag is an injection /
// DoS surface. These cases prove the SOTA++ defenses BLOCK the attack rather
// than merely "handle" it: string flags stay single-quoted (one rg invocation,
// no shell metacharacter escape), integer flags are bounded (no unbounded
// output), and the absent-all-new-fields argv is byte-identical to today.

describe("grep flag surface — hellgate", () => {
  // (a) ARGV INJECTION: a `type` carrying shell metacharacters must stay inside
  //     a single-quoted token. If it escaped, the joined string would contain a
  //     second command (`rm -rf /`) or break out of the rg invocation.
  test("type with shell metacharacters cannot inject a second command", () => {
    const argv = buildGrepArgv({ pattern: "x", type: "; rm -rf / #" })
    // The malicious value is present, but wrapped by sq(): a single rg token.
    expect(argv).toContain("--type")
    const idx = argv.indexOf("--type")
    const tok = argv[idx + 1] ?? ""
    // Single-quoted, with the embedded value intact and inert.
    expect(tok.startsWith("'")).toBe(true)
    expect(tok.endsWith("'")).toBe(true)
    expect(tok).toContain("rm -rf /")
    // Exactly one rg invocation token at the head — no injected command word.
    expect(argv[0]).toBe("rg")
    expect(argv.filter((p) => p === "rg").length).toBe(1)
    // The joined shell string contains the value ONLY inside the quotes, so a
    // shell would treat `; rm -rf /` as literal text, not a command separator.
    const joined = argv.join(" ")
    expect(joined).toContain("'; rm -rf / #'")
  })

  // A `type` with embedded single quotes must be POSIX-escaped (`'\''`) so it
  // still resolves to one token — the classic quote-breakout.
  test("type with embedded single quote is POSIX-escaped (no breakout)", () => {
    const argv = buildGrepArgv({ pattern: "x", type: "ts'; id; '" })
    const tok = argv[argv.indexOf("--type") + 1] ?? ""
    expect(tok).toContain("'\\''")
    expect(argv[0]).toBe("rg")
    expect(argv.filter((p) => p === "rg").length).toBe(1)
  })

  // (b) INTEGER DoS: an absurd context count must be rejected/clamped, never
  //     forwarded raw (rg -A 1000000000 would buffer unbounded output).
  test("context line count of 1e9 is rejected (no unbounded output)", () => {
    const argv = buildGrepArgv({ pattern: "x", A: 1e9 })
    // The absurd value must NOT appear anywhere in the argv.
    expect(argv.join(" ")).not.toContain("1000000000")
    // -A is dropped entirely when out of bounds (fail-closed, not clamped-silent).
    expect(argv).not.toContain("-A")
  })

  test("non-integer / NaN / negative context counts are rejected", () => {
    for (const bad of [3.5, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const argv = buildGrepArgv({ pattern: "x", C: bad as number })
      expect(argv).not.toContain("-C")
    }
  })

  // Integer flags must be passed UNQUOTED (rg parses them as numbers) — proving
  // a valid small value is not run through sq().
  test("valid context count is unquoted", () => {
    const argv = buildGrepArgv({ pattern: "x", B: 2 })
    const idx = argv.indexOf("-B")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe("2")
  })

  // (c) BYTE-IDENTICAL: absent all new fields → argv identical to today's fixed
  //     baseline. This is the default-OFF guarantee.
  test("absent-all-new-fields argv is byte-identical to today", () => {
    expect(buildGrepArgv({ pattern: "needle" })).toEqual([
      "rg",
      "--line-number",
      "--no-heading",
      "--color=never",
      "-e",
      "'needle'",
    ])
  })

  test("byte-identical with glob + path (pre-existing surface unchanged)", () => {
    expect(buildGrepArgv({ pattern: "needle", glob: "*.ts" }, "/jail/x")).toEqual([
      "rg",
      "--line-number",
      "--no-heading",
      "--color=never",
      "-g",
      "'*.ts'",
      "-e",
      "'needle'",
      "'/jail/x'",
    ])
  })

  // count / files_with_matches are mutually-incompatible with context flags in
  // rg; context flags MUST be dropped under those modes (documented precedence).
  test("context flags are dropped under count mode", () => {
    const argv = buildGrepArgv({ pattern: "x", output_mode: "count", A: 3 })
    expect(argv).toContain("-c")
    expect(argv).not.toContain("-A")
  })

  test("context flags are dropped under files_with_matches mode", () => {
    const argv = buildGrepArgv({ pattern: "x", output_mode: "files_with_matches", C: 3 })
    expect(argv).toContain("-l")
    expect(argv).not.toContain("-C")
  })
})
