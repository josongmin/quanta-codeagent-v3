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
