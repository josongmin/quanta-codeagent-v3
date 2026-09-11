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

import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { SPHINX_RA_SHIM } from "@/apps/bench/python-swebench"
import { canExecute, capability } from "../../tools/dev/capability-receipt-consumer"

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

// ─── capability receipt (TVH-11) ────────────────────────────────────────────
//
// The `spawnSync("python3", …)` that ACTUALLY RUNS the shim used to sit here,
// at module scope: importing this file executed a Python program. The
// interpreter answer now comes from the tier's capability receipt (one probe
// per tier, not one per file) and the real work moved into `beforeAll`, so
// module load is inert.
//
// `if (!havePy) return` was the old guard — bun tallies an early return as a
// PASS, so on a host without python3 this file reported 2/2 green with zero
// assertions executed. `describe.skipIf` makes absence a VISIBLE skip.
const python = capability("python3")
const PY = python.resolved ?? "python3"

describe.skipIf(!canExecute(python))(
  `SPHINX_RA_SHIM — predicate behavior (real python3, zero drift) [${python.label}]`,
  () => {
    let run: ReturnType<typeof spawnSync>

    beforeAll(() => {
      run = spawnSync(PY, ["-c", script], { encoding: "utf8" })
    })

    test("the probe actually ran — anti-vacuity floor for every assertion below", () => {
      // Without this, a python3 that starts and prints nothing makes the parse
      // below throw in a way that reads as a code defect rather than a broken
      // fixture — and any `try/catch` softening of it would make the whole file
      // vacuous. Assert the shape of what came back, once, loudly.
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(0)
      expect(String(run.stdout).trim().length).toBeGreaterThan(0)
    })

    test("sphinx tox cmd gets `-rA`; every other shape untouched", () => {
      const out = JSON.parse(String(run.stdout)) as Record<string, string>
      expect(out["sphinx-doc/sphinx"]).toBe("tox --current-env -epy39 -v -- -rA") // FIXED
      expect(out["astropy/astropy"]).toBe("pytest -rA -vv -o console_output_style=classic") // already -rA
      expect(out["pydata/xarray"]).toBe("pytest -rA") // already -rA
      expect(out["django/django"]).toBe("./tests/runtests.py --verbosity 2") // unittest
      expect(out["tox-already-ra/x"]).toBe("tox -e py39 -- -rA") // NOT doubled
      expect(out["tox-no-dashdash/x"]).toBe("tox -e py39 -v") // no `--` slot
    })
  },
)
