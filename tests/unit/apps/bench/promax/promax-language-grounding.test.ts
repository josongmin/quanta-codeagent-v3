/**
 * HELLGATE — aug-22 residual G3: the strict-LSP-grounding preflight must not
 * identify a task's language from the GOLD PATCH for a family that publishes one.
 *
 * `assertRemoteStrictGroundingSupported` derived "what language is this task?"
 * from the diff headers of `row.patch` (the gold patch). PMX-02's ticket forbids
 * exactly that — "anything derived from the gold patch (localization file lists,
 * LSP targets, prompt hints)" is off limits — and ProMax publishes a `language`
 * field precisely so the toolchain preflight has a sanctioned public source.
 *
 * The old behaviour was not merely impure, it was WRONG in both directions:
 *
 *   FALSE ACCEPT  a Rust task whose gold patch happens to touch a `.py` test
 *                 helper grounded as Pyright and launched a box that cannot
 *                 ground it — the false-green this refusal exists to prevent.
 *   FALSE REFUSE  a CORRECTLY-PROJECTED ProMax corpus (public artifact: no gold
 *                 at all) produced zero diff files for every row, so every task
 *                 hit `unknown-task-language` and the whole lane was unlaunchable.
 *
 * Both are asserted below against the REAL production function, plus a PAIRED
 * CONTROL proving the gold-derived path is untouched for the JSONL families that
 * carry no public `language` field.
 *
 * ⚠️ No network, no box, no provisioning: this calls the local preflight only.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { presetRequiresLiveLspGrounding } from "@/apps/bench/preset"
import {
  assertRemoteStrictGroundingSupported,
  UnsupportedRemoteStrictLspGroundingError,
} from "@/apps/bench/remote/box-session/dataset-preflight"
import { PYRIGHT_LANGSERVER_BIN, RUST_ANALYZER_BIN } from "@/lsp/server-registry"

const STRICT_PRESET = "agentless-v3-thin-strict"

const DIRS: string[] = []
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true })
})
const writeCorpus = (name: string, text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx-g3-"))
  DIRS.push(dir)
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

/** A gold patch that touches ONLY Python files — the misleading signal. */
const PY_GOLD_PATCH = [
  "diff --git a/tests/conftest.py b/tests/conftest.py",
  "--- a/tests/conftest.py",
  "+++ b/tests/conftest.py",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n")

const promaxRow = (id: string, language: string, extra: Record<string, unknown> = {}) => ({
  instance_id: id,
  repo: "acme/thing",
  base_commit: "0".repeat(40),
  problem_statement: `PROBLEM ${id}`,
  language,
  ...extra,
})

describe("G3 — the ProMax lane grounds on the PUBLIC `language`, never on gold", () => {
  test("KNOWN-ITEM FLOOR — the preset really does demand live grounding", () => {
    expect(presetRequiresLiveLspGrounding(STRICT_PRESET)).toBe(true)
    // …and a preset that does not is the paired no-op (nothing is asserted
    // vacuously against a gate that is off for every input).
    expect(presetRequiresLiveLspGrounding("agentless-v1")).toBe(false)
  })

  test("FALSE-ACCEPT — a RUST task whose gold patch touches .py is REFUSED", () => {
    // The row is gold-bearing (an operator pointed at the raw upstream array).
    // Its public `language` says rust; its gold patch says python. The remote box
    // proves only Pyright, so the honest answer is a refusal.
    const path = writeCorpus(
      "raw.json",
      JSON.stringify([promaxRow("k__rust-1", "rust", { patch: PY_GOLD_PATCH })]),
    )
    let err: unknown
    try {
      assertRemoteStrictGroundingSupported({
        preset: STRICT_PRESET,
        datasetPath: path,
        surface: "test",
        family: "promax",
      })
    } catch (e) {
      err = e
    }
    expect(err, "the gold-derived .py signal grounded a RUST task as Pyright").toBeInstanceOf(
      UnsupportedRemoteStrictLspGroundingError,
    )
    const message = String((err as Error).message)
    expect(message).toContain(RUST_ANALYZER_BIN)
    expect(message).toContain("k__rust-1")
  })

  test("FALSE-REFUSE — a correctly PROJECTED (gold-free) python row is ACCEPTED", () => {
    // This is the shape `public-tasks.json` / a ProMax chunk slice actually has:
    // no `patch` key at all. Under the gold-derived rule every such row produced
    // zero diff files ⇒ `unknown-task-language` ⇒ the lane could never launch.
    const path = writeCorpus(
      "public.json",
      JSON.stringify([promaxRow("k__py-1", "python"), promaxRow("k__py-2", "python")]),
    )
    expect(() =>
      assertRemoteStrictGroundingSupported({
        preset: STRICT_PRESET,
        datasetPath: path,
        surface: "test",
        family: "promax",
      }),
    ).not.toThrow()
  })

  test("a gold-free NON-python row is still refused, naming its real server", () => {
    const path = writeCorpus("public-go.json", JSON.stringify([promaxRow("k__go-1", "go")]))
    expect(() =>
      assertRemoteStrictGroundingSupported({
        preset: STRICT_PRESET,
        datasetPath: path,
        surface: "test",
        family: "promax",
      }),
    ).toThrow(/gopls/)
  })

  test("an UNMAPPABLE public language refuses by NAME, and never falls back to gold", () => {
    // `cobol` maps to no configured language server. The row also carries a
    // python gold patch: if the public signal were merely a first attempt with a
    // gold fallback, this would silently ground as Pyright and pass.
    const path = writeCorpus(
      "cobol.json",
      JSON.stringify([promaxRow("k__cobol-1", "cobol", { patch: PY_GOLD_PATCH })]),
    )
    let err: unknown
    try {
      assertRemoteStrictGroundingSupported({
        preset: STRICT_PRESET,
        datasetPath: path,
        surface: "test",
        family: "promax",
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UnsupportedRemoteStrictLspGroundingError)
    expect(String((err as Error).message)).toContain("cobol")
  })

  test("PAIRED CONTROL — a JSONL family with NO public language keeps the gold-derived path", () => {
    // Byte-identical behaviour for verified/live/pro: they publish no `language`
    // field, so the diff-header derivation is still the only signal they have.
    const path = writeCorpus(
      "verified.jsonl",
      `${JSON.stringify({
        instance_id: "django__django-1",
        repo: "django/django",
        base_commit: "1".repeat(40),
        problem_statement: "P",
        patch: PY_GOLD_PATCH,
      })}\n`,
    )
    expect(() =>
      assertRemoteStrictGroundingSupported({
        preset: STRICT_PRESET,
        datasetPath: path,
        surface: "test",
        family: "verified",
      }),
    ).not.toThrow()
    expect(PYRIGHT_LANGSERVER_BIN).toBe("pyright-langserver")
  })
})
