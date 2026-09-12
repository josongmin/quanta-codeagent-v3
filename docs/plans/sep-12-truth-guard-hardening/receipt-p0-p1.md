# truth-guard-hardening — P0-1·P0-2·P1-1·P1-2 receipt

- 상태: IMPLEMENTED on `codex/truth-guard-hardening`, NOT pushed, NOT merged.
- 브랜치 base: `e8795ac5ee1bc4ba01644b49472a1cb510b7df87` (main, clean tree).
- 격리: `.worktrees/truth-guard` (`.gitignore:100` 관례). `node_modules`는 메인으로
  가는 심볼릭 — 정리 시 `unlink`만 쓸 것. `rm -rf`는 과거에 메인 `node_modules`를
  깨뜨렸다.

## base 이탈 1건 (의도적)

계획은 `b84c2bc249da294671bf56b469e7566e0949bfe1`에서 분기하라고 했다. 그 근거는
"현재 dirty main을 건드리지 않는다"였는데, 그 dirty 13파일(`tools/dev/**`)이
`4d98b6fb4 fix(verify): the unbounded-child ban was on two spellings, not on the call`
로 이미 랜딩해 트리가 clean이 됐다. 구 base로 분기하면 receipt가 main과 불일치하고
최종 게이트가 그 랜딩된 수정을 제외한다. `b84c2bc`는 조상으로 포함된다.

부수 효과: `tools/dev/**` 소유권이 풀렸으므로 P1-6(tools/dev 면제 제거)의
선행 조건이 해소됐다.

## 환경

| 항목 | 값 |
|---|---|
| bun | 1.3.14 |
| tsc | 5.9.3 |
| biome | 2.4.15 |
| OS | Darwin arm64 24.6.0 |
| load average (착수) | 55.05 / 49.55 / 45.07 |
| 캐시 | `QUANTA_TEST_CACHE` 미설정(기본), cold/warm 미제어 |

⚠️ 부하 40~55 구간에서 실행했다. 아래는 전부 **정적·순수 단위 테스트**(디스크 IO
최소, 타이머 없음)라 타이밍 의존이 없다. 성능·ABBA 수치는 하나도 만들지 않았고,
`prepush` 전체와 측정성 게이트는 **돌리지 않았다** — 병렬 세션의 캠페인 receipt를
오염시키기 때문이다.

## P0-1 — subagent master kill switch

결함: `src/agent/optional-ports.ts`의 `wireSubagentToolGates`가 자식 게이트만 보고
`subagent: {}`를 만들었다. 빈 블록이 runner-enabling 기본값이라, 명시적
`QUANTA_SUBAGENT=0`이 무력화됐다. `QUANTA_SUBAGENT_FOLLOWUP`은 apps/cli 시드
루프가 `"1"`로 심으므로 **인터랙티브 CLI에서 이게 기본 결과**였다. 프로덕션 경로
확인: `src/host/runtime/agent-arg-builder.ts:753`이 `process.env`로 이 wire를 부른다.

수정: 마스터를 `@/shared#gateDisabled`(canonical falsy 어휘)로 읽고, 명시 falsy면
`base`를 **그대로** 반환한다. caller가 코드로 넘긴 `subagent` 블록은 env 게이트보다
우선하므로(ADR-0332) 삭제·변형하지 않는다. mailbox wire도 같은 판정을 통과한다.

```
bun test tests/unit/subagent-knobs-wire-hellgate.test.ts
  RED  (수정 전)  14 pass /  7 fail
  GREEN(수정 후)  21 pass /  0 fail   93 expect   0.67s
```

mutation (cp 백업 원복, `git checkout --` 미사용):

| mutant | 결과 |
|---|---|
| 마스터 early-return 제거 | 14 pass / 7 fail |
| mailbox 마스터 체크 제거 | 20 pass / 1 fail |
| `gateDisabled` → `gateOn` (어휘 반전) | 13 pass / 8 fail |
| 원복 | 21 pass / 0 fail |

