# SEP12-TVH — 테스트 검증 안전성·속도 정상화 티켓

- 감사 기준: 2026-09-12 KST
- 기준 HEAD: `85a99bb6f424bfd5640714aea1752fad1d33269a`
- 기준 base: `origin/main=309917d5ffab002f0fabddf90a060e77baa7c0d2`
- snapshot: local `main` ahead 3 / behind 0. 감사 시작 시 code tree는 clean이었고 현재 이 ticket directory만 untracked다.
- 증거 종류: 정적 코드 감사, discovery-only 및 side-effect 없는 pure/read-only probe 결과. current-HEAD full/prepush/nightly 실행 receipt는 없다.
- 실행 제약: 이 티켓 작성 과정에서는 full, prepush, `test:ci`, test shard를 실행하지 않았다.

## 결론

현재 장시간 검증의 원인은 단순히 테스트 수가 많은 것이 아니다. 빠른 tier가 실제로 분리되지 않았고, prepush가 real toolchain/upstream clone/network install/PTY/contract를 모두 포함하며, scheduler의 resource·timing·receipt 구조가 구현된 정책을 실제 실행에 사용하지 않는다. 일부 테스트에는 실 metadata endpoint 접근, 실제 사용자 `~/Library` 노출, 무제한 child process, capability 부재를 PASS로 기록하는 결함도 있다. 별도로 manifest의 precommit gate 수가 runner 하한보다 작아 실제 gate 실행이 첫 gate 전에 거부되는 current-HEAD P0 drift도 있다.

현재 authority 값:

| 항목 | 값 | 의미 |
|---|---:|---|
| prepush / PR / full membership | 각 3,928 files, 동일 digest | 세 tier가 이름만 다르고 파일 집합이 동일 |
| gate ownership floor | precommit actual 8 / pinned floor 10 | `--list`는 검사를 우회하지만 실제 실행 경로는 gate 1 전에 종료하도록 구현됨 |
| required producer universe | expected-ID equality 없음 | `QUANTA_REQUIRED_NEEDS`에 success row 하나만 있어도 pure aggregator는 PASS; workflow에서 producer+needs 동시 삭제를 탐지하지 못함 |
| lifecycle `ps` dependency | timeout 없는 sync `ps` | RSS watchdog과 TERM→KILL drain이 `ps` hang 시 함께 정지; 정상 70초 drain도 group당 약 1,400회 spawn 가능 |
| nightly membership | 3,934 files | 물리적으로 분리된 nightly 파일은 6개뿐 |
| integration-path | 561 files | certification 0, 모두 fallback |
| resource policy mismatch | 356 files | policy resource와 실제 source classifier 결과 불일치 |
| non-pure chunks | 20 | 현재 서로 완전 직렬 |
| full plan | 3,934 files / 44 chunks | `targetChunkCount`는 검증만 되고 실제 membership에는 반영되지 않음 |
| pure bucket headroom | 최대 158 / ceiling 160 | 같은 hash bucket에 3개 추가되면 전체 plan 중단 가능 |
| timing v2 | 없음 | 모든 파일을 1,000ms fallback으로 계획 |
| shard receipt v3 | 없음 | current-HEAD cache/실행 증거 없음 |
| scan population | 192 scan IDs / 253,199 path visits | 55개 파일의 대형 scan이 process-local cache를 반복 구매 |
| compiled probes | ordinary unit/full에서 5 builds | `bun build --compile` 산출물을 공유하지 않음 |
| runner output spool | 크기/디스크 상한 없음 | 출력이 계속 늘면 hang이 progress로 간주되고 종료 시 전체 로그를 메모리로 다시 읽음 |
| wall-time assertion 후보 | ordinary test 정적 후보 130 sites | 기능 검증과 host-performance 판정이 섞여 load-induced rerun 가능 |
| resilient retry | parsed failure마다 직렬 1회, `-t` zero-match면 file 전체 1회 추가 | 동일 파일의 다수 실패가 중복 Bun process와 전체 파일 rerun으로 증폭 |
| ambient ignored scratch | 현재 workspace `tools/dev/.scratch` 4,437 files / 132MiB | `test:clean-js`의 무제한 `find tests tools`가 ignored corpus까지 매번 순회; repository HEAD 소유 데이터는 아님 |
| confirmed temp leaks | 최소 20 mkdtemp callsites / 8 ordinary files | 현 guard는 exit-hook만 검사하고 mkdtemp↔finally cleanup pairing을 보지 않음 |
| nested admission waits | 최대 3m campaign + 10m shard + 3m quiet gate | 상위 deadline을 지우고 각 계층이 budget을 새로 만들어 sustained-load에서 실행 전 최대 16분 idle |
| exact prepush receipt | 오래된 다른 HEAD, 만료 | current HEAD 증거로 사용 불가 |

## 실행 순서와 barrier

| 순서 | 티켓 | 목적 | 활성화 barrier |
|---:|---|---|---|
| 0 | TVH-01 | 사용자 상태/네트워크/절대경로 안전 결함 제거 | 다른 성능 작업보다 먼저 착륙 |
| 1 | TVH-02 | smoke/prepush/PR/full/nightly 의미와 명령 정상화 | membership accounting + red-on-injection |
| 2 | TVH-07 P0 slice | bounded process observer·identity-safe kill | `ps` hang/unknown injection bounded, unrelated kill 0 |
| 3 | TVH-06 P0 slice | required expected producer set·TTL/base context | missing producer/extended TTL/moved base injection RED |
| 4 | TVH-03 | real toolchain/capability lane 분리 | capability receipt와 pinned fixture |
| 5 | TVH-04 | resource certification과 scheduler 연결 | 561개 전수 처리, conflict canary 0 |
| 6 | TVH-05 | timing/cache 구조 정상화 | healthy-load v2 표본과 cache incoherence tests |
| 7 | TVH-06/07 remainder | receipt·child lifecycle 전체 정상화 | wrong-suite/path/capability RED, survivor 0 |
| 8 | TVH-08 | heavy/skip/temp hygiene 정리 | PR canary와 nightly exhaustive universe equality |
| 9 | TVH-09 | hosted matrix를 required로 승격 | monolith와 exact verdict equality receipt |
| 10 | TVH-11 | discovery/module-load probe 비용 제거·가시화 | module-load external effect 0, bounded shared probe |
| 11 | TVH-12 | scan/build/gate producer 중복 제거 | producer receipt와 consumer exact-input parity |
| 12 | TVH-13 | memory/output/disk resource envelope | peak·spool·disk admission과 bounded retention |
| 13 | TVH-14 | top-level verification DAG와 lifecycle | dependency-aware critical path, per-gate deadline |
| 14 | TVH-15 | wall-clock flake·random stress 제거 | deterministic seed/clock와 measurement lane 분리 |
| 15 | TVH-10 | 문서·성능 closeout | clean current-HEAD ABBA/full/nightly receipts |

TVH-02와 TVH-03의 파일별 분리, TVH-11의 probe helper, TVH-12의 각 producer 전환은 병렬 개발할 수 있다. `package.json`, `tools/dev/gate-manifest.ts`, `tools/dev/run-test-shards.ts`, `.github/workflows/ci.yml`은 공유 surface이므로 통합 담당이 순차 병합한다. TVH-04 이전에 lease를 풀거나 TVH-06/09 이전에 required authority를 바꾸지 않는다.

## 완료 정의

