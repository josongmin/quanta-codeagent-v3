# TVH-08 handoff — heavy test / skip / fixed-wait / temp hygiene

- 작업일: 2026-09-12 KST
- 브랜치: `main` (미커밋). 동시 작업 세션이 여럿이라 `git add`/commit/stash/checkout 일절 하지 않음.
- 실행 제약 준수: full / prepush / `test:ci` / shard campaign 실행 없음. 전부 `bun test <file>` 단일 파일.

## 0. 한 줄 요약

티켓 20개 타깃 중 **측정으로 전제가 확인된 것만** 처리했다. temp leak·self-skip·이중 authority·nested suite는
전부 구조적 가드 + red-on-injection까지 랜딩했고, heavy fixture는 **실측 결과 티켓의 전제가 틀린 항목이 많아서**
실제로 무거운 2건만 분리했다. 나머지는 "안 했다"가 아니라 "측정상 하면 안 된다"로 아래에 수치와 함께 적었다.

---

## 1. 랜딩한 것

### 1.1 temp leak (티켓 6·17·18·20)

새 분석기 `tools/dev/temp-lifecycle.ts` — AST로 `mkdtemp`의 **소유 바인딩**을 풀고(`await`, 로컬 팩토리,
escrow 배열 경유 포함) 그 바인딩을 지우는 호출이 `finally`/`afterEach`/`afterAll`/`onTestFinished` 안에 있는지 본다.
`cleaned | unguarded | leaked | transferred | unowned` 5분류.

- grep으로는 불가능한 이유: `rmSync(dir)`가 test body 끝에 있는 것과 `finally` 안에 있는 것은 **같은 텍스트**다.
- 분석기 자체 버그 1건을 census로 잡아서 고쳤다: `dir = mkdtempSync(...)` 대입에서 `parent.left === node`를
  보고 있어 `let dir` + `beforeEach` 형태 **148 사이트**를 전부 `unowned`로 오분류했다. → `parent.right === node`.
- escrow 형태(`made.push(dir)` + `afterAll(() => for (const d of made) rmSync(d))`) 지원 추가로 오탐 61파일 제거.

새 오너 헬퍼 `tests/_helpers/temp-dir.ts`: `withTempDir` / `withTempDirSync` / `makeTempDirOwner`.
cleanup 실패를 삼키지 않는다(성공 경로면 throw, body가 이미 실패했으면 `cause`로 첨부).

고친 파일(9개, 21 callsite):

| 파일 | 사이트 | 처리 |
|---|---:|---|
| `tests/integration/cli-version-flag-e2e.test.ts` | 1 | `withTempDir` |
| `tests/integration/cli-tool-profile-argv-e2e.test.ts` | 1 | `withTempDir` (인라인 `cwd:`라 바인딩 자체가 없었음) |
| `tests/integration/repo-map-3tree-e2e-hellgate.test.ts` | 1 | **module-scope** → `beforeAll`/`afterAll` |
| `tests/integration/mention-folder-git-e2e-hellgate.test.ts` | 1 | **module-scope** → `beforeAll`/`afterAll` |
| `tests/unit/xlsx-docx-read-roundtrip-e2e-hellgate.test.ts` | 4 | `makeTempDirOwner` + `afterEach` |
| `tests/unit/xlsx-docx-read-deflate-bomb-e2e-hellgate.test.ts` | 4 | 〃 |
| `tests/unit/office-authoring-hellgate.test.ts` | 6 | 〃 |
| `tests/unit/office-authoring-e2e-hellgate.test.ts` | 2 | 〃 |
| `tests/integration/cli-live-debug-mode-hellgate.test.ts` | 1 | 〃 |

**측정 (같은 9파일 1회 실행, `/private/tmp` owned prefix 카운트):**

    원본 코드(HEAD에서 복원):   68 → 100   (+32 디렉터리/런)
    수정 후:                   100 → 100   (+0)

