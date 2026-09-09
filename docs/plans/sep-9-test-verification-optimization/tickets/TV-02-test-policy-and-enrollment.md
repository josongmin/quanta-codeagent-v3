# TV-02 — 테스트 정책과 누락 없는 등록

- 우선순위: P0
- 상태: FOCUSED_VERIFIED
- 소유자: C
- 선행: TV-00, contracts.md

## 문제와 근거

`test-shard-plan.ts`의 classifier는 자원 충돌을 regex/path로 추정하며 비용·빈도·실제 환경 요구를 표현하지 않는다. `tests/unit`에는 real toolchain과 subprocess도 있다. 디렉터리 이름만으로 PR/nightly를 결정하면 검증이 빠진다.

## 구현 범위

1. `TestPolicy`를 기준으로 tier, runner, cost, resources, capabilities, inputScope, owner를 정한다.
2. 기본 규칙 + 명시적 override로 관리한다. 3,906개 수동 YAML을 무조건 생성하지 않는다. 한 파일의 정책은 결정적으로 하나로 resolve하고 conflict는 오류로 처리한다.
3. 파일 미분류 시 full에 포함하고 자원은 exclusive, inputScope는 whole-tree로 둔다. 신규 파일은 owner/cost 검토 필요를 표시한다.
4. 임의의 unknown source 변경은 TV-03에서 full fallback으로 연결한다.
5. Bun/Vitest/contract/PTY/live eval의 population을 모두 inventory에 연결한다. unit+integration만으로 full을 대체하지 않는다.
6. test case group 분할 시 안정적 ID와 seed/selector 목록을 보존한다. PR/nightly 그룹의 합집합과 원래 case universe를 비교한다.
7. scanner는 실제 입력 영역을 선언한다. 검증되기 전에는 always-run 범위를 유지하며 파일 이름의 ratchet 문자열만 신뢰하지 않는다.
8. 정책 버전 변경은 selection·membership·receipt에 전파한다.

## 수정 파일

- NEW: `tools/dev/test-policy.ts`, `tools/dev/test-policy-overrides.json`
- EXISTING: `tools/dev/test-shard-plan.ts`의 분류 소비부 (통합 담당)
- EXISTING TEST: `tests/unit/_arch/gated-test-scope-ratchet.test.ts`, `tests/unit/test-shard-plan.test.ts`
- NEW TEST: `tests/unit/dev/test-policy-enrollment.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/test-policy.ts` | NEW `TestPolicy`, `resolveTestPolicy`, `resolveTestPopulation`, `policyDigest` | path 기본 규칙과 override를 합성해 파일당 정확히 하나의 runner/tier/cost/resource/capability/inputScope/owner를 만든다. 미분류는 `full + exclusive + whole-tree`로 fail-wide한다. | 동일 입력의 결정성, override conflict, unknown file fallback을 검증한다. |
| `tools/dev/test-policy-overrides.json` | NEW schema v1 | 예외만 기록한다. 각 항목은 exact path 또는 검증된 pattern, reason, owner, expiry(임시 예외일 때)를 가진다. | 존재하지 않는 path, 중복 match, 빈 owner를 reject한다. |
| `tools/dev/test-shard-plan.ts` | `TEST_RESOURCE_CLASSES`, `classifyTestResource`, `resourceClassesOverlap` | 기존 regex classifier를 policy resolver의 compatibility adapter로 바꾼다. resource class와 실행 빈도는 별도 필드로 유지한다. | 기존 resource fixtures의 결과 보존 + unknown exclusive 검증. |
| `tests/unit/_arch/gated-test-scope-ratchet.test.ts` | population scan | 실제 discovery 결과와 policy-resolved 결과의 set equality를 검사하고 anti-vacuum floor를 baseline에 고정한다. | 신규 test를 policy에서 제거한 mutation이 해당 파일로 RED여야 한다. |
| `tests/unit/dev/test-policy-enrollment.test.ts` | NEW | Bun/Vitest/contract/PTY/web/eval fixture를 모두 넣고 runner mismatch와 tier 공백을 검사한다. | table-driven exhaustive test. |

## 작업 순서

1. `TestPolicy` schema와 safe default를 고정한다.
2. 현재 classifier 결과를 snapshot fixture로 만들고 resolver를 연결한다.
3. 모든 현재 population을 resolve한 뒤 conflict/unknown 목록을 TV-00 evidence에 남긴다.
4. enrollment ratchet의 red-on-injection self-test를 추가한다.
5. policy digest를 TV-03/04/06 receipt 계약에 연결한다.

## 검증 계획

- synthetic population에 unknown test를 추가하면 full/exclusive/whole-tree가 선택되는지 검증.
- 중복 override, 존재하지 않는 ID, runner mismatch, tier 없음은 실패.
- 전체 discovery 집합과 정책 resolve 집합이 정확히 일치.
- 주입한 미등록 contract/web test가 inventory 검사에서 실패.
- 관련 기존 gate: `bun test tests/unit/_arch/gated-test-scope-ratchet.test.ts tests/unit/test-shard-plan.test.ts`

## 완료 기준

- [ ] 모든 runner population이 소유자를 가진다.
- [ ] unknown이 빠른 lane으로 자동 승격되지 않는다.
- [ ] 자원 격리와 실행 비용이 별도 축이다.
- [ ] policy 변경 시 receipt identity가 달라진다.

## 실패·복구

분류 정확성에 문제가 있으면 exclusive/full 기본값으로 복귀한다. 분류 비율을 개선하려고 임의로 pure를 늘리지 않는다.
