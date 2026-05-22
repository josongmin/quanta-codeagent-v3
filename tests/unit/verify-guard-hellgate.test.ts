/**
 * ★ CONTRACT — verify-guard hard-gate (ADR-0067 verification discipline).
 *   src/agent/verify-guard.ts `decideVerifyGuard` BLOCKS closeout when:
 *     (a) the session mutated code (edit/write/scripted_replace fired), AND
 *     (b) NO test-like bash command ran afterward (registry in
 *         src/agent/verify-signal.ts: pytest/bun test/npm test/go test/cargo
 *         test/jest/vitest/make test/tox/python -m pytest/... — 16+ matchers).
 *   `VERIFY_FORCE_MESSAGE` is injected as a forced continuation; the lying-
 *   command set (git status / echo / cd && ls / runserver / `true` / ...)
 *   must NOT satisfy. Negative-table loophole is the precise security boundary.
 *
 *   THIS IS THE FLAGSHIP CLAIM ("거짓-success 방지 = hard gate, not prompt").
 *   Every assertion is labeled inline: CONTRACT (gate blocks/satisfies) vs
 *   CHARACTERIZATION (exact recognizer return shape). Both halves of the
 *   lying-command table and the real-runner table use the REAL
 *   decideVerifyGuard / isTestLikeCommand / matchVerifyCommand — no
 *   reimplemented regex in tests.
 */
import { describe, expect, test } from "bun:test"
import {
  createVerifyGuardState,
  decideVerifyGuard,
  isTestLikeCommand,
  matchVerifyCommand,
  VERIFY_FORCE_MESSAGE,
} from "@/agent/verify-guard"

/**
 * D5 HELLGATE — the FLAGSHIP false-success DENY net at the pure-policy level.
 *
 * This suite is the comprehensive adversarial table. The premise: a false
 * POSITIVE (a non-test command counted as "verified") DEFEATS the guard — the
 * model ships a wrong fix. So every "looks like verification but ISN'T"
 * command, after a code edit, MUST keep the gate blocking. And every REAL
 * verification command across the supported ecosystems MUST satisfy the gate.
 *
 * We assert at the gate (`decideVerifyGuard`), not just the recognizer, so the
 * proof is about the SHIPPING decision, not an internal bool.
 */

type Item = { name: string; arg?: string }
const h = (...items: (string | Item)[]): readonly Item[] =>
  items.map((it) => (typeof it === "string" ? { name: it } : it))

/** Drive the gate for: one edit, then a single bash `cmd`, then a finish. */
const gateAfterEditThen = (cmd: string): ReturnType<typeof decideVerifyGuard> => {
  const state = createVerifyGuardState()
  return decideVerifyGuard({
    history: h("edit", { name: "bash", arg: cmd }),
    cfg: {},
    state,
  })
}

describe("D5 hellgate — LYING commands MUST keep the gate blocking", () => {
  // Every entry is a command that superficially resembles "doing something"
  // after an edit but is NOT a test/reproduction run. A false positive on any
  // of these is a flagship-breaking defeat of the guard.
  const LYING: ReadonlyArray<[label: string, cmd: string]> = [
    // status / inspection noise
    ["git status", "git status"],
    ["git diff", "git diff"],
    ["git diff --stat", "git diff --stat HEAD~1"],
    ["git log", "git log --oneline -10"],
    // lying echo
    ["echo done", "echo done"],
    ['echo "tests pass"', 'echo "tests pass"'],
    ["echo all green", "echo 'all tests pass, OK'"],
    // navigation / read noise
    ["cd src && ls", "cd src && ls"],
    ["cat result.txt", "cat result.txt"],
    ["pwd", "pwd"],
    ["ls -la", "ls -la"],
    ["grep noise", "grep -rn TODO src/"],
    // long-running servers — NOT a test
    ["django runserver", "python manage.py runserver"],
    ["django migrate", "python manage.py migrate"],
    ["npm run dev", "npm run dev"],
    ["node server.js", "node server.js"],
    ["python main.py", "python main.py"],
    ["python setup.py build", "python setup.py build"],
    // no-op commands
    ["true", "true"],
    ["colon noop", ":"],
    // comment-only / whitespace
    ["comment only", "# just a comment, nothing run"],
    ["whitespace only", "   \t  "],
    ["empty string", ""],
  ]

  for (const [label, cmd] of LYING) {
    test(`"${label}" after an edit ⇒ STILL BLOCKS (not counted as verify)`, () => {
      const r = gateAfterEditThen(cmd)
      expect(r.block).toBe(true)
      expect(r.text).toBe(VERIFY_FORCE_MESSAGE)
      // And the underlying recognizer agrees it is NOT a test/repro signal.
      // (empty/whitespace arg also fails the guard's own length check.)
      if (cmd.trim().length > 0) {
        expect(isTestLikeCommand(cmd)).toBe(false)
        expect(matchVerifyCommand(cmd)).toBeNull()
      }
    })
  }

  test("AGGREGATE: not one lying command in the table satisfies the gate", () => {
    const satisfied = LYING.filter(([, cmd]) => gateAfterEditThen(cmd).block === false)
    expect(satisfied).toEqual([])
  })
})

