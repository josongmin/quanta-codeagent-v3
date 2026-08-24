/** biome-ignore-all lint/suspicious/noThenProperty: `then` is the canonical BDD Given-When-Then field name of the Scenario contract (ADR-0253) — renaming would break the user-facing spec shape. */
/**
 * Hellgate — spec-to-test generator (ADR-0253).
 *
 * 15 cases pinning the spec→bun:test fixture contract:
 *
 *   - HELL-ST-01  단일 scenario → 1 test()
 *   - HELL-ST-02  3 scenarios → 3 test()
 *   - HELL-ST-03  then[] 3 개 → 3 expect()
 *   - HELL-ST-04  empty scenarios → Err("empty-spec")
 *   - HELL-ST-05  special chars in name → escape
 *   - HELL-ST-06  multiline given/when → preserve as comment
 *   - HELL-ST-07  filename = `${name}.spec.ts`
 *   - HELL-ST-08  generated code parses (no syntax error) via Bun.Transpiler
 *   - HELL-ST-09  generated test fails by default (TODO placeholder)
 *   - HELL-ST-10  default-OFF byte-identical (idempotent across calls)
 *   - HELL-ST-11  utf-8 한글 scenario name
 *   - HELL-ST-12  50 scenario 성능 sanity (<50ms)
 *   - HELL-ST-13  Scenario.then 빈 배열 허용 → 0 expect, smoke test 만
 *   - HELL-ST-14  generator 순수 — no I/O (isolated TMPDIR + cwd stays empty)
 *   - HELL-ST-15  filename sanitize — special chars → `-`
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultSpecToTestGen,
  generateSpecTest,
  type Scenario,
  type Spec,
} from "@/skill/playbook/spec-to-test"

/** Resolved here so the child driver imports the SAME module this file does. */
const GEN_MODULE = Bun.resolveSync("@/skill/playbook/spec-to-test", import.meta.dir)

