# SEP9-TV — 테스트 검증 비용 최적화 실행 티켓

- 감사일: 2026-09-09 / 최초 티켓 작성: 2026-09-10 / 구조 캠페인 갱신: 2026-09-11 (KST)
- 상태: IMPLEMENTING — 기존 focused rail과 shadow matrix 코드는 착륙했지만 resource certification, lease 세분화, tier별 exact file membership, hosted activation/receipt가 열려 있다. current private-repository plan에서 ruleset/branch-protection API는 HTTP 403이고 최신 Actions도 0-step 실패다. authoritative full 캠페인은 재개하지 않았다.
- 고정 증거: [evidence/baseline-94073ffa6415.json](../evidence/baseline-94073ffa6415.json), [evidence/known-failures.md](../evidence/known-failures.md), [evidence/remote-protection-r0.json](../evidence/remote-protection-r0.json), [evidence/open-gaps.md](../evidence/open-gaps.md)
- 현재 full population digest: `c5ec263c9c83e7ce82d48f10854ddae56cca7bd55ee47456bb3a9e1308bc3a71` (3,924 files; 2026-09-11 local discovery-only snapshot)
- 현재 계획 기준 HEAD: `4fd84e7f2f809b5ff53772a29e91cb26cc991e17`; `origin/main=dba37472ec70acad1a38721a50a0693583333cd3`로 로컬 `main`이 15 commits 앞선다.
- 요청: 기존 장시간 검증 중단 후 smoke / prepush / PR / nightly 체계와 최적화 작업을 구체적으로 기록.
- 현재 실행 제약: full / prepush / test:ci 캠페인은 중단 상태를 유지한다. 이 문서의 명령은 향후 구현·검증 명세이며 지금 실행하라는 지시가 아니다.
- 기존 W7의 미해결 실패·외부 실행 증거는 이 계획으로 완료 처리하지 않는다.

## 목표와 범위

로컬 반복 검증 비용을 줄이고 CI에서 전체 검증을 병렬화한다. 검증 범위, 입력, 실행 정책이 다른 결과를 같은 성공으로 재사용하지 않는다. 런타임 기능 수정, 유료 EC2/LLM 실행, 원격 보호 규칙 변경은 문서 작성 완료에 포함하지 않는다.

이 패킷은 실행 계획의 단일 인덱스다. 아래 티켓의 상태를 갱신하고 인덱스도 같은 변경에서 갱신한다. `contracts.md`는 공통 인터페이스를 정의하며 각 티켓은 이를 구현·소비한다. 제안된 파일·명령은 명시적으로 NEW/PROPOSED로 표시한다.

각 TV 티켓에는 구현 범위 외에 파일·심볼/job별 변경 로직, owner-local 회귀 rail, 작업 순서, 완료/복구 조건이 있다. 구현자는 자신의 티켓에 적힌 신규 sibling 파일과 테스트를 소유하고, 아래 공유 파일은 통합 담당에게 patch 요구를 넘긴다.

## 관측 근거와 한계

| 항목 | 감사 시점 관측 | 해석 |
|---|---|---|
| full manifest | 3,906 files / 40 chunks | 기준 스냅샷 값; 미래에는 정확한 집합과 추가·삭제 이유를 검증 |
| 자원 분류 | pure 2,998 / non-pure 908 | 현행 regex/path 분류 결과; 격리 보증이 아님 |
| timing store | 3,866 files, 합 약 1,422초 | 서로 다른 실행의 추정 weight; 정상 머신 wall-time 아님 |
| 최근 캠페인 | 2,494,512ms / 41분 34초, SIGINT 종료 | 전체 통과 receipt 아님 |
| 머신 | 16 CPU, 시작 load 120.41 / 종료 139.69 | 과부하 실행이므로 성능 목표 산정의 정상 baseline으로 사용 금지 |
| 캠페인 결과 | exit 130, drained=true, survivingGroups=[] | 프로세스 정리 확인; 테스트 통과를 의미하지 않음 |
| 실패 | chunk 16, bench-full-remote-hellgate의 access-token 전달 assertion | owner-local 재현 후 G-F5 readiness mock 공백이 원인. quarantine 금지. 캐시-off full 캠페인 영수증 아님 |
| 작업 트리 | 감사 당시 clean | 실행 착수 전 다시 확인 |

