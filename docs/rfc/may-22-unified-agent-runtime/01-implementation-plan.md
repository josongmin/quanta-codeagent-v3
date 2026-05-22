# Implementation Plan — Unified Agent Runtime

- **상태**: Draft (depends on 00-rfc.md being Accepted)
- **날짜**: 2026-05-22
- **관련**: [00-rfc.md](./00-rfc.md), RFC-0001 §3.1 (슬라이스 격리)

이 문서는 RFC 본문 design을 *코드 변경 단위*로 분해한다. 어떤 파일을 만들고, 어디를 옮기고, 어떤 슬라이스를 신설/축소하고, 어떤 phase에 무엇을 검증하는지를 모두 명시한다.

---

## 1. 최종 모듈 토폴로지

### 1.1 새로 생기는 슬라이스

```
src/
  agent/
    run-mode/                     [NEW slice]
      types.ts                    AgentMode + ModePolicy + 12 lever 타입
      presets.ts                  4 mode × 12 lever 매트릭스 (preset 번들)
      narrow.ts                   type-narrow + 매트릭스 invariant assert
      clamp.ts                    dials → caps clamp with surface warning
      index.ts                    barrel
    budget/                       [NEW slice]
      types.ts                    BudgetDials, BudgetCaps, BudgetExhaustionPolicy
      meter.ts                    BudgetMeter — 누적 측정 + clamp + exhaustion fire
      events.ts                   BudgetEvent (trajectory에 출력)
      index.ts                    barrel
    prompt-rules/                 [EXPAND existing single file]
      core.ts                     공통 6 rule (R-ENV 등)
      assistant.ts                interactive pack
      task-runner.ts              headless pack
      benchmark.ts                batch pack
      pr-agent.ts                 ci-bot pack
      index.ts                    barrel + renderPackByMode()
  apps/
    agent/                        [NEW unified entry]
      index.ts                    CLI entry (--mode 파싱, dispatch)
      assemble.ts                 mode + dials → AgentConfig
      cli-args.ts                 argv → AssembleRequest
      run.ts                      runAgent wrapper + exit handling
      mode-presets/               [신설 — preset 분기 wiring]
        interactive.ts            interactive 전용 wiring (REPL stdin/stdout 진입)
        headless.ts               headless 전용 wiring
        batch.ts                  batch 전용 wiring (eval driver 호출)
        ci-bot.ts                 ci-bot 전용 wiring (PR 컨텍스트, gh)
    bench/                        [SHRINK — eval driver만 남음]
      eval/                       [기존 runner.ts를 분해]
        driver.ts                 instance loop + verdict aggregation
        sandbox.ts                per-instance cp + cleanup
        snapshot.ts               withGitSnapshot (T2 pathspec exclude 포함)
        verdict.ts                testCmd 실행 + verdict 결정
        repair.ts                 (기존 repair/ 슬라이스 그대로 이전)
        report.ts                 predictions.jsonl + report.json 작성
        observe.ts                (기존 observe.ts)
        env-prep.ts               (T4 setupCmd + env_setup_commit checkout)
      harness/                    (기존, 그대로 유지 — docker grading)
      corpus/                     [신설 — corpus loading 분리]
        loader.ts                 (기존 swebench.ts)
        dataset.ts                (기존 swebench-dataset.ts)
        cache-pathspecs.ts        (기존)
        failure-classifier.ts     (기존)
        paths.ts                  (기존 benchHome SSOT)
      index.ts                    얇은 wrapper → apps/agent --mode batch
    cli/                          [SHRINK — REPL만 남음]
      index.ts                    얇은 wrapper → apps/agent --mode interactive
      repl.ts                     stdin/stdout REPL (mode=interactive 진입)
      session-io.ts               session save/resume (interactive-only)
```

### 1.2 슬라이스 격리 (biome boundaries) 갱신

- **`@/agent/run-mode`** — type-only slice. `@/agent/budget`, `@/agent/prompt-rules`, `@/permission`, `@/llm`만 import. 다른 슬라이스(`apps/*`)는 cross-import 금지.
- **`@/agent/budget`** — type + 순수 state machine. `@/observability` 외 import 없음.
- **`@/agent/prompt-rules`** — pure data. import 없음 (현재와 동일).
- **`@/apps/agent`** — cross-slice 조립자 (현재 `apps/cli`처럼). 모든 슬라이스 import 가능.
- **`@/apps/bench/eval`** — `apps/agent`에서만 호출되는 도메인 module. 자체 슬라이스 격리 유지.