가드는 기존 `tests/unit/test-fixtures-do-not-leak-tmp.test.ts`에 붙였다(이미 scan-reach floor가 pin 된 파일).
burndown baseline `tools/dev/temp-lifecycle-burndown.json` = **leak 145파일 / 408사이트**, module-scope **91파일 / 93사이트**.
one-directional(내려가거나 사라지는 것만 허용). stale 엔트리도 RED.

### 1.2 self-skip detector (티켓 5)

기존 정규식은 `test(` 헤더가 **한 줄**이어야 매치했다. `worktree.test.ts`는 per-test timeout 3번째 인자 때문에
biome가 4줄로 감싸므로 `if (!(await gitAvailable())) return` 4개가 **전부 PASS로 기록**되고 있었고 ratchet은 green이었다.
포매터가 룰의 적용 여부를 결정하고 있었다.

`tools/dev/self-skip-sites.ts` — AST로 "test 콜백의 **첫 문장**이 조건부 return인가"만 묻는다. line/title까지 반환.

변환한 파일(전부 silent PASS → visible SKIP):

- `tests/unit/worktree.test.ts` 4건 → `test.skipIf(!GIT_AVAILABLE)` (`hasBinary`는 PATH 조회, subprocess 없음)
- `tests/unit/permission-provenance-closure-r3-hellgate.test.ts` 1건 → 61 pass **1 skip**
- `tests/unit/runtime/win-shell-guard-hellgate.test.ts` 1건
- `tests/unit/posture-phase-modules-hellgate.test.ts` 1건 → **아래 §3.1 발견**

allowlist는 10파일 25사이트로 갱신. 2건은 숫자가 **올라갔는데**(browser-real-chrome-adversarial 2→3,
recursive-file-list-characterization 9→10) 이건 papering이 아니라 **정규식이 못 보던 사이트가 드러난 것**이고
파일 주석에 그렇게 명시했다. 2건(`sphinx-ra-shim`, `git/conflict-parser-differential-fuzz`)은 이미 고쳐져서 제거.

### 1.3 nightly membership 이중 authority (티켓 4)

`tests/integration/lint-debt-reach-e2e.nightly.test.ts`의 `test.skipIf(!nightlyStressEnabled())` 제거.
파일명 `.nightly.`가 `tools/dev/test-policy.ts`에서 단일 authority.

가드는 `tests/unit/_arch/self-skip-reports-as-pass-ratchet.test.ts`에 두 번째 describe로 추가:
AST로 `process.env.QUANTA_TEST_STRESS` 멤버 접근과 `nightlyStressEnabled()` 호출만 잡는다(산문/생성 fixture 문자열은 무시).
ordinary tier conditional body **0**. plumbing 예외 2파일은 이름으로 명시 + stale 검사.

> **왜 별도 파일이 아닌가**: `assertScanPopulation` 신규 등록은 `git add`가 필요한데(자식 런 코퍼스를
> `git grep -l assertScanPopulation`으로 뽑음) 이 티켓은 `git add` 금지다. 그래서 이미 floor가 pin 된
> 파일에 같은 walk를 공유해 붙였다. **커밋 이후** 별도 `_arch` 파일로 떼어내려면 memory
> `scan-reach-guard-enrollment`의 3단 절차를 밟으면 된다.

### 1.4 nested whole-suite 재실행 (티켓 12)

`tests/unit/bench-results-fence-hellgate.test.ts`가 `bench-write-artifacts.test.ts`(5 케이스) 전체를
**child `bun test`로 2회** 돌리고 있었고 그 파일은 normal membership에도 있어서 cold full에서 같은 5케이스가 3번 실행.

→ OS temp dir에 `writeArtifacts` **1회 호출짜리 probe**를 생성해서 그걸 spawn한다(cwd는 repo root라
bunfig preload = 테스트 대상 fence가 그대로 적용된다). repo 트리 안에 `.test.ts`를 만들지 않는 이유는
동시 실행 중인 다른 에이전트의 discovery/tier count가 그걸 주워가기 때문.

