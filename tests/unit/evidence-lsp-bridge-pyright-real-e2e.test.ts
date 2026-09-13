/**
 * #1-P1 (jun-19 audit) — REAL pyright e2e for the PRODUCTION `evidenceLspStatic()`
 * port at a per-instance SANDBOX cwd. The #1 grounding audit's P1 gap: every
 * existing pyright test injects a FAKE client (proves pool lifecycle, NOT that a
 * REAL pyright answers). So a regression where pyright is on PATH but cannot
 * actually SERVE the sandbox — the jun-16 django dead-end class: missing
 * `pythonPath` / no `didChangeConfiguration` push ⇒ pyright hangs/returns empty
 * on every request — would pass the whole default suite silently.
 *
 * This test spawns a REAL pyright against a tiny 2-file Python project rooted at
 * a temp sandbox and asserts the production port returns NON-EMPTY static
 * evidence at a failure site. Empty ⇒ pyright is inert at the sandbox (exactly
 * the silent-degrade) ⇒ RED. AUTO-SKIPS without pyright (opt-in serial lane,
 * same gate as the rust-analyzer real e2e: QUANTA_REAL_TOOLCHAIN_E2E=1).
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportExecuted,
} from "../_helpers/capability-lane"

const GROUP = "lsp-pyright"
const FILE = "tests/unit/evidence-lsp-bridge-pyright-real-e2e.test.ts"

// CAPABILITY GROUP `lsp-pyright`. Same opt-in serial lane as the rust sibling
// (a real LSP server under the full parallel suite gets CPU-starved → empty →
// flake), now declared in the manifest rather than implied by a filename.
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: {
    "pyright-langserver": hasBinary("pyright-langserver"),
    python3: hasBinary("python3"),
  },
})
const D = laneDescribe(GATE)

/** A 2-file Python project: `main.py` imports + calls `helpers.compute`. The
 *  failure site is the call line — a real pyright must resolve `compute` there
 *  (hover type + cross-file definition into helpers.py). */
const project = (): { dir: string; main: string; line: number } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pyright-nav-")))
  writeFileSync(
    join(dir, "helpers.py"),
    ["def compute(value: int) -> int:", "    return value * 2", ""].join("\n"),
  )
  const mainLines = [
    "from helpers import compute",
    "",
    "def run() -> int:",
    "    result = compute(21)", // line 4 — the failure/edit site
    "    assert result == 99",
    "",
  ]
  writeFileSync(join(dir, "main.py"), mainLines.join("\n"))
  return { dir, main: join(dir, "main.py"), line: 4 }
}

D("evidenceLspStatic — PRODUCTION pyright port rooted at a sandbox (real server)", () => {
  afterAll(() =>
    reportExecuted(GATE, GROUP, FILE, "real pyright-langserver served a sandbox", () => ({
      pyrightVersion: boundedVersion(["pyright-langserver", "--version"]),
      pythonVersion: boundedVersion(["python3", "--version"]),
    })),
  )

  test("a real pyright resolves a symbol at the sandbox failure site (not inert)", async () => {
    const { dir, main, line } = project()
    const port = evidenceLspStatic()
    const ev = await port(main, line, dir)
    // The hard teeth: a non-null packet with REAL content. If pyright were inert
    // at the sandbox (no pythonPath / no didChangeConfiguration — the jun-16
    // silent-degrade), every request returns empty and `ev` is null / blank.
    expect(ev).not.toBeNull()
    const harvested =
      (ev?.type_info ?? "").length +
      (ev?.definition_chain?.length ?? 0) +
      (ev?.references?.length ?? 0)
    expect(harvested).toBeGreaterThan(0)
  }, 120_000)
})
