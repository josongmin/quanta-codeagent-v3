/**
 * spec-to-test generator port (ADR-0253).
 *
 * 작은 1-method closed port — `generate(spec, opts)` 를 통해 Devin-style spec
 * 을 bun:test fixture 텍스트로 변환한다. 구현은 `./default-generator.ts` 가
 * 제공하며, caller 는 항상 이 인터페이스를 통해서만 접근한다 (구체 함수에
 * 직접 의존 금지).
 *
 * - throw 없음. operational failure 는 {@link GenError} 로 surface.
 * - I/O 없음. caller 가 반환된 {@link TestFixture}.content 를 fs.write 한다.
 *
 * 슬라이스 규율: leaf port. types 만 import (`./types`). 어떤 adapter, 어떤
 * runtime, 어떤 @/shared 도 의존하지 않는다.
 */

import type { GenError, Result, Spec, TestFixture } from "./types"

/**
 * 옵션 — default-OFF 시 호출 자체가 없으므로, 옵션 또한 모두 optional.
 *
 * - `headerComment` — 생성 파일 최상단에 박을 주석 (예: ADR 출처). 없으면 생략.
 *                     트레일링 newline 은 generator 가 자동 부착.
 */
export interface GenerateOptions {
  readonly headerComment?: string
}

/**
 * The generator port. 단일 메서드 — 호출은 순수, 결정적 (같은 input → 같은
 * output, byte-identical).
 */
export interface SpecToTestGen {
  readonly generate: (spec: Spec, opts?: GenerateOptions) => Result<TestFixture, GenError>
}