- 측정: 2.51s → 2.15s (wall). 구조적 이득은 **cold full에서 중복 케이스 실행 10회 제거**.
- temp root 3개를 body 끝에서 지우던 것도 `finally`로 이동.

가드 `tools/dev/nested-suite-targets.ts` + 위 hygiene 파일. `["bun","test",<repo .test.ts>]`만 잡고
temp 경로/계산된 타깃/존재하지 않는 경로는 잡지 않는다. allowlist는 **이유 문자열이 비면 무효**.

### 1.5 heavy fixture 분리 (티켓 2·3·15·19)

union/intersection 레지스트리 `tests/_helpers/split-universe.ts` + 가드(위 hygiene 파일).
**id는 실제 test title의 `[case:<id>]`를 파싱해서 읽는다** — 손으로 적은 목록이 아니라 두 파일의 실제 내용.

#### (a) `ipynb-render-document-caps` — 메모리

| lane | 파일 | peak RSS (3회) |
|---|---|---|
| baseline | (필터로 0 케이스) | 51 / 53 / 56 MiB |
| before | `ipynb-cell-read-render-hellgate.test.ts` | 620 / 620 / 622 MiB |
| canary | 〃 (분리 후) | 115 / 107 / 107 MiB |
| nightly | `ipynb-render-document-caps.nightly.test.ts` | 599 / 596 / 605 MiB |

테스트별 귀속: `50k capped outputs` 단독 **574 MiB**, `200k cells` 단독 **141 MiB**,
`AT the cell cap` 61 MiB, `chunked base64 10M chars` 55 MiB(=baseline, 배열이 같은 문자열을 참조해서 실제 할당 없음 → 건드리지 않음).

**canary 최소 크기와 근거**
- `doc-cap-cells-boundary` = `MAX_NOTEBOOK_CELLS + 1 = 5001` 셀.
  cap은 등식이라 "capped/not capped"를 구분할 수 있는 최소 입력이 정확히 cap+1이다(5000에서는 둘 다 5000 헤더).
  **length 임계값이 아니라 헤더 개수와 `1 more cell(s) elided` 정확 문자열**을 본다 — 200k가 필요했던 이유가 바로
  length 임계값이었다.
- `doc-cap-outputs-boundary` = `MAX_OUTPUTS_PER_CELL + 1 = 65` 출력, 각각 **2000자(= per-output cap)**.
  폭이 load-bearing: 더 좁으면 문자 cap만 적용하고 개수 cap은 무시하는 구현이 통과한다.
- nightly가 따로 잡는 것: "cap을 **materialize 이전에** 적용하는가". 50k를 join한 뒤 자르는 구현은 경계 canary를
  전부 통과하면서 100MB를 할당한다. 그래서 magnitude는 지운 게 아니라 옮긴 것.

#### (b) `goal-quiet-window-real-time` — 실시간

`tests/e2e-pty/cli-goal-pursuit-e2e.test.ts`의 단일 `await sleep(16_000)`.

- 공용 하네스 `tests/e2e-pty/goal-pursuit-harness.ts`로 3-프로세스 시나리오(`attachToSecondThread`)를 추출해서
  **두 lane이 같은 셋업을 쓴다**(복붙 아님).
- PR lane: 같은 시나리오 + `/goal` → `No goal set.` (attach가 surface objective store를 다시 가리키지 않으면
  가장 먼저 깨지는 관측 가능한 상태). 대기 0초.
- nightly lane: `tests/e2e-pty/cli-goal-quiet-window.nightly.test.ts` — 16s 실시간 canary 1건.
  **왜 줄일 수 없나**: quiet window는 shipped policy가 public 15s로 clamp하고(`QUANTA_GOAL_QUIET_MS: 50` → 15000),
  "attach 후 A의 이미 armed된 타이머가 조용한가"에 대응하는 typed decision이 CLI 표면에 없다. 경과시키는 게 유일한 관측.