- `verify:smoke`, prepush, PR, full, nightly가 서로 다른 exact membership과 성공 의미를 가진다.
- gate manifest의 exact ID/stage 검증이 list와 execution 양쪽에서 동일하며 현재 manifest가 self-consistent하다.
- ordinary prepush에는 upstream clone/build, unpinned package install, live local model inference가 없다.
- 모든 capability 부재는 `passed`가 아니라 `skipped-capability`, `blocked`, `failed-setup` 중 하나로 기록된다.
- resource claims가 scheduler와 lease의 실제 입력이며 미인증/드리프트는 exclusive fallback이다.
- cache identity와 receipt가 exact file set, tier, policy, capability, input scope를 증명한다.
- 모든 child process에는 total wall deadline, process-group kill, drain, temp cleanup이 있다.
- watchdog/drain의 process observation 자체도 bounded·failure-aware하며 `unknown`을 종료/부재와 혼동하지 않는다.
- test file module load에는 browser/network/install/compile/daemon side effect가 없고 discovery 시간이 별도 계측된다.
- full-tree scan, feature catalog load, lint-debt, compiled probe는 exact-input producer가 한 번 수행하고 검증된 receipt/artifact를 소비한다.
- worker admission은 CPU뿐 아니라 predicted peak RSS, temp/spool disk, output budget을 함께 만족한다.
- top-level gates도 bounded lifecycle과 dependency/resource DAG를 사용하며 기능 test의 host wall-clock assertion은 measurement lane과 분리된다.
- retry/quarantine 경로는 shard scheduler를 우회하지 않고 최초 실패를 보존하며 bounded deduplicated diagnosis만 수행한다.
- cleanup/discovery 비용은 ignored ambient workspace 크기나 중첩 suite walk 수에 비례하지 않는다.
- required matrix와 단일 full의 current-HEAD verdict equality 및 hosted artifact가 있다.
- required aggregator는 expected producer ID exact set과 capability별 executed floor를 검증하고 missing/skip/zero-case green을 거부한다.
- 성능 수치는 healthy-load current-HEAD ABBA에서만 확정한다.

---

## 착륙 로그 (2026-09-12, local main)

`85a99bb6f` 이후 110 커밋 (`280300e5e` 기준 측정; 동시 세션 커밋 포함). 각 항목은 측정치와 red-on-injection을
커밋 메시지에 담고 있다. 아래 표는 1~16번 묶음만 나열하며, 이후 커밋은 섹션별로 이어진다 —
"42"는 표에 적힌 행 수도 아니고 실제 커밋 수도 아니었다.

### 1~16 — P0와 tier 분리

| 커밋 | 내용 |
|---|---|
| `151040786` | gate ownership floor drift — **모든 gate 명령이 HEAD에서 죽어 있었다** (precommit 8 vs floor 10). exact `(id, stage)` 계약으로 교체, list/run 공통 validator |
| `49d86642b` | worker HOME의 `~/Library` 전면 대여 → browser chunk로 한정 |
| `831d032b2` | suite floor(pre-selection) ↔ tier floor(post-selection) 분리, `--parallel=1` no-op 거부, 오해를 고정하던 가드 executor별 분리 |
| `14348d545` | required aggregator가 producer **개수**만 보던 것 → SSOT/needs/workflow 3-way exact 비교 |
| `fbb536f62` | capability lane이 실행 증명을 발행(JUnit→`capability-result.v1`), contract argv drift 해소, parity guard 구조 결함 2건 |
| `52044ab1f` | discovery 4회 중복 walk → 1 snapshot projection (ABBA median 124ms→45ms) |
| `26ae28aea` | membership bucket이 ceiling까지 **여유 1파일** — throw 대신 결정론적 분할 |
| `9365c21c6` | 절대경로 3개 entrypoint + SSRF fixture의 실제 link-local 요청 제거 |
| `f3d49f529` | bounded process observer + identity-safe kill (70초 drain 1400→34 snapshot) |
| `3772f7df6` | `smoke` 이중 authority 통합 |
| `7bea20017` | `targetChunkCount` dead parameter 거부 |
| `8b96f06f5` | campaign이 **대기 전** HEAD를 기록하던 것 → queued/running/end 3-snapshot + base OID |
| `c7e91b306` | 두 floor의 실행 증거 부재(dirty tree에선 도달조차 안 함) → selector 추출, 4 mutant killed |
| `741b68fe5` | `~/Library` 가드가 source만 읽던 것 → 실제 파일시스템 효과 검증, 5 mutant killed |
| `6523ab56c` | `test:clean-js`가 무시된 scratch의 `.js`를 **삭제**하고 있었다 |
| `e818b72fc` | tier 3개가 한 population이던 상태 해소 + prepush 조기 축소 interlock |

### 17~42 — 어딧 대응, 스케줄러, hygiene, 등록

| 커밋 | 내용 |
|---|---|
| `137fb6e60` | 적대 어딧 R1이 찾은 6건 — **main이 RED였다**(내 docstring이 slice를 빈 문자열로 만들어 가드 3개가 통과) |
| `c48602062` | top-level gate용 ready-set 스케줄러 (배선은 보류, 이유는 아래) |
| `c1a87073d` | 계속 출력하는 chunk가 불사였고, 종료 시 전체 로그를 RAM으로 다시 읽었다 |
| `e0b20052a` | eval cron과 merge gate가 concurrency lane 하나를 공유 |
| `1097325af` | pollution 가드가 fail-closed의 근거인 `git status`에서 hang 가능 |
| `3f6f61018` | 내가 미등록으로 착륙시킨 스캔 가드 2개 등록 |
| `d18368cc2` | suite discovery가 Chrome·Python·Git·서버를 **spawn하지 않게** 됨 |
| `277931291` | flake 도구가 두 번째 광역 suite를 돌려 실패 20건을 child 40개로 증폭 |
| `7cf5f435f` | 손상된 scheduling hint 하나가 전체 plan을 죽였고, cache는 전건 miss |
| `6e9f4f5ca` | 뮤테이션 어딧(155 뮤턴트)의 HIGH 생존자 전건 차단 |
| `8e576eee1` | SSRF 가드가 production 소스를 본 적이 없었고 egress 4형태를 놓쳤다 |
| `30d0b9f10` | requesting-assignment 규칙을 sink walk에서 분리 |
| `fd00812fb` | SEP9 인벤토리를 날짜 스냅샷으로 표기(재작성 대신) |
| `b059d8a8d` | 내 timing/watchdog 작업이 무효화한 가드 marker 3개 갱신 |
| `5c0754ab0` | 562개 미인증 파일, 그리고 아무도 읽지 않는 policy 필드 |
| `a3a6219ae` | run당 temp 32개, 16초 대기, 같은 suite 3회 실행 |
| `8b6cbbdd5` | 이 캠페인의 도구 등록 + **죽은 gate가 가리고 있던 파일 6개** |
| `c94d6dc24` | current-HEAD 실행 receipt |
| `c4ebde26d` | `chunkClaimsOverlap`이 call site 0·테스트 0으로 export돼 있었다 |

(문서 전용 커밋 `b9073c8fe`·`04a4a8072`·`54250b900`·`c7c061c49`·`b336710f1`·`5a012bcea`·`7844d73ae`는 생략)

## 티켓 최종 상태

| 티켓 | 상태 | 핵심 |
|---|---|---|
| TVH-01 safety/portability | **LANDED** | worker HOME·절대경로·실 metadata egress. LL-b/c/e/f/h paired control로 분류기 정밀도 닫음(`06bd6714c`) |
| TVH-02 tier contract | **LANDED** | exact gate 계약, tier 4종 / **digest 3종** 분리(prepush==pr은 의도된 미완). prepush 축소는 interlock 보류 |
| TVH-03 capability lanes | **LANDED** | 부재 capability가 PASS로 기록되지 않음 |
| TVH-04 resource scheduler | **LANDED** | 548 certified / 14 intentionally-exclusive / 0 missing(재생성 후). overlap 전환은 canary 보류, audit 실행 gate는 없음 |
| TVH-05 timing/cache | **LANDED** | 증거(timing v2 store)는 clean-tree 캠페인 필요 |
| TVH-06 receipt integrity | **LANDED** | 3-way exact producer 비교. VR-13은 `948498381`에서 닫힘(`homeCapabilitySha256` producer/consumer 양쪽) |
| TVH-07 process lifecycle | **LANDED** | drain snapshot 1,400→34. LC-13은 `1656dd2ae`에서 닫힘(`pollSchedule` 중앙 clamp) |
| TVH-08 test hygiene | **LANDED** | 전제 5건은 측정으로 반증 |
| TVH-09 hosted matrix | **BLOCKED** | 외부 권한 — Actions 빌링 차단 |
| TVH-10 closeout | **PARTIAL** | 문서 완료, healthy-load ABBA 미생성 |
| TVH-11 probe amortization | **LANDED** | discovery 4-walk→1, module-load effect 0 |
| TVH-12 producer dedup | **PARTIAL** | producer→receipt 전환은 hosted lane과 결합 |
| TVH-13 resource envelope | **PARTIAL** | spool/wall/sweep/retention 착륙, RSS admission 미착륙 |
| TVH-14 DAG runner | **PARTIAL** | 스케줄러는 있으나 `gate.ts`는 여전히 직렬 |
| TVH-15 flake determinism | **LANDED** | sleep budget 73,720→51,470ms |