### 2026-09-11 current-HEAD 구조 스냅샷

`run-test-shards --discover-only`와 현재 classifier를 read-only로 실행한 값이다. timing 값은 2026-09-09 v1 store의 오래된 scheduling weight이므로 현재 wall-time 증거로 사용하지 않는다.

| 항목 | 현재 값 | 남은 의미 |
|---|---:|---|
| full/core/unit/integration | 3,924 / 3,534 / 3,210 / 390 files | 모든 tier manifest의 current population 기준 |
| pure | 3,012 | 현재 intra-worker 병렬화 허용 |
| integration-path | 558 | 경로 fallback; 파일별 자원 격리 인증 전에는 직렬 유지 |
| lsp / port / process-global | 206 / 62 / 55 | 단일 class 이름이 아니라 실제 resource key/mode로 세분화 필요 |
| browser / worktree / repo-write | 12 / 17 / 2 | 배타성 유지; checkout/git-common/cache 경계 분리 필요 |
| shadow matrix | plan/worker/aggregate 코드와 조건부 workflow 존재 | `QUANTA_SHADOW_MATRIX=1` hosted receipt 없음; required는 `full-suite` 소비 |
| tier membership | committed-HEAD discovery: PR/full 3,924, nightly 3,927 | `--tier`/policy digest와 hosted PR job 연결, Biome reach·conflict-fuzz remainder·bench matrix 물리 분리; 나머지 capability migration은 진행 중 |

## 현재 남은 구조 캠페인

| 순서 | 소유 티켓 | 작업 | 활성화 barrier | 성능 효과 |
|---:|---|---|---|---|
| 0 | TV-07, TV-13 | timing v2 재기준화, nightly Bun `1.3.14` 고정 | schema/pin 구현 완료; healthy-load sample open | 잘못된 hot-file 우선순위 제거 |
| 1A | TV-02, TV-08 | 558개 integration-path source-digest resource certification | authority/audit 완료; 현재 missing 558, candidate claim 124, 미인증/만료는 exclusive | full/integration 내부 병렬성 |
| 1B | TV-09, TV-13 | smoke/prepush/PR/full/nightly exact file membership | tier wiring + 첫 nightly file 완료; 나머지는 hosted artifact 전 PR coverage 제거 금지 | PR file load/setup 직접 감소 |
| 2 | TV-08 | checkout/git-common/cache/host resource lease 세분화 | canonical multi-key primitive 완료; campaign 전환은 1/2/4 동등 verdict와 충돌 0 이후 | 다중 세션 대기 감소 |
| 3 | TV-12 | 4-worker shadow matrix live 실행·단일 full과 exact 비교 | exact HEAD hosted receipt | hosted full wall 감소 |
| 4 | TV-11, TV-15 | Actions 복구 및 required/branch protection 활성화 | private repo plan 또는 visibility 결정 | merge enforcement |
| 5 | TV-90 | healthy-load ABBA와 authoritative full/nightly 1회 | 위 barrier 완료 및 full 재개 승인 | 최종 정확성·성능 receipt |

1A와 1B는 별도 파일에서 병렬 개발할 수 있다. `test-policy.ts`, `gate-manifest.ts`, `run-test-shards.ts`, workflow 같은 공유 surface는 통합 담당이 순차 병합한다. resource certification 없이 lease만 풀거나, nightly hosted receipt 없이 PR membership을 줄이는 변경은 금지한다.

원본 관측은 `.git/quanta-verification-cache/last-campaign.json`, `test-timings-v1.json`, `.cache/full-junit.xml.shard-16.xml`에서 수집했다. 이 파일들은 가변·로컬 캐시이며 영구 증거가 아니다. TV-00에서 필요한 비밀정보 없는 요약을 고정한다.

주요 코드: `tools/dev/gate-manifest.ts`, `gate.ts`, `verification-campaign.ts`, `run-test-shards.ts`, `test-shard-plan.ts`, `test-shard-receipt.ts`, `test-shard-timings.ts`, `verify-scope.ts`, `.github/workflows/ci.yml`.

## 최종 tier 계약