어휘 반전이 7건이 아니라 8건을 깨뜨린다 = paired control이 양방향을 고정한다.

회귀: `bun test tests/unit/subagent` → **1041 pass / 0 fail** (79 files, 4.96s).

## P0-2 — feature-catalog baseline 허위 표시

결함: `tools/feature-catalog/render.ts`가 `tsc 0 · biome clean`을 **문자열
리터럴**로 출력했다. `baseline.json`은 `tsc {exit:2, errors:38}`,
`biome {exit:1, errors:14}`. 그리고 `loadBaseline`이 그 블록을 **의도적으로
버렸다**("the renderer only needs the flat totals") — 즉 반증할 데이터가 렌더러에
도달조차 못 하는 구조였다. 생성물 `docs/10.feature-catalog.md`는 precommit
`fc-ci` diff 게이트와 CI가 바이트로 보존한다.

수정: `Baseline`에 `tsc`/`biome`을 **필수** 필드(`BaselineToolStatus | null`)로 추가.
loader가 두 숫자가 모두 유한할 때만 채우고 나머지는 `null`. `toolVerdict`가
`clean`(exit 0 AND errors 0) / `FAIL(exit N, errors M)` / `unknown`을 렌더.
누락은 clean이 아니라 unknown이다.

```
bun test tests/unit/feature-catalog-render.test.ts
  RED  (수정 전)  20 pass / 6 fail
  GREEN(수정 후)  26 pass / 0 fail
bun run tools/feature-catalog/cli.ts ci   EXIT 0
  validate 1071 all resolved / diff: no changes / lint ok
```

기존 golden snapshot이 `tsc 0 · biome clean`을 박아두고 있었다 — 거짓을 보존한
장치가 그것이었다. 진실 문장으로 갱신했다.

생성물 실측 (`docs/10.feature-catalog.md:2485`):
```
> 검증 베이스라인: tsc FAIL(exit 2, errors 38) · biome FAIL(exit 1, errors 14) · 2/2/2/3 (1237 files). 최종 빌드: 2026-05-29T12:58:06.607Z.
```

부수 관측(범위 밖): `baseline.json`의 `generated_at`이 2026-05-29다. 3.5개월 묵었다.

회귀: `bun test tests/unit/feature-catalog` → **213 pass / 0 fail** (17 files).

## P1-1 — automation 활성화 토큰 불일치

결함: `/cron`·`/schedule`·`/inbox`가 `hint: set QUANTA_AUTOMATION=1`을 출력하는데
`src/scheduler/runtime-wire.ts`의 `assembleAutomation`은 `flag !== "on"`이면 null.
힌트대로 하면 안 켜졌다. 그리고 `tests/unit/cli/automation-wire-hellgate.test.ts`의
`HELL-AW-19`가 `"1"`과 `"true"`를 **비활성으로 고정**하고 있었다 — 테스트가 틀린
계약을 인증한 상태.

수정 방향 결정: 힌트가 아니라 **런타임을 SSOT로** 옮겼다. `notWired`의 공유 힌트에
허용 어휘를 나열하는 안은 기각했다 — 그 힌트를 쓰는 게이트 중
`QUANTA_UNTRUSTED_ENVELOPE`가 `=== "1"` **strict**이므로 "1/on/true/yes 허용"이
거짓이 된다. `=1`은 strict·lenient 양쪽이 모두 받는 유일한 토큰이라 canonical
하나만 유지한다.

추가: 인식 불가 토큰은 fail-closed **+ 진단 warn**. canonical falsy는 무음.

```
bun test tests/unit/cli/automation-wire-hellgate.test.ts
  RED  (수정 전)  23 pass / 2 fail
  GREEN(수정 후)  25 pass / 0 fail
```

mutation:

| mutant | 죽는 테스트 |
|---|---|
| `isTruthyToken` → `!== "on"` | HELL-AW-19b (truthy 활성화) |
| 진단 warn 제거 | HELL-AW-19c (진단) |
| falsy 예외 제거 | HELL-AW-19d (falsy 무음 paired control) |