function asOk<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${JSON.stringify(r.error)}`)
  return r.value
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: "noop",
    given: "an empty state",
    when: "the action is invoked",
    then: ["the result is success"],
    ...overrides,
  }
}

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    name: "my-feature",
    scenarios: [makeScenario()],
    ...overrides,
  }
}

describe("spec-to-test generator hellgate (ADR-0253)", () => {
  test("HELL-ST-01: single scenario produces exactly 1 test() block", () => {
    const out = asOk(generateSpecTest(makeSpec()))
    const matches = out.content.match(/\btest\(/g) ?? []
    expect(matches.length).toBe(1)
    expect(out.content).toContain('describe("my-feature"')
  })

  test("HELL-ST-02: 3 scenarios produce 3 test() blocks", () => {
    const spec = makeSpec({
      scenarios: [
        makeScenario({ name: "case-a" }),
        makeScenario({ name: "case-b" }),
        makeScenario({ name: "case-c" }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    const matches = out.content.match(/\btest\(/g) ?? []
    expect(matches.length).toBe(3)
    expect(out.content).toContain('test("case-a"')
    expect(out.content).toContain('test("case-b"')
    expect(out.content).toContain('test("case-c"')
  })

  test("HELL-ST-03: then[] of 3 items emits 3 expect() lines in that scenario", () => {
    const spec = makeSpec({
      scenarios: [
        makeScenario({
          name: "triple-then",
          then: ["alpha", "beta", "gamma"],
        }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    const matches = out.content.match(/\bexpect\(/g) ?? []
    expect(matches.length).toBe(3)
    expect(out.content).toContain('"TODO: alpha"')
    expect(out.content).toContain('"TODO: beta"')
    expect(out.content).toContain('"TODO: gamma"')
  })

  test("HELL-ST-04: empty scenarios yields Err('empty-spec')", () => {
    const res = generateSpecTest({ name: "x", scenarios: [] })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error.kind).toBe("empty-spec")
  })

  test("HELL-ST-05: special chars in name are escaped (double-quote, backslash)", () => {
    const spec = makeSpec({
      name: 'has "quote" and \\backslash',
      scenarios: [makeScenario({ name: 'tricky "name" \\' })],
    })
    const out = asOk(generateSpecTest(spec))
    // Escaped sequences appear inside the source literal — describe label must
    // contain the JSON-escaped form so the resulting source parses cleanly.
    expect(out.content).toContain('describe("has \\"quote\\" and \\\\backslash"')
    expect(out.content).toContain('test("tricky \\"name\\" \\\\"')
  })

  test("HELL-ST-06: multiline given/when preserved as `// ` comment lines", () => {
    const spec = makeSpec({
      scenarios: [
        makeScenario({
          name: "multi",
          given: "line one\nline two\nline three",
          when: "act one\nact two",
          then: ["t1"],
        }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    expect(out.content).toContain("// Given:")
    expect(out.content).toContain("//   line one")
    expect(out.content).toContain("//   line two")
    expect(out.content).toContain("//   line three")
    expect(out.content).toContain("// When:")
    expect(out.content).toContain("//   act one")
    expect(out.content).toContain("//   act two")
  })

  test("HELL-ST-07: filename uses sanitized name + .spec.ts suffix", () => {
    const out = asOk(generateSpecTest(makeSpec({ name: "my-feature" })))
    expect(out.filename).toBe("my-feature.spec.ts")
  })

  test("HELL-ST-08: generated code parses without syntax error (Bun.Transpiler)", () => {
    const spec = makeSpec({
      name: "parse-check",
      scenarios: [
        makeScenario({ name: "case-1", then: ["a", "b"] }),
        makeScenario({
          name: 'case-with "quotes"',
          given: "multi\nline\ngiven",
          when: "act",
          then: ["one", "two"],
        }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    // Bun.Transpiler.scan throws on syntax errors. If this returns at all,
    // the generated source is syntactically valid TypeScript.
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    expect(() => transpiler.scan(out.content)).not.toThrow()
  })

  test("HELL-ST-09: generated tests fail by default — TODO placeholders never match", () => {
    const spec = makeSpec({
      scenarios: [makeScenario({ then: ["foo", "bar"] })],
    })
    const out = asOk(generateSpecTest(spec))
    // The default-fail invariant: every expect compares `undefined` to a
    // string literal beginning with "TODO:" — guaranteed mismatch until the
    // caller (LLM / human) replaces both sides with real values.
    const expectMatches = out.content.match(/expect\(undefined\)\.toBe\("TODO: [^"]+"\)/g) ?? []
    expect(expectMatches.length).toBe(2)
  })

  test("HELL-ST-10: default-OFF byte-identical — same input yields identical content", () => {
    const spec = makeSpec({
      scenarios: [
        makeScenario({ name: "a", then: ["x"] }),
        makeScenario({ name: "b", then: ["y", "z"] }),
      ],
    })
    const first = asOk(defaultSpecToTestGen.generate(spec))
    const second = asOk(defaultSpecToTestGen.generate(spec))
    const third = asOk(generateSpecTest(spec))
    expect(second.content).toBe(first.content)
    expect(third.content).toBe(first.content)
    expect(second.filename).toBe(first.filename)
  })

  test("HELL-ST-11: utf-8 한글 scenario name is preserved in describe/test labels", () => {
    const spec = makeSpec({
      name: "한글-기능",
      scenarios: [
        makeScenario({
          name: "성공 케이스",
          given: "사전조건",
          when: "동작",
          then: ["결과 확인"],
        }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    expect(out.content).toContain('describe("한글-기능"')
    expect(out.content).toContain('test("성공 케이스"')
    expect(out.content).toContain("// Given: 사전조건")
    expect(out.content).toContain("// When: 동작")
    expect(out.content).toContain('"TODO: 결과 확인"')
    // generated code must still parse despite non-ASCII identifiers in strings.
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    expect(() => transpiler.scan(out.content)).not.toThrow()
  })

  test("HELL-ST-12: 50-scenario spec generates within 50ms (perf sanity)", () => {
    const scenarios: Scenario[] = []
    for (let i = 0; i < 50; i += 1) {
      scenarios.push(
        makeScenario({
          name: `s-${i}`,
          then: [`r1-${i}`, `r2-${i}`, `r3-${i}`],
        }),
      )
    }
    const spec: Spec = { name: "perf-50", scenarios }
    const start = performance.now()
    const out = asOk(generateSpecTest(spec))
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)
    const testCount = (out.content.match(/\btest\(/g) ?? []).length
    expect(testCount).toBe(50)
  })

  test("HELL-ST-13: empty then[] → 0 expect, smoke test only (still parses)", () => {
    const spec = makeSpec({
      scenarios: [
        makeScenario({
          name: "smoke-only",
          given: "",
          when: "",
          then: [],
        }),
      ],
    })
    const out = asOk(generateSpecTest(spec))
    const expectCount = (out.content.match(/\bexpect\(/g) ?? []).length
    expect(expectCount).toBe(0)
    expect(out.content).toContain('test("smoke-only"')
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    expect(() => transpiler.scan(out.content)).not.toThrow()
  })

  test("HELL-ST-14: generator is pure — it writes NOTHING, checked in an isolated process", async () => {
    // This used to snapshot the SHARED OS tmpdir before and after the call and
    // fail if a new entry appeared. With ~2,900 test files creating temp
    // directories on the same machine, a new entry appearing between the two
    // `readdirSync` calls is a matter of luck, not of the generator doing I/O —
    // the test could only pass by chance, and it did fail a full-suite run for
    // exactly that reason. Its own comment already conceded the problem and
    // half-mitigated it by tolerating SHRINKAGE, which does not help: the race
    // that matters is a concurrent CREATE.
    //
    // So the observation is made attributable instead. A child process gets a
    // private `TMPDIR` and a private `cwd` that nothing else on the machine
    // knows about, calls both generator entry points, and the directory is then
    // asserted empty. Anything the generator wrote — to `os.tmpdir()`, to a
    // cwd-relative path, or to a nested directory it created — lands there and
    // nowhere else. That is strictly STRONGER than the old check (which watched
    // only tmpdir) and it cannot be perturbed by a concurrent test.
    const sandbox = mkdtempSync(join(tmpdir(), "spec-to-test-purity-"))
    try {
      const driver = join(sandbox, "driver.ts")
      writeFileSync(
        driver,
        [
          `import { defaultSpecToTestGen, generateSpecTest } from ${JSON.stringify(GEN_MODULE)}`,
          "const scenario = (name: string, then: string[]) => ({",
          '  name, given: "g", when: "w", then,',
          "})",
          "const spec = {",
          '  name: "purity", description: "d",',
          '  scenarios: [scenario("x", ["a", "b", "c"]), scenario("y", ["d"])],',
          "}",
          "const a = generateSpecTest(spec as never)",
          "const b = defaultSpecToTestGen.generate(spec as never)",
          'if (!a.ok || !b.ok) throw new Error("generator refused a valid spec")',
        ].join("\n"),
        "utf8",
      )
      const run = Bun.spawnSync(["bun", "run", driver], {
        cwd: sandbox,
        env: { ...process.env, TMPDIR: sandbox },
        stdout: "pipe",
        stderr: "pipe",
      })
      // Anti-vacuity: if the child never ran, an empty directory proves nothing.
      expect({ code: run.exitCode, stderr: run.stderr.toString().slice(0, 500) }).toEqual({
        code: 0,
        stderr: "",
      })
      // The driver is the ONLY thing that may be in there.
      expect(readdirSync(sandbox).sort()).toEqual(["driver.ts"])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("HELL-ST-15: filename sanitize — special chars collapse to `-`, fallback to `spec`", () => {
    const out1 = asOk(generateSpecTest(makeSpec({ name: "abc/def\\ghi:jkl mno" })))
    // `/`, `\`, `:`, space all → `-`, runs collapse to single `-`.
    expect(out1.filename).toBe("abc-def-ghi-jkl-mno.spec.ts")

    const out2 = asOk(generateSpecTest(makeSpec({ name: "한글이름" })))
    // Non-ASCII identifier sanitizes to all-`-`, trimmed → fallback `spec`.
    expect(out2.filename).toBe("spec.spec.ts")

    const out3 = asOk(generateSpecTest(makeSpec({ name: "---trim-me---" })))
    expect(out3.filename).toBe("trim-me.spec.ts")
  })
})