측정:

    PR lane  before: 16 pass / 153.74s   after: 16 pass / 140.09s
    nightly:                              1 pass /  24.05s
    awaited fixed sleep (해당 파일): 22,650ms → 6,600ms

### 1.6 fixed wait aggregate gate (티켓 14·16)

`tools/dev/awaited-sleep-budget.ts` — **파일별 합계**를 센다.

- 세는 것: `await sleep(<literal>)`, `await new Promise(r => setTimeout(r, <literal>))`
- 안 세는 것: `Promise.race([p, sleep(n)])`(= timeout, 상한이지 대기가 아님), 루프 안의 sleep(= poll interval).
  이 둘을 세면 **올바른 모양이 추측보다 나쁜 점수**를 받아서 룰이 틀린 걸 가르친다. 텍스트로는 구분 불가 → parse.

ledger `tools/dev/awaited-sleep-budget.json` (ordinary tier만; `.nightly.`는 제외 — 그래야 "nightly로 옮긴다"가
"PR에 둔다"와 다른 점수를 받는다):

    before: 129파일 / 34,530ms
    after:  130파일 / 18,530ms   (-46%)
    최악:   cli-goal-pursuit-e2e 22,650 → 6,600

(전 코퍼스 합계는 34,530 그대로다 — 16,000이 사라진 게 아니라 nightly로 갔다.
 ledger가 세는 건 ordinary tier이고, 그게 PR이 실제로 내는 비용이다.)

추가로 티켓 완료기준 그대로 **"ordinary 파일에 단일 15초 이상 awaited wait 0"** 도 별도 테스트로 pin.
(15,000은 임의값이 아니라 shipped quiet window 값이고, 그 밑에서는 assertion이 실패할 수 없다.)

---

## 2. red-on-injection 증거 (전부 실제 파일에 주입 → 복원)

| # | 주입 | 가드 출력 |
|---|---|---|
| A | `cli-version-flag-e2e.test.ts:54`에 cleanup 없는 `mkdtempSync` | `tests/integration/cli-version-flag-e2e.test.ts: 1 new — lines 54 (leaked: no rm/rmSync in this file names this binding)` |
| B | `worktree.test.ts`의 `rm`을 `finally` 밖으로 (assertion-before-cleanup) | `tests/unit/worktree.test.ts: 2 new — lines 19 (unguarded: …), 38 (unguarded: …)` |
| C | `worktree.test.ts:60` multiline/async 콜백 early return | `tests/unit/worktree.test.ts: 1 new self-skip(s) — tests/unit/worktree.test.ts:60 "clean run auto-removes the worktree and returns the body value"` |
| D | nightly 파일에 `QUANTA_TEST_STRESS` skip 재도입 | `tests/integration/lint-debt-reach-e2e.nightly.test.ts:113 — .QUANTA_TEST_STRESS` |
| E | `bench-results-fence-hellgate` 원본(전체 sibling suite spawn) 복원 | `tests/unit/bench-results-fence-hellgate.test.ts:115 spawns \`bun test tests/unit/bench-write-artifacts.test.ts\`` |
| F | nightly lane에서 case id 1개 rename (유실) | `ipynb-render-document-caps: LOST from both lanes → doc-cap-50k-outputs` |
| G | 같은 case id를 두 lane에 (중복) | `ipynb-render-document-caps: run in BOTH lanes → doc-cap-at-cell-cap` + `LOST from both lanes → doc-cap-200k-cells` |
| H | `bench-write-artifacts.test.ts`에 새 `await sleep(1_500)` | `tests/unit/bench-write-artifacts.test.ts: 1500ms new — 37:1500ms` |