세 뮤턴트가 각각 **다른 테스트 하나씩만** 죽인다 = 커버리지가 겹치지 않는다.

**동작 변경으로 기록한다**: `QUANTA_AUTOMATION=1`이 이제 엔진 슬롯을 만든다.

회귀: `bun test tests/unit/scheduler tests/unit/cli/automation-wire-hellgate.test.ts
tests/unit/cli/not-wired-exit-code-hellgate.test.ts` → **261 pass / 0 fail** (16 files).

## P1-2 — memory 기본값 문서가 런타임과 반대

런타임 진실 실측 (`src/memory/store-path.ts` 순수 함수 직접 호출):

| 입력 | 결과 |
|---|---|
| `QUANTA_MEMORY` 미설정 | kind `sqlite` (durable) |
| 기본 경로 | `<home>/.quanta/memory/memory.sqlite` |
| 레거시 `<cwd>/.quanta/memory.sqlite` 존재 | 그 파일 사용 + 마이그레이션 안내 1회 |
| `QUANTA_MEMORY_PATH` | 명시 경로 최우선 |
| `=memory` | 휘발 in-memory |
| `=0/false/off/no` | store 없음 |

문서는 정반대를 말했다. `README.md:38`(미설정 시 OFF), `:53`(전부 기본 OFF,
byte-for-byte 불변), `:58`(미설정=OFF), `:59`(기본 `.quanta/memory.sqlite`), 그리고
`src/apps/cli/memory-compose.ts:26`(unset ⇒ VOLATILE, `=sqlite`가 유일한 영속
opt-in). 플립은 ADR-0557 `198b5c31d`(2026-08-25)였고 README 마지막 커밋은
`2a7645cbd`(2026-06-24)다.

결정: 검증된 런타임을 canonical로 삼고 문서를 맞췄다. 런타임 기본값을 OFF로
되돌리는 건 제품 결정 + 마이그레이션 영향 검토가 필요하므로 이 truth-fix에 섞지
않았다.

신규 가드 `tests/unit/memory/memory-doc-parity-hellgate.test.ts`는 런타임 동작을
**재테스트하지 않는다** — 그건 `durable-store-default-hellgate`가 이미 덮는다.
없던 것은 문서-런타임 parity이고, 기대값을 하드코딩하지 않고
`defaultDurableStorePath`/`legacyCwdStorePath`에서 **파생**시킨다.

```
bun test tests/unit/memory/memory-doc-parity-hellgate.test.ts   6 pass / 0 fail
```

mutation:

| mutant | 결과 |
|---|---|
| README `기본 ON` → `전부 기본 OFF` | 5 pass / 1 fail |
| 기본 경로를 레거시로 되돌림 | 5 pass / 1 fail |
| 상단 env 목록만 되돌림 | 5 pass / 1 fail |
| docstring 을 pre-0557 서술로 되돌림 | 5 pass / 1 fail |
| **런타임 파일명 상수 변경** (`memory.sqlite`→`mem2.sqlite`) | **3 pass / 3 fail** |
| 원복 | 6 pass / 0 fail |

마지막 뮤턴트가 이 가드의 성격을 증명한다. 런타임을 바꾸면 가드가 따라온다 =
텍스트 대 텍스트 비교가 아니다.

회귀: `bun test tests/unit/memory` → **653 pass / 0 fail** (36 files, 9.36s).

## 레일

```
biome check <8 changed files>                  no fixes applied (clean)
bun run tools/dev/typecheck.ts src             EXIT 0
bun run tools/feature-catalog/cli.ts ci        EXIT 0
```

`bun run precommit` / `prepush` / 전체 shard / JUnit receipt는 **미실행**. 부하
40~55이고 병렬 세션이 캠페인 중이라 증거 오염 위험이 크다. 낮은 부하의 clean
worktree에서 별도로 돌려야 한다.

## 남은 것

