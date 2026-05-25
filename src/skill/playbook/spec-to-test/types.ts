/** biome-ignore-all lint/suspicious/noThenProperty: `then` is the canonical BDD Given-When-Then field name of the Scenario contract (ADR-0253) — renaming would break the user-facing spec shape. */
/**
 * spec-to-test generation types (ADR-0253).
 *
 * Devin Playbook의 `spec` 필드는 자동으로 test fixture 를 생성한다. quanta는
 * ADR-0203 success-criteria[]/procedure 만 선언적으로 보유 — executable test
 * 생성 흡수가 미흡했다. 이 슬라이스는 spec → bun:test fixture (assertions만)
 * 변환의 작고 닫힌 포트를 제공한다. 실 implementation 은 caller (LLM / 사람)
 * 가 채워 넣는다 — generator 는 `// TODO` placeholder 만 박는다.
 *
 * 슬라이스 규율: leaf-only types. NO imports from anywhere — pure data shape.
 * 슬라이스 posture: SELF-CONTAINED. 같은 디렉토리 안에서만 import.
 *
 * Default-OFF: nothing here is invoked unless a host calls
 * {@link SpecToTestGen.generate} explicitly. byte-identical to pre-0253 시
 * 호출이 없으면 — generator 는 순수 함수이므로 호출되지 않으면 효과가 없다.
 */

/**
 * Given-When-Then 형식 한 시나리오. Devin spec 의 한 row 에 해당한다.
 *
 * - `name`     — 시나리오 식별자 (test() 의 라벨)
 * - `given`    — precondition 자연어 (주석으로만 보존, 코드 생성 안함)
 * - `when`     — action 자연어 (주석으로만 보존, 코드 생성 안함)
 * - `then`     — 검증 예측 자연어 list. 각 항목 → 1 expect() TODO 라인
 */
export interface Scenario {
  readonly name: string
  readonly given: string
  readonly when: string
  readonly then: readonly string[]
}

/**
 * spec 전체 — describe() 블록 1개에 매핑된다.
 *
 * - `name`      — describe 라벨 (그리고 filename 의 base)
 * - `scenarios` — test() 들. 빈 배열은 reject 된다 (HELL-ST-04).
 */
export interface Spec {
  readonly name: string
  readonly scenarios: readonly Scenario[]
}

/**
 * 생성된 test fixture — text + 권장 filename. caller 가 직접 fs.write 한다
 * (generator 자체는 I/O 없음; HELL-ST-14 invariant).
 *
 * - `filename`  — `${sanitize(name)}.spec.ts` (HELL-ST-07 / HELL-ST-15)
 * - `content`   — bun:test 모듈 텍스트 (HELL-ST-08 parses)
 */
export interface TestFixture {
  readonly filename: string
  readonly content: string
}

/**
 * 생성 실패 reason — closed enum. throw 하지 않고 typed result 로 surface.
 *
 * - `empty-spec`         — scenarios 배열이 비어있다 (HELL-ST-04)
 * - `empty-name`         — spec.name 이 공백/빈 문자열
 * - `empty-scenario-name`— 어떤 scenario.name 이 공백/빈 문자열
 */
export type GenError =
  | { readonly kind: "empty-spec" }
  | { readonly kind: "empty-name" }
  | { readonly kind: "empty-scenario-name"; readonly index: number }

/**
 * 작은 Result 형태 — `@/shared` 의 일반 Result 와 호환 가능한 shape 이지만
 * 슬라이스 누수를 피하려 의도적으로 local 정의 (closed-port + zero deps).
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
