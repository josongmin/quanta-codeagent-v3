/**
 * Regression-prevention ratchet — no per-framework heuristic in the SWE-bench
 * test-command / repro-execution paths.
 *
 * The codebase used to derive the test runner via inline per-framework
 * branches — `if (repo === "django/django")` — and hardcoded the django
 * runner strings (`"test_sqlite"`, `runtests.py`) directly into the
 * test-command / repro paths. That is a HEURISTIC: the runner must instead be
 * derived from the SWE-bench spec SSOT
 * (`src/runner/batch/corpus/repo-version-specs.ts`, generated data — the only
 * legitimate home for those spec strings, surfaced via `specTestCmd`).
 *
 * This ratchet FAILS if anyone reintroduces that class of heuristic into:
 *   - src/runner/batch/corpus/
 *   - src/runner/batch/eval/
 *   - src/agent/repro-test/
 *
 * It scans .ts files recursively (excluding *.test.ts and __tests__/) for three
 * smells and asserts ZERO hits, EXCEPT in the generated SSOT file
 * `repo-version-specs.ts` (where the spec strings legitimately live — its
 * `specRunnerKind` is the ONE place runner-name knowledge belongs):
 *
 *   1. A repo-name equality branch — a TS expression of the form
 *      `repo === "x/y"` / `instanceId === "x/y"`. Modeled on the orphan-literal
 *      scanner in tests/unit/observability/vocabulary-migration.test.ts.
 *   2. The literal `"test_sqlite"` (double OR single quoted) — the magic django
 *      settings value, which now lives ONLY in the generated spec.
 *   3. The `runtests.py` runner-name literal — logic must classify via
 *      `specRunnerKind(repo, version)`, never match the runner name inline.
 *
 * CORRECTNESS NOTE on smell #1: the repo-equality regex MUST require the TS
 * identifier `repo` / `instanceId` on the LEFT of `===`. This is deliberate so
 * it does NOT flag `src/runner/batch/eval/cha-multisite.ts`, which contains a
 * django path match INSIDE A PYTHON STRING
 * (`parts[0:3] == ["django","db","backends"]`) that is intentionally
 * knob-gated and is NOT a TS branch (it uses `==`, not `===`, and has no
 * `repo`/`instanceId` identifier on the left). The regex must catch real
 * `repo === "x/y"` TS branches but never the python-string-literal array.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// File-system walker (vendored — tests should not import the src under scan).
// Scoped to the three heuristic-prone dirs to keep the scan bounded.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

const SCAN_DIRS: ReadonlyArray<string> = [
  join(SRC_ROOT, "runner", "batch", "corpus"),
  join(SRC_ROOT, "runner", "batch", "eval"),
  join(SRC_ROOT, "agent", "repro-test"),
]

/** The generated SWE-bench spec SSOT. Spec strings (`test_sqlite`,
 *  `runtests.py`, repo identifiers) legitimately live here as generated data;
 *  this is the ONE file authorized to host them. Listed even though it may not
 *  exist yet in a given worktree — the allowlist is a path-set membership
 *  check, so a non-existent path simply never matches. */
const SSOT_OWNER_FILE = join(SRC_ROOT, "runner", "batch", "corpus", "repo-version-specs.ts")

const isExcludedTsFile = (p: string): boolean => p.endsWith(".test.ts") || p.endsWith(".test.tsx")

/** Recursively collect .ts/.tsx files under `dir`, excluding *.test.ts and any
 *  `__tests__` directory (test files are not source-under-scan). */
const walk = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p, out)
    } else if (st.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx")) && !isExcludedTsFile(p)) {
      out.push(p)
    }
  }
}

