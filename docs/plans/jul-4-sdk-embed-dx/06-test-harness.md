# Phase 6 — 결정론 테스트 하네스

## 기능 / 왜

- (기능) `fakeLlm(script)` + `RecordingStream`을 공개 문에서 export.
- (왜) 소비자가 네트워크·비용 없이 통합 테스트. 없으면 CI가 실 LLM 때려 flaky+과금. 이미 존재([fake-llm.ts](../../../src/apps/headless/fake-llm.ts), [fake-deps.ts](../../../src/apps/headless/fake-deps.ts))지만 headless slice 내부라 외부 미노출.

## Tasks

6.1 **`fakeLlm` 재수출** — `src/sdk/testing.ts`. headless의 `FakeLlm`을 sdk-owned로 승격(또는 re-export). 주의(어딧 G): headless는 `apps/*`라 sdk가 직접 import하면 fence 위반 → **FakeLlm 코어를 sdk/testing로 이동**하고 headless가 sdk에서 소비하도록 역전(또는 공용 `@/llm/testing`으로 하강).
6.2 **`RecordingStream` 재수출** — 이벤트 시퀀스 assert용. StreamPort 구현.
6.3 **`fakeLlm(script)` 팩토리** — `FakeCompletion[]` 스크립트 → `LLMPort`. 툴콜 스크립팅 지원(멀티턴 테스트).

## Hellgate

- RED: `testing.test.ts` — `createAnalysisAgent({ llm: fakeLlm([...]) })`가 네트워크 0으로 스크립트대로 재생.
- 적대 어딧 R1-3: (a) fence(sdk가 apps import 안 함 — 6.1 이동으로 해소), (b) 스크립트 소진 후 동작, (c) 툴콜 왕복 스크립팅 정확성.

## Acceptance

- [ ] 공개 문만으로 네트워크 없는 멀티턴 테스트 작성 가능.
- [ ] boundary.slice.test 여전히 green(fence 유지).

## Files

- `src/sdk/testing.ts` (신설), FakeLlm/RecordingStream 코어 이동(`src/llm/testing/` or `src/sdk/testing/`)
- `tests/unit/sdk/testing.test.ts` (신설)
- `src/apps/headless/**` (이동된 fake 소비처 갱신)
