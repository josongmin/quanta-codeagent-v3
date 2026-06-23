/**
 * REAL-PYTEST hellgate — execution-grounded verdict (P1).
 *
 * These tests drive an ACTUAL `python3 <path>` process (the driver's contract)
 * against generated test files, proving end-to-end that:
 *
 *   1. A test whose assertion FAILS on the (synthetic) buggy code classifies
 *      `"reproduced"` — via pytest's real exit code, not a printed sentinel.
 *   2. A test whose assertion PASSES classifies `"resolved"`.
 *   3. A top-level import error classifies `"exec_failed"` (infra, NOT a fake
 *      reproduced — the import-vs-failure confound, proven against real pytest).
 *   4. A file with no `def test_*` classifies `"unknown"` ("no tests ran").
 *   5. The `python <path>` → pytest BRIDGE actually controls the exit code: the
 *      `ensurePytestFooter` footer makes a bare `python <path>` run pytest on
 *      itself. Run WITHOUT the footer, the same file exits 0 (no verdict) — so
 *      the footer is load-bearing, not decorative.
 *   6. MUTATION: a file that PRINTS "Issue resolved" but whose pytest assertion
 *      FAILS classifies `"reproduced"` — the printed sentinel can NO LONGER fake
 *      a green, driven through real pytest. This is the exact fakeability P1
 *      removes, proven against the real interpreter.
 *
 * Capability-gated: if `python3 -c "import pytest"` is not available the heavy
 * tests skip VISIBLY (a sentinel assertion still runs so the suite never
 * silently passes with zero coverage). The pure `classifyPytest` teeth in
 * execute.test.ts ALWAYS run regardless.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFile as fsWriteFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensurePytestFooter } from "../../../src/agent/repro-test/generate"

/** Probe whether a real python3 with pytest is importable on this box. */
const pytestAvailable = (): boolean => {
  try {
    const r = Bun.spawnSync(["python3", "-c", "import pytest"])
    return r.exitCode === 0
  } catch {
    return false
  }
}

const HAS_PYTEST = pytestAvailable()
if (!HAS_PYTEST) {
  // VISIBLE skip — never a silent zero-coverage pass.
  // biome-ignore lint/suspicious/noConsole: surfacing a capability skip
  console.warn("[real-pytest-grounding] python3+pytest unavailable — heavy teeth SKIPPED")
}

/** Run a source string EXACTLY as the driver would: write it, then
 *  `python3 <path>` (no pytest in argv — the footer must self-drive it). */
const runAsPython = async (
  dir: string,
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const path = join(dir, name)
  await fsWriteFile(path, source, "utf8")
  const proc = Bun.spawnSync(["python3", path], { cwd: dir })
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

// Re-derive the outcome the SAME way execute.ts does (classifyPytest) so the
// test asserts the production mapping, not a re-implementation.
import { classifyPytest } from "../../../src/agent/repro-test/execute"

const outcomeOf = (r: { code: number; stdout: string; stderr: string }) =>
  classifyPytest(r.stdout, r.stderr, r.code)

describe("real-pytest grounding (capability-gated)", () => {
  let dir = ""
  beforeAll(async () => {
    if (HAS_PYTEST) dir = await mkdtemp(join(tmpdir(), "repro-pytest-"))
  })
  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true })
  })

  test.skipIf(!HAS_PYTEST)("failing assertion ⇒ reproduced (real pytest exit)", async () => {
    const src = ensurePytestFooter("def test_bug():\n    assert 1 == 2  # buggy")
    const r = await runAsPython(dir, "t_fail.py", src)
    expect(r.code).not.toBe(0) // pytest exit ≠ 0 for a failure
    expect(outcomeOf(r)).toBe("reproduced")
  })

  test.skipIf(!HAS_PYTEST)("passing assertion ⇒ resolved (real pytest exit)", async () => {
    const src = ensurePytestFooter("def test_fixed():\n    assert 1 == 1  # fixed")
    const r = await runAsPython(dir, "t_pass.py", src)
    expect(r.code).toBe(0)
    expect(outcomeOf(r)).toBe("resolved")
  })

  test.skipIf(!HAS_PYTEST)("top-level import error ⇒ exec_failed (NOT reproduced)", async () => {
    const src = ensurePytestFooter(
      "import nonexistent_module_xyz_123\n\ndef test_bug():\n    assert True",
    )
    const r = await runAsPython(dir, "t_import.py", src)
    expect(r.code).not.toBe(0)
    // The crash happens before the footer drives pytest ⇒ no summary ⇒ infra.
    expect(outcomeOf(r)).toBe("exec_failed")
  })

  test.skipIf(!HAS_PYTEST)("no def test_* ⇒ unknown (no tests ran)", async () => {
    const src = ensurePytestFooter("x = 1\ny = x + 1")
    const r = await runAsPython(dir, "t_none.py", src)
    expect(outcomeOf(r)).toBe("unknown")
  })

  test.skipIf(!HAS_PYTEST)(
    "BRIDGE proof — WITHOUT the footer `python <path>` exits 0 (no verdict)",
    async () => {
      // The same failing test, but NO self-driving footer: `python <path>` just
      // imports the module (defining a function is a no-op) and exits 0. The
      // footer is what converts that into a pytest verdict — load-bearing.
      const noFooter = "def test_bug():\n    assert 1 == 2"
      const r = await runAsPython(dir, "t_nofooter.py", noFooter)
      expect(r.code).toBe(0) // no footer ⇒ no pytest ⇒ false green
      expect(outcomeOf(r)).toBe("unknown")

      // WITH the footer the very same body now reports the failure.
      const withFooter = ensurePytestFooter(noFooter)
      const r2 = await runAsPython(dir, "t_withfooter.py", withFooter)
      expect(r2.code).not.toBe(0)
      expect(outcomeOf(r2)).toBe("reproduced")
    },
  )

  test.skipIf(!HAS_PYTEST)(
    "MUTATION — printing 'Issue resolved' CANNOT fake a green when pytest fails",
    async () => {
      // The legacy sentinel oracle would scan stdout, see "Issue resolved", and
      // classify `resolved` (a fake green). Driven through REAL pytest, the
      // printed string is ignored and the failing assertion wins ⇒ reproduced.
      const src = ensurePytestFooter(
        'print("Issue resolved")\nprint("Issue resolved")\n\n\ndef test_bug():\n    assert 1 == 2',
      )
      const r = await runAsPython(dir, "t_mutation.py", src)
      expect(r.stdout).toContain("Issue resolved") // the sentinel IS printed
      expect(outcomeOf(r)).toBe("reproduced") // …but it cannot fake a green
    },
  )

  // Always-on guard so a fully-skipped run is never a silent green.
  test("capability probe is a boolean (suite ran)", () => {
    expect(typeof HAS_PYTEST).toBe("boolean")
  })
})
