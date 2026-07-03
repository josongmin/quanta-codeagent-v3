# Phase 8 — 안정성 · 문서 · 게이트

## 기능 / 왜

- (기능) 공개 API shape 스냅샷 게이트 + version + README + hellgate e2e(second-consumer proof).
- (왜) 내부 리팩터가 소비자 표면 안 깨게(어딧 C 연장). headless와 동급의 계약 증명.

## Tasks

8.1 **API shape 스냅샷 테스트** `tests/unit/sdk/public-surface.test.ts` — `src/sdk/index.ts`의 export 키 집합을 스냅샷/화이트리스트로 핀. 추가·제거 시 의도적 갱신 강제.
8.2 **version export** — `export const version` (package.json에서 유도). semver 정책 주석.
8.3 **README** `docs/plans/jul-4-sdk-embed-dx/USAGE.md` — runnable 10줄 hello-analysis + 프로파일/툴/테스트 예제.
8.4 **hellgate e2e** `tests/integration/sdk-consumer-contract.test.ts` — **최상위 RED**: 공개 문(`quanta-codeagent/sdk`)만 import해서 fake-driven 분석 세션 1회 완주(툴 주입→호출→outcome). headless `enter-plan-mode-consumer-contract.test.ts` 패턴.

## Hellgate

- 8.4가 Phase 1 착수 전 RED로 먼저 존재(공개 문 없음 → red). 전 phase가 이걸 green으로 미는 것을 북극성으로.
- 적대 어딧 R1-3(최종, 전체 표면): (a) 문서 예제가 실제 컴파일되는지(doctest), (b) 스냅샷이 타입 export까지 커버, (c) fence+누수 회귀 종합.

## Acceptance

- [ ] sdk-consumer-contract.test green(공개 문만으로 완주).
- [ ] public-surface 스냅샷 green.
- [ ] USAGE.md 예제 tsc 통과.

## Files

- `tests/unit/sdk/public-surface.test.ts`, `tests/integration/sdk-consumer-contract.test.ts` (신설)
- `src/sdk/version.ts` (신설)
- `docs/plans/jul-4-sdk-embed-dx/USAGE.md` (신설)