새 cross-slice import 룰은 [biome.json](biome.json) overrides에 한 줄 추가.

### 1.3 기존 슬라이스 영향

| 슬라이스 | 영향 | 변경 종류 |
|---|---|---|
| `@/agent/loop` | `runAgent`가 BudgetMeter 인스턴스 받고 hook 사이트마다 `meter.tick()` 호출 | 코드 수정 (additive — null-default) |
| `@/agent/prompt.ts` | `buildSystemPrompt(opts)`가 `promptPack` 인자 받음 | 시그너처 확장 (default = assistant) |
| `@/permission` | 변경 없음 (HITL gate 그대로) | — |
| `@/tool` 슬라이스 본체 | 변경 없음 (도구 자체) | — |
| `@/lsp` | 변경 없음 | — |
| `@/apps/cli`, `@/apps/bench` | 90% shrink — 얇은 wrapper만 남음 | 대규모 이동 (move + adapt) |

### 1.4 모듈화 원칙

- **mode 정의는 agent core 안에 (agent/run-mode/)** — 어디서 호출되든 type-level invariant 그대로 강제됨
- **mode-별 wiring은 apps/agent/mode-presets/에** — 각 preset이 외부 의존(REPL/eval driver/PR context) 가져옴
- **도메인 module(bench eval driver)은 자체 슬라이스 유지** — apps/agent가 strategy pattern으로 주입받음
- **모든 lever는 default-OFF / null-as-noop** — 합법적 모드 조합이 아닌 경우 type 차단 + 런타임 assert

---

## 2. 코드 변경 inventory (파일 단위)

### 2.1 신규 파일 (~17개)

| 파일 | LOC 추정 | 책임 |
|---|---|---|
| `src/agent/run-mode/types.ts` | 120 | `AgentMode`, `ModePolicy`, 12 lever 모두 타입 |
| `src/agent/run-mode/presets.ts` | 80 | 4 mode × 12 lever 매트릭스 (불변 const) |
| `src/agent/run-mode/narrow.ts` | 40 | `narrowConfig<M>()` 헬퍼 + 런타임 assert |
| `src/agent/run-mode/clamp.ts` | 50 | `clampToCaps(dials, caps)` + warn |
| `src/agent/run-mode/index.ts` | 10 | barrel |
| `src/agent/budget/types.ts` | 60 | `BudgetDials`, `BudgetCaps`, `BudgetExhaustionPolicy` |
| `src/agent/budget/meter.ts` | 180 | `BudgetMeter` 클래스 — tick/record/checkExhausted |
| `src/agent/budget/events.ts` | 30 | `BudgetEvent` (trajectory 출력 shape) |
| `src/agent/budget/index.ts` | 10 | barrel |
| `src/agent/prompt-rules/core.ts` | (이동) | (현재 단일 파일을 이 위치로) |
| `src/agent/prompt-rules/assistant.ts` | 5 | re-export core (변형 없음) |
| `src/agent/prompt-rules/task-runner.ts` | 20 | core 일부 + headless 특화 |
| `src/agent/prompt-rules/benchmark.ts` | 30 | core + R-NO-SHIM 강조 + R-NO-EXPLORE-OVER-EDIT |
| `src/agent/prompt-rules/pr-agent.ts` | 40 | core + R-SMALL-DIFF + R-EXPLAIN-IN-PR + R-NO-PUSH-MAIN |
| `src/agent/prompt-rules/index.ts` | 30 | `renderPackByMode(mode)` 디스패치 |
| `src/apps/agent/index.ts` | 100 | unified entry — argv 파싱 + dispatch |
| `src/apps/agent/cli-args.ts` | 150 | argv → `AssembleRequest` (mode, dials, overrides) |
| `src/apps/agent/assemble.ts` | 200 | mode + dials → `AgentConfig` (단일 wiring) |
| `src/apps/agent/run.ts` | 80 | `runAgent` 호출 + exhaustion 핸들링 + exit code |
| `src/apps/agent/mode-presets/interactive.ts` | 60 | REPL + reviewer port wiring |
| `src/apps/agent/mode-presets/headless.ts` | 40 | -p 인자 처리, stdout/json 출력 |
| `src/apps/agent/mode-presets/batch.ts` | 60 | eval driver 호출, structured report |
| `src/apps/agent/mode-presets/ci-bot.ts` | 70 | PR 컨텍스트, gh CLI, branch-only git write |

