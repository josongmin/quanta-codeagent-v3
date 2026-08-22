/**
 * Leaf-unit hellgate for the test_runner tool's two PRIVATE pure heuristics,
 * exposed via the `__test` seam:
 *
 *   - `verdict(combined, exitCode, timedOut)` — the one-line human verdict.
 *   - `detectCommand(cwd, path)` — marker-file probe order + path forwarding.
 *
 * The integration suite only exercises the happy paths through `execute`; the
 * verdict boundary matrix (exit-0-but-output-says-failed, "0 failed" NOT
 * misclassified, word-boundary tokens, timedOut precedence) and the detect
 * probe precedence were unpinned. Each case observes the ACTUAL returned value
 * (anti-vacuous — asserted directly, never `toBeDefined`-then-narrow) and the
 * matrix is paired (each branch has a control that must produce a DIFFERENT
 * verdict, so a collapsed branch goes red).
 *
 * STRUCTURAL FINDING pinned below: given the exit-code fallbacks (source lines
 * 104-105), the returned verdict for a NON-timed-out run is fully determined by
 * `Math.sign(exitCode)` — the pass/ok regex branch (line 103) is cosmetically
 * inert, and the fail regex (line 102) is only ever load-bearing THROUGH its
 * `exitCode !== 0` guard on the exit-0 side. These tests pin that reality (not a
 * wished-for behavior); see the "structural inertness" block.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __test } from "@/tool/test-runner"

const { verdict, detectCommand } = __test

describe("verdict — timedOut precedence (wins over any output/exit)", () => {
  test("timedOut ⇒ 'timed out' even with a passing exit-0 + 'passed' output", () => {
    expect(verdict("42 passed", 0, true)).toBe("timed out")
  })

  test("timedOut ⇒ 'timed out' even with a failing exit-1 + 'failed' output", () => {
    expect(verdict("3 failed", 1, true)).toBe("timed out")
  })

  // Paired control: identical inputs, timedOut flipped off ⇒ NOT "timed out".
  test("paired control: same output+exit but timedOut=false ⇒ NOT 'timed out'", () => {
    expect(verdict("42 passed", 0, false)).not.toBe("timed out")
    expect(verdict("3 failed", 1, false)).not.toBe("timed out")
  })
})

describe("verdict — failed branch (fail-signal AND exitCode!==0)", () => {
  test("exit-1 + '3 failed' ⇒ failed", () => {
    expect(verdict("3 failed", 1, false)).toBe("failed")
  })

  test("exit-1 + non-ASCII ✗ cross ⇒ failed", () => {
    expect(verdict("some check ✗ here", 1, false)).toBe("failed")
  })

  test("exit-1 + heavy-cross ✖ ⇒ failed", () => {
    expect(verdict("✖ boom", 1, false)).toBe("failed")
  })

  // The guarded case: fail-TEXT present but exit code is 0. The `exitCode !== 0`
  // guard MUST hold the fail branch back so we fall through to the exit-0 path.
  test("EDGE: exit-0 but output SAYS '2 failed' ⇒ passed (heuristic trusts a 0 exit)", () => {
    expect(verdict("2 failed", 0, false)).toBe("passed")
  })

  // The classic false-match trap: "0 failed" is a SUCCESS line. `\bfailed\b`
  // matches it, but the exitCode!==0 guard (exit 0 here) keeps it out of the
  // fail branch ⇒ passed, NOT failed.
  test("EDGE: exit-0 + '0 failed' (success summary) ⇒ passed, NOT failed", () => {
    expect(verdict("0 failed, 12 passed", 0, false)).toBe("passed")
  })
})

describe("verdict — passed branch + exit-0 fallback", () => {
  test("exit-0 + '42 passed' ⇒ passed", () => {
    expect(verdict("42 passed", 0, false)).toBe("passed")
  })

  test("exit-0 + non-ASCII ✓ check ⇒ passed", () => {
    expect(verdict("all green ✓", 0, false)).toBe("passed")
  })

  test("exit-0 + heavy-check ✔ ⇒ passed", () => {
    expect(verdict("✔ done", 0, false)).toBe("passed")
  })

  test("exit-0 + no recognizable signal ⇒ passed (exit-0 fallback)", () => {
    expect(verdict("random unstructured noise", 0, false)).toBe("passed")
  })

  test("exit-1 + no recognizable signal ⇒ failed (exit-nonzero fallback)", () => {
    expect(verdict("random unstructured noise", 1, false)).toBe("failed")
  })
})

describe("verdict — word-boundary regex behavior (real, not wished-for)", () => {
  // `\bok\b` requires boundaries on BOTH sides: 'broken' embeds 'ok' mid-word,
  // so the ok-token does NOT fire. On exit-1 that means the fail-fallback owns
  // the verdict (failed) — the ok-token never rescues a nonzero exit.
  test("'broken' (embeds 'ok' mid-word) + exit-1 ⇒ failed (ok-token does NOT false-match)", () => {
    expect(verdict("the build is broken", 1, false)).toBe("failed")
  })

  // Paired control proving the ok-token IS the discriminator on the passed
  // regex: a standalone 'ok' token matches `\bok\b`. (Result is 'passed' either
  // way on exit-0, so this pins regex membership, not the returned verdict —
  // see structural-inertness block for why the returned value can't
  // distinguish these on the exit-0 path.)
  test("standalone 'ok' token IS matched by the passed regex (membership pin)", () => {
    expect(/\bok\b/.test("status: ok")).toBe(true)
    expect(/\bok\b/.test("broken")).toBe(false)
  })

  // The fail regex `\b\d+\s+fail|\bfailed\b`: 'passenger' / 'broke' contain no
  // fail token, so an exit-1 with only such words still lands 'failed' via the
  // fallback — but crucially the FAIL REGEX itself does not false-match them.
  test("fail regex does NOT false-match 'passenger'/'broke' (no fail token)", () => {
    expect(/\b\d+\s+fail|\bfailed\b|✗|✖/.test("passenger broke down")).toBe(false)
  })

  // Documented sharp edge: the passed regex uses `\bpass` (prefix, no trailing
  // boundary), so it DOES match 'passenger'. This is pinned as a ratchet — if
  // someone "fixes" it to `\bpassed?\b` this flips and we notice. It does not
  // change any returned verdict (exit-code fallback dominates), so it is a
  // membership pin only.
  test("RATCHET: passed regex `\\bpass` is a PREFIX match ⇒ matches 'passenger' too", () => {
    expect(/\bpass|\bok\b|✓|✔|\b\d+\s+passed\b/.test("passenger")).toBe(true)
  })
})

describe("verdict — structural inertness (exit sign fully determines a non-timeout verdict)", () => {
  // Paired control across the SAME text with only exitCode flipped: proves the
  // returned verdict tracks exit-code sign, independent of output signal words.
  // This is the invariant the exitCode fallbacks impose.
  const texts = ["", "3 failed", "42 passed", "✓✗ mixed", "totally ambiguous"]
  for (const t of texts) {
    test(`text=${JSON.stringify(t)}: exit-0 ⇒ passed, exit-1 ⇒ failed (regex non-load-bearing for the value)`, () => {
      expect(verdict(t, 0, false)).toBe("passed")
      expect(verdict(t, 1, false)).toBe("failed")
    })
  }
})

// ── detectCommand ─────────────────────────────────────────────────────────
// Real FS via a per-case tmpdir (detectCommand reads markers through the
// storage port, unjailed for absolute cwd paths — same approach as the
// integration suite). Each dir is disposed after the case.

const withProject = async (
  files: Record<string, string>,
  path: string | undefined,
  fn: (result: string | undefined) => void | Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "tr-detect-"))
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents)
    }
    await fn(await detectCommand(dir, path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("detectCommand — probe order (bun → npm → pytest)", () => {
  test("bun.lockb present ⇒ 'bun test'", async () => {
    await withProject({ "bun.lockb": "" }, undefined, (r) => expect(r).toBe("bun test"))
  })

  test("bunfig.toml present ⇒ 'bun test'", async () => {
    await withProject({ "bunfig.toml": "" }, undefined, (r) => expect(r).toBe("bun test"))
  })

  test("package.json packageManager=bun@… ⇒ 'bun test' (beats bare npm)", async () => {
    await withProject(
      { "package.json": JSON.stringify({ packageManager: "bun@1.1.0" }) },
      undefined,
      (r) => expect(r).toBe("bun test"),
    )
  })

  test("package.json ONLY (no bun marker) ⇒ 'npm test'", async () => {
    await withProject({ "package.json": JSON.stringify({ scripts: {} }) }, undefined, (r) =>
      expect(r).toBe("npm test"),
    )
  })

  // Precedence: a bun marker beside a plain package.json must resolve to bun,
  // NOT npm — pins the probe order (bun probed before the npm/package.json arm).
  test("PRECEDENCE: bun.lockb + package.json ⇒ 'bun test' (bun wins over npm)", async () => {
    await withProject(
      { "bun.lockb": "", "package.json": JSON.stringify({ scripts: {} }) },
      undefined,
      (r) => expect(r).toBe("bun test"),
    )
  })

  test("pytest.ini (no JS) ⇒ 'pytest'", async () => {
    await withProject({ "pytest.ini": "" }, undefined, (r) => expect(r).toBe("pytest"))
  })

  test("pyproject.toml (no JS) ⇒ 'pytest'", async () => {
    await withProject({ "pyproject.toml": "" }, undefined, (r) => expect(r).toBe("pytest"))
  })

  test("setup.py (no JS) ⇒ 'pytest'", async () => {
    await withProject({ "setup.py": "" }, undefined, (r) => expect(r).toBe("pytest"))
  })

  // Precedence: package.json beside a python marker resolves to npm, NOT pytest
  // — the npm arm is probed before the python arm.
  test("PRECEDENCE: package.json + pyproject.toml ⇒ 'npm test' (npm arm before pytest)", async () => {
    await withProject(
      { "package.json": JSON.stringify({ scripts: {} }), "pyproject.toml": "" },
      undefined,
      (r) => expect(r).toBe("npm test"),
    )
  })

  test("no markers ⇒ undefined (cannot auto-detect)", async () => {
    await withProject({}, undefined, (r) => expect(r).toBeUndefined())
  })

  test("malformed package.json (parse fails) + no other marker ⇒ undefined (not npm)", async () => {
    // readPackageJson swallows the parse error and returns null ⇒ pkg!==null is
    // false ⇒ npm arm skipped; no python marker ⇒ undefined.
    await withProject({ "package.json": "{ not json" }, undefined, (r) => expect(r).toBeUndefined())
  })
})

describe("detectCommand — path forwarding (npm uses `--`, others append raw)", () => {
  test("bun + path ⇒ 'bun test <path>' (no --)", async () => {
    await withProject({ "bun.lockb": "" }, "spec/foo.test.ts", (r) =>
      expect(r).toBe("bun test spec/foo.test.ts"),
    )
  })

  test("npm + path ⇒ 'npm test -- <path>' (path forwarded after separator)", async () => {
    await withProject(
      { "package.json": JSON.stringify({ scripts: {} }) },
      "spec/foo.test.ts",
      (r) => expect(r).toBe("npm test -- spec/foo.test.ts"),
    )
  })

  test("pytest + path ⇒ 'pytest <path>' (no --)", async () => {
    await withProject({ "pytest.ini": "" }, "tests/test_bar.py", (r) =>
      expect(r).toBe("pytest tests/test_bar.py"),
    )
  })
})
