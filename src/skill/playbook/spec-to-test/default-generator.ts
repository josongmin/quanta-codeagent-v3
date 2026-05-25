/**
 * Default spec→bun:test generator (ADR-0253).
 *
 * Pure, deterministic, dependency-free. 같은 input → 같은 output (byte-identical).
 * I/O 없음 — 모든 결과는 {@link TestFixture} text 로 반환되고 caller 가
 * 직접 파일에 write 한다 (HELL-ST-14).
 *
 * 생성된 코드:
 *   1. bun:test 모듈로 parse 가능해야 한다 (HELL-ST-08).
 *   2. 호출 시 기본 fail 상태여야 한다 — `expect(undefined).toBe("TODO")`
 *      형태로 caller 가 채우기 전까지 통과하지 않는다 (HELL-ST-09).
 *   3. then[] 이 비면 그 test 는 0 expect (smoke test) — describe 안의
 *      그 자리만 빈 body 가 되며, 호출은 통과한다 (HELL-ST-13).
 *
 * Escape policy (HELL-ST-05):
 *   - 모든 자연어 라벨은 JSON.stringify 로 직렬화된 후 surrounding 큰따옴표를
 *     벗겨 본문에 삽입한다. 큰따옴표/백슬래시/제어문자 모두 안전하게 escape.
 *
 * Multiline (HELL-ST-06):
 *   - given/when 의 줄바꿈은 `// `prefix 가 붙은 여러 라인으로 보존된다.
 *
 * Filename sanitize (HELL-ST-15):
 *   - alphanumeric + `_` 만 유지, 그 외는 `-` 로 치환. trim leading/trailing `-`.
 *   - 결과가 공백이면 `spec` 으로 폴백 (절대 빈 파일명을 만들지 않는다).
 *   - 한글 등 비-ASCII 식별자는 sanitize 에서 `-` 로 치환되지만,
 *     `describe()` 라벨은 원문을 그대로 유지한다 (HELL-ST-11).
 */

import type { GenerateOptions, SpecToTestGen } from "./port"
import type { GenError, Result, Scenario, Spec, TestFixture } from "./types"

const INDENT = "  "

/** JSON-string escape, but stripping surrounding quotes — safe for inline string-literal injection. */
function escapeForStringLiteral(s: string): string {
  const json = JSON.stringify(s)
  return json.slice(1, json.length - 1)
}

/** Sanitize an arbitrary label into a safe filename stem. */
function sanitizeFilenameStem(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_]/g, "-")
  const trimmed = replaced.replace(/^-+|-+$/g, "").replace(/-+/g, "-")
  return trimmed.length > 0 ? trimmed : "spec"
}

/** Render multi-line natural-language fragment as `// `-prefixed comment lines. */
function asCommentLines(label: string, body: string, indent: string): string {
  const lines = body.split(/\r?\n/)
  if (lines.length === 1) {
    return `${indent}// ${label}: ${lines[0]}\n`
  }
  const head = `${indent}// ${label}:\n`
  const rest = lines.map((l) => `${indent}//   ${l}\n`).join("")
  return head + rest
}

function renderThenExpect(thenText: string, indent: string): string {
  const escaped = escapeForStringLiteral(thenText)
  // Default-fail placeholder: `undefined` vs string literal — caller MUST replace.
  return `${indent}expect(undefined).toBe("TODO: ${escaped}")\n`
}

function renderScenario(sc: Scenario): string {
  const nameLit = escapeForStringLiteral(sc.name)
  const body: string[] = []
  if (sc.given.length > 0) {
    body.push(asCommentLines("Given", sc.given, INDENT.repeat(2)))
  }
  if (sc.when.length > 0) {
    body.push(asCommentLines("When", sc.when, INDENT.repeat(2)))
  }
  for (const t of sc.then) {
    body.push(renderThenExpect(t, INDENT.repeat(2)))
  }
  // When body is empty (no given/when/then) we still need a syntactically valid
  // test body — emit just a single line comment so `test(() => { /* ... */ })` parses.
  if (body.length === 0) {
    body.push(`${INDENT.repeat(2)}// smoke: no scenarios provided\n`)
  }
  return `${INDENT}test("${nameLit}", () => {\n${body.join("")}${INDENT}})\n`
}

function validate(spec: Spec): Result<true, GenError> {
  if (spec.name.trim().length === 0) {
    return { ok: false, error: { kind: "empty-name" } }
  }
  if (spec.scenarios.length === 0) {
    return { ok: false, error: { kind: "empty-spec" } }
  }
  for (let i = 0; i < spec.scenarios.length; i += 1) {
    const sc = spec.scenarios[i]
    if (!sc || sc.name.trim().length === 0) {
      return { ok: false, error: { kind: "empty-scenario-name", index: i } }
    }
  }
  return { ok: true, value: true }
}

function renderHeader(opts: GenerateOptions | undefined): string {
  const headerComment = opts?.headerComment
  if (!headerComment || headerComment.trim().length === 0) {
    return ""
  }
  const lines = headerComment.split(/\r?\n/)
  return `${lines.map((l) => `// ${l}\n`).join("")}\n`
}

function generateImpl(spec: Spec, opts?: GenerateOptions): Result<TestFixture, GenError> {
  const v = validate(spec)
  if (!v.ok) {
    return v
  }
  const nameLit = escapeForStringLiteral(spec.name)
  const header = renderHeader(opts)
  const importLine = `import { describe, expect, test } from "bun:test"\n`
  const describeOpen = `describe("${nameLit}", () => {\n`
  const scenarioBlocks = spec.scenarios.map((sc) => renderScenario(sc)).join("\n")
  const describeClose = `})\n`
  const content = `${header + importLine}\n${describeOpen}${scenarioBlocks}${describeClose}`
  const filename = `${sanitizeFilenameStem(spec.name)}.spec.ts`
  return { ok: true, value: { filename, content } }
}

/**
 * The default generator port implementation. Stateless, safe to share.
 */
export const defaultSpecToTestGen: SpecToTestGen = {
  generate: (spec, opts) => generateImpl(spec, opts),
}

/**
 * Convenience: same as `defaultSpecToTestGen.generate(spec, opts)` — exported
 * so adapters and tests can call without going through the port object when
 * the port indirection is unnecessary.
 */
export function generateSpecTest(
  spec: Spec,
  opts?: GenerateOptions,
): Result<TestFixture, GenError> {
  return generateImpl(spec, opts)
}