**신규 총합**: ~1400 LOC, 23 파일.

### 2.2 이동 파일 (기존 → 새 위치)

| 기존 | 새 위치 | 이유 |
|---|---|---|
| `src/agent/prompt-rules.ts` | `src/agent/prompt-rules/core.ts` | 파일 → 슬라이스로 확장 |
| `src/apps/bench/runner.ts` (분해) | `src/apps/bench/eval/driver.ts` + `eval/sandbox.ts` + `eval/snapshot.ts` + `eval/verdict.ts` + `eval/report.ts` + `eval/env-prep.ts` | per-책임 분리 |
| `src/apps/bench/swebench-dataset.ts` | `src/apps/bench/corpus/dataset.ts` | corpus 책임 그룹화 |
| `src/apps/bench/swebench.ts` | `src/apps/bench/corpus/loader.ts` | 동일 |
| `src/apps/bench/cache-pathspecs.ts` | `src/apps/bench/corpus/cache-pathspecs.ts` | 동일 |
| `src/apps/bench/failure-classifier.ts` | `src/apps/bench/corpus/failure-classifier.ts` | 동일 |
| `src/apps/bench/paths.ts` | `src/apps/bench/corpus/paths.ts` | (또는 그대로, 영향 적음) |
| `src/apps/bench/python-swebench.ts` | (제거 — `harness/`로 흡수 끝남) | 이미 진행 중 |
| `src/apps/bench/repair/` | `src/apps/bench/eval/repair/` | eval 하위 그룹화 |
| `src/apps/bench/index.ts` | `src/apps/bench/index.ts` (얇은 wrapper로 축소) | apps/agent로 위임 |
| `src/apps/cli/index.ts` | `src/apps/cli/index.ts` (얇은 wrapper) | apps/agent로 위임 |
| `src/apps/cli/internal.ts` (`buildTooling`, `lspNavEnabled` 등) | 일부는 `src/apps/agent/assemble.ts`로 흡수, 일부는 `src/apps/cli/repl.ts`로 | 책임 분리 |

### 2.3 수정 파일

| 파일 | 변경 |
|---|---|
| `src/agent/loop.ts` | `AgentConfig`에 `modePolicy` + `budgetMeter` 옵션 추가. tick 사이트(턴 시작/도구 호출/모델 호출/테스트 호출) 5곳에 `meter.tick(kind)`. 모두 default-OFF (meter 없으면 byte-identical). |
| `src/agent/prompt.ts` | `buildSystemPrompt(_cwd, opts?: { persona?, promptPack? })` — promptPack 미지정 = 현재 default rules (back-compat) |
| `src/agent/types.ts` | `AgentConfig`에 `modePolicy?: ModePolicy`, `budgetMeter?: BudgetMeter` 필드 (optional, default-OFF) |
| `src/agent/index.ts` | barrel에 `run-mode`, `budget` 모듈 export 추가 |
| `src/shared/runtime-config.ts` | `mode` 관련 env 추가: `QUANTA_AGENT_MODE` (default `interactive`), budget override env (`QUANTA_BUDGET_MAX_TURNS` 등) — 기존 `QUANTA_MAX_TURNS`는 alias 유지 |
| `biome.json` | `agent/run-mode`, `agent/budget`, `apps/agent` slice rules 추가 |
| `package.json` | `scripts.cli`, `scripts.bench` → `bun run agent --mode interactive`/`--mode batch` 라우팅. 새 `scripts.agent` 추가 |
| `tsconfig.json` | path aliases 추가: `@/agent/run-mode`, `@/agent/budget`, `@/apps/agent` |

### 2.4 삭제 / deprecate

