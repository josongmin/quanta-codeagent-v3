# TV-15 — 보호 규칙 확인, 단계적 활성화, 문서 동기화

- 우선순위: P0
- 상태: PLANNED
- 소유자: 통합 담당
- 선행: preflight=TV-00; 활성화는 아래 barrier별 적용

## 문제와 근거

workflow에 gate가 있다는 것과 원격 branch protection이 실제 요구한다는 것은 다르다. `fc-gate.yml`은 check 이름 보존을 명시한다. tests README는 과거 361 unit files/45초를 설명해 현재 population과 맞지 않는다.

## 단계별 구현

### R0 — 읽기 전용 preflight

- 원격 repo, 기본 branch, direct push/PR 흐름, required checks/rulesets, merge queue를 확인한다.
- 현재 check 이름과 SHA 판정 기준을 기록한다. 확인할 수 없으면 remote-unverified로 남긴다.
- 원격 설정을 쓰는 단계는 별도 권한과 실행 결과를 기록하며 문서 작성 요청으로 수행하지 않는다.

### R1 — 새 경로 구현, 기존 보호 유지

- TV-01 명령을 추가하고 TV-11 새 aggregator를 병행 실행한다.
- TV-03의 local 선택기와 fallback이 준비될 때까지 hook의 빠른 경로를 활성화하지 않는다.
- staged/dirty source를 actual push commit의 검증으로 주장하지 않는다.

### R2 — 로컬 prepush 전환

- 선행: TV-01,03 focused 통과 및 실제 remote full required 확인.
- `package.json`과 hook을 같은 변경에서 전환한다.
- PR을 거치지 않는 direct push가 가능하면 로컬 축소의 회귀 위험을 명시하고 해당 branch의 검증 정책을 먼저 정한다.

### R3 — CI 집계 및 nightly 이동

- TV-11의 새 required context가 실제 PR에서 실행됨을 확인한 후 보호 규칙을 전환한다.
- 이전 context는 전환 확인 뒤 제거한다. workflow 이름만 먼저 바꾸지 않는다.
- TV-09 exhaustive의 PR 빈도 축소는 TV-03 affected-runtime 선택과 TV-13 nightly 연결 이후다.

### R4 — 선택기 승격

- shadow 비교를 먼저 수집한다. 표본은 변경 유형별로 평가한다.
- merge queue가 있을 때만 full을 merge_group으로 이동 검토한다.
- merge queue가 없으면 PR full을 유지한다. nightly green으로 대신하지 않는다.

## 수정 파일

- `package.json`, `.githooks/pre-push`, `tools/dev/gate-manifest.ts`
- `tests/README.md`, `docs/decisions/0003-test-pyramid.md` (역사적 결정은 보존하고 새 superseding 정책 링크)
- 관련 feature-catalog YAML; `docs/10.feature-catalog.md`는 build로만 생성
- gate/workflow parity, test-root enrollment, 현재 티켓 인덱스

## 파일·단계별 작업

| 단계 | 파일/외부 surface | 구체 작업 | 통과 증거 |
|---|---|---|---|
| R0 | git/GitHub read-only | `git remote get-url origin`, default branch, rulesets/branch protection, merge queue, 현재 required context를 exact repo에서 조회한다. | 조회 시각, repo, branch, check name, source URL/API response digest. |
| R1 | `package.json`, `tools/dev/gate-manifest.ts`, `tools/dev/gate.ts` | 새 tier 명령을 추가하되 기존 `prepush`, `test:ci`, required context는 유지한다. | focused tests와 script/gate parity. |
| R2 | `.githooks/pre-push`, `package.json` | hook을 `verify:prepush --base=<remoteSha> --head=<localSha>`로 원자 전환한다. 다중 ref/신규 branch/missing remote base는 full-required를 반환한다. | fake stdin ref updates와 failing child exit propagation. |
| R3 | `.github/workflows/ci.yml`, `.github/workflows/fc-gate.yml`, remote ruleset | 새 `required` check를 병행 실행하고 실제 PR 실패/취소 차단을 확인한 뒤 원격 보호를 전환한다. old context는 같은 변경에서 먼저 삭제하지 않는다. | exact PR HEAD의 checks + ruleset 재조회. |
| R4 | selection policy | 변경 유형별 shadow false-skip 0과 fallback 비율을 TV-90에서 확인한 뒤 skip authority를 제한적으로 활성화한다. | source/config/fixture/delete/rename/toolchain strata별 receipt. |
| 문서 | `tests/README.md`, 새 superseding ADR, feature YAML | 현재 명령·population·성공 의미·rollback을 갱신한다. feature catalog MD는 `bun fc build`로만 생성한다. | `bun fc validate`, build, diff 및 docs command existence. |

## 원격 변경 전후 체크리스트

1. 변경 직전 exact HEAD와 현재 required context를 다시 조회한다.
2. 새 check가 success뿐 아니라 failure/cancel/missing에서 merge를 막는지 확인한다.
3. ruleset 변경 ID와 이전 config digest를 rollback receipt에 기록한다.
4. 변경 직후 같은 branch/PR에서 required context를 재조회한다.
5. 권한 또는 merge queue가 없으면 `REMOTE_UNVERIFIED`/`NOT_APPLICABLE`로 남기고 로컬 green으로 닫지 않는다.

## 검증 계획

문서의 명령이 실제 scripts에 있고 tier별 scope가 같아야 한다. 신규 check 성공뿐 아니라 실패/취소 시 merge 차단도 검증한다. local hook이 fake failing runner exit를 보존하는지 확인한다. `bun fc validate`, `bun fc build`, `bun fc diff`는 구현 관련 YAML 수정 후 수행한다.

## 완료 기준

- [ ] local 구현 / CI 실행 / remote required 활성화가 별도 기록됨.
- [ ] old required context 제거 시 검증 공백 없음.
- [ ] 현재 scope·측정 시간으로 문서 갱신.
- [ ] branch 흐름에 맞는 prepush/full 정책 확정.
- [ ] rollback 명령·이전 config revision이 기록됨.

## 실패·복구

새 aggregator/selection이 불안정하면 old required와 full 경로를 유지한다. 성능 목표를 이유로 remote 보호를 먼저 해제하지 않는다.
