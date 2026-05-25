# ADR-0253: Devin playbook spec → bun:test fixture auto-generation

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0203 (user-authored playbook frontmatter — provides `successCriteria[]` declarative + `procedure[]`), ADR-0241 (playbook auto-dispatch — same slice canonical sink), ADR-0211 (mode-variant registry — playbook orchestrator host)
- **References**:
  - `src/skill/playbook/spec-to-test/port.ts` (1-method closed port `SpecToTestGen.generate`)
  - `src/skill/playbook/spec-to-test/types.ts` (`Spec` / `Scenario` / `TestFixture` / `GenError` / `Result`)
  - `src/skill/playbook/spec-to-test/default-generator.ts` (pure spec → bun:test text)
  - `src/skill/playbook/spec-to-test/index.ts` (slice barrel)
  - `tests/unit/skill/playbook/spec-to-test-hellgate.test.ts` (15 cases)
  - `tools/feature-catalog/features/01-agent-loop/253-spec-to-test-gen-devin.yaml`

## Context

Devin Playbook의 `spec` 필드는 자동으로 bun:test fixture 를 생성해 caller (LLM / 사람) 가 implementation 만 채우면 되는 TDD-first 워크플로우를 제공한다. quanta 는 ADR-0203 에서 `successCriteria[]` 와 `procedure[]` 를 **선언적**으로만 받았고, 이를 **실행 가능한 test code** 로 자동 변환하는 슬라이스가 미흡수 상태였다.

흡수해야 하는 핵심은 **변환 자체** (spec → bun:test text) 이며, 그 외 부수 책임(파일 쓰기, 워크스페이스 통합, 자동 dispatch) 은 **caller** 가 owns 한다.

## Decision

### MVP scope (의도적으로 좁힘)

`spec` → bun:test 모듈 텍스트 1개. 다음은 의도적으로 **포함하지 않음**:
- 파일 시스템 쓰기 (HELL-ST-14 — pure invariant)
- 자동 dispatch / watcher 통합 (ADR-0241 가 별도 슬라이스로 다룸)
- assertion 자동 추론 (caller 가 `// TODO` placeholder 를 채움 — HELL-ST-09)
- procedure → test 변환 (success-criteria 만; procedure 는 dispatch 가 owns)

### 슬라이스 구조 (4 파일, leaf-only)

- **types.ts** — `Spec { name, scenarios }`, `Scenario { given, when, then[] }`, `TestFixture { filename, content }`, `GenError` closed enum (`empty-spec` / `empty-name` / `empty-scenario-name`), local `Result<T,E>` (zero deps)
- **port.ts** — `SpecToTestGen { generate(spec, opts): Result<TestFixture, GenError> }` 1-method closed port + `GenerateOptions { headerComment? }`
- **default-generator.ts** — pure `generateImpl(spec, opts?)`; `defaultSpecToTestGen` const + `generateSpecTest` convenience export
- **index.ts** — barrel (types + port + impl만)

### 핵심 invariant 7개

1. **default-OFF** — generator 호출 자체가 없으면 byte-identical (HELL-ST-10)
2. **순수성** — 같은 입력 → 같은 출력, no I/O, no global state (HELL-ST-10, HELL-ST-14)
3. **closed-port** — `SpecToTestGen` interface 통해서만 접근. 구체 함수는 convenience export 로만 노출
4. **no-throw** — 모든 operational failure 는 `Result<_, GenError>` 로 surface
5. **escape-safe** — 모든 자연어 라벨은 `JSON.stringify` slice 로 직렬화 → 큰따옴표/백슬래시/제어문자/유니코드 안전 (HELL-ST-05, HELL-ST-11)
6. **parses-clean** — 생성된 코드는 `new Bun.Transpiler({loader:"ts"}).scan()` 로 검증 (HELL-ST-08)
7. **fails-by-default** — placeholder `expect(undefined).toBe("TODO: ...")` — caller 가 채우기 전까지 호출은 통과하지 않음 (HELL-ST-09)

### 생성 형식

```typescript
// optional header (헤더 comment)

import { describe, expect, test } from "bun:test"

describe("${spec.name}", () => {
  test("${scenario.name}", () => {
    // Given: ${scenario.given}
    // When: ${scenario.when}
    expect(undefined).toBe("TODO: ${scenario.then[0]}")
    expect(undefined).toBe("TODO: ${scenario.then[1]}")
  })
})
```

`given` / `when` 이 multiline 이면 첫 줄은 `// Given:` head, 나머지는 `//   <line>` 형식으로 보존 (HELL-ST-06). `then[]` 이 비면 1 smoke comment 만 박힘, 0 expect (HELL-ST-13).

### filename sanitize 정책 (HELL-ST-15)

`/[^A-Za-z0-9_]/g → "-"` → leading/trailing `-` trim → `-+` collapse → empty 면 `"spec"` 폴백. 결과 + `.spec.ts`. 한글 등 비-ASCII identifier 는 sanitize 단계에서 `-` 로 치환되므로 `한글` → `spec.spec.ts` 폴백이 정상이며, `describe()` label 은 원문 유지.

## Hellgate

`tests/unit/skill/playbook/spec-to-test-hellgate.test.ts` — 15 cases, 43 expect():

- HELL-ST-01 단일 scenario → 1 test()
- HELL-ST-02 3 scenarios → 3 test()
- HELL-ST-03 then[] 3 개 → 3 expect()
- HELL-ST-04 empty scenarios → Err("empty-spec")
- HELL-ST-05 special chars (큰따옴표 / 백슬래시) escape
- HELL-ST-06 multiline given/when → `// `-prefixed lines
- HELL-ST-07 filename = `${name}.spec.ts`
- HELL-ST-08 Bun.Transpiler.scan 으로 syntax 검증
- HELL-ST-09 generated test fails by default (TODO placeholder mismatch)
- HELL-ST-10 default-OFF byte-identical (idempotent)
- HELL-ST-11 utf-8 한글 scenario name 보존
- HELL-ST-12 50 scenario 성능 sanity (<50ms)
- HELL-ST-13 then[] 빈 배열 허용 → 0 expect, smoke test only
- HELL-ST-14 generator 순수 — tmpdir entry 집합 불변
- HELL-ST-15 filename sanitize — special chars → `-`, 폴백 `spec`

## Configurable knobs

- `GenerateOptions.headerComment?: string` — 생성 파일 최상단 주석 (예: ADR 출처). 없으면 헤더 라인 자체가 없음.

## Default-OFF invariants

- generator 함수 호출이 없으면 효과 없음 (순수 함수)
- caller 가 fs.write 를 호출하지 않으면 파일이 생기지 않음 (HELL-ST-14)
- 어떤 host 도 자동 호출 안 함 — 이 슬라이스는 명시적 caller 가 import 해서 써야만 의미가 있음

## Consequences

- ADR-0203 success-criteria 가 executable test fixture 로 변환 가능해짐 — Devin Playbook spec→test 갭 봉합
- 이후 슬라이스가 `playbook.successCriteria` → `spec.scenarios` adapter 를 추가해 자동 fixture 생성 워크플로우를 완성할 수 있음 (이 ADR scope 외)
- caller (LLM / 사람) 가 TODO placeholder 를 채우는 TDD-first 워크플로우 — quanta 의 ADR 우선 + hellgate-RED-먼저 패턴과 정합
- 슬라이스가 leaf 라 후속 흡수 (예: `prosperity-criterion`, `mutation-testing-hint`) 이 같은 디렉토리에 부담 없이 사이드킥 추가 가능