모두 주입 직후 RED, `cp` 복원 직후 GREEN까지 같은 Bash 호출 안에서 확인.

---

## 3. 발견 (내 스코프 밖 — 후속 필요)

### 3.1 🔴 `posture-phase-modules-hellgate`의 "equivalence to shipped presets (core teeth)" 블록이 전면 vacuous

self-skip을 `skipIf`로 바꾸자 **4개 EQUIV 케이스가 전부 skip**으로 드러났다. 확인:

    KNOB_PRESETS 총 17개
    agentless-v3-thin-strict-select                 MISSING
    agentless-v3-thin-strict-closure-select-clean   MISSING
    agentless-v4-proof-clean                        MISSING
    agentless-v4-proof-clean-execfull               MISSING

즉 그 describe 블록은 **한 건도 assert하지 않으면서 4 green PASS**를 내고 있었다(원래 `if (...) return`이라 skip 집계에도 없었음).
지금은 4 skip으로 보인다. `EQUIVALENCES`의 preset 이름을 현재 레지스트리에 맞추거나 블록을 제거하는 판단은
bench knob 레지스트리 오너 몫이다. (기능·ROI: preset composite 동치성 = thin-base+modules 조합이 shipped preset과
같은 거동인지 보는 유일한 behavioral tooth. 지금은 0.)

### 3.2 `tests/unit/evidence-node-failure-static-real-e2e.test.ts` — temp leak (내 소유 아님: `*-real-e2e` 17파일)

`project()`가 매 호출 `evnode-*` root를 만들고 지우는 곳이 없다. 정확한 diff:

```diff
@@ imports
-import { afterAll, beforeAll, expect, test } from "bun:test"
+import { afterAll, beforeAll, expect, test } from "bun:test"
+// (rmSync를 node:fs import에 추가)

@@ 파일 상단 (GATE 선언 뒤)
+/** 이 파일이 만든 모든 fixture root. `afterAll`이 쓸어담는다. */
+const madeProjects: string[] = []

@@ const project = (): string => {
   const dir = realpathSync(mkdtempSync(join(tmpdir(), "evnode-")))
+  madeProjects.push(dir)

@@ describe 안, 기존 afterAll 옆
+  afterAll(() => {
+    while (madeProjects.length > 0) {
+      const dir = madeProjects.pop()
+      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
+    }
+  })
```

escrow 형태라서 `tools/dev/temp-lifecycle.ts`가 `cleaned`로 인식한다(별도 예외 불필요).
적용 후 `tools/dev/temp-lifecycle-burndown.json`의 해당 엔트리를 지워야 stale 검사가 green이다.

### 3.3 tier population

새로 추가한 test 파일 2개는 **둘 다 `.nightly.`** 라서 prepush/pr/full 모집단은 불변, nightly만 +2.
`tools/dev/test-tier-population.json`은 내 소유가 아니라 손대지 않았다. `bun test tests/unit/dev/test-policy-enrollment.test.ts` 13 pass 확인.

---

## 4. 측정으로 **기각**한 항목 (티켓 전제가 현재 HEAD에서 틀림)

`/usr/bin/time -l` maximum resident set size + wall. bun 인터프리터 baseline ≈ 51–56 MiB.

| 티켓 항목 | 파일 | wall | peak RSS | 판정 |
|---|---|---:|---:|---|
| 2. 300k transition | `plan-mode-stress-100k-ops.test.ts` | 183ms | **115 MiB** | 기각 — baseline+25MiB, 0.2초. 분리 = 순수 churn |
| 15. 5MiB boundary | `resource-limit-boundary-hellgate.test.ts` | 186ms | **93 MiB** | 기각 — baseline+5MiB |
| 15. 10MB MCP URI | `mcp-inbound-adversarial-hellgate.test.ts` | 368ms | **87 MiB** | 기각 — baseline |
| 15. 10MB conflict 입력 | `git/conflict-parser.test.ts` | 310ms | **69 MiB** | 기각 — baseline |
| 19. 33MiB office buffer | `xlsx-docx-read-hellgate.test.ts` | 483ms | **68 MiB** | 기각 — baseline |
| 11. daemon 14회 재부팅 | `apps/web-daemon/server.test.ts` | **1.40s / 29 tests** | — | 기각 — 부팅당 ≈50ms. shared fixture로 바꾸면 케이스별 완전격리(가장 강한 격리)를 0.5초와 맞바꾸는 것 |

