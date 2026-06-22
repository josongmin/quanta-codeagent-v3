import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ExecFn } from "../../src/apps/bench/eval/repair/types"
import { validate } from "../../src/apps/bench/eval/repair/validator"

const HARNESS_SANDBOX = "/tmp/repair-test-sandbox"

interface Captured {
  cmd: string
  cwd: string
  timeoutMs: number
}

const makeExec = (
  result: { code: number; stdout: string; stderr: string },
  log?: Captured[],
): ExecFn => {
  return async (cmd, cwd, timeoutMs) => {
    log?.push({ cmd, cwd, timeoutMs })
    return result
  }
}

describe("validate (non-leaking repair validator)", () => {
  test("ok path: exec returns code 0 ⇒ {ok:true} with no failTail", async () => {
    const exec = makeExec({ code: 0, stdout: "ok\n", stderr: "" })
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "pytest tests/test_x.py -k repro",
      exec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(true)
    expect(r.failTail).toBeUndefined()
  })

  test("fail path: code 1 with stdout+stderr ⇒ {ok:false, failTail:'x\\ny'}", async () => {
    const exec = makeExec({ code: 1, stdout: "x", stderr: "y" })
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "pytest",
      exec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toBe("x\ny")
  })

  test("tail bound: huge stdout/stderr ⇒ failTail length ≤ tailBytes", async () => {
    const stdout = "A".repeat(5000)
    const stderr = "B".repeat(5000)
    const exec = makeExec({ code: 1, stdout, stderr })
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "pytest",
      exec,
      timeoutMs: 1000,
      tailBytes: 1024,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toBeDefined()
    expect((r.failTail ?? "").length).toBeLessThanOrEqual(1024)
    // tail preserved: end of stderr ("B"s) should appear
    expect((r.failTail ?? "").endsWith("B")).toBe(true)
  })

  test("default tail bound is 2000", async () => {
    const stdout = "A".repeat(5000)
    const exec = makeExec({ code: 1, stdout, stderr: "" })
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "pytest",
      exec,
      timeoutMs: 1000,
    })
    expect((r.failTail ?? "").length).toBeLessThanOrEqual(2000)
  })

  test('repro fallback: only reproPath ⇒ exec called with `python "<reproPath>"`', async () => {
    const log: Captured[] = []
    const exec = makeExec({ code: 0, stdout: "", stderr: "" }, log)
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      reproPath: "/sbx/repro.py",
      exec,
      timeoutMs: 1234,
    })
    expect(r.ok).toBe(true)
    expect(log).toHaveLength(1)
    expect(log[0]?.cmd).toBe('python "/sbx/repro.py"')
    expect(log[0]?.cwd).toBe(HARNESS_SANDBOX)
    expect(log[0]?.timeoutMs).toBe(1234)
  })

  test("cmd takes precedence over reproPath when both present", async () => {
    const log: Captured[] = []
    const exec = makeExec({ code: 0, stdout: "", stderr: "" }, log)
    await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "pytest -k a",
      reproPath: "/sbx/repro.py",
      exec,
      timeoutMs: 1000,
    })
    expect(log[0]?.cmd).toBe("pytest -k a")
  })

  test("degenerate: neither cmd nor reproPath ⇒ {ok:false, failTail:''} (NOT silent pass)", async () => {
    const log: Captured[] = []
    const exec = makeExec({ code: 0, stdout: "", stderr: "" }, log)
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      exec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toBe("")
    // exec must NOT be invoked when there's no signal
    expect(log).toHaveLength(0)
  })

  test("empty-string cmd is treated as absent ⇒ degenerate failure", async () => {
    const log: Captured[] = []
    const exec = makeExec({ code: 0, stdout: "", stderr: "" }, log)
    const r = await validate({
      sandbox: HARNESS_SANDBOX,
      cmd: "",
      exec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toBe("")
    expect(log).toHaveLength(0)
  })
})

