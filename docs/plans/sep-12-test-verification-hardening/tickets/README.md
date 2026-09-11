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

`85a99bb6f` 이후 16 커밋. 각 항목은 측정치와 red-on-injection을 커밋 메시지에 담고 있다.

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

### 현재 tier membership (current HEAD)

    prepush 3925   pr 3925   full 3935   nightly 3948

`prepush == pr`은 **의도된 미완**이다. `gate.ts`가 tier를 shard runner에 넘기므로
prepush를 canary-only로 좁히면 `bun run prepush`가 3,941 → 8파일이 된다.
affected/changed selector가 어떤 gate에도 연결되지 않은 상태에서의 축소는 커버리지 붕괴이며,
`PREPUSH_NARROWED_TO_CANARY` interlock이 조기 플립을 RED로 만든다.

### 아직 열린 항목

- TVH-04 resource certification(561 integration-path 미인증), TVH-05 timing/cache,
  TVH-08 heavy fixture/temp hygiene, TVH-09 hosted matrix 승격, TVH-13 resource envelope,
  TVH-14 DAG runner, TVH-10 closeout.
- TVH-11 / TVH-15는 별도 lane에서 진행 중(미커밋).
- `lint:debt`가 현재 RED — 원인은 전부 진행 중 lane 파일.
- hosted CI 증거는 없다. Actions 빌링 차단이 2026-07-10부터 유효하므로 hosted receipt는 외부 blocker다.

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

### 아직 열린 어딧 항목

- F7/F8: link-local 분류기의 production 소스 미스캔과 4개 egress 형태 미탐지.
- LL-b/c/e/f/h: 분류기의 **정밀도** 규칙(데이터를 데이터로 유지하는 쪽) 5건이 미검증.
- `verification-receipt` VR-13: `homeCapabilitySha256` payload에 `home` 자체가 빠져 있어
  내부 레이아웃이 같은 두 HOME이 동일 해시가 된다.
- `test-shard-lifecycle` LC-13: `maxPollMs < pollMs`면 스케줄이 뒤집힌다.
- **방법론 플래그**: `waitForEmptyGroup`의 wall deadline을 지우는 뮤턴트는 **hang으로만** 드러난다.
  `bun test`에는 워치독이 없어 "아직 실행 중"과 구분되지 않는다. 이 뮤턴트가 공유 트리로
  새어나가 다른 레인의 kill path를 실제로 멈춰 세웠다.