| 항목 | 처리 |
|---|---|
| `apps/bench/runner.ts` 모놀리스 | 분해 후 제거 |
| `apps/cli/internal.ts`의 `buildTooling` (apps-only) | apps/agent/assemble.ts로 흡수 후 제거 |
| 기존 `prompt-rules.ts` 단일 파일 | 슬라이스화 후 삭제 |

---

## 3. Phase 분해 (6 phase)

각 phase는 **단독 PR**, 다음 phase는 이전 phase merge 후 시작. 회귀는 매 phase 끝에 9-task bench regression run으로 측정.

### Phase 0 — 타입 슬롯 + ADR (no-op)

**목표**: 새 타입을 코드에 추가하되 *사용 0*. 빈 슬롯만.

**파일 작업**:
- 신규: `src/agent/run-mode/types.ts`, `src/agent/run-mode/presets.ts`, `src/agent/run-mode/index.ts`
- 신규: `src/agent/budget/types.ts`, `src/agent/budget/index.ts`
- 수정: `src/agent/index.ts` (barrel에 export 추가)
- 신규: `docs/decisions/0083-unified-agent-runtime.md` (ADR — RFC 수락 결정)
- 신규: `tsconfig.json` path aliases

**검증**:
- `bunx tsc --noEmit` 통과
- 기존 모든 unit/integration 테스트 통과 (코드 변경 0이라 자동)
- 9-task bench regression baseline 캡처: turns/patch-bytes/verdicts 기록 (`docs/rfc/may-22-unified-agent-runtime/baseline-9task.json` 저장)

**Deliverable**: 1 PR, ~300 LOC, 컴파일 통과만.
**Risk**: 거의 0. 코드 변경 없음.
**Rollback**: PR revert로 즉시 가능.

---

### Phase 1 — BudgetMeter + clamp + exhaustion (default-OFF)

**목표**: budget 누적/clamp/exhaustion 로직을 agent loop에 연결하되 *cfg.budgetMeter가 undefined면 byte-identical 동작 유지*.

**파일 작업**:
- 신규: `src/agent/budget/meter.ts` (BudgetMeter 클래스)
- 신규: `src/agent/budget/events.ts` (BudgetEvent shape)
- 신규: `src/agent/run-mode/clamp.ts` (`clampToCaps`)
- 수정: `src/agent/loop.ts` — 5 tick 사이트에 `cfg.budgetMeter?.tick(kind)` (옵셔널 체인)
- 수정: `src/agent/types.ts` — `AgentConfig.budgetMeter?: BudgetMeter` 추가
- 신규: `tests/unit/agent/budget-meter.test.ts` (pure state machine 단위 테스트)
- 신규: `tests/unit/agent/budget-loop-integration.test.ts` (loop이 meter를 정확히 호출하는지)

**검증**:
- 새 unit 12+개 통과
- 모든 기존 테스트 통과 (default-OFF 보장)
- 9-task regression: budget meter 비활성 상태로 baseline과 동일 결과 확인

**Deliverable**: 1 PR, ~400 LOC + tests.
**Risk**: 중. loop.ts 수정이 핵심 동작 경로. mitigation = exhaustive default-OFF 단위 테스트.
**Rollback**: tick 사이트의 `?.tick()` 호출만 제거하면 즉시 복원.

---

### Phase 2 — Bench를 새 shape에 어댑트

**목표**: bench가 새 `ModePolicy` shape를 받아 동작. *사용자 가시적 동작 변화 0*.

**파일 작업**:
- 분해: `apps/bench/runner.ts` → `apps/bench/eval/{driver,sandbox,snapshot,verdict,report,env-prep}.ts`
- 이동: corpus 책임 → `apps/bench/corpus/`
- 수정: `apps/bench/index.ts` — `ModePolicy.batch` preset + BudgetCaps `policy.budgetCaps` + `BudgetMeter` 인스턴스화. 기존 cli flag 모두 작동
- 신규: `tests/integration/bench-runtime-shape.test.ts` — 새 shape로 동일 verdict 산출 확인

**검증**:
- bench 9-task regression: Phase 0 baseline과 **patch shape / turns / verdict 모두 일치** 검증 (byte-identical 아니어도 OK — observe trajectory는 timing 변화 가능. 단, predictions.jsonl과 verdict는 일치)
- 기존 bench unit + integration 테스트 모두 통과

