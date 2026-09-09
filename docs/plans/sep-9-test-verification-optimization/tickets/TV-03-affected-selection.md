# TV-03 — 변경 영향 선택과 full fallback

- 우선순위: P1
- 상태: FOCUSED_VERIFIED
- 소유자: A
- 선행: TV-01, TV-02
- 소비자: local prepush, PR early feedback, TV-05 cache 입력 분석

## 문제와 근거

`verify-scope.ts`는 transitive import와 이름 기반 global scanner를 계산해 경로만 출력한다. staged set이 기본이고 base/head 삭제·rename, 설정·fixture·동적 실행의 영향 계약이 부족하다. 이 결과를 그대로 merge 판정에 연결하지 않는다.

## 구현 범위

1. `--base=<sha> --head=<sha> --json` (PROPOSED)와 명시적 working/staged 모드를 구분한다.
2. base/head 양쪽 그래프를 이용해 삭제·rename·barrel 변경의 영향을 합친다. computed import, side-effect import, alias 변경을 보수적으로 처리한다.
3. package/lock/bunfig/tsconfig/preload/selector/runner 변경은 full fallback으로 연결한다.
4. fixture, docs/ADR, source scanner, subprocess entrypoint는 TV-02 input/resource 정책으로 연결한다. 불명확하면 full.
5. changed tests + reachable consumers + mandatory scanners + affected runtime canaries를 중복 제거하고 이유를 기록한다.
6. unknown base/clone depth 부족/git 실패/partial parsing은 성공한 empty set으로 반환하지 않는다.
7. frontend 테스트를 Bun으로 보내지 않고 runner별로 실행 계획을 분리한다.
8. 로컬부터 적용한다. PR에서는 full을 계속 실행하고 selected와 full 실패를 비교하는 shadow receipt를 저장한다.
9. PR 수만으로 승격하지 않는다. global config, 삭제/rename, fixture, barrel, toolchain 등 변경 유형별 증거와 mutation 검증을 TV-90에서 평가한다.

## 수정 파일

- EXISTING: `tools/dev/verify-scope.ts`
- NEW: `tools/dev/verification-selection.ts`, `tests/unit/dev/verification-selection.test.ts`
- EXISTING TEST: `tests/unit/verify-scope-derivation.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verify-scope.ts` | `buildVerificationGraph`, `deriveVerificationScope`, `VERIFICATION_GRAPH` | process-global graph를 snapshot 입력으로 계산 가능한 함수로 추출한다. base/head 각각의 file text와 path set으로 graph를 만들 수 있게 하고 기존 working-tree CLI는 adapter로 남긴다. | 기존 `verify-scope-derivation` fixture 결과 보존. |
| `tools/dev/verification-selection.ts` | NEW `SelectionMode`, `deriveVerificationSelection`, `SelectionReason`, `FullFallbackReason` | `git diff --name-status -z <base>..<head>`를 parse하고 A/M/D/R을 양쪽 graph에 적용한다. 결과는 runner별 selected set, reasons, mandatory set, fallback 상태를 포함한다. | rename/delete/barrel/fixture/global config/missing-base table test. |
| `tools/dev/verify-scope.ts` CLI | `--base`, `--head`, `--working`, `--staged`, `--json` | mode를 상호 배타적으로 parse한다. parse/git 실패는 non-zero + `fullRequired=true`; empty success로 바꾸지 않는다. | CLI subprocess test에서 JSON schema와 exit code를 함께 검사한다. |
| `tools/dev/test-policy.ts` | `inputScope`, capabilities 소비 | scanner·fixture·subprocess·frontend 항목을 selection에 전달한다. unsupported dynamic edge는 full fallback이다. | Bun/Vitest runner 혼선이 없는지 검증한다. |

## 작업 순서

1. graph builder의 filesystem 접근을 adapter 뒤로 이동시킨다.
2. NUL-delimited diff parser와 base/head snapshot loader를 추가한다.
3. selection reason/fallback union을 정의하고 JSON serializer를 만든다.
4. synthetic repo mutation test를 먼저 통과시킨다.
5. local dry-run만 연결하고 PR skip authority는 shadow 결과가 쌓일 때까지 비활성으로 둔다.

## 검증 계획

`bun test tests/unit/verify-scope-derivation.test.ts`

새 synthetic repo 회귀: transitive helper 수정, .json fixture 수정, 삭제된 module, rename, named/star barrel, computed import, 변경된 다른 test를 읽는 scanner, unsupported extension, missing base. 기대 결과는 정확한 선택 또는 명시적 full fallback이다. 실제 CLI가 JSON reason과 exit status를 일관되게 반환하는 작은 통합 테스트를 추가한다.

## 완료 기준

- [ ] 단순 변경에서 불필요한 전체 실행을 줄임.
- [ ] 새/삭제된 입력을 조용히 놓치지 않음.
- [ ] selected/not-selected의 합집합이 전체 정책 universe와 일치.
- [ ] full 실행 금지 상태에서는 full-required를 반환하며 실행하지 않음.
- [ ] PR full 비교 기록이 존재하며 아직 증명하지 않은 skip을 authoritative로 사용하지 않음.

## 실패·복구

selection 결함이면 full fallback으로 전환한다. fallback 비용은 별도 보고하며 임의 상한으로 테스트를 잘라내지 않는다.