| 명령 (PROPOSED) | 범위 | 초기 목표 | 성공의 의미 |
|---|---|---|---|
| `verify:smoke` | strict replay + critical canaries + 변경 파일 lint | warm p95 ≤60초 / cold ≤120초 | 명시된 smoke 집합 통과 |
| `verify:prepush` | static + affected tests + 필수 scanners + 관련 runtime canaries | warm p95 ≤180초 / cold ≤300초 | 해당 diff의 로컬 검증 통과 |
| `verify:pr` | 초기에는 전체 deterministic + contract, CI job 병렬화 | required critical path p95 ≤12분 | PR 검증 스냅샷 전체 통과 |
| `verify:full` | 현재 전체 population의 명시적 authoritative 실행 | 정상 CI 측정 후 예산 확정 | 해당 suite/HEAD/policy 전체 통과 |
| `verify:nightly` | cache-off full + 전체 PTY·toolchain·fuzz·stress | 전용 CI 45분 목표 / 60분 예산 | 예정된 nightly population 실행 완료 |
| 별도 live eval | 유료 provider/LLM/SWE-bench | 별도 비용·시간 한도 | 제품 품질 평가; merge-green 아님 |

목표 시간은 달성 수치가 아니다. 초과 시 테스트를 생략하거나 PASS로 처리하지 않는다. cold/warm, queue/setup/run을 따로 측정하며 broad-impact fallback은 일반 변경 시간 목표의 별도 집단으로 보고한다.

`verify:merge`는 merge queue가 실제 존재할 때 `verify:full`을 호출하는 선택적 alias다. PR과 merge에서 동일 full을 무조건 두 번 실행하도록 설계하지 않는다. merge queue가 없으면 PR full required를 유지한다.

## 전체 작업 목록

| ID | 우선순위 | 소유 경계 | 선행 | 상태 |
|---|---|---|---|---|
| [TV-00](TV-00-baseline-and-inventory.md) | P0 | 기준 증거·미해결 실패 기록 | 없음 | INTEGRATED |
| [TV-01](TV-01-tier-runner-and-local-hook.md) | P0 | tier 실행·명령·fail-fast | 00 | FOCUSED_VERIFIED |
| [TV-02](TV-02-test-policy-and-enrollment.md) | P0 | test policy·tier/resource 등록 | 00 | IMPLEMENTING — base policy green, explicit enrollment open |
| [TV-03](TV-03-affected-selection.md) | P1 | 변경 영향 선택·fallback | 01,02 | FOCUSED_VERIFIED |
| [TV-04](TV-04-cache-policy-and-cold-mode.md) | P0 | 캐시 정확성·JUnit·cache-off | 00 | FOCUSED_VERIFIED |
| [TV-05](TV-05-declared-input-cache.md) | P1 | 제한된 입력 범위 캐시 | 02,04 | FOCUSED_VERIFIED |
| [TV-06](TV-06-stable-shard-membership.md) | P1 | 안정적 청크·완전성 | 02,04 | FOCUSED_VERIFIED |
| [TV-07](TV-07-performance-observability.md) | P1 | 타이밍·비용 관측 | 00,04 | IMPLEMENTING — v2/rebaseline open |
| [TV-08](TV-08-admission-and-resource-isolation.md) | P0/P1 | resource certification / 자원 lease | 01,02,04,07 | IMPLEMENTING — certification/lease split open |
| [TV-09](TV-09-heavy-test-decomposition.md) | P1 | exact tier membership·중량 테스트 분할 | 02; 활성화는 03,13 | IMPLEMENTING — Git/bench split and CLI lazy load done; toolchain split open |
| [TV-10](TV-10-static-scan-and-setup-reuse.md) | P1 | 중복 scan·preload·setup | 02 | FOCUSED_VERIFIED |
| [TV-11](TV-11-ci-jobs-and-required-check.md) | P0 | CI job DAG·집계 context | 01 | IMPLEMENTING — hosted activation blocked |
| [TV-12](TV-12-ci-shard-matrix.md) | P1 | 분산 청크·artifact 집계 | 04,06,11 | IMPLEMENTING — shadow code, no live receipt |
| [TV-13](TV-13-nightly-and-toolchain-lanes.md) | P1 | nightly·환경 matrix | 02,04,11; matrix는 12 | IMPLEMENTING — stress wired, hosted receipt open |
| [TV-14](TV-14-flake-and-quarantine.md) | P2 | 실패 분류·quarantine | 02,11 | FOCUSED_VERIFIED |
| [TV-15](TV-15-rollout-and-documentation.md) | P0 | 보호 규칙 확인·명령 활성화·문서 | 단계별 01,03,09,11,13 | IMPLEMENTING |
| [TV-90](TV-90-performance-and-closeout.md) | P1 | 최종 성능·정확성·종결 | 00–15 | IMPLEMENTING |

