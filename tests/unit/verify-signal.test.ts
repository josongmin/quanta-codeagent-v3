import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  isTestLikeCommand,
  isVerifyOutputFailing,
  isVerifySignalCommand,
  matchesExactVerifyCommand,
  matchVerifyCommand,
  OUTCOME_FAILURE_MATCHERS,
  TEST_LIKE_RE,
  VERIFY_MATCHERS,
} from "@/agent/verify-signal"

describe("verify-signal — isTestLikeCommand / matchVerifyCommand", () => {
  // ── true positives: a real test/reproduction run is recognized. Grouped by
  //    ecosystem so a regression points at the exact matcher. ────────────────
  const POSITIVE: ReadonlyArray<[cmd: string, ecosystem: string]> = [
    ["pytest", "python"],
    ["python -m pytest tests/test_x.py", "python"],
    ["python -m unittest", "python"],
    ["tox", "python"],
    ["python test_x.py", "python"],
    ["python x_test.py", "python"],
    ["python conftest.py", "python"],
    ["python tests/runtests.py auth", "python"], // django runtests.py (has 'test')
    ["python manage.py test myapp", "python"], // django manage.py test
    ["python reproduce_bug.py", "generic"], // 'reproduce' token (generic)
    ["python repro.py", "generic"],
    ["npx jest", "js"],
    ["vitest run", "js"],
    ["npx mocha", "js"],
    ["npx playwright test", "js"],
    ["npx cypress run", "js"],
    ["npm test", "js"],
    ["pnpm test", "js"],
    ["pnpm run unit-test", "js"],
    ["yarn test", "js"],
    ["bun test", "js"],
    ["deno test", "js"],
    ["go test ./...", "go"],
    ["cargo test", "rust"],
    ["cargo nextest run", "rust"],
    ["bundle exec rspec", "ruby"],
    ["rake test", "ruby"],
    ["phpunit", "php"],
    ["dotnet test", "dotnet"],
    ["mvn verify", "jvm"],
    ["mvn test", "jvm"],
    ["./gradlew test", "jvm"],
    ["ctest", "cpp"],
    ["mix test", "elixir"],
    ["swift test", "swift"],
    ["make check", "generic"],
  ]

  for (const [cmd, ecosystem] of POSITIVE) {
    test(`recognizes "${cmd}" (ecosystem=${ecosystem})`, () => {
      expect(isTestLikeCommand(cmd)).toBe(true)
      expect(matchVerifyCommand(cmd)?.ecosystem).toBe(ecosystem)
    })
  }

  // ── true negatives: shell noise + arbitrary non-test execution. A false
  //    positive here would DEFEAT the guard (model skips real verification). ─
  const NEGATIVE: ReadonlyArray<string> = [
    "git status",
    "ls -la",
    "echo hi",
    "cat src/main.py",
    "grep -rn foo src/",
    "python manage.py runserver", // django dev server — NOT a test
    "python manage.py migrate",
    "python setup.py build",
    "python main.py",
    "node server.js",
  ]

  for (const cmd of NEGATIVE) {
    test(`does NOT recognize "${cmd}"`, () => {
      expect(isTestLikeCommand(cmd)).toBe(false)
      expect(matchVerifyCommand(cmd)).toBeNull()
    })
  }

  test("a runner name inside another word does not match (boundary)", () => {
    expect(isTestLikeCommand("ingest data")).toBe(false) // not 'jest'
    expect(isTestLikeCommand("digest the report")).toBe(false)
  })

  test("exact allowlist admits a repo-local verifier without widening the generic matcher", () => {
    const cmd = `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`
    expect(isTestLikeCommand(cmd)).toBe(false)
    expect(matchesExactVerifyCommand(cmd, [cmd])).toBe(true)
    expect(isVerifySignalCommand(cmd, [cmd])).toBe(true)
  })

  test("exact allowlist normalizes trivial whitespace drift", () => {
    const authoritative = 'node -e "process.exit(0)"'
    expect(matchesExactVerifyCommand(`  node   -e   "process.exit(0)"  `, [authoritative])).toBe(
      true,
    )
  })

  test("TEST_LIKE_RE (derived) agrees with isTestLikeCommand on every case", () => {
    for (const [cmd] of POSITIVE) expect(TEST_LIKE_RE.test(cmd)).toBe(true)
    for (const cmd of NEGATIVE) expect(TEST_LIKE_RE.test(cmd)).toBe(false)
  })

  test("registry ids are unique and patterns are case-insensitive", () => {
    const ids = VERIFY_MATCHERS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(isTestLikeCommand("PYTEST")).toBe(true)
    for (const m of VERIFY_MATCHERS) expect(m.pattern.flags).toContain("i")
  })
})

describe("verify-signal module purity", () => {
  // Pure leaf: no I/O, no clocks, no randomness, no cross-module coupling.
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "src", "agent", "verify-signal.ts"),
    "utf8",
  )

  test("imports nothing (pure leaf module)", () => {
    const importLines = source
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s*export\s+.*\bfrom\b/.test(l))
    expect(importLines).toHaveLength(0)
  })
})

describe("verify-signal — output failure detection", () => {
  test("plural non-zero errors are treated as failing output", () => {
    expect(isVerifyOutputFailing("test_runner", undefined, "1 passed, 2 errors in 0.01s")).toBe(
      true,
    )
  })

  test("zero-count summary is NOT treated as failing output", () => {
    expect(
      isVerifyOutputFailing("test_runner", undefined, "1 passed, 0 failed, 0 errors in 0.01s"),
    ).toBe(false)
  })

  test("failure matcher ids stay unique", () => {
    const ids = OUTCOME_FAILURE_MATCHERS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