// ---------- STRUCTURAL NO-LEAK GOLDEN (MERGE-GATE-CLASS) ----------
// Scan the SOURCE TEXT of the repair files and assert ZERO occurrences of
// forbidden tokens, and that they import ONLY local repair helpers. One self-
// protecting test = the no-leak invariant becomes a build gate.
describe("structural no-leak invariant (build gate)", () => {
  const ROOT = resolve(__dirname, "../../src/runner/batch/eval/repair")
  const FILES = ["validator.ts", "context.ts", "index.ts", "repro-outcome.ts"] as const
  // Forbidden dataset/grader tokens. These names MUST NOT appear in source
  // text — the validator/context/orchestrator must be structurally incapable
  // of touching them.
  const FORBIDDEN_TOKENS = ["FAIL_TO_PASS", "PASS_TO_PASS", "test_patch", "goldPatch"]
  const FORBIDDEN_REGEXES: RegExp[] = [/\.report\.json/, /swebench\.harness/]
  // Imports allow-list: ONLY local repair helpers (and no `@/*`, no `node:*`,
  // no `child_process`, no `Bun.spawn`). Match FULL import statements
  // (possibly multi-line) by scanning `import ... from "X"` patterns across the
  // source text.
  const IMPORT_STMT_RE = /import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g
  const FORBIDDEN_RUNTIME_RES: RegExp[] = [
    /Bun\.spawn/,
    /\brequire\s*\(/,
    /from\s+["']child_process["']/,
  ]

  const assertNoForbidden = (src: string, f: string): void => {
    for (const tok of FORBIDDEN_TOKENS) {
      expect(src.includes(tok), `forbidden token "${tok}" in ${f}`).toBe(false)
    }
    for (const re of FORBIDDEN_REGEXES) {
      expect(re.test(src), `forbidden pattern ${re} in ${f}`).toBe(false)
    }
    for (const re of FORBIDDEN_RUNTIME_RES) {
      expect(re.test(src), `forbidden runtime ${re} in ${f}`).toBe(false)
    }
  }
  const allowedImportsOf = (f: (typeof FILES)[number]): readonly string[] => {
    switch (f) {
      case "validator.ts":
      case "index.ts":
        return ["./types", "./repro-outcome"]
      case "repro-outcome.ts":
        return ["./types"]
      case "context.ts":
        return ["./types"]
    }
  }
  const assertImportsOnlyAllowed = (src: string, f: (typeof FILES)[number]): void => {
    const sources: string[] = []
    // Reset lastIndex (defensive: regex is module-scoped above).
    IMPORT_STMT_RE.lastIndex = 0
    let m: RegExpExecArray | null = IMPORT_STMT_RE.exec(src)
    while (m !== null) {
      sources.push(m[1] ?? "")
      m = IMPORT_STMT_RE.exec(src)
    }
    expect(sources.length, `no import statements found in ${f}`).toBeGreaterThan(0)
    const allowed = allowedImportsOf(f)
    for (const s of sources) {
      expect(allowed.includes(s), `${f} import source must be one of ${allowed.join(", ")}, got "${s}"`).toBe(true)
    }
  }
  for (const f of FILES) {
    test(`${f}: no forbidden tokens, imports only local repair helpers`, () => {
      const src = readFileSync(resolve(ROOT, f), "utf8")
      assertNoForbidden(src, f)
      assertImportsOnlyAllowed(src, f)
    })
  }
})

describe("repair repro-outcome SSOT", () => {
  const ROOT = resolve(__dirname, "../../src/runner/batch/eval/repair")
  const HELPER = readFileSync(resolve(ROOT, "repro-outcome.ts"), "utf8")
  const INDEX = readFileSync(resolve(ROOT, "index.ts"), "utf8")
  const VALIDATOR = readFileSync(resolve(ROOT, "validator.ts"), "utf8")
  const LOCAL_CLASSIFIER_RE = /\b(?:const|function)\s+classifyReproOutcome\b/
  const LOCAL_MARKER_RE = /\bMARKER_(?:REPRODUCED|RESOLVED|OTHER)\b/

  test("helper owns the classifier implementation", () => {
    expect(HELPER).toContain('export const MARKER_REPRODUCED = "Issue reproduced"')
    expect(HELPER).toContain('export const MARKER_RESOLVED = "Issue resolved"')
    expect(HELPER).toContain('export const MARKER_OTHER = "Other issues"')
    expect(HELPER).toContain("export const classifyReproOutcome =")
  })

  test("index and validator import the shared helper instead of redefining markers/classifier", () => {
    for (const src of [INDEX, VALIDATOR]) {
      expect(src).toContain('from "./repro-outcome"')
      expect(LOCAL_CLASSIFIER_RE.test(src)).toBe(false)
      expect(LOCAL_MARKER_RE.test(src)).toBe(false)
    }
  })
})