- P1-3 knob completeness AST 스캐너 (regex 8형태 구멍 → 미선언 read; 정확한 수는
  read/write·prefix 분류 후 확정. `ORPHAN_CEILING=0` 유지)
- P1-4 tool manifest → production builder probe (`lsp_diagnostics` ghost row)
- P1-5 `gate:default-off` 5개 canonical 이관 + ledger row
- P1-6 `tools/dev` blanket exemption 제거 (선행 조건 해소됨)
- P2 `/knobs set` 표시, top-level flag registry, build identity, evidence
  population, primary reachability, dependency asset probe

---

# P1-3 ~ P2 receipt (continuation)

- 상태: IMPLEMENTED and MERGED to local `main` incrementally, 11 commits.
- 각 항목은 커밋 하나, 병합은 `main`을 브랜치로 당긴 뒤 `--ff-only`. 병합 직전마다
  내 테스트 재실행 + `main` HEAD 재확인(동시 세션이 캠페인 중).

## P1-3 — knob completeness: AST 센서스로 교체

`isReadLine`이 3개 구문만 보았고, 트리는 10개를 쓴다. `ORPHAN_CEILING`은 몇 달째
0이었고 로그도 `orphans=0/0`을 찍었다. 실제 미선언은 **63**.

| | |
|---|---|
| 파싱 파일 (git ls-files) | 3,734 |
| declared (정적) | 650 |
| read 사이트 / distinct | 984 / 622 |
| write / delete / prefix | 36 / 21 / 2 distinct |
| orphan 예외 전 | **63** |
| orphan 예외 후 | **28** (프로덕션 26 + 테스트 2) |

처리: **19 선언**(cli-knobs 14 · host 2 · runner 4 · mention 2 · extra 2) +
**2 예외**(`QUANTA_SIDE_AGENT_TEST_MODE`, `QUANTA_TB_BEST_OF_N`) + 테스트 corpus
제외 2. `ORPHAN_CEILING=0` 유지 — 상향 없음.

유저 정정 2건이 스캐너로 확증됨: `QUANTA_ALLOW_UNSIGNED`는 write(
`plugin-isolation/bun-spawner.ts:87`), `QUANTA_BENCH_`/`QUANTA_SWEBENCH_PRO_`는
prefix. 둘 다 read 집합에 없음.

측정 중 함정 하나를 직접 밟았다: 처음 `allKnobs()`로 declared를 모아 **0**이 나왔다.
등록 모듈 import 전엔 비어 있어 runner knob 전부가 orphan으로 뒤집힌다. 기존 라쳇이
정적 스캔을 고집한 이유가 이것이고, 같은 방식으로 맞췄다.

RED-on-injection: 프로덕션 파일에 한 줄씩 주입(cp 백업 원복, `git checkout --`
미사용) — property / bracket / alias(`e.`) / cast / destructure / call-arg /
const-key **7형태 전부 1/0 트립**, write-only는 0/0. 구 regex는 3/7만 보았다.

## P1-4 — tool manifest 자기충족

`scanRegisteredToolNames()`가 `src/tool`을 grep하고 그 안에 매니페스트 자신이 있다.
모든 행이 자기를 증명 ⇒ "no stale rows" 방향이 구조적으로 발화 불가.

```
스캔 WITH 매니페스트    194 → stale: none
스캔 WITHOUT 매니페스트  193 → stale: lsp_diagnostics
```

`lsp_diagnostics`는 존재한 적 없다. `lspDiagnosticsTool()`이
`diagnosticsTool(lspDiagnosticsProvider())`를 반환하고 그 도구 이름은
`"diagnostics"`(이미 BASE 행). `QUANTA_LSP`는 provider 교체다.

결함 재현: 유령 행 + 제외 유지 → 35/1(문다), 유령 행 + 제외 제거 → **36/0**(눈감는다).

빌더 프로브는 추가하지 않았다 — 79행에 `buildDefaultTools()` 정확 일치가 이미 있다.