**Deliverable**: 1-2 PR, ~600 LOC (이동 + adapt).
**Risk**: 중-상. runner.ts 분해가 가장 큰 코드 이동. mitigation = pure 이동 + adapter 패턴으로 각 단계 isolated 테스트.
**Rollback**: 단일 commit revert. 단, dependent commit이 있으면 sequential revert 필요.

---

### Phase 3 — CLI를 새 shape에 어댑트

**목표**: CLI가 `ModePolicy.interactive` preset 사용. 사용자 가시적 변화 0.

**파일 작업**:
- 신규: `apps/cli/repl.ts` (REPL stdin/stdout 로직 분리)
- 신규: `apps/cli/session-io.ts` (session save/resume)
- 수정: `apps/cli/internal.ts` — `buildTooling` 일부를 `apps/agent/assemble.ts` 친화 shape로 (Phase 4 준비)
- 수정: `apps/cli/index.ts` — `ModePolicy.interactive` + `BudgetMeter` 인스턴스화 + reviewer port wiring

**검증**:
- CLI smoke test (인터랙티브 시작 → simple task → 종료)
- session save/resume e2e 테스트 통과
- hooks/MCP 로딩 e2e 통과
- `--mode plan`, `--mode review` 동작 확인 (mode discriminator + plan/review submode 직교)

**Deliverable**: 1 PR, ~400 LOC.
**Risk**: 중. REPL/session/mode-switch 복잡도. mitigation = 변경 전후 동일 시나리오 회귀.
**Rollback**: 단일 commit revert.

---

### Phase 4 — apps/agent 통합 entry + assemble.ts

**목표**: 두 앱이 같은 `apps/agent/assemble.ts`를 호출. drift 불가능 상태 도달.

**파일 작업**:
- 신규: `apps/agent/index.ts`, `apps/agent/cli-args.ts`, `apps/agent/assemble.ts`, `apps/agent/run.ts`
- 신규: `apps/agent/mode-presets/{interactive,headless,batch,ci-bot}.ts` (ci-bot은 stub만, Phase 5에서 구현)
- 축소: `apps/cli/index.ts`, `apps/bench/index.ts` — 모두 얇은 wrapper로 (`apps/agent`에 위임)
- 수정: `package.json` — `scripts.cli`, `scripts.bench` 라우팅 + 새 `scripts.agent`
- 신규: `tests/integration/apps-agent-unified.test.ts` — 같은 task가 mode interactive vs batch로 다른 결과 contract 검증
- 신규: `tests/unit/apps/agent/assemble.test.ts` — mode + dials 조합별 AgentConfig shape 검증

**검증**:
- `bun run cli`, `bun run bench` 둘 다 기존과 동일 동작
- 새 `bun run agent --mode interactive`, `bun run agent --mode batch --corpus X` 동작 확인
- 9-task regression — Phase 0 baseline과 일치
- **drift detector test**: lspNavTools가 모든 mode 매트릭스 셀에서 같은 knob을 따르는지 명시 assert

**Deliverable**: 1 PR, ~500 LOC.
**Risk**: 중. routing layer. mitigation = legacy alias가 정확히 같은 args 전달하는지 단위 테스트.
**Rollback**: 단일 commit revert. apps/cli, apps/bench의 기존 코드를 잠시 둔 채 새 apps/agent를 추가만 하고 라우팅 변경은 별도 commit으로 — 그러면 라우팅 revert가 한 줄.

---

### Phase 5 — ci-bot 모드 (새 surface)

**목표**: 4번째 모드 추가. 기존 3 mode 동작 그대로.

**파일 작업**:
- 신규: `apps/agent/mode-presets/ci-bot.ts` (Phase 4의 stub 구현)
- 신규: `src/permission/gh-policy.ts` (gitWrite=branch-only, network=allowlist 구현)
- 신규: `src/runtime/network-allowlist.ts` (allowlist 검사)
- 신규: `tests/integration/ci-bot-mode-e2e.test.ts` — 실제 dummy repo로 PR comment 만드는 시나리오
- 신규: `tools/feature-catalog/features/01-agent-loop/ci-bot-mode.yaml`