## 의도된 보류 4건 (시간 부족이 아니라 근거 부족)

| 보류 | 왜 | 승격 조건 |
|---|---|---|
| prepush canary 축소 | selector가 어느 gate에도 연결돼 있지 않아 3,938→8 커버리지 붕괴 | selector 배선 후 `PREPUSH_NARROWED_TO_CANARY` 플립, interlock 자동 해제 |
| `chunkClaimsOverlap` 전환 | 실 캠페인 없는 동시성 확대 | 1/2/4-worker verdict 등가 canary |
| declared-input cache 축소 | 인증 registry의 declared-input 절반이 비어 전 chunk가 `whole-tree` | input scope 등록만으로 코드 변경 없이 축소됨 |
| `runGateDag` 배선 | `Bun.spawnSync(["sh","-c",…])`에 process-group kill이 없다. 둘을 동시에 띄우고 둘 다 못 죽이는 스케줄러는 직렬 루프보다 나쁘다 | bounded child primitive 착륙 + gate에 `resources[]` 선언 |

---

## 헬어딧 결과 (2026-09-12)

`85a99bb6f..HEAD` 범위에 적대 어딧 2라운드를 돌렸다.

### R1 — 적대 어딧 (10건)

| # | 심각도 | 내용 | 처리 |
|---|---|---|---|
| F1 | HIGH | **main이 RED였다.** 내가 `c7e91b306`에 넣은 docstring이 `await main()`을 `const main =`보다 앞 offset에 두면서 slice가 음수 길이가 됐고, `mainSource`가 `""`가 되어 drain-before-release·signal handler·repository-lane 직렬화 **가드 3개가 빈 문자열 위를 통과**했다 | `137fb6e60` |
| F2 | MED-HIGH | discovery enumeration 카운터가 계측이 아니었다. 호출부 옆의 리터럴 `+= 1`이라 projection을 통째로 되돌려도 13/13 green. "4→1, 타이머가 아니라 단언" 주장은 거짓이었다 | `137fb6e60` |
| F3 | MED-HIGH | tier floor가 **실제 corpus 유실을 "선택 축소"로 오귀속**했다. suite floor 3,600과 tier floor 3,900 사이 300 구간에서 `selected === discovered`인데도 "SELECTION shrink, not corpus loss"를 출력 | `137fb6e60` |
| F4 | MED | `readRef`가 git exit code를 무시했다. `origin/main`이 없는 체크아웃에서 `baseOid`에 git의 4줄 fatal 메시지가 저장됐고, 주변 `try/catch`는 전부 죽은 코드였다 | `137fb6e60` |
| F5 | MED | `baseOid`가 커밋 메시지의 주장과 달리 아무도 소비하지 않는다 | 커밋 메시지 정정 |
| F6 | MED | split 전략 선택 근거 표가 receipt에 영향 없는 양을 측정했다(`treeSha256`이 어차피 전 chunk를 무효화) | 커밋 메시지 정정 |
| F7 | MED-LOW | link-local 가드가 production `src/**/*.ts` 3,435개를 스캔하지 않는다 | 미처리(열림) |
| F8 | MED-LOW | 분류기가 `Image().src=`, XHR `.open()`, `location.href=`, `importScripts`를 놓친다 | 미처리(열림) |
| F9 | LOW | `.toBe(10)` 스냅샷 + `test:pollution`/`eval:retrieval`/`e2e:pty` 미커버 | `137fb6e60` |
| F10 | LOW | over-capacity split이 locale 의존 비교자를 썼다 | `137fb6e60` |

### R2 — 뮤테이션 어딧 (155 뮤턴트, 27 생존)

kill 요약: `process-observer` 13/13, `test-shard-discovery` 7/7, `worker-home` 3/3,
`test-shard-options` 2/2, `gate.ts` 3/3, `test-shard-lifecycle` 18/19.

HIGH 생존자 4건 + MEDIUM 3건을 `6e9f4f5ca`에서 닫았다.

- `$`shell`` egress가 SSRF 가드를 통과했다(`SHELL_TAGS` 비워도 12/12 green).
- 문서 어디든 skip이 있으면 **block-form case 전부가 미실행으로 읽혔다**. 모든 fixture의
  실행 case가 self-closing이라 body 분기에 들어간 적이 없었다. `executedCases`는 required가
  게이트하는 바로 그 값이다.
- **dirty tree에서 만든 receipt가 재사용 가능했다.** context 비교는 receipt↔current만 보고,
  바뀌지 않은 dirt는 자기 자신과 완벽히 일치한다.
- campaign receipt의 새 필드 4개가 **producer 미검증**이었다. 한 시간 대기한 런이
  `headMovedInQueue: false`를 보고해도 아무도 몰랐다.
- `loadTierPopulationFloors`가 `minFiles`/`reason`/schema를 하나도 검증하지 않았다.
- `CapabilityFloor`의 file floor가 미검증이라 `executedCases: 5, executedFiles: []`가 통과했다.
- `assertGateManifestMatchesContract`는 호출부 0의 죽은 가드 — 테스트가 아니라 **삭제**했다.

### R3 — 어딧 항목 종결 (2026-09-12)

R1/R2가 열어둔 항목을 전부 닫았다. 각 건은 "이미 고쳐져 있었는가"를 **뮤턴트로** 확인했다.

| 항목 | 실제 상태 | 처리 |
|---|---|---|
| F7/F8 link-local production 스캔·egress 4형태 | 열려 있었음 | `8e576eee1` |
| LL 정밀도 규칙 (데이터를 데이터로) | **paired control 0건** — 세 규칙 모두 grep으로 되돌려도 green | `06bd6714c` |
| VR-13 `homeCapabilitySha256` | `home`은 payload에 **있었다**. 없는 건 증명이었다 — 필드를 지워도 28/28 green | `948498381` |
| LC-13 `maxPollMs < pollMs` | clamp는 각 호출부에 **복제**돼 있었다. 세 번째 호출자는 아무것도 상속받지 못한다 | `1656dd2ae` |
| `chunkClaimsOverlap` | call site 0 · 테스트 0. 이 캠페인이 같은 이유로 죽은 가드를 삭제한 적 있다 | `c4ebde26d` |
| `posture-phase-modules-hellgate` skip 4건 | preset 4개가 registry에서 전부 사라져 블록 전체가 무의미 | `63da154bb` |

교훈이 반복된다: **"고쳐져 있다"와 "증명돼 있다"는 다르다.** VR-13은 코드가 맞고
테스트가 틀렸고, LC-13은 두 호출부가 맞고 계약이 없었다. 둘 다 뮤턴트를 넣기 전까지
"닫힌 항목"으로 보였다.

### 구조적으로 닫을 수 없는 것 (기록)

- **방법론 플래그**: `waitForEmptyGroup`의 wall deadline을 지우는 뮤턴트는 **hang으로만**
  드러난다. `bun test`에는 워치독이 없어 "아직 실행 중"과 구분되지 않는다. 이 뮤턴트가
  공유 트리로 새어나가 다른 레인의 kill path를 실제로 멈춰 세웠다.
- **`EQUIVALENCES` 4건**: 어떤 preset을 재현해야 하는지는 bench 소유자의 판단이다.
  추측하지 않고 one-directional 기록으로 남겨 새 drift만 RED가 되게 했다.

---

## current-HEAD 실행 증거 (2026-09-12, clean tree)

### `bun tools/dev/gate.ts precommit` — 캠페인의 핵심 receipt

시작 시점(`85a99bb6f`)에는 **gate를 하나도 실행하지 못하고 exit 1**이었다.
현재 HEAD:

```
  PASS  smoke-canary            1814ms
  PASS  typecheck               1358ms
  PASS  lint                   41710ms
  PASS  lint-debt                621ms
  PASS  fc-check-changed        1526ms
  PASS  fc-ci                   1589ms
  PASS  fc-reachability        20571ms
  PASS  silent-catch-baseline    243ms
  PASS  protocol-generated       232ms
  [capabilities] absent on this host, so anything gated on them was skipped:
    bwrap, chromium, chromium-browser, dlv, google-chrome,
    google-chrome-stable, gopls, limactl, lldb-dap
precommit: ok — 9 of 9 gate(s) passed
```