## P1-5 — default-off ledger 라벨

`gate:default-off` 5개가 정확 일치 필터에서 조용히 제외. **누락이 아니라 부재**라
위반으로도 안 잡혔다. 라벨 + row를 같은 변경에(한쪽만 하면 각각 5건 RED).

decision은 게이트 실코드에서: rfc01 `measure-first`(gateOnStrict) · rfc02
`enable-now`(등록만, read-only) · rfc04 `repair-first`(`parseEnvFlag`의 빈문자열=true
구멍) · rfc05 `hold`(bool 아님, selector+centralConfig 이중게이트) · rfc06
`repair-first`(**co-gate 결함** — 저널 스토어가 `QUANTA_HUNK_UNDO`에 걸려 자기 게이트로
자기 기능을 못 켬). ledger 첫 `repair-first` 2건.

metrics 179→184행, wired 171→175, 95.5→95.1%, repair-first 0→2, dormant 8→9 —
plan 문서 3개 needle 8개 동시 갱신(파이프라인이 정확 일치를 요구, 과거 2회 정상 작동).

드리프트 가드 신설: 정본 철자 near-miss 금지 + `gate:` 네임스페이스는 env 키 전용.
뮤턴트 3건(4 fail / 3 fail / 1 fail).

## P1-6 — tools/dev 면제

면제 근거가 소스에 "0 of ~20 catalogued"라 적혀 있었다. 실측 **51/102**. 절반이
카탈로그된 상태라 커버리지가 동전던지기였고, 게이트가 유일하게 막아야 할 신규 파일이
정확히 통과 대상이었다.

일괄 등록 없음 — `runCheckChanged`의 ADDED=blocker / MODIFIED=advisory 비대칭이
그 일을 한다. 첫 적발 대상은 내 `tools/dev/knob-env-access.ts`였고
`cli-slash-knobs-live-control`에 등록했다.

결함 재현: 신규 파일 + 면제 제거 → BLOCK, 면제 복원 → ok.
첫 뮤턴트는 무효였다(`knob-env-access.ts`가 이미 `origin/main`에 있어 MODIFIED) —
가드가 아니라 프로브가 틀렸고 진짜 신규 파일로 다시 증명했다.

## P2 — 표시·배포·증명

**`/knobs set`**: catalog 674행 전부에 "live this session"을 주장했다.
`hotToggleable: true`는 카탈로그 전체에 **1개**(`QUANTA_PERSONA`)이고 그 소스가
스스로 apply 경로가 DEAD라고 적는다. `hotToggleable`을 canonical로 쓰고 그 1개를
false로 내렸다. 기존 스위트는 `setOverride`를 가짜 wire로 스텁해 프로듀서를 안 탄다
(`slash-knobs.test.ts:208`) — 새 테스트는 조립된 `knobsCmd`를 직접 쓰고 스텁 금지.

**top-level 플래그**: `--lsp-tools`·`--git-tools`·`--metrics`는 파서 없음(구현된 적
없음), 실제 파싱되는 6개는 미광고. 테이블로 만들고 usage를 렌더, `VALUED_FLAGS`를
흡수(병존하면 세 번째 목록). 양방향 가드. 내 스캐너가 두 번 틀렸고 둘 다 기록:
`-lc`/`-p` 오탐 → 좁힘, 그 다음 `--image`/`--tool-profile` 오탐 → **스캐너가 틀린 것**
이라 3개 실제 read 형태로 넓힘(표를 줄이지 않음).

**build identity**: `bun build`에 `--define`이 **없다**. 주면 exit 0으로 아무것도
치환하지 않는다 — 스탬프 기능에 최악의 실패다. `--env='QUANTA_BUILD_*'`가 동작.
repo 밖에서 확인:

```
/tmp $ dist/agent --version   → quanta 1.0.035 (6a82f65d1c9d-dirty)
repo $ bun run …/index.ts --version → quanta 1.0.035   (스탬프 없음, 불변)
```