const scanFiles = (): string[] => {
  const out: string[] = []
  for (const dir of SCAN_DIRS) {
    // statSync throws if the dir is missing — all three are expected to exist;
    // if one is renamed away, the ratchet should loudly fail to scan.
    if (statSync(dir).isDirectory()) walk(dir, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// Forbidden-pattern scanner.
// ---------------------------------------------------------------------------

interface Forbidden {
  /** Human label used in the failure report. */
  label: string
  /** Per-line regex (global, so we can count multiple hits per line). */
  re: RegExp
}

/** A repo-name branch keyed on the TS identifier `repo`/`instanceId` (word-bounded
 *  on the LEFT — so it does NOT match python-string content like
 *  `parts[0:3] == ["django","db","backends"]`, which has no such identifier and
 *  uses `==`). Catches the realistic forms, against a quoted `org/name…` slug
 *  (single/double/backtick): equality `repo === "x/y"` (tolerating
 *  `.toLowerCase()` chaining), AND `repo.startsWith("django/")` /
 *  `repo.includes("django/db")` evasions. The slug requires an `org/` prefix
 *  (a `/` with a leading token) so a legit `repo === ""` empty-check or a
 *  `path.includes("/")` separator check never trips it. */
const REPO_EQUALITY_RE =
  /\b(repo|instanceId)\b[^\n=]{0,40}===\s*["'`][a-z0-9_-]+\/[a-z0-9_-]*["'`]/g
const REPO_METHOD_RE =
  /\b(repo|instanceId)\b\s*\.\s*(?:startsWith|includes)\s*\(\s*["'`][a-z0-9_-]+\/[a-z0-9_-]*/g

// All runner-name knowledge is centralized in the SSOT module via `specRunnerKind`
// — logic code classifies with that helper, never a runner-name literal. So all
// three spec strings are forbidden in logic and allowed ONLY in the SSOT owner
// file: a `repo === "x/y"` branch, the magic `test_sqlite` settings value, and the
// `runtests.py` runner name (which lives only inside `specRunnerKind`).
const FORBIDDEN: ReadonlyArray<Forbidden> = [
  { label: 'repo-name equality branch (repo/instanceId === "x/y")', re: REPO_EQUALITY_RE },
  { label: 'repo-name method branch (repo.startsWith/includes("x/…"))', re: REPO_METHOD_RE },
  { label: "\"test_sqlite\" / 'test_sqlite' literal", re: /["']test_sqlite["']/g },
  { label: "runtests.py runner-name literal (use specRunnerKind)", re: /runtests\.py/g },
]

interface Hit {
  file: string
  line: number
  label: string
  text: string
}

/** Scan a single text body line-by-line for every forbidden pattern. Exposed
 *  separately from the file walk so the red-on-injection test can drive it with
 *  an inline fixture string (no real file edit). */
const scanText = (text: string, file: string): Hit[] => {
  const hits: Hit[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    for (const f of FORBIDDEN) {
      f.re.lastIndex = 0
      if (f.re.test(line)) {
        hits.push({ file, line: i + 1, label: f.label, text: line.trim() })
      }
    }
  }
  return hits
}

const scanLiveSource = (): Hit[] => {
  const hits: Hit[] = []
  for (const file of scanFiles()) {
    if (file === SSOT_OWNER_FILE) continue
    hits.push(...scanText(readFileSync(file, "utf8"), file))
  }
  return hits
}

const fmtHits = (hits: Hit[]): string =>
  hits
    .map((h) => `  ${h.file.slice(REPO_ROOT.length + 1)}:${h.line}  [${h.label}]  ${h.text}`)
    .join("\n")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("no per-framework heuristic ratchet", () => {
  test("scan dirs and SSOT owner file resolve to real paths", () => {
    for (const d of SCAN_DIRS) {
      expect(statSync(d).isDirectory()).toBe(true)
    }
    // SSOT file may not exist yet in every worktree — assert only that the
    // allowlist constant points inside the corpus dir (path shape), not that it
    // exists, so the ratchet stays valid before/after the SSOT lands.
    expect(SSOT_OWNER_FILE.startsWith(join(SRC_ROOT, "runner", "batch", "corpus"))).toBe(true)
  })

  test("no per-framework heuristic smell in the test-command / repro paths", () => {
    const hits = scanLiveSource()
    if (hits.length > 0) {
      throw new Error(
        "per-framework heuristic reintroduced — derive from " +
          "repo-version-specs.ts (specTestCmd) instead:\n" +
          fmtHits(hits),
      )
    }
    expect(hits.length).toBe(0)
  })
})

describe("ratchet teeth — red-on-injection", () => {
  test('repo-equality scanner FIRES on an inline `repo === "x/y"` fixture', () => {
    const fixture = ["const a = 1", 'const _x = repo === "flask/flask"', "const b = 2"].join("\n")
    const hits = scanText(fixture, "<fixture>")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.line === 2 && h.label.startsWith("repo-name equality"))).toBe(true)
  })

  test("scanner FIRES on all smells (instanceId ===, startsWith/includes evasion, test_sqlite, runtests.py)", () => {
    const fixture = [
      'if (instanceId === "django/django") {}',
      'if (repo.startsWith("django/")) {}',
      'if (repo.includes("flask/flask")) {}',
      'const s = "test_sqlite"',
      'if (runner.includes("runtests.py")) {}',
    ].join("\n")
    const hits = scanText(fixture, "<fixture>")
    expect(hits.some((h) => h.label.startsWith("repo-name equality"))).toBe(true)
    // the .startsWith / .includes evasions are caught by the method-branch smell
    expect(hits.filter((h) => h.label.startsWith("repo-name method")).length).toBe(2)
    expect(hits.some((h) => h.label.includes("test_sqlite"))).toBe(true)
    expect(hits.some((h) => h.label.includes("runtests.py"))).toBe(true)
  })

  test("scanner does NOT false-fire on empty-check / path-separator (no org/name slug)", () => {
    // `repo === ""` (empty check) and `path.includes("/")` (separator) are legit —
    // the slug requires an `org/` prefix with a leading token, so neither trips.
    const fixture = [
      'if (repo === "") return',
      'if (path.includes("/")) {}',
      'if (s.includes("tests/")) {}',
    ].join("\n")
    const hits = scanText(fixture, "<fixture>")
    expect(hits.filter((h) => h.label.includes("repo-name")).length).toBe(0)
  })

  test("repo-equality scanner does NOT fire on the cha-multisite python-string array", () => {
    // Verbatim shape of the intentionally knob-gated python rule in
    // cha-multisite.ts — `==` (not `===`), no `repo`/`instanceId` identifier.
    const fixture = 'if len(parts) >= 5 and parts[0:3] == ["django", "db", "backends"]:'
    const hits = scanText(fixture, "<fixture>")
    expect(hits.some((h) => h.label.startsWith("repo-name equality"))).toBe(false)
  })

  test("the real cha-multisite.ts is not flagged by the repo-equality smell", () => {
    const cha = join(SRC_ROOT, "runner", "batch", "eval", "cha-multisite.ts")
    if (statSync(cha).isFile()) {
      const hits = scanText(readFileSync(cha, "utf8"), cha).filter((h) =>
        h.label.startsWith("repo-name equality"),
      )
      expect(hits.length).toBe(0)
    }
  })
})
