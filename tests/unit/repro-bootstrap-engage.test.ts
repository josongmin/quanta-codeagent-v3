/**
 * jun-27 engage=0 RCA fix — repro execution bootstrap (django settings).
 *
 * Cassette-confirmed root cause of `engage=0`: a django repro's module body
 * touches `settings` when pytest re-imports it for collection → without a
 * configured settings module that raises `ImproperlyConfigured` → "1 error
 * during collection" → `collected=0` → outcome `"unknown"` → reproducedCount=0
 * → reproTest.installed=false → baseValidatedRed=false → NO primary rail → the
 * repair gate never opens. The fix prepends a per-repo bootstrap that configures
 * the framework BEFORE collection (`applyReproBootstrap`).
 *
 * Two proofs:
 *   1. PURE — `applyReproBootstrap` prepends the django bootstrap (idempotent,
 *      no-op off-django / empty).
 *   2. REAL BRIDGE — drive the ACTUAL `executeReproTests` (real python3 + pytest
 *      + the self-driving footer) on a config-gated repro: WITHOUT the bootstrap
 *      it cannot reproduce (reproducedCount 0 → no rail); WITH a setdefault-style
 *      bootstrap preamble (structurally identical to the django one) it
 *      REPRODUCES (reproducedCount 1 → the rail the repair gate needs). This is
 *      the exact fail→reproduce flip the live django path needs.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeReproTests, type ReproExecPort } from "@/agent/repro-test/execute"
import {
  applyReproBootstrap,
  ensurePytestFooter,
  reproBootstrapPreamble,
} from "@/agent/repro-test/generate"

describe("repro bootstrap — pure wiring (applyReproBootstrap)", () => {
  test("django repo: prepends a settings bootstrap (django.setup before the test body)", () => {
    const out = applyReproBootstrap(
      "import x\ndef test_a():\n    assert x.v == 1\n",
      "django/django",
    )
    expect(out).toContain("DJANGO_SETTINGS_MODULE")
    expect(out).toContain("django")
    expect(out).toContain(".setup()")
    // the bootstrap is at the TOP (before the test's imports), not appended
    expect(out.indexOf("DJANGO_SETTINGS_MODULE")).toBeLessThan(out.indexOf("def test_a"))
    expect(reproBootstrapPreamble("django/django")).not.toBe("")
  })

  test("non-django repo / empty source ⇒ byte-identical (no bootstrap)", () => {
    const src = "import x\ndef test_a():\n    assert True\n"
    expect(applyReproBootstrap(src, "sympy/sympy")).toBe(src)
    expect(applyReproBootstrap(src, undefined)).toBe(src)
    expect(applyReproBootstrap("", "django/django")).toBe("")
    expect(reproBootstrapPreamble("sympy/sympy")).toBe("")
  })

  test("idempotent: applying twice never double-prepends", () => {
    const once = applyReproBootstrap("def test_a():\n    assert True\n", "django/django")
    expect(applyReproBootstrap(once, "django/django")).toBe(once)
  })
})

// Real python3 + pytest bridge. Skips (visibly) if the toolchain is absent so a
// python-less CI box doesn't fail; locally it is a genuine end-to-end proof.
const realExec: ReproExecPort = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

const pytestAvailable = async (): Promise<boolean> => {
  try {
    const r = await realExec(["python3", "-c", "import pytest"], tmpdir(), 10_000)
    return r.code === 0
  } catch {
    return false
  }
}

describe("repro bootstrap — real python+pytest bridge flips fail→reproduce", () => {
  test("config-gated repro: NO bootstrap ⇒ not reproduced; WITH bootstrap ⇒ reproduced", async () => {
    if (!(await pytestAvailable())) {
      // biome-ignore lint/suspicious/noConsole: visible skip marker when the python toolchain is absent
      console.log("[skip] python3+pytest unavailable — bridge proof skipped (visible skip)")
      return
    }
    const root = mkdtempSync(join(tmpdir(), "repro-boot-"))
    try {
      // A library whose use raises unless the env is configured — the offline
      // analog of django's `ImproperlyConfigured` when settings aren't set up.
      await Bun.write(
        join(root, "_q_gate.py"),
        [
          "import os",
          "def value():",
          '    if os.environ.get("_Q_GATE_READY") != "1":',
          '        raise RuntimeError("ImproperlyConfigured: _Q_GATE_READY not set")',
          "    return 42",
          "",
        ].join("\n"),
      )
      // The repro accesses the gated lib AT MODULE TOP (like a django model using
      // settings) and asserts the EXPECTED value — so on the buggy base it FAILS
      // (42 != 999) = "reproduced", but ONLY if collection ever gets that far.
      const body =
        "import _q_gate\nRESULT = _q_gate.value()\ndef test_bug():\n    assert RESULT == 999\n"
      const writeFile = async (p: string, c: string): Promise<void> => {
        await Bun.write(p, c)
      }
      const readFile = async (p: string): Promise<string> => await Bun.file(p).text()

      // WITHOUT bootstrap: module-top value() raises → no reproduction.
      const without = await executeReproTests({
        tests: [ensurePytestFooter(body)],
        repoRoot: root,
        exec: realExec,
        writeFile,
        readFile,
        tempPath: (i) => join(root, `__repro_nb_${i}.py`),
      })
      const reproducedWithout = without.filter((s) => s.outcome === "reproduced").length
      expect(reproducedWithout).toBe(0) // the engage=0 world

      // WITH a setdefault-style bootstrap preamble (same shape as the django one):
      // env is configured before collection → the repro runs → assertion fails →
      // "reproduced" → reproducedCount>0 → the rail the repair gate needs.
      const preamble = 'import os as _b_os\n_b_os.environ.setdefault("_Q_GATE_READY", "1")\n'
      const withBoot = await executeReproTests({
        tests: [ensurePytestFooter(preamble + body)],
        repoRoot: root,
        exec: realExec,
        writeFile,
        readFile,
        tempPath: (i) => join(root, `__repro_wb_${i}.py`),
      })
      const reproducedWith = withBoot.filter((s) => s.outcome === "reproduced").length
      expect(reproducedWith).toBe(1) // the fix: rail opens

      // The whole point: the bootstrap is what flips it.
      expect(reproducedWith).toBeGreaterThan(reproducedWithout)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