모든 gate가 `load/core 6.59–8.52 — OVERSUBSCRIBED` 상태에서 실행됐다(외부 세션 부하).
부재 capability는 green 한 줄에 묻히지 않고 **이름이 나열된다**.

> 죽어 있던 gate를 살리자 `fc-check-changed`가 즉시 **이전부터 red였던** 위반을 드러냈다:
> 캠페인 3커밋 전에 추가된 파일 6개가 어떤 catalog 항목에서도 참조되지 않았다.
> 죽은 gate는 선을 지키지 않는다 — 선이 움직였다는 사실을 가릴 뿐이다.

### tier membership (HEAD `280300e5e`, `--discover-only`, 재측정)

| tier | files | digest |
|---|---:|---|
| prepush | 3,944 | `bb4cf51376e18f18` |
| pr | 3,944 | `bb4cf51376e18f18` |
| full | 3,954 | `3438930588af7024` |
| nightly | 3,968 | `eb560f5a634f84d4` |

> 이 표는 **한 커밋 안에서도 움직인다.** 위 수치는 `280300e5e` 측정이며, 같은 세션에서
> `e8795ac5e` 기준으로는 3,941 / 3,951 / 3,965였다 — 동시 세션이 테스트 파일을 추가하면
> 바로 바뀐다. 그래서 이 표의 계약은 "절대값"이 아니라 **측정 기준 커밋을 같이 적는 것**과
> 아래 관계식이다.

이 표는 원래 `1d153a109` 측정치(3,938 / 3,948 / 3,962, digest 4종 전부 상이)를
"current-HEAD"라고 적어두고 36 커밋 동안 갱신하지 않았다. **관계는 그대로였고
절대값과 digest 전부가 틀렸다.** 코퍼스가 커지면 숫자가 움직이는 게 정상이며,
문서가 그걸 따라가지 않는 것이 결함이다.

`prepush == pr`은 **의도된 미완**이며 interlock으로 고정돼 있다. 즉 tier는 4종이지만
**digest는 3종**이다 — prepush와 pr은 바이트 단위로 같은 모집단이다.
시작 시점에는 prepush/pr/full이 **하나의 동일 digest**였다.

**커버리지는 줄지 않았다** — tier가 갈렸다는 것과 테스트가 사라졌다는 것은 다르다:

    pr ⊂ full ⊂ nightly            (strict, 측정)
    nightly (3,968) == universe     (3,968)
    universe 에서 유실:              0

full-only 10개, nightly-only 14개가 tier를 가르는 전부다. 어떤 파일도 어느 tier에도
속하지 않는 상태로 떨어지지 않는다.

### 3차 셀프어딧(3병렬) 후속 — 실측 후 수정한 결함 (HEAD `280300e5e`)

세 라운드의 findings를 **전부 직접 재현한 뒤** 고쳤다. 서브에이전트 보고를 그대로 신뢰하지
않았고, 한 건(`pty` 플로어 수치)은 라운드 간 주장이 엇갈려 직접 측정으로 판정했다.