**검증**:
- ci-bot 모드 e2e: PR 컨텍스트 시뮬레이션 → diff-ready termination → github-check output
- network allowlist invariant: 허용 host만 outbound 가능
- gitWrite branch-only invariant: main branch에 commit 시도하면 deny

**Deliverable**: 1 PR, ~500 LOC.
**Risk**: 낮. 신규 surface 추가, 기존 영향 없음.
**Rollback**: PR revert.

---

### Phase 6 — Anti-regression invariants

**목표**: drift 재발 방지를 type + test로 잠금.

**파일 작업**:
- 신규: `tests/unit/agent/agent-wiring-invariants.test.ts` — RFC §6.1
- 신규: `tests/unit/agent/mode-matrix-invariants.test.ts` — RFC §6.2
- 신규: `tests/unit/agent/agent-config-shape.test.ts` — RFC §6.3
- 수정: 기존 `tests/unit/src-no-sketchy-code.test.ts` — mode 매트릭스 셀이 완전히 채워졌는지 정적 분석 추가

**검증**:
- 모든 anti-regression 테스트 통과
- 의도적 invariant 위반 (예: bench가 reviewer port 사용 시도) 코드 추가 → 테스트가 실패하는지 검증 (red phase 명시 기록)

**Deliverable**: 1 PR, ~300 LOC tests.
**Risk**: 0. test-only.

---

## 4. Phase 시퀀싱 + 의존

```
Phase 0 (타입 슬롯)
   │
   ▼
Phase 1 (Budget meter, default-OFF)  ◀── 독립
   │
   ▼
Phase 2 (Bench adapt)  ──────┐
                              │     양쪽 어댑트 끝나면
Phase 3 (CLI adapt)  ─────────┤        Phase 4로
                              │
                              ▼
                       Phase 4 (apps/agent 통합)
                              │
                              ▼
                       Phase 5 (ci-bot, optional 시점)
                              │
                              ▼
                       Phase 6 (anti-regression lock)
```

**스토리**: Phase 0~3은 독립 PR, sequential. Phase 4가 통합 PR (의존성 핵심). Phase 5는 신규 surface 필요할 때만. Phase 6은 통합 후 잠금.

**예상 일정 (full-time 기준)**:
- Phase 0: 0.5d
- Phase 1: 1.5d (meter + tick + 단위 테스트)
- Phase 2: 2d (runner.ts 분해가 큰 작업)
- Phase 3: 1d
- Phase 4: 1.5d
- Phase 5: 1.5d (별도 트리거 시)
- Phase 6: 0.5d

**총**: ~7-8 dev-day (Phase 5 제외 시 6d). 사이즈 작은 폴리시 변경 ROI는 작지만, drift 방지 + 새 surface 추가 비용 감소로 net positive.

---

## 5. Anti-regression invariants — 구체 항목

Phase 6에서 잠그는 invariant 14개:

### 5.1 Type-level (컴파일 에러로 차단)

1. `AgentConfig.mode === "batch"` ⇒ `permission.kind === "auto"` (narrowConfig 강제)
2. `AgentConfig.mode === "interactive"` ⇒ `permission.kind === "reviewer-backed" | "auto"` (multi-allow narrowing)
3. `AgentConfig.mode !== "interactive"` ⇒ `exhaustion !== "ask-user"`
4. `mode === "batch"` ⇒ `externalDeps.kind === "hermetic"` (hooks/MCP 차단 type-level)
5. `mode === "ci-bot"` ⇒ `gitWrite.kind === "branch-only"`

### 5.2 Runtime assert (방어)

6. assemble.ts가 type-narrow 우회 시 throw — `assertModeMatrix(cfg)` 호출
7. BudgetMeter.tick()이 unknown tick kind 받으면 throw

### 5.3 Wiring test (드리프트 검출)

8. `lspToolsEnabled=true` 모든 4 mode에서 lsp_* 도구가 registry에 존재
9. `gitToolsEnabled=true` 모든 4 mode에서 git_* 도구가 registry에 존재
10. `mcpServers != []` AND `externalDeps.kind === "host"` 일 때만 MCP 도구 등록
11. `hooks != null` AND mode === "interactive" 일 때만 hook 채널 활성
12. `promptPack` 4개가 mode와 1:1 매핑