내 커버리지가 두 번 실패했고 둘 다 기록: bake fallback 삭제가 초록(모듈 로드 시
env 읽어 소스 실행에선 영구 부재) → 주입 파라미터로. `-dirty` 분기 삭제도 초록 →
`composeCommitLabel(commit, dirty)` 순수 함수로.

**evidence population**: 4,083 tracked / 4,041 실행가능 / **진짜 고아 9**(나머지 33은
web `.test.tsx`, vitest가 실제로 돌림 = 회계 공백). 그중 하나가 L3 feature의
`contract` evidence(`objective-goal-continuation-live` → goal smoke). `check-evidence`의
존재 계약은 건드리지 않고 별도 가드 신설. `gated-test-scope-ratchet`이 이미
`tests/smoke`/`tests/eval`을 out-of-band로 선언·검사하므로 **재구축하지 않고 인용**.
내 가드가 세 번 틀렸고 전부 뮤턴트로 잡힘: 배럴/하네스 오탐 8건 → 규칙 좁힘 · 임의
`deliberate_hold` 수용(정작 그 케이스는 headless/batch hold) → 실행 사실 요구 ·
"smoke" 단어 수용(그 feature가 이미 smoke를 길게 서술) → 실행 부재 주장으로 강화.

**partial-dead reachability**: `src.every(isDead)`라 live 1개가 dead 다수를 가린다.
실측 **all-dead 0 / partial 83 feature · 105 파일**. fan-in 1.95배라 카탈로그를
채울수록 사각이 커진다. `some()` 치환은 83건 동시 실패 + primary/auxiliary 축이
스키마에 없어 판정 불가 ⇒ **가시화 + 감소전용 라쳇**까지. blocker 승격은 스키마 필드
+ 83 triage의 별도 캠페인임을 명시. `.d.ts` 제외가 85/107→83/105의 차이.

## 레일

```
bun run tools/dev/typecheck.ts src     passed (매 커밋)
bun run tools/dev/typecheck.ts tests   EXIT 0
biome check <변경 파일>                 clean (repo-wide lint:fix 미사용)
bun fc ci                              EXIT 0 (1071 resolved / diff: no changes)
bun fc check-changed                   ok
```

## 미실행 / 미완

- `bun run precommit` / `QUANTA_TEST_CACHE=off bun run prepush` / shard 1-8 / JUnit
  receipt — 세션 내내 부하 25~72, 동시 세션 캠페인 진행 중. 성능·ABBA 수치 0건 주장.
- primary/auxiliary evidence 축 (partial-dead blocker 승격의 선행)
- `tests/smoke`·`tests/eval` 실행 레인 승격 (이미 의도적 out-of-band)
- 설치 바이너리 교체 (`bun run install:cli`) — 코드/검증과 분리된 별도 액션
- `tool` 스위트에서 관측된 1~4 fail은 `test-resilience`/`bounded-child` 타이밍
  플레이크. 내 커밋 파일 전수에 미포함, 격리 재실행 3/3 초록, 부하 71.88.

---

# 최종 게이트 실행 (2026-09-12)

## 통과

```
bun run precommit                      ok — 9 of 9 gate(s) passed
  smoke-canary 1702ms · typecheck 20298ms · lint 30097ms · lint-debt 570ms
  fc-check-changed 1459ms · fc-ci 1536ms · fc-reachability 12831ms
  silent-catch-baseline 326ms · protocol-generated 392ms
bun run tools/dev/typecheck.ts all     passed (full tree, src + tests)
bun run lint                           clean (경고 1건, 내 파일 아님)
bun run lint:debt                      23 diagnostics / 2 rules, 천장 위반 0
bun test tests/unit/god-code-ratchet   9 pass / 0 fail
bun fc validate / build / diff          1071 resolved · wrote · no changes
```

`protocol-generated`와 `fc diff`가 통과한다 = 생성물 드리프트 0.

## precommit 첫 실행이 내 신규 코드 3개를 잡았다