**"느리게 두더라도 커버리지를 지운다"를 하지 않기 위해 기각했다.** 특히 §11은 red-on-injection(리셋 누락 → 다음 케이스 RED)까지
설계했다가 측정 후 접었다 — 매 케이스 fresh daemon은 리셋 증명이 필요 없는 격리다.

아직 **진짜 무거운데 손대지 않은** 것(다음 순번):

| 파일 | peak RSS | 비고 |
|---|---:|---|
| `tool-cluster-hardening-r1-hellgate.test.ts` | **366 MiB** / 1.45s | 40×4MiB inflate 코퍼스. 경계 canary = 1-entry + max+1, magnitude는 nightly. 티켓 19 그대로 유효 |
| `delta-token-identity-hellgate.test.ts` | **261 MiB** / 0.92s | 50M-char 토큰 fixture (`"x".repeat(50_000_000)`) |
| `ipynb-render-property-fuzz-r2-hellgate.test.ts` | **238 MiB** / 0.44s | 50MB chunked image 케이스가 대부분. 800/300/500/400 seed는 CPU상 무의미(합쳐 0.4초)이므로 **seed를 쪼개는 건 무의미**하고 50MB만 옮기면 된다 |

---

## 5. 남은 것 (기능 + 이유 + ROI)

1. **web-daemon authenticated flow의 20–80ms 추측 18개** (`authenticated-operator-flow-e2e-hellgate.test.ts`, 합계 650ms).
   (기능) 상태 도착을 시간으로 추측 → readiness predicate. (왜) 로드에서 뒤집히는 flake 표면.
   (ROI) 중 — 650ms는 작지만 18사이트가 전부 "도착했겠지"라서 부하 시 false RED 후보. ledger에 pin 되어 있어 더 늘지는 않는다.
2. **`tool-cluster-hardening-r1` / `delta-token-identity` / `ipynb-property-fuzz` 분리** (위 표).
   (기능) PR lane peak RSS. (왜) TVH-13 admission이 predicted peak RSS를 쓰게 되면 366/261/238 MiB가 shard 편성을 지배.
   (ROI) 상 — 셋 합쳐 ~600 MiB를 nightly로. 레지스트리·가드는 이미 있으므로 각 건당 작업량은 ipynb 케이스와 동일.
3. **`evidence-node-failure-static-real-e2e` temp leak** (§3.2 diff 그대로). (ROI) 소 — 1 root/run.
4. **temp burndown 145파일 소각**. (기능) `/tmp` 누적 → `ls /tmp` 지연 → 무관한 테스트 timeout.
   (왜) 지금은 ratchet이 "더 늘지 않음"만 보장. (ROI) 중 — 상위 6파일(subagent-persistence 19, gc.hellgate 16,
   slice-graph 16, disk-store 15, file-transaction 13, file-lock 12)만 처리해도 91사이트.
5. **module-scope temp 93사이트**. (왜) import만으로 디렉터리가 생긴다 = discovery/`-t` 필터 런에서도 비용+누수.
   (ROI) 중 — TVH-11(module-load effect) lane과 겹치므로 합쳐서 하는 게 싸다.
6. **`_arch` 가드 파일 분리**. 지금 `tests/unit/test-fixtures-do-not-leak-tmp.test.ts`가 temp/nested-suite/
   split-universe/sleep-budget 4개 concern을 이고 있다. `git add`가 가능해지면 scan-reach 등록 3단 절차를 밟아
   쪼갤 것. (ROI) 소 — 가독성.

