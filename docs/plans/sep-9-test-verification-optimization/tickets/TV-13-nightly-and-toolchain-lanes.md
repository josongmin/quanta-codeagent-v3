# TV-13 — nightly, 실제 도구체인, cold 검증

- 우선순위: P1
- 상태: IMPLEMENTING — Bun pin/tier wiring/hosted PR binding/Biome nightly file focused green; 추가 capability lanes와 hosted receipt 미완료
- 소유자: CI 담당 / toolchain fixture 담당
- 선행: TV-02, TV-04, TV-11
- matrix 확장 선행: TV-12

## 문제와 근거

real-toolchain이 로컬 prepush에 포함돼 upstream clone·native build를 매번 실행할 수 있다. 기존 nightly eval workflow도 있으므로 중복 예약을 만들면 전체 비용이 증가한다. 현행 prepush:cold는 shard-cache bypass가 아니다.

2026-09-11 현재 `NIGHTLY_MEMBERSHIP.includes`는 `cache-off-full-suite`, `exhaustive-fuzz`, `exhaustive-static-oracles`를 포함한다. conflict fuzz는 PR 6-seed와 nightly-only 54-seed entrypoint로 물리 분리됐고, `QUANTA_TEST_STRESS=1`은 아직 이동하지 않은 다른 heavy branch에 남아 있다. nightly workflow의 Bun은 CI와 같은 `1.3.14`로 고정됐고 parity rail이 있다. 다만 workflow는 단일 job이며 최근 hosted nightly는 0-step 실패하여 uncached execution receipt가 없다.

## 구현 범위

1. 기존 ci schedule, agent-nightly-regression, grounding-live schedule의 범위를 조사하고 새 nightly 중복 실행을 제거한다.
2. `verify:nightly`는 test-result cache=off full을 실제 실행한다. dependency cache 사용 여부는 별도로 기록한다.
3. full PTY, fuzz/stress, browser/daemon, Python/Node/Go/Rust/LSP/debugger를 capability별 job으로 나눈다.
4. Linux를 기본으로 하고 macOS/Windows는 실제 지원해야 할 capability를 명시한 matrix로 둔다. 현재 지원되지 않는 adapter를 skipped green으로 증명하지 않는다.
5. 필수 toolchain은 준비 단계에서 확인한다. 부재 시 required lane blocked/fail, 사전 정의한 unsupported capability만 별도 표시한다.
6. Astropy base/proof rematerialization cold 검증을 유지한다. 빈도와 timeout은 별도 heavy budget으로 관리하고 실패 시 환경 설치와 제품 assertion을 구별한다.
7. expensive fixture의 dependency 환경은 lockfile+upstream SHA+ABI로 준비한다. candidate 변경을 숨기는 editable artifact 재사용은 금지한다.
8. live LLM/유료 API/EC2는 일반 nightly deterministic job에 자동 포함하지 않는다. 별도 명시된 budget·credential·실행 정책이 필요하다.
9. nightly failure는 owner와 issue로 연결하고 지나간 green을 최신 증거로 표시하지 않는다. cache correctness 실패는 TV-05 재사용을 중단하는 신호다.
10. TV-09의 exhaustive 그룹을 nightly에 먼저 연결한 뒤 PR 빈도를 줄인다.
11. `.github/workflows/verification-nightly.yml`의 Bun을 CI authority와 같은 `1.3.14`로 고정하고 parity guard를 추가한다. latest 비교는 별도 non-required compatibility lane으로만 둔다.
12. exhaustive case를 `*.nightly.test.ts` file membership으로 이동해 PR/full/nightly exact manifest를 구분한다.

## 수정 파일

- NEW: `.github/workflows/verification-nightly.yml`
- EXISTING: `.github/workflows/ci.yml`, 관련 nightly workflow의 중복 trigger
- `package.json`, `tools/dev/gate-manifest.ts` (통합 담당)
- `tests/unit/project-env-astropy-real-e2e.test.ts` 및 real-e2e entrypoints

## 파일·job별 작업

| 파일 | 심볼/job | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `.github/workflows/verification-nightly.yml` | existing nightly job; follow-up `plan`, `deterministic-full-cold`, capability matrix, `aggregate` | Bun `1.3.14`를 고정하고 schedule+workflow_dispatch에서 `cache=off` result execution을 강제한다. dependency cache 상태는 worker envelope에 별도 기록한다. | CI/nightly Bun parity와 schedule/dispatch policy manifest equality. |
| `.github/workflows/agent-nightly-regression.yml` 및 기존 schedule workflows | trigger inventory | 목적이 겹치는 fuzz/stress/toolchain step은 새 workflow와 owner를 비교해 하나만 예약한다. 유료/live lane은 이동하지 않고 별도 유지한다. | 동일 gate ID가 같은 schedule에서 두 번 계획되면 실패. |
| `package.json`, `tools/dev/gate-manifest.ts` | `verify:nightly`, nightly membership | exhaustive test IDs와 capability groups를 manifest로 노출한다. `verify:nightly`는 TV-04 cache-off를 전달한다. | argv와 manifest parity. |
| `tests/unit/project-env-astropy-real-e2e.test.ts` | `D`, `ASTROPY_13033`, `runRepro`, `expectNoBuildCollapse` | real Astropy case를 `python-native-build` capability에 등록하고 base repro와 candidate proof artifact를 각각 남긴다. assertion을 mock으로 바꾸지 않는다. | missing Python/build tool은 setup failure, product mismatch는 assertion failure. |
| workflow capability probe | Bun/Node/Python/Go/Rust/LSP/debugger | required tool의 exact version/ABI를 receipt에 기록한다. 미지원 OS만 manifest의 `not-selected`가 가능하다. | 필수 binary 누락이 PASS/skipped가 아닌 failure. |

## 작업 순서

1. 모든 기존 schedule과 gate ID를 read-only inventory한다.
2. nightly manifest와 capability matrix를 코드로 생성한다.
3. deterministic cold, PTY, toolchain, exhaustive 그룹을 별도 job으로 연결한다.
4. duplicate schedule detector와 capability failure test를 통과시킨다.
5. nightly artifact가 실제 생성되기 전 TV-09의 PR coverage를 줄이지 않는다.
6. exact file membership 분리 후 `PR ∪ nightly` case universe와 기존 case inventory의 equality를 검증한다.
7. hosted Actions가 실제 steps를 실행한 뒤 cache-off/nightly receipt를 수집하고 PR membership 축소 barrier를 해제한다.

## 검증 계획

스케줄/dispatch별 선택 manifest를 비교한다. fake capability probe에서 필수 도구 누락이 not-selected나 PASS가 되지 않아야 한다. cache-off는 TV-04의 fake worker counter로 먼저 확인한다. 실제 도구 설치·full matrix는 승인된 TV-90 실행에서 확인한다.

## 완료 기준

- [ ] nightly exhaustive population과 owner가 명시됨.
- [ ] 실제 uncached 실행 receipt 있음.
- [ ] setup/run/cleanup 및 toolchain fingerprint 기록.
- [ ] 동일 nightly 목적의 중복 실행 없음.
- [ ] 유료 eval과 deterministic 검증의 결과·비용 구분.
- [x] CI/nightly Bun version parity; `latest`가 required/nightly authority에 없음.
- [ ] PR/full/nightly file manifests가 동일 파일 내부 skip이 아니라 exact entrypoint로 분리됨.

## 실패·복구

nightly 연결이 실패하면 PR coverage 축소를 활성화하지 않는다. cache correctness 문제는 관련 cache scope를 비활성화하고 원인을 기록한다.