이번 세션에 랜딩한 가드 두 개가 방금 쓴 파일에 발화했다. 기록해 둔다 — 남의 코드만
잡는 가드는 검증된 가드가 아니다.

- `knob-registry-completeness` → `orphans=3`: `QUANTA_BUILD_{COMMIT,DIRTY,TIME}`.
  선언이 아니라 예외로 처리했다. `bun build --env` 가 컴파일 타임에 인라인하므로
  출하 바이너리에선 리터럴이고, 런타임에 설정해도 아무 일이 없다. `/knobs` 에 올리면
  설정 불가능한 설정 3개를 광고하는 것.
- `fc-check-changed` → 신규 3파일 BLOCK. **두 커밋 전에 `tools/dev` 일괄 면제를
  제거했기 때문에** 가능했다. 각자 이미 속한 엔트리에 등록(build-stamp+build-cli →
  `version-cmd`/`repo-info` 소유 엔트리, top-level-flags → `top-level-usage` 소유
  엔트리). 신규 엔트리 0 — 셋 다 자기 서피스가 없다.

## authoritative prepush: 만들지 못했다 (이유 명시)

```
gate.ts: authoritative prepush receipts require a clean checkout; refusing before gate 1:
  ?? node_modules
[verification] RAN HOT — load/core still 4.36 after 180s;
               a failure below may be contention, not code
```

두 가지가 동시에 막는다.

1. **clean checkout 부재.** worktree 는 메인 `node_modules` 심볼릭이 untracked 로
   남는다. per-worktree `.git/worktrees/<n>/info/exclude` 는 이 경우 효과가 없었고,
   공유 `.git/info/exclude` 는 동시 세션과 공유되는 파일이라 건드리지 않았다(한 번
   넣었다가 되돌렸음). 메인 체크아웃도 동시 세션의 `tools/dev/lease-*` 4파일로 dirty.
2. **부하.** 실행 시점 load average 45.80 → 64.25. 게이트 자신이 HOT 경고를 냈고,
   이 조건의 red 는 code 인지 contention 인지 귀속 불가. 억지로 돌리면 동시 세션의
   캠페인 receipt 도 오염된다.

그래서 **prepush receipt 를 주장하지 않는다.** 대신 회귀 판정만 별도로 했고
(`bun test tests/unit`), 그 결과는 receipt 가 아니라 회귀 증거로만 읽어야 한다.

남은 조건 — cold prepush 완주 · shard 1-8/8 · 부분 아닌 JUnit receipt · exact-HEAD
동일성 — 은 **clean 체크아웃 + 저부하** 에서 별도로 받아야 한다. 이 세션에서
충족했다고 적지 않는다.

## 회귀 판정 (receipt 아님)

내가 건드린 파일에 직접 연결된 23 스위트:

```
291 pass / 0 fail   (load 58 — 넓은 스위트는 이 부하에서 귀속 불가라 좁혔다)
```

첫 실행은 **1 fail** 이었고 내 결함이었다. `no-raw-process-env` 라쳇이 46/43 —
`build-stamp.ts` 의 `process.env.QUANTA_BUILD_*` 3개가 헤드룸 0을 넘겼다. 이 라쳇은
precommit 레인에 없어서 게이트가 못 잡았고, 내 변경 파일을 좁게 돌려서만 드러났다.

**ceiling 은 올리지 않았다** (43 유지). 파일을 exempt 했고 사유는 "여기선 raw read 가
우회가 아니라 메커니즘" 이다. `bun build --env` 는 `process.env.<NAME>` 을 리터럴로
치환하는데 accessor 호출은 치환 대상이 아니므로, `readCliKnob` 으로 라우팅하면 스탬프가
영구히 부재하고 기능이 조용히 죽는다. 그리고 출하 바이너리 안에서 이 값들은 환경변수가
아니라 리터럴이므로 `/config set` 이 가로챌 대상 자체가 없다.

precommit 재실행: **ok — 9 of 9 gate(s) passed** (load/core 1.92~2.48).