### 5.4 Behavior test (회귀 검출)

13. 9-task bench regression — Phase 0 baseline의 turns/patch-bytes/verdict와 일치 (±tolerance for non-determinism)
14. CLI smoke: `bun run cli` 시작 → 단순 task → `/quit` — 5초 이내 정상 종료

---

## 6. 검증 전략

### 6.1 각 phase 끝 게이트

```
bunx tsc --noEmit                              # type check
biome lint src/                                 # slice rules
bun test tests/unit                             # unit (~ 1500 tests)
bun test tests/integration -t "agent|bench|cli" # integration
bash docs/rfc/may-22-unified-agent-runtime/regression-9task.sh
                                                # 9-task bench → diff vs baseline
```

### 6.2 Regression baseline (Phase 0 캡처)

`docs/rfc/may-22-unified-agent-runtime/baseline-9task.json`:
```json
{
  "captured": "2026-05-XX (Phase 0)",
  "instances": [
    {"id": "py.repo.swebench_django.017", "turns": 9, "patch_bytes": 794, "verdict": "completed_unresolved"},
    ...
  ],
  "tolerance": {"turns": 20, "patch_bytes_pct": 30}
}
```

`tolerance`는 모델 비결정성 흡수 — verdict가 일치하고 turns/bytes 범위 안이면 OK.

### 6.3 회귀 자동화

`docs/rfc/may-22-unified-agent-runtime/regression-9task.sh`:
- gpt-5-mini로 9-task 실행
- 결과를 baseline JSON과 diff
- tolerance 초과 시 exit 1

PR마다 CI에서 자동 실행 (cost ~$0.5/PR).

---

## 7. Repo 변경 작업 inventory

### 7.1 신규 디렉토리

```
src/agent/run-mode/          (5 files)
src/agent/budget/            (4 files)
src/agent/prompt-rules/      (6 files, 기존 1파일이 분해)
src/apps/agent/              (4 files)
src/apps/agent/mode-presets/ (4 files)
src/apps/bench/eval/         (~7 files, 기존 runner.ts 분해)
src/apps/bench/corpus/       (5 files, 기존 파일들 이동)
docs/rfc/may-22-unified-agent-runtime/  (3 files: 00-rfc.md, 01-implementation-plan.md, baseline-9task.json)
```

### 7.2 단일 PR 단위 매핑

| PR | Phase | 주요 파일 | LOC | 의존 |
|---|---|---|---|---|
| #1 | 0 | run-mode/types,presets,narrow + budget/types + ADR-0083 | 350 | none |
| #2 | 1 | budget/meter + loop.ts tick 사이트 + tests | 500 | #1 |
| #3 | 2 | bench eval/ 분해 + corpus/ 이동 + adapt | 700 | #2 |
| #4 | 3 | cli repl/session-io + adapt | 450 | #2 |
| #5 | 4 | apps/agent + assemble + alias | 600 | #3 + #4 |
| #6 | 5 | ci-bot mode + gh-policy + network-allowlist | 550 | #5 |
| #7 | 6 | anti-regression invariants 14개 | 350 | #5 |

**총합**: 7 PRs, ~3500 LOC (분해/이동 포함, 신규 ~1400 LOC).

### 7.3 package.json 변경 (Phase 4)

```diff
 "scripts": {
-  "cli": "bun run src/apps/cli/index.ts",
-  "bench": "bun run src/apps/bench/index.ts",
+  "agent": "bun run src/apps/agent/index.ts",
+  "cli": "bun run src/apps/agent/index.ts --mode interactive",
+  "bench": "bun run src/apps/agent/index.ts --mode batch",
+  "headless": "bun run src/apps/agent/index.ts --mode headless",
+  "ci-bot": "bun run src/apps/agent/index.ts --mode ci-bot"
 }
```

기존 사용자 명령어 그대로 동작 (alias).

### 7.4 biome.json 슬라이스 룰 추가

