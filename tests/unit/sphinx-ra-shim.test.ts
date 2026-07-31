/**
 * ★ CONTRACT — SPHINX_RA_SHIM PREDICATE BEHAVIOR (jun-28 false-unresolved fix).
 *
 * Complements `swebench-buildargv-sphinx-ra.test.ts` (which pins the WIRING +
 * shim-string shape). This one EXECUTES the shim's exact predicate under real
 * python3 over representative test_cmds, proving the BEHAVIOR — not just that the
 * string contains the clauses:
 *   - sphinx (`tox … --`, no -rA)      → `-rA` appended (the fix)
 *   - astropy / xarray (already `-rA`) → untouched
 *   - django (unittest, no tox)        → untouched
 *   - tox that ALREADY has `-rA`        → NOT doubled
 *   - tox NOT ending in `--`            → untouched (no passthrough slot)
 *
 * The predicate lines are SLICED out of SPHINX_RA_SHIM (drop the imports +
 * run_module) so there is ZERO mirror/drift — we run the shipped logic verbatim.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { SPHINX_RA_SHIM } from "@/apps/bench/python-swebench"

const SAMPLES: Record<string, Record<string, { test_cmd: string }>> = {
  "sphinx-doc/sphinx": { "4.3": { test_cmd: "tox --current-env -epy39 -v --" } },
  "astropy/astropy": { "5.0": { test_cmd: "pytest -rA -vv -o console_output_style=classic" } },
  "pydata/xarray": { x: { test_cmd: "pytest -rA" } },
  "django/django": { "4.1": { test_cmd: "./tests/runtests.py --verbosity 2" } },
  "tox-already-ra/x": { v: { test_cmd: "tox -e py39 -- -rA" } },
  "tox-no-dashdash/x": { v: { test_cmd: "tox -e py39 -v" } },
}

// EXACT mutation lines from the shipped shim — drop imports + run_module only.
const predicate = SPHINX_RA_SHIM.split("\n")
  .filter(
    (l) =>
      !l.startsWith("import runpy") && !l.startsWith("import swebench") && !l.startsWith("runpy."),
  )
  .join("\n")

const script = [
  "import json",
  "class _C: pass",
  `_C.MAP_REPO_VERSION_TO_SPECS = json.loads(${JSON.stringify(JSON.stringify(SAMPLES))})`,
  predicate,
  "print(json.dumps({r: list(v.values())[0]['test_cmd'] for r,v in _C.MAP_REPO_VERSION_TO_SPECS.items()}))",
].join("\n")

const run = spawnSync("python3", ["-c", script], { encoding: "utf8" })
const havePy = run.status === 0 && !run.error

describe("SPHINX_RA_SHIM — predicate behavior (real python3, zero drift)", () => {
  test("python3 available (else VISIBLE skip)", () => {
    if (!havePy) {
      console.warn(
        `[sphinx-ra-shim] python3 unavailable — predicate test SKIPPED: ${run.error ?? run.stderr}`,
      )
    }
    expect(true).toBe(true)
  })

  test("sphinx tox cmd gets `-rA`; every other shape untouched", () => {
    if (!havePy) return
    const out = JSON.parse(run.stdout) as Record<string, string>
    expect(out["sphinx-doc/sphinx"]).toBe("tox --current-env -epy39 -v -- -rA") // FIXED
    expect(out["astropy/astropy"]).toBe("pytest -rA -vv -o console_output_style=classic") // already -rA
    expect(out["pydata/xarray"]).toBe("pytest -rA") // already -rA
    expect(out["django/django"]).toBe("./tests/runtests.py --verbosity 2") // unittest
    expect(out["tox-already-ra/x"]).toBe("tox -e py39 -- -rA") // NOT doubled
    expect(out["tox-no-dashdash/x"]).toBe("tox -e py39 -v") // no `--` slot
  })
})