| # | 결함 | 실측 증거 | 커밋 |
|---|---|---|---|
| 1 | 캐시 재사용이 여전히 count 기반 — id를 바꿔치기하고 digest 재계산·재서명한 receipt가 `hit` | `verdict: hit ["tests/unit/x.test.ts","tests/unit/y.test.ts"]` (계획에 없는 2개 파일) | `5ff0ef9fc` |
| 2 | scan-reach receipt를 **어떤 tier도 통과할 수 없었다** | full→`membership-mismatch`, nightly→`wrong-tier`, pr→`non-authoritative-tier` | `28ceba210` |
| 3 | quarantine이 양방향 inert (campaign은 읽지 않고, runner는 campaign 아래서 쓰지 않음) | 같은 record에 대해 `quarantinePath` 없이 ACQUIRED port=47451 / 있으면 refused | `eb52ea7ed` |
| 4 | `spawnDetachedKeeper`가 detach하지 않음 | parent pgid 26124 == keeper pgid 26124 (`ps`); setsid 후 keeper pid == pgid | `b84c2bc24` |
| 5 | unbounded child 금지가 **두 철자만** 막았다 (array form·`Promise.all` 안의 `proc.exited`) | 9개 sibling capture가 무제한; `timeout:600` vs `sleep 3` → 605ms SIGTERM | `4d98b6fb4` |
| 6 | 문서 9건이 틀렸다 (tier 표 전 항목·commit 수·닫힌 항목 3개·hold #4·ADR 렌더링) | 아래 tier 표 및 각 절 | `7ff3ee577` |
| 7 | `--tier=pr --tier=nightly`가 조용히 마지막 것을 채택 | `"name": "full:nightly"` 3,965 files | `bb5120aeb` |
| 8 | 소스 4개가 grep에 **바이너리** — 모든 검색에 침묵으로 답함 | `git grep -I` exit 1 / `grep -c` 무출력; fingerprint·digest는 전후 동일 | `7347a64a8` |
| 9 | exemption segmenter 우회 10가지 (`&`·개행·`timeout`·`env`·subshell·`$()`·`xargs`·`docker`·`cargo`·`git`) | 각 shape로 unregistered gate 밀반입 성공 | `c2cef9ec3` |
| 10 | matrix plan floor 100 (실제 tier 3,900) + population digest 3개를 아무것도 비교 안 함 | pr/nightly가 universe는 같고 membership digest는 다름 | `a9a1cc498` |
| 11 | root-scratch 가드가 8가지 중 1가지만 잡음 + `import.meta.path` 예외가 죽은 코드(사유도 거짓) | 8 shape 측정표; 이름 기반 1차 시도는 오탐 119건 | `308013c6b` |
| 12 | capability **그룹별 case 플로어가 전부 dead data** (v1이 총합만 발행) | `toolchain` 7그룹 floor 4/2/1/1/1/2/3 중 어느 것도 읽히지 않음 | `085045945` |
| 13 | DAG bridge의 "behaviourally identical" 주장이 거짓 | dispatch `b,a` vs result `a,b`; `skipped-input` 사유 변경 | `280300e5e` |

부수적으로 **내 자신의 결함 3건**을 같은 도구들이 잡아냈다: 새 greppability 가드 파일 자체가
금지 바이트를 품고 있었고(추적 전엔 green, 커밋하자 red), 새 plumbing 규칙이
`QUANTA_X=1 bun run y`를 scaffolding으로 오분류했고, prefilter/parser 분리에서 좁힌 prefilter가
통과했다. 셋 다 커밋 메시지에 그대로 남겼다.

### 기타 current-HEAD 게이트

| 게이트 | 상태 |
|---|---|
| `typecheck:all` | clean |
| `lint:debt` | 23 diagnostics, 회귀 0, ceiling 상향 0 |
| `test-determinism-ratchet` | ✓ (files 4,047 · wall 165 · random 36 · sleep_budgeted 51,470ms) |
| `module-load-effect-guard` | files 4,047 · effects 150 · violations 0 |
| `awaited-sleep-budget` / `temp-lifecycle` | exit 0 |
| `test-resource-certification --check` | exit 0 (548 certified / 14 intentionally-exclusive / 0 missing) — 재생성 후 |
| `tests/unit/_arch` (33 files) | 427 / 427 |
| `precommit` (9 gates) | 9 / 9 PASS (load 52 OVERSUBSCRIBED로 기록됨) |

> 이 표의 두 행은 감사에서 **거짓으로 확인돼 고친 것**이다.
> `test-determinism-ratchet`은 exit 1이었다 — 캠페인이 직접 넣은
> `verification-tier-runner.test.ts`의 `Bun.sleep(15)` 2개가 sleep budget을
> 51,470 → 51,525ms로 올렸다. 타이머를 microtask 순서 관찰로 교체해 baseline으로 복귀.
> `test-resource-certification --check`도 exit 1이었다 — 캠페인 자신의 커밋
> `1656dd2ae`가 건드린 파일 1개가 source-drift, 3개가 closure under-declare.
> 재생성했고 claim은 전부 **확장**이며 삭제는 0이다.
> **아직 남은 결함: 이 audit을 실행하는 gate/workflow/test가 없다** (`--check` 25.8s wall).
> 이 세션 안에서만 두 번 드리프트했다 — `1656dd2ae`가 만진 파일 1개, 그리고 내가
> vacuous guard를 고친 `tests/unit/_arch/worktree-pollution-guard.test.ts` 1개.
> 테스트를 건드리면 반드시 드리프트하고, 아무도 실행하지 않으므로 아무도 모른다.

### 아직 없는 증거 (정직하게)

- **healthy-load full/prepush 캠페인 receipt 없음.** 이 박스는 세션 내내 외부 부하
  load 25–111이었고, 동시 실행 중인 다른 세션이 트리를 공유했다. ABBA 성능 비교는
  단일 실행이나 부하 상태 숫자로 확정하지 않는다는 규칙에 따라 만들지 않았다.
- **hosted 증거 없음.** GitHub Actions 빌링이 2026-07-10부터 차단돼 job이 시작하지 않는다.
  matrix↔monolith verdict 동등성, branch protection live read-back은 **권한 blocker**다.
- **timing v2 store 없음.** `unit-speed-budget`의 완료 기준은 clean-tree 캠페인 1회가 필요하다.


---

## 2차 감사 대응 (사용자 액션리스트)

사용자 감사가 지적한 결함을 dependency 순서대로 처리했다. 각 항목은
red-on-injection 뮤턴트로 확인했고, **등가 뮤턴트는 등가라고 적었다**.

| # | 결함 | 조치 | 뮤턴트 |
|---|---|---|---:|
| P0-1 | chunk receipt가 파일 **개수**만 증명 — 남의 파일 147개도 green | exact-set 공통 helper(`executed-file-set.ts`), receipt v3→v4가 ids+digest 보관 | 4/4 |
| P0-2 | scan receipt가 `manifestSha256.length!==64`만 검사, suite/tier 무검증 | v2 authority 5필드, consumer가 트리에서 **독립 재계산**, 좁은 tier는 발행 자체를 거부 | 7/7 |
| P0-3 | capability lane 전체에 1 file/1 case floor | manifest 파생 floor + **그룹별** 검사. pty 8/8 · toolchain 10/14 · contract 5/5 | 6/6 |
| 4 | drained:false인데 lease 해제 | quarantine 레코드 + keeper. liveness는 keeper가 아니라 **survivor**로 판정 | 7/7 |
| 5 | inherited lease가 64-hex 아무거나 통과 | 소유자 리스너가 토큰을 **발급하고 응답**. fabricate/replay/rebind 동시 차단 | 5/5 |
| 6 | top-level child 3곳 무제한 | 하나의 bounded primitive로 통합(12분 inactivity·4시간 backstop), 그 뒤 DAG 배선 | 8/9 (1 equivalent) |
| 7 | tier 미지정이 전체 universe 선택 | tier 필수화, flag/env 불일치 fail-closed, 별칭 전부 명시 | 2/2 |
| 9 | matrix `full` vs monolith `pr` | plan v4가 tier+population digest 보관, `--expect-tier`, 100파일 floor | 5/5 |
| 10 | exemption이 뒤에 붙은 명령을 은폐 | segment 단위 매칭. 배관(`\|\| true`, `\| tee`)은 기존 개념 재사용 | 2/2 |
| 11 | manifest digest가 destructure한 필드만 해시 | dispatch schema 닫힌 universe + 컴파일/런타임 드리프트 가드 | 4/4 |
| 12 | frozen base OID가 child에 미전달 | env로 전달, non-main base 보존, `<absent>` sentinel 구분, base 이동 보고 | 5/5 |
| 13 | daemon 상태가 receipt identity 밖 | `hostCapabilityFingerprint`(소비자 0이던 모듈)를 두 receipt에 배선 | 2/2 |

### 이 과정에서 드러난 선존 결함 (캠페인이 만든 것 아님)

게이트를 **실제로 돌리자** origin/main에 이미 red이던 것들이 나왔다.

- `no-raw-process-env-knob-ratchet` 44/43 — `src/`가 origin/main과 byte-identical인데 44.
- `terminal-surface` ownership fence — `readSite` 경로 포인터를 leak으로 오판.
- `src-no-sketchy-code` 7건 — 무시된 주입 시계, 삼킨 catch, 메시지 기반 라우팅, 미등록 knob 2개.

전부 ceiling 상향 없이 구조적으로 닫았다. 2건(bootstrap-phases, session-main)은
이미 allowlist된 composition root의 분리본이라 **실제 부채를 적어서** 분류했다.

### 반복해서 나온 패턴

**built-but-unwired**. 이 캠페인이 찾은 것만 넷이다: `gate-dag.ts`,
`bounded-child.ts`(docstring이 gate.ts를 명시), `capabilityProducerFloors()`
("이게 써야 할 숫자"라고 적혀 있음), `hostCapabilityFingerprint`. 전부 완성돼
있었고 전부 생산 소비자가 0이었다. 옆 docstring은 결함을 **과거형으로** 설명한다.


---

## 3차 감사 대응 (2026-09-14, 병렬 적대 감사 2라운드) — 사용자 액션리스트

범위는 `4db28a3f5..922910655`, local `main`이다. 1라운드는 감사 4개(capability·catalog·
test-shards·quarantine)를 반영했다. 2라운드는 immutable snapshot `a128bc99d`에서 서로
겹치지 않는 범위로 적대 감사 5개(capability 체인·catalog·shard tier·quarantine·주장 대
실제)를 병렬로 돌렸다. 감사는 전부 read-only였고, 수정은 통합 담당 한 명이 순차로 반영했다.
감사 보고는 직접 재현한 뒤에만 반영했다. 뮤턴트 원복은 cp 백업으로 했다.

### 반영 완료

| # | 결함 | 조치 | 뮤턴트 |
|---|---|---|---:|
| C1 | 워커가 receipt bag을 잃으면 gated describe가 skip으로 green | runner가 자기 `process.env`에 definite id로 `QUANTA_REQUIRE_CAPABILITIES`를 무장. bag이 빠지면 이름 붙은 실패 | 20 |
| C2 | `test:contract`·`test:real-toolchain`에 receipt가 없음(로컬 skip-green, CI 계약 job은 red) | `with-capability-receipt.ts` 래퍼. probe와 child가 preload가 유지하는 scratch HOME 하나를 공유 | (C1에 포함) |
| C3 | contract guard가 module-scope throw라 `--bail=1`에서 junit이 비고 같은 파일 case가 사라짐. `REQUIRE_CONTRACT=0`이 strict. lint sweep이 skip 경고를 삭제 | 등록형 실패, 스위치 문법 통일(`0/false/no/off`), 경고 복구 | (C1에 포함) |
| C4 | aggregator의 `blockedMissing`·`failedSetup`이 아무도 넘기지 않는 CLI 플래그 전용이라 두 hard-failure 검사가 발화 불가 | consumer가 파일마다 `[capability] RECORD` testcase를 남기고 reducer가 집계. REQUIRED 실패도 record(실행 case 아님) | 18+17 |
| C5 | call-site scanner가 상수·namespace·alias·dynamic import·조건부·`process.env` 2번째 인자를 못 봄 | 모든 호출 분류, 보증 불가 형태를 문제로 명시. consumer import 없는 파일은 파싱 생략 | (C4에 포함) |
| C6 | campaign에서 `failed-setup`을 읽는 곳이 없음. 느린 Chrome(endpoint 15s timeout)을 `unavailable`로 기록해 fail-loud가 회귀로 오판 | runner가 fresh·cached chunk의 record를 PASS 줄 앞에 출력. endpoint timeout은 `probe-timeout`(예산 불변) | (C4에 포함) |
| C7 | 늦게 도착한 probe가 이미 쓰고 무장한 receipt를 변경(map 공유). runner가 receipt를 지우지 않음 | mint snapshot, `finally`에서 삭제 | (C4에 포함) |
| C8 | scratch HOME이 도구를 가려도 receipt는 "없음"이라고만 기록 | 실제 HOME에서 재probe해 `AVAILABLE under the real HOME` 표기(status·verdict digest 불변) | (C4에 포함) |
| T1 | floor slack 때문에 `tools/`·`tests/meta`·`tests/adversarial`·`tests/measurement` 전체와 src 42개가 사라져도 16조합 green | discovery 완전성 threshold 0: tracked ⊆ discovered, root마다 ≥1 | 12 (11 red, 1개는 정책 suite가 잡음) |
| T2 | prepush/pr/full의 실제 파일 삭제를 "SELECTION shrink … lower the floor"로 보고 | 레코드 v3가 측정 `discovered`를 보관하고 측정 대비로 판정. 조치 문구는 `--measure` | (T1에 포함) |
| T3 | 일관되게 낮춘 레코드(`unit.selected=1`)가 로더를 통과 | `--measure`가 커밋 트리에서 재계산해 레코드를 씀. arm이 `measuredAt` 재계산과 완전 일치를 요구 | (T1에 포함) |
| T4 | git snapshot을 선택 **후에** 찍어서 선택 중 착륙한 커밋이 비교를 통과 | 선택 전에 snapshot | (T1에 포함) |
| Q1 | keeper가 TTL에 live 그룹 위의 expired 레코드를 path 기준으로 삭제 → "보관+보고" 경로가 실행되지 않음, 새 레코드도 삭제 가능 | keeper는 감시·로그만. 정리는 포트를 잡은 holder만 | 15 |
| Q2 | 슬롯 확인 후 bind라서 쓰기·해제 사이 창과 대기자의 live 레코드 삭제가 재현됨 | bind 후 포트를 잡은 채로 읽음 | (Q1에 포함) |
| Q3 | 모든 읽기 오류가 `absent`=free(chmod 000·slot 자리의 디렉터리·탐색 불가 root). mtime 실패가 1970=stale | ENOENT만 absent. 나머지는 block, mtime 불가 시 읽을 때마다 새로 나이 계산 | (Q1에 포함) |
| Q4 | reader가 root를 검증 안 함. expiry 무상한. identity 비멱등. 병합에서 survivor 유실. mirror 실패가 quarantine을 숨김 | 비사설 root는 block, 느슨한 mode 교정, legacy fallback, TTL cap, 멱등 normalizer, misfiled 운반·unreadable 보관 | (Q1에 포함) |
| Q5 | 테스트 arm이 stub keeper 프로세스를 영구 누수(호스트에서 18개 발견) | stub가 디렉터리가 사라지면 종료, arm이 종료를 assert. 남은 17개는 kill | — |
| K1 | 가짜 heredoc·산술 `<<`·여러 줄 작은따옴표가 shell 마스킹을 꺼버림. quoted delimiter도 마스킹됨 | 줄 사이 quote 상태 유지, 마스킹된 코드에서 opener 탐지, delimiter 보존 | 21 |
| K2 | workflow `env.X`를 스칼라 전체에서 매칭(step name·run 주석·echo 문자열) | `${{ }}`와 `if:` 값만 읽음 | (K1에 포함) |
| K3 | Python·TS 구조분해 쓰기와 테스트 `expect(process.env.X)`를 읽기로 계산. 삭제된 tracked 파일이 스캔을 crash | 쓰기 제외, expect 제외, ENOENT skip, `wiring.activation` env key 추출 | (K1에 포함) |
| K4 | 마스킹·언어 규칙 12개 이상과 필드 3개 누락이 각각 green(`declared.size > 400`이 고른 수) | 규칙마다 그 규칙만 결정하는 fixture 줄, 필드마다 전용 이름이 declared에 도달해야 함 | (K1에 포함) |
| G1 | `--trust-scope owner`·`member`가 실제 댓글에 아무에게도 응답 안 함(OWNER/MEMBER가 collaborator로 먼저 접힘). SETUP.md 예시가 곧 먹통 봇 | association → scope 매핑, SETUP 표를 코드 동작으로 교정 — **보안 회귀였음, 아래 4·5차 섹션 정정(`e9cd6491d`)** | 2 |

이번 세션 뮤턴트는 105개다. 104개가 red였고 1개(override tier 무시)는 현재 override로는
등가지만 정책 suite가 잡는다. (`c5e23b02f` 커밋 메시지의 "21 mutants"는 20이 맞다.)

### 수치 (current HEAD 실측, 성능 주장 아님)

| 항목 | 값 |
|---|---|
| contract 레인 | 8 pass/5 skip → receipt 후 14/3 → record 후 14/4, fail 0 유지 |
| real-toolchain 레인 | 22 pass / 28 skip / **7 fail**(Rust 전부, 아래 A1) |
| tracked vs discovered (full) | 3995 / 3995 |
| catalog env | 532 declared / 0 unbacked |
| tier 레코드 v3 (`34b1d74fc`) | discovered full 3995·core 3601·unit 3275·integration 394 |

### 남은 액션 (기능 · 왜 · ROI)

| # | 기능 | 왜 | ROI |
|---|---|---|---|
| A1 | test preload HOME fence가 toolchain root(`RUSTUP_HOME`·`CARGO_HOME`, Python user site)를 유지하도록 하거나, lane helper가 버전 probe 실패를 `failed-setup`으로 분류 | `4f8d4a89b`(다른 세션) 이후 Rust real-e2e 7개가 rustup toolchain을 못 찾아 fail. helper는 binary만 보고 `executed`라고 보고함. hermeticity와 도구 접근의 트레이드오프라 소유자 결정 필요 | 높음: 개발 호스트에서 toolchain 레인이 초록으로 돌아오고 lane 보고가 정직해짐 |
| A2 | `resolveTestPopulation`의 source 분류(37 MB, 단일 프로세스 실측 ~5.5–6.1s) 가속: 내용 해시 영속 캐시 또는 `resourceEvidenceFor` 프로파일 | always-run prepush canary(`test-policy-enrollment`)가 부하에서 5s timeout. 모든 campaign 선택도 비용 지불. ABBA 측정 필수 | 높음: prepush flake 제거와 campaign 시작 단축 |
| A3 | receipt 유효성을 runner lease 수명에 묶기(6h TTL, 실행 중 toolchain fingerprint 변경) | 무장한 스위치가 만료·지문 변경 후의 consumer를 전부 REQUIRED 실패로 만듦(메시지는 이유를 명시) | 중간: 장시간·동시 설치 상황의 가짜 red |
| A4 | quarantine 슬롯과 legacy 쓰기가 둘 다 실패하면 survivor가 사는 동안 listener 유지(TTL cap) | 지금은 둘 다 실패 시 WARN 후 release | 중간: 드문 fs 장애에서 격리 누락 |
| A5 | pgid 재사용 방어(leader start time을 `DrainedGroupRecord`까지 전달) | 죽은 그룹 pgid를 다른 프로세스가 재사용하면 alive로 오판 | 낮음–중간 |
| A6 | catalog: registry 항목은 `readSite` 파일의 실제 read로 교차검증 | generic accessor(`cli-knobs-accessor.ts`)가 모든 inventory knob을 읽어서 행동 reader가 사라져도 backed로 남음. 현재 declaration 전용 파일로만 backed인 이름은 0 | 중간: 죽은 knob 탐지 정밀도 |
| A7 | catalog tokenizer에 Go backtick·Rust raw string·Python f-string 내부 read 추가 | 지금은 false red 방향(누락 read)이라 시끄럽게 실패함 | 낮음 |
| A8 | worker·probe·fence HOME 레이아웃 함수 하나로 통합 | runner·래퍼·fence가 같은 레이아웃을 따로 들고 있어 drift 위험 | 낮음–중간 |
| A9 | universe floor 3900(`c7e91b306`에 고른 값) 재검토와 정기 `--measure` | corpus가 자라며 파생 floor slack이 커짐. 완전성 검사가 slack에 의존하지 않는 이유 | 낮음 |
| A10 | healthy load에서 full-suite campaign 1회와 ABBA | 이번 세션은 부하 20–56 구간이라 campaign·성능 주장을 하지 않음 | 높음(증거) |

### 외부 권한 blocker

- 원격 push·PR·branch protection: 권한이 없어 하지 않았다. 전부 local `main`에만 있다.
- hosted CI는 GitHub Actions 빌링 차단 상태다. 그래서 다음이 미검증이다:
  - capability 레인과 `required` aggregator가 실제 runner에서 도는지.
  - toolchain CI job이 rust-analyzer·gopls·pyright·typescript-language-server를 설치하지 않아 group floor 4개가 구성상 **확정** 실패(4·5차 섹션 B1).
- `ci.yml`의 capability 단계 이름은 `capability-result.v1`이라고 적혀 있지만 artifact는 v2다. gate-manifest가
  단계 이름을 pin하고, ci.yml은 다른 세션이 편집 중이라 손대지 않았다.
- `41a86c849` 커밋 설명의 근거(false green이 아니라 false RED)는 history를 rewrite하지 않는 한 고칠 수 없다.

---

## 4·5차 감사 대응 (2026-09-14, 적대 감사 3·4라운드) — 사용자 액션리스트

범위는 `922910655..bab5c692b`, local `main`이다. 3라운드는 감사 5개(capability 코드·catalog와 trust scope·tier record·quarantine·교차 통합)를 돌렸다. 4라운드는 3라운드 수정 자체를 snapshot `59c619cd5`에서 감사 3개(capability record와 scanner·receipt와 matrix와 quarantine·catalog)로 다시 봤다. 감사는 전부 read-only였다. 보고는 직접 재현한 뒤에만 반영했고, 수정은 한 명이 순차로 넣었다. 뮤턴트는 커밋된 코드에서 cp 백업으로 원복했다.

### 앞 섹션 정정 (이 캠페인이 만든 회귀)

- **G1은 보안 회귀였다.** `ac5bc1c52`는 댓글 **작성자**의 association을 **sender**에게 줬다. 그래서 write 권한자가 owner의 옛 댓글을 편집하면 owner scope로 실행됐다. `e9cd6491d`에서 association은 `comment.user.login === sender.login`일 때만 쓰고, 조회는 `Map`으로 바꿨다(prototype key가 모든 scope를 통과하던 것도 막음).
- **C6은 시작 즉시 죽는 Chrome을 skip-green으로 만들었다.** endpoint timeout을 `probe-timeout`으로 매핑하면서 sandbox 없는 CI의 launch crash까지 여기에 들어갔다. `4776f1bed`에서 endpoint 대기가 프로세스 종료를 관찰한다. 종료는 `spawn-failed`로 기록되고 fail-loud 대상이다.
- **C8의 문구**는 "real HOME"이 아니라 "caller's HOME"이다. Bun의 `userInfo().homedir`는 `$HOME`을 돌려준다.
- **A1(Rust 7 fail)은 해결됐다(`37d5c4a72`).** fence가 `.rustup`·`.cargo`를 scratch HOME에 symlink로 빌려준다. 제품 env scrub이 `RUSTUP_HOME`을 지워서 env var 방식은 효과가 없었다. 다른 세션의 `c63a8e393`("done")이 중간 버전을 함께 커밋했고, history는 rewrite하지 않았다.
- **커밋 메시지 오류** (history rewrite 없이는 못 고쳐서 여기 기록):
  - `fc7fcb016`: "16 of 17" → 실제는 19줄 중 17개 실패(대조군 2). "complexity 5→4" → 실제는 7→4. "body가 quote state를 건드리지 않는다"와 "`<<<`는 opener가 아니다"는 `2dcd61ee0` 전까지 거짓.
  - `3ef6c2e75`: "Either way it is a junit RECORD"는 hook 안에서 부른 gate에 대해서는 거짓이었다. `ee3ff16d1`에서 gate는 module scope에서만 부르도록 arm으로 강제했다.

### 반영 완료

| # | 결함 (재현) | 조치 | 커밋 |
|---|---|---|---|
| R3A-1 | 시작 즉시 죽는 Chrome → `probe-timeout` → 17개 browser case skip-green | 종료 관찰, `spawn-failed` | `4776f1bed` |
| R3A-2 / R4-F3 | `Bun.env`·alias·spread, 이어서 `node:process` import·`import.meta.env`·`global`·getter·`Object.assign`으로 채운 literal이 scanner에서 "injected" | ambient 이름을 fixed point까지 전파(함수 본문 제외). 모든 binding 종류를 반영하고, 쓰기가 일어난 이름은 불신 | `3ef6c2e75`, `ee3ff16d1` |
| R3A-3 / R4-F4 | WIRING arm이 `capabilityRecords: []` 호출에도, `return` 뒤로 옮긴 push에도 green | const collector 하나가 전달·forward·출력됨을 증명. push는 도달 가능한 statement여야 함 | `3ef6c2e75`, `ee3ff16d1` |
| R3A-4 / R3E-2 | lane REQUIRED 실패가 `beforeAll` throw라서 junit `(unnamed)`로 기록되고 `executedCases:1, blocked=0` | gate가 `[capability] REQUIRED group <id>` 이름 붙은 실패 또는 RECORD를 등록 | `3ef6c2e75` |
| R4-F1 | 위 수정 이후 선택 group(nightly-heavy, floor 제외)이 PR `required`를 red로 만듦 | 두 체계에서 `blocked-missing`의 뜻이 다름. receipt id는 항상 hard, lane group은 REQUIRED일 때만 hard | `ee3ff16d1` |
| R4-F2 | hook 실패(npm install 실패, Ollama 불통)가 실행 case로 계산돼 `js-test-runner` floor 2/2를 채움 | Bun junit에서 `line` 없는 failure를 failed-setup으로 분류. Ollama는 `capabilitySetupFailed`로 보고 | `ee3ff16d1` |
| R3A-5 / R4-F6 | 표준 selector·interface 필드·label·type parameter·hoisted `var`가 false red, pattern default·instance field가 false green | 위치 기반 conditional, 이름 위치 확장, scope 해석 | `3ef6c2e75`, `ee3ff16d1` |
| R3A-6 | signal 경로가 receipt를 지우지 않음 | `releaseCampaign`(guarded 삭제 후 lease 해제)을 두 출구 모두 호출 | `3ef6c2e75` |
| R3A-7 | caller HOME 재probe 하나가 reject하면 campaign이 죽음 | probe마다 catch, 남은 deadline 안에서만 실행 | `3ef6c2e75` |
| R3A-8 / R4-F7 | detail의 개행이 `&#10;`로 record prefix를 가림. id 형태 가정이 검증되지 않음 | 제어문자 치환, id가 `^[a-z0-9-]+$`이고 receipt id에 `group` 없음을 arm으로 확인 | `3ef6c2e75`, `ee3ff16d1` |
| R4-F5 | gate를 hook 안에서 부르면 record 등록이 조용히 실패 | 모든 lane gate를 module top level에서만 부르도록 corpus arm으로 강제 | `ee3ff16d1` |
| R3E-3 / R4 matrix F1·F5 | shadow matrix worker에 receipt가 없고 이후엔 chrome이 없음. planner에 완전성 검사 없음. worker가 signal에 lane을 누수 | `prepareCapabilityLane`(`includeChrome`)으로 실행, planner도 거부, SIGINT/SIGTERM이면 abort와 dispose | `1724ed65f`, `950946244` |
| R3E-5 / R4 matrix F6 | arm·kill된 campaign이 실제 shared cache에 receipt를 누수. sweep 오류가 campaign을 죽임 | dead writer·만료 receipt sweep(경고만 하고 계속), `cacheRoot`를 필수로 | `3ef6c2e75`, `59c619cd5`, `950946244` |
| R3C-1..7,9 | 대체 쓰기가 격리를 해제, slot 쓰기 실패가 lane을 해제, 다른 identity를 덮어씀, 포트 누수, 이유 1개만 남음, 구 reader 대기, normalizer가 포트를 이동 | `holdUntilMs`, fallback 병합, foreign 거부, listener 해제, 이유 누적, v1 mirror, fixed point normalizer | `e6547f183` |
| R4 quarantine F2·F3·F4 | 이름 옮기기 후 쓰기 실패 → 격리 해제. 두 쓰기 모두 실패(같은 볼륨) → 살아있는 그룹 위로 lane 해제. foreign의 active hold를 덮어씀 | hard link로 보존한 뒤 rename. owner 4곳이 `quarantineOrHoldLane`을 await(그룹이 살아있는 동안, TTL 이내에서 hold). hold도 거부 | `950946244` |
| R3D-1·2 | (G1 정정 참조) | | `e9cd6491d` |
| R3D-3..7 / R4 catalog F1..F8 | heredoc 본문·escape·`"$(…)"`가 이후 read를 마스킹. interpreter를 줄 전체에서 매칭. 여러 줄·큰따옴표·중첩 inline script 누락. `<<<` 오판. Python pop 문장 오판. 문자열 속 괄호를 세고 dict 1개에 14.5s | 한 pass 마스커(frame stack), 세그먼트 command word, 줄바꿈 보존, 모든 깊이 span, 한 pass bracket 추적, 규칙마다 fixture | `fc7fcb016`..`bab5c692b` |
| 부수 | `tests/unit/dev`에 red 3개: 내가 넣은 module-load `mkdtemp`, fixed sleep, 09-10부터 red였던 INTERLOCK arm. unused import 2개 | beforeAll 이동, unix socket barrier, AST로 import 판정, import 제거 | `5fca11988`, `950946244` |

**뮤턴트:** 이번 두 라운드에서 121개를 돌렸고 마지막에 전부 red다.
- quarantine R3: 9
- capability R3: 37 (arm 구멍 2개와 잘못 만든 뮤턴트 1개를 보완)
- matrix R3: 3
- catalog R3: 33 (fixture 1줄 보완)
- R4 capability·quarantine·matrix: 27
- R4 catalog: 12

감사자가 추가로 돌린 catalog 뮤턴트 43개 중 25개가 살아남았다. 동등하지 않은 16개는 fixture로 닫았다.

**부수효과(보고):** `toolchain-roots.test.ts`가 `cacheRoot` 없이 wrapper를 불러서, 테스트 실행 중에 clone의 실제 shared receipt cache를 sweep했다. 죽은 프로세스가 남긴 receipt 13개가 삭제됐다. 삭제 대상 자체는 sweep이 원래 지우는 것이지만, 테스트에서 일어나면 안 되는 일이다. `cacheRoot`를 필수로 바꿔 타입 수준에서 막았다.

### 수치 (HEAD `bab5c692b`, load ≈6, 성능 주장 아님)

| 항목 | 값 |
|---|---|
| `tests/unit/dev` + module-load guard + lease + lane 17파일 | 843 pass / 91 skip / 0 fail |
| contract 레인 (`bun run test:contract`) | 14 pass / 4 skip / 0 fail. artifact: executed 4 files·14 cases, blocked 0, setup 0 |
| real-toolchain 레인 | 30 pass / 26 skip / 0 fail. 이전 22/28/7 → 25/26/5(load 30–46). artifact: executed 16 files·30 cases, blocked 0. 선택 group 기록 2개(`lsp-go` gopls 없음, `native-debugger` dlv 없음) |
| rust-analyzer arm 4개 | load 30–46에서 실패했고 load 6에서 통과. 부하 원인 확정 |
| catalog, old 대 new, 실제 corpus | 8,503 files·1,105 names, 잃은 것 0·새로 생긴 것 0 |
| 8,000-name Python dict 스캔 | 14.5 s(감사 측정) → 45 ms (단일 측정. 알고리즘을 역방향 반복에서 한 pass로 바꾼 결과이고 suite 성능 주장이 아님) |
| shared receipt cache 누수 | 13 → 0 |
| typecheck:all · lint:debt · fc validate | pass · 23/0 regression · 1071 features |

### 남은 액션 (기능 · 왜 · ROI)

| # | 기능 | 왜 | ROI |
|---|---|---|---|
| B1 | CI `toolchain` job에 gopls·pyright·typescript-language-server·rust-analyzer 설치 단계 추가 | group floor 7개 중 4개(`lsp-rust`·`lsp-go`·`lsp-pyright`·`lsp-typescript`)가 구성상 확정 red다. 앞 섹션의 "가능성"은 틀린 표현. 설치 단계는 manifest `needs[].provision`에 있다 | 높음. 단 빌링 차단이라 검증 불가(외부 blocker) |
| B2 | `quarantineOrHoldLane` hold 중 두 번째 Ctrl-C가 경고와 함께 즉시 해제 | 지금은 첫 signal의 `terminating` guard 때문에 두 번째 signal이 무시되고, 최대 30분 hold를 끊으려면 SIGKILL밖에 없다 | 중간. 드문 disk-full 상황의 UX |
| B3 | quarantine root를 사용자 전용 경로(`DARWIN_USER_TEMP_DIR`, `$XDG_RUNTIME_DIR`)로 | 다른 local 사용자가 `/tmp/quanta-lease-quarantine-<uid>`를 먼저 만들면 lane이 재부팅까지 막힌다(R3C-8) | 낮음. 단일 사용자 개발 호스트 |
| B4 | scanner가 call 결과(`{K: read()}`)도 추적, 이름 기반을 scope 기반 binding으로 | 문서화된 한계. arm 자체가 produce 결과를 넘겨서 지금은 추적하지 않는다 | 낮음. 의도적 우회만 해당 |
| B5 | hook 실패 분류가 Bun junit 형태(`line` 없음)에 의존 | Bun writer가 바뀌면 분류가 달라진다. 실제 Bun을 도는 arm이 red로 알려준다 | 낮음 |
| B6 | Python dict 값 위치의 `os.environ.pop(`(`{"a": pop("X")}`) | `:` 경계를 lambda·block과 구분하지 못해 write로 분류된다 | 낮음 |
| A2·A3·A5·A6·A7·A8·A9·A10 | 앞 섹션과 동일 | 이번 라운드에서 다루지 않음 | 앞 섹션 참조 |

### 외부 권한 blocker

- 원격 push·PR·branch protection은 권한이 없어 하지 않았다. 전부 local `main`에만 있다.
- hosted CI는 GitHub Actions 빌링 차단이다. B1(toolchain 설치), capability 레인과 `required` aggregator의 실제 실행, `fetch-depth: 0` 변경(`dc0878fa0`)이 미검증이다.
- `ci.yml`의 capability 단계 이름(`capability-result.v1`)과 artifact 버전(v2) 불일치는 그대로다.

---

## prepush 실행 로그 (2026-09-12, clean tree, healthy load)

부하가 8–20까지 떨어진 창에서 prepush를 반복 실행했다. **매 실행마다 red가 하나씩
줄었고, 전부 캠페인이 만든 게이트가 찾아낸 것이다.**

| 실행 | 결과 | 원인 | 귀속 |
|---:|---|---|---|
| 1 | full-suite RED | `no-raw-process-env-knob-ratchet` 44/43 | origin/main 선존 |
| 2 | gate 1 전 거부 | 내가 캠페인 중 트리를 더럽힘 | **내 절차 실수** (가드는 정상 작동) |
| 3 | EXECUTED-SET MISMATCH chunk 38 | 0-테스트 묘비 파일 (6월부터) | 선존 — **개수 비교로는 영원히 못 봄** |
| 4 | chunk 36 RED | bench stub이 readiness probe에 잘못된 sentinel | 선존 (3파일 12케이스) |
| 5 | BUG-1 RED | 같은 stub 결함 2파일 더 | 선존 (32케이스) |
| 6 | endDirty=true | kill된 worker가 repo 루트에 scratch 유출 | 선존 (5파일 6지점) |
| 7 | options 파싱 RED | tier 필수화가 ambient env 노출 테스트를 깨뜨림 | **내 회귀** |
| 8 | readSite RED | god-module split 후 낡은 포인터 5개 | 선존 |
| 9 | **inactivity watchdog 발화** | chunk 38이 720초 무출력 | 기존 미해결 Bun stall |

### 9번이 이 캠페인의 증거다

```
[test:shards] TIMEOUT chunk=38/44 inactive: nothing written for 720701ms
              (ceiling 720000ms); killing worker process tree.
[test:shards] END chunk=38/44 exit=130 timeout elapsed_ms=727828
```

`sep-04-bun-test-intermittent-stall`은 메모리에 **미해결**로 기록된 결함이다.
캠페인이 고친 것은 stall 자체가 아니라 **그것이 무한정 매달리지 않는다**는 것이다.
720초 경계는 이 티켓에서 측정으로 정한 값이고, 처음으로 실제 무언가를 끝냈다.

### P0-1 가드가 실제로 잡은 것

3번은 이 캠페인 전체를 정당화한다. `tests/unit/apps/cli/cli-sdk-parity.test.ts`는
2026-06-08에 테스트가 전부 삭제되고 주석과 `export {}`만 남은 파일인데, 코퍼스가
**이름으로** 선택하므로 그 이후 모든 캠페인이 chunk에 넣고 돌렸다. 단독 실행하면
`Ran 0 tests across 1 file`로 exit 1이고 JUnit을 쓰지 않는다.

**개수 비교(`executedFiles === plan.files.length`)로는 이것을 영원히 볼 수 없다.**
exact-set 비교가 첫 실제 캠페인에서 잡았다.

### item 19도 실제 실패에서 동작 확인

chunk 36 실패 시 `failure-attempt.json`이 발행됐고, `parseFailureArtifact`가
그대로 수용했다 — producer→consumer 배선이 합성 fixture가 아니라 실제 실패에서
end-to-end로 확인됐다.