```diff
 "overrides": [
   ...기존...
+  {
+    "include": ["src/agent/run-mode/**"],
+    "linter": {
+      "rules": {
+        "style": {
+          "noRestrictedImports": {
+            "options": { "paths": [
+              { "name": "@/apps", "message": "run-mode is type-only, cannot import apps" },
+              { "name": "@/llm", "message": "run-mode is type-only, cannot import llm" }
+            ] }
+          }
+        }
+      }
+    }
+  },
+  {
+    "include": ["src/agent/budget/**"],
+    "linter": { ... 비슷 ... }
+  },
+  {
+    "include": ["src/apps/agent/**"],
+    "linter": { /* 모든 슬라이스 import 허용 (조립자) */ }
+  }
 ]
```

---

## 8. 운영자 영향 (operator-facing changes)

### 8.1 명령어 변경

- `bun run cli` → 동일 동작 (alias로 라우팅)
- `bun run bench --corpus X` → 동일 동작
- 신규: `bun run agent --mode <mode>` — 일반화된 entry
- 신규: `bun run headless -p "<task>"` — Claude Code식 단발 실행
- 신규: `bun run ci-bot --pr <num>` — GitHub PR 모드

### 8.2 env 변경

- 기존 `QUANTA_*` env 모두 유지
- 신규 `QUANTA_AGENT_MODE` — default `interactive` (legacy CLI 호환)
- 신규 `QUANTA_BUDGET_MAX_TURNS`, `QUANTA_BUDGET_MAX_COST_USD` 등 (operator 다이얼)

### 8.3 사용자 가시 cap 메시지

operator가 cap 위반 dial 줄 때:
```
[budget-cap] requested maxWallClockMs=999999999, mode 'batch' caps at 1800000.
             clamping to 1800000. Use --mode headless or interactive for higher caps.
```

silent clamp 안 함 (RFC §7.1 §6 결정).

---

## 9. 리스크 + 완화

| 리스크 | 확률 | 영향 | 완화 |
|---|---|---|---|
| Phase 2-3 마이그레이션 중 사용자 경험 변화 | 낮 | 중 | alias가 정확히 같은 args 전달 — 단위 테스트로 강제 |
| BudgetMeter가 hot path에 오버헤드 | 낮 | 낮 | tick()은 increment만, allocation 없음 — bench profile에서 측정 |
| ci-bot의 gh CLI 의존성 | 중 | 낮 | optional dep — `gh` 없으면 ci-bot 모드 기동 거부, 다른 모드 무영향 |
| Anti-regression 테스트가 false positive | 중 | 낮 | tolerance + 명시 baseline 캡처 |
| 슬라이스 격리 위반 | 낮 | 중 | biome lint가 CI에서 차단 |
| 16-week 사이 다른 RFC가 충돌 | 중 | 중 | Phase 0-1만 먼저 머지 (no-op), 나머지는 다른 RFC 안정화 후 |

---

## 10. 후속 가능성 (이 RFC 밖)

- **`web` surface**: server + thin client 시점에 별도 RFC. 현재는 단일 process 전제.
- **`daemon` surface**: 백그라운드 agent. headless mode를 daemonize한 형태 — 별도 RFC.
- **`ide-plugin` surface**: editor LSP-like — apps/agent를 RPC로 노출. C 패턴 RFC 트리거.
- **Mode plugin system**: 4 mode가 5-6개를 넘으면 hardcoded enum → plugin pattern (별도 RFC).
- **Budget-aware planner**: BudgetMeter의 남은 cap을 model context에 노출해 self-planning. 별도 ADR 후보.

---

## 11. 결정 체크리스트 (PR 머지 전)

각 PR이 머지되기 전 점검:

- [ ] tsc clean
- [ ] biome lint clean
- [ ] 새/수정 단위 테스트 추가
- [ ] 모든 기존 테스트 통과
- [ ] 9-task regression baseline tolerance 안
- [ ] slice 격리 규칙이 올바르게 적용
- [ ] anti-regression invariant 1+ 새로 잠금 (Phase 6 시)
- [ ] CHANGELOG / ADR 갱신 (해당 시)
- [ ] README 또는 docs/10.feature-catalog.md 갱신 (해당 시)

---

## 12. 변경 이력

| 날짜 | 버전 | 변경 |
|---|---|---|
| 2026-05-22 | Draft | 7-phase 구현 계획 + 모듈 토폴로지 + LOC 추정 + invariants 14개 |