describe("D5 hellgate — REAL verification commands MUST satisfy the gate (13+ ecosystems)", () => {
  const REAL: ReadonlyArray<[label: string, cmd: string]> = [
    ["pytest", "pytest"],
    ["npm test", "npm test"],
    ["bun test", "bun test"],
    ["go test ./...", "go test ./..."],
    ["cargo test", "cargo test"],
    ["jest", "npx jest src/foo.test.ts"],
    ["vitest", "vitest run"],
    ["mvn test", "mvn test"],
    ["gradle test", "./gradlew test"],
    ["pytest -k", "pytest -k test_regression"],
    ["python -m pytest", "python -m pytest tests/test_x.py"],
    ["make test", "make test"],
    ["tox", "tox"],
    ["custom repro script", "python reproduce_issue_1234.py"],
  ]

  for (const [label, cmd] of REAL) {
    test(`"${label}" after an edit ⇒ does NOT block (gate satisfied)`, () => {
      const r = gateAfterEditThen(cmd)
      expect(r.block).toBe(false)
      expect(isTestLikeCommand(cmd)).toBe(true)
    })
  }

  test("AGGREGATE: every real verify command satisfies the gate", () => {
    const blocked = REAL.filter(([, cmd]) => gateAfterEditThen(cmd).block === true)
    expect(blocked).toEqual([])
  })
})

describe("D5 hellgate — gate state-machine corners", () => {
  test("multiple edits then ONE real test ⇒ satisfied (verify scans past all edits)", () => {
    const state = createVerifyGuardState()
    const r = decideVerifyGuard({
      history: h("edit", "edit", "edit", { name: "bash", arg: "pytest -q" }),
      cfg: {},
      state,
    })
    expect(r.block).toBe(false)
    expect(state.trips).toBe(0)
  })

  test("a verify BEFORE the last edit does NOT count (lying ordering)", () => {
    const state = createVerifyGuardState()
    // pytest ran, THEN another edit landed with no re-verify ⇒ must block.
    const r = decideVerifyGuard({
      history: h("edit", { name: "bash", arg: "pytest" }, "edit"),
      cfg: {},
      state,
    })
    expect(r.block).toBe(true)
  })

  test("no mutation at all (pure read session) ⇒ never blocks (no false positive)", () => {
    const state = createVerifyGuardState()
    expect(
      decideVerifyGuard({ history: h("read", "read", { name: "bash", arg: "ls" }), cfg: {}, state })
        .block,
    ).toBe(false)
    expect(state.trips).toBe(0)
  })

  test("lying-then-real: edit, git status, finish(forced), pytest ⇒ now satisfied", () => {
    const state = createVerifyGuardState()
    const first = decideVerifyGuard({
      history: h("edit", { name: "bash", arg: "git status" }),
      cfg: {},
      state,
    })
    expect(first.block).toBe(true)
    const second = decideVerifyGuard({
      history: h("edit", { name: "bash", arg: "git status" }, { name: "bash", arg: "pytest" }),
      cfg: {},
      state,
    })
    expect(second.block).toBe(false)
  })
})