---

## 5b. baseline 재생성 (동시 lane 주의)

`tools/dev/temp-lifecycle-burndown.json` / `tools/dev/awaited-sleep-budget.json` 둘 다
**동시에 변하는 트리의 스냅샷**이다. 다른 lane이 leak을 고치거나 sleep을 줄이면 stale 검사가 RED가 되는데,
그게 ratchet이 의도한 동작이고 고친 쪽이 숫자를 내리면 된다. 재생성은 분석기를 그대로 호출하면 된다
(`--write` 플래그는 일부러 두지 않았다 — 자동 재생성 스위치가 있으면 regression도 같이 흡수한다):

```ts
// temp: tools/dev/temp-lifecycle.ts 의 tempSites/isLeak 를 src/tests/tools 의
//       test-adjacent .ts 전체에 돌려 { leaks, moduleScope } 를 쓴다
//       (tests/_helpers/temp-dir.ts 는 제외 — 오너 모듈 자신)
// sleep: tools/dev/awaited-sleep-budget.ts 의 awaitedSleepTotalMs 를
//        `.nightly.` 가 아닌 파일에만 돌려 { grandTotalMs, perFileMs } 를 쓴다
```

## 6. 내가 하지 못한 것 (blocker)

- **hosted CI 증거 없음**. Actions 빌링 차단(2026-07-10~)은 외부 blocker. 모든 수치는 이 호스트 로컬 실측.
- **`assertScanPopulation` 신규 등록 불가**. 등록 1단계가 `git add`인데 이 작업 지시가 금지. §1.3 참조.
- **full/prepush 회귀 미확인**. 지시대로 단일 파일 실행만 했다. 내가 만진 24개 파일 + 관련 arch ratchet은
  전부 개별 green(§7)이지만, tier 전체 상호작용은 확인하지 않았다.
- **RSS 측정은 단일 호스트/동시 부하 있음**. 다른 에이전트 세션이 같은 박스에서 돌고 있어 3회 반복 수치를 그대로 적었다
  (편차: ipynb canary 115/107/107).

---

## 7. 실행 증거 (verbatim tail)

```
tests/unit/test-fixtures-do-not-leak-tmp.test.ts        25 pass  0 fail  100 expect()   [6.72s]
tests/unit/_arch/self-skip-reports-as-pass-ratchet.ts    8 pass  0 fail   30 expect()   [3.33s]
tests/unit/ipynb-cell-read-render-hellgate.test.ts      23 pass  0 fail   60 expect()   [181ms]
tests/unit/ipynb-render-document-caps.nightly.test.ts    2 pass  0 fail                 [281ms]
tests/unit/bench-results-fence-hellgate.test.ts          8 pass  0 fail   27 expect()   [1.85s]
tests/unit/worktree.test.ts                              4 pass  0 fail   11 expect()   [2.60s]
tests/unit/permission-provenance-closure-r3-hellgate     61 pass 1 skip   0 fail        [1.01s]
tests/unit/posture-phase-modules-hellgate.test.ts        14 pass 4 skip   0 fail        [888ms]
tests/e2e-pty/cli-goal-pursuit-e2e.test.ts              16 pass  0 fail   33 expect()   [140.09s]
tests/e2e-pty/cli-goal-quiet-window.nightly.test.ts      1 pass  0 fail    1 expect()   [24.05s]
(9-file temp cohort)                                    58 pass  0 fail  230 expect()   [13.83s]
tests/unit/_arch/{anti-vacuity,per-test-vacuity,scan-enrollment,module-load-effect}
                                                        70 pass  0 fail  307 expect()   [17.62s]
bun run typecheck:all                                   passed (6894ms)
bun run lint:debt                                       23 diagnostics, 0 regression (exit 0)
```