우선순위는 실행 순서이며 취약점 심각도 등급이 아니다. TV-08의 lease 분할은 대기 통합과 별도 단계로 관리한다.

## 병렬 실행과 직렬 통합

동시 활성 슬롯 4개: 통합 담당 1명 + 구현 담당 최대 3명.

1. 통합 담당이 TV-00과 공통 계약을 고정한다.
2. 1차 병렬: A=TV-01, B=TV-04, C=TV-02/TV-09의 별도 신규 canary 파일.
3. 2차 병렬: A=TV-03, B=TV-06/TV-07, C=TV-10. runner 공유 파일은 통합 담당이 순차 적용한다.
4. 3차 병렬: A=TV-11/TV-12, B=TV-05, C=TV-13/TV-14. workflow 파일도 한 작성자만 수정한다.
5. TV-08 대기 예산 통합은 runner 변경 사이 직렬 통합한다. lease 분할은 격리 증거 이후 별도 적용한다.
6. TV-15의 활성화 barrier와 TV-90의 승인된 측정을 직렬 수행한다.

공유 파일 단일 작성자: `package.json`, `.githooks/pre-push`, `gate-manifest.ts`, `gate.ts`, `run-test-shards.ts`, `test-shard-plan.ts`, `test-shard-receipt.ts`, `.github/workflows/ci.yml`, gate parity 및 generated catalog. 담당자는 sibling 모듈·별도 테스트에서 작업하고 공유 파일 변경 요구를 통합 담당에게 전달한다. 같은 파일을 여러 작업이 동시에 수정하지 않는다.

공유 파일의 repo-relative 경로는 각각 `tools/dev/gate-manifest.ts`, `tools/dev/gate.ts`, `tools/dev/run-test-shards.ts`, `tools/dev/test-shard-plan.ts`, `tools/dev/test-shard-receipt.ts`다. 구현 patch는 티켓 ID별로 분리하고 공유 파일에는 동시에 하나의 patch만 적용한다.

## 공통 검증·종결 규칙

- 상태 흐름: PLANNED → IMPLEMENTING → FOCUSED_VERIFIED → INTEGRATED → ACTIVE_VERIFIED → CLOSED. 코드 완료와 운영 활성화 완료를 분리한다.
- 모든 티켓은 아래 테스트를 자동 실행하라는 지시가 아니다. 중단된 full 캠페인을 계획 작성 중 재시작하지 않는다.
- 구현 시 가장 작은 회귀 테스트부터 실행한다. 전체 실행은 TV-90에서 승인된 한 캠페인으로 통합한다.
- 테스트 새 파일은 해당 runner population에 등록한다. 문서의 경로만 존재하는 것은 실행 증거가 아니다.
- static guard를 추가하면 실제 call/구조 매칭, non-empty floor, 결함 주입 시 RED를 요구한다.
- touched 기능 catalog YAML을 갱신하고 `bun fc validate`, `bun fc build`, `bun fc diff`를 수행한다. generated MD 직접 수정 금지. 문서-only 계획 작성에는 catalog 재생성 불필요.
- schema·runner·selector 변경은 기존 receipt와 버전 분리한다. 이전 green이 새 tier 전체 검증으로 승격되지 않는다.
- 원격 check/ruleset 변경, 실제 CI 실행, 비용 발생 실행은 각각 실행 근거를 기록한다. 현재 요청의 산출물은 이 티켓 패킷이다.
- 상세 공통 타입·fallback·receipt는 [contracts.md](contracts.md)를 따른다.
