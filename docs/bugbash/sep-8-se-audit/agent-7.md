# Sep-08 SE audit — agent-7 (Lane A)

> **역할:** Sep-07 SOLID/SE·duplicate-development 캠페인의 **레인 A** 워커.
> 이 파일은 해당 세션에서 직접 연 코드·소비자·스냅샷까지 포함한 **세션 원장**임.
> 정규 영수증은 [`docs/plans/sep-7-solid-se-audit/receipts/W1-A.md`](../../plans/sep-7-solid-se-audit/receipts/W1-A.md).
> 781파일 TSV 매니페스트는 그 영수증 appendix에만 있음. 여기선 중복하지 않음.

**상태:** 1차 분류 + **2026-09-08 갭필 보완**. 프로덕션 수정 없음.

**날짜:** 2026-09-07 ~ 2026-09-08

**범위:** `src/agent`, `src/activity`, `src/attention`, `src/objective`

> **갭필 성적 (이 파일이 이김, 1차 §5/§7보다 우선):**  
> 캠페인 HEAD `0b14f5cf`에서 N7·S8 트리거는 **재현됨** (WT overlay / 이후 커밋 `9b05cd33`만 고침).  
> P1-A-01 → **P2 강등**. P1-A-02 **KEEP**. P2-A-01 → **P3/텔레메트리 강등**.  
> 신규 **P2-A-04** (인메모리 레지스트리 무상한), **P2-A-05** (diagnostics hook null 영구 캐시).

---

## 1. 세션이 한 일

1. Sep-07 디스패치 팩을 레인 A로 수행함. W0 영수증은 **없었음**. 로컬 프리즈로 HEAD/unstaged/권한 문서 해시를 묶고 워킹 트리를 검사함.
2. A 레인 프로덕션 781파일을 열거하고 A1/A2/A3로 나눠 병렬 점검함. 코디네이터가 핵심 더티 파일·P1/P2 후보를 직접 재검증함.
3. **[1차 오판 — §7/§16이 뒤집음]** 1차는 SEP6 N7·S8을 "재현되지 않음"으로 닫았으나, 캠페인 HEAD `0b14f5cf`에서 **둘 다 재현됨**. SEP5 D8만 미재현 유지.
4. `W1-A.md`만 씀. 소스/테스트/다른 캠페인 문서는 안 고침.

병렬 샤드:

| 샤드 | n | 초점 |
|---|---:|---|
| A1 | 100 | loop / dispatch / retry / recovery / compaction / admissibility / stream-* |
| A2 | 85 | session-registry / plugin / mention / checkpoint / sandbox / untrusted |
| A3-agent | 542 | remaining agent. ≥400줄 딥리드 + 디렉터리 분류 |
| A3-leaf | 54 | activity 12 + attention 3 + objective 39 |

합집합 781, 교집합 공집합. A3 1차 패스는 INCOMPLETE였고, A3b(대용량 55) + A3c(잔여 555 분류)로 닫음.

---

## 2. 스냅샷

검사 시작·종료 모두:

| 항목 | 값 |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` (= `origin/main`, ahead/behind 0) |
| staged SHA-256 | `e3b0c442…` (empty) |
| unstaged SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| 검사 시작 untracked 7파일 매니페스트 | `e3144092830e882813b8faf905e5e8fdebbcd59dddc1f5f5100aa57eb24e2612` |
| W0 | **ABSENT**. 나중에 W0가 이 해시와 다르면 W1-A는 STALE |

권한 문서 (worktree):

| Path | SHA-256 |
|---|---|
| `AGENTS.md` | `79de5da2…1702c` |
| `AGENT_CORE.md` | `d1f585c7…d7d82` |
| `AGENT_PLAYBOOK.md` | `288bb7e2…b4f4b6` |
| `docs/ARCHITECTURE.md` | `16626624…9b0fcf` (검사 시점 DIRTY; `9b05cd33`에 커밋되어 현재 clean) |
| `tests/README.md` | `ba80760a…351967` |
| `package.json` | `97c0650b…556e4` |
| `biome.json` | `86028e6e…39703` |
| `slice-boundary-configs.ts` | `1e570be7…4458d6` (검사 시점 DIRTY; `9b05cd33`에 커밋되어 현재 clean) |
| god-code allowlist | `9ce34fb2…e34a3` (`modules`/`functions` 둘 다 빈 배열) |
| lint-debt ceiling | `b56462a0…aaf24` |

검사 중 언트래킹이 14로 늘어남. 델타 = 형제 `W1-B.md`…`W1-H.md`. HEAD/staged/unstaged/권한 문서는 그대로. 프로덕션 드리프트 아님.

검사 진실: A-owned **더티 파일은 워킹 트리**(SEP6 오버레이). 클린 A 파일은 HEAD. 크로스레인 더티는 A 쓰기 소유권 아님.

시작 언트래킹 7:

- `docs/plans/sep-6-role-contract-audit/tickets/{README,SEP6-01-hitl-retry-fail-closed,SEP6-P2-active-register}.md`
- `docs/plans/sep-7-solid-se-audit/prompts/README.md`
- `src/shared/mention-text.ts` (RESERVED / S8 오너)
- `tests/unit/_arch/slice-boundary-env-allow-hygiene-hellgate.test.ts`
- `tests/unit/mention-first-line-parity-hellgate.test.ts`

---

## 3. 커버리지

| 항목 | 값 |
|---|---|
| A 프로덕션 `.ts` | **781** |
| colocated 테스트 | 108 |
| 프로덕션 줄 | **127901** (프리즈 `0b14f5cf`). 127966은 `9b05cd33` 값 |
| god-module >1000 | **0** |
| cohort 900–999 | **3**: `compaction.ts` 983, `admissibility-gate/gates.ts` 913, `objective/authority.ts` 904 |
| fn>150 | **0**. 정본 AST 검출기(`tools/god-code/detect.ts`) 기준 repo 전체 0이고 ratchet 9/9 green. `dispatchTool`은 `dispatch.ts:113-190` = 선언 78줄 / body 71줄 — 1차의 "113-753 ~641줄"은 brace 스캐너가 함수 끝을 놓치고 `:753` 주석까지 삼킨 오측정(파일 전체가 756줄). `work-metrics-collector.emit` 219줄 주장도 **거짓** (`:40` 1줄 인터페이스 메서드) |
| slice | agent 727 / activity 12 / attention 3 / objective 39 |

이름 휴리스틱 미러 테스트: unit ≈387, integration ≈47. 실행하지 않음 (정적 owner+consumer).

---

## 4. A-owned 더티 오버레이 (도입/악화)

직접 `git status` + 파일 오픈으로 확인함.

| 파일 | 세션 판단 |
|---|---|
| `src/agent/dispatch/execute.ts` | **introduced**. `result.source`와 `classifySource` max-merge. `secret`은 여전히 Layer-1 wipe. 미달 레닥션 아님 → 파인딩 아님 |
| `src/agent/retry.ts` | 주석만 (SEP6-01 / `consult_markers`). kind 테이블 없음. N7 재오픈 안 함 |
| `mention-runner/skill-resolver.ts` + `plugin-app-resolver/{mcp,plugin,skill,subagent}-resolver.ts` | 전부 `mentionFirstLine` (`@/shared`). 로컬 `firstLineOf` 없음. S8 재오픈 안 함 |
| `per-tool-checkpoint/rollback-llm-error-bridge.ts` | 주석만. 프로덕션 와이어 없음. default-OFF |
| `session-resource-registry/{auto-sweep,global,index,inspector,disk-adapter/gc,sqlite-adapter/*}` | inspect/cleanup이 싱글톤 핸들만 봄. **P1-A-01 오퍼레이터 커플링을 악화** |

---

## 5. 유지 파인딩

P0 없음. 런타임 미실행. 아래는 오너 코드 + 도달 소비자를 연 정적 증거임.

### P1-A-01 — 세션 레지스트리 mint vs lifecycle 스플릿-브레인

**불변식:** 프로세스당 `SessionResourceRegistry` Map은 하나고, durable GC/inspect/cleanup이 그 인스턴스를 봄.

**라이브 오너 1 + 도달불가 오너 1:**

- `src/agent/session-resource-registry/global.ts:94-148` — 싱글톤 + `startAutoSweep`. 첫 `runtimeConfig()` 스냅샷 고정. **유일한 라이브 오너.**
- `src/agent/session-resource-registry/caller-owned-builder.ts:91-127` — 매번 새 인스턴스, 스윕 핸들 **없음**, `runtimeConfig()` **재읽음**. ADR-0372가 “글로벌에 emitter를 못 넣으니 우회”라고 문서화함. **단 프로덕션 도달 0** — 아래 §16.1 참조. `unified-api.ts`의 `getOrCreateRegistry`와 `buildCallerOwnedSessionResources`도 프로덕션 호출자 0.

**프로듀서 (레인 G, 증거만):** `src/host/runtime/agent-config-assembler.ts:665-672`

```
metricsEmitter 있음 → buildCallerOwnedRegistryWithTelemetry(...).getOrCreate(sessionId)
없음           → getGlobalSessionResourceRegistry().getOrCreate(sessionId)
```

**스윕/inspect는 싱글톤만:** `auto-sweep.ts:408-420`은 **설정된 path 전부** GC (마운트된 Map이 아님). `inspector.ts:360-372`, CLI `session-registry-cmd.ts`도 싱글톤.

**실패 모드:**

- SQLite 어댑터는 Map-as-truth + sqlite 미러. 같은 `databasePath`에 인스턴스 둘 → Map 둘.
- auto-sweep이 caller-owned durable 파일을 지워도 라이브 Map은 그대로일 수 있음.
- metrics-on 조립은 라이브 mint에 스윕을 안 붙임 → 쓰기 경로에 TTL GC가 없음.

**귀속:** pre-existing (ADR-0372/0383). 더티 오버레이가 inspect/cleanup을 싱글톤 전용으로 묶어서 **악화**.
**증명 한계 아님 — 타입 레벨 도달불가:** `AgentConfig.metrics?: Metrics`(`agent/types.ts:360`)의 `Metrics`는 private 필드를 가진 클래스라 nominal이고(`extends Metrics` 0건), 메서드가 `counter/gauge/timer/snapshot`뿐 — `increment` **0건**. `looksLikeMetricsRegistry`(`metrics-adapter.ts:137-141`)는 `increment`+`gauge`를 요구하므로 절대 통과 못 함. `defaultMetricsRegistry()`가 `cfg.metrics`에 도달하는 사이트도 0.
**SEP5/SEP6 아님.**

**A 쓰기 셋:** `global.ts`, `caller-owned-builder.ts`, `unified-api.ts`, `auto-sweep.ts`.  
**금지:** host assembler, CLI session-registry-cmd (G).  
**의도:** 라이프사이클 오너 하나. caller-owned가 싱글톤+스윕을 물려받거나, metrics-on이 싱글톤을 쓰고 flock 텔레메트리만 주입.

직접 확인한 코드 포인트:

- `global.ts` 주석: “Option A process-level”이 계약. lazy-init + `resetGlobal…` 테스트 격리.
- `caller-owned-builder.ts` 주석: “Mutating global.ts 비목표”, “Every call returns a NEW instance”.
- `auto-sweep.ts:408-420`: diskDir/sqlitePath 길이 >0이면 그 path를 스윕. 마운트 인스턴스와 무관.

---

### P1-A-02 — unknown-model 폴백에서만 갈라지는 USD writer

**범위 정정 (실측):** 가격표에 있는 모델에선 meter와 ledger가 센트까지 일치함 — `gpt-5.6-terra` 1M in/500k cacheRead → 양쪽 1.10, `claude-sonnet-4-6` → 양쪽 3.15, cacheWrite 케이스 → 양쪽 2.50. `DEFAULT_MODEL_PRICING = deriveLedgerPricing(MODEL_RATE_CARD)`(`budget-ledger-pricing.ts:27-28`)로 표가 하나이기 때문. **발산은 unpriced 모델의 `safeFallback` 단일 조건에서만** 발생한다. "이중 USD writer"는 과한 일반화.

**불변식:** `emitUsage`가 한 번 가격하고 모든 sink가 그 숫자를 씀. 두 sink가 같은 이벤트에 다른 합을 내면 안 됨. `emit-helpers.ts:28-32`가 그렇게 적혀 있음.

**두 라이브 오너:**

1. `src/agent/loop/emit-helpers.ts` — `priceUsage` 한 번. unpriced → `pricingKnown:false`, `totalUsd=0`. meter는 `eventCost.pricingKnown`일 때만 `tick("cost_usd")` (`:111`).
2. `src/agent/budget-ledger.ts:474-475,711-713` — `resolvePricing = pricing[model] ?? safeFallback` (`claude-sonnet-4-6`). **같은 이벤트를 재가격**. `pricingKnown`은 false인데 USD는 들어감. 헤더 `:45-49`는 “fail safe-LOUD”라고 명시.

**소비자:** `USAGE_SINKS` 선언은 `emit-helpers.ts:69`; 발산하는 두 sink는 meter `:99-112` / ledger `:121-132`. assembler는 `budgetMeter`를 항상 붙임 (`agent-config-assembler.ts:789`). ledger는 `QUANTA_BUDGET_LEDGER` + cap일 때. 단 `maxCostUsd`는 batch/ci-bot/daemon 프리셋에만 존재(`run-mode/presets.ts:166`=5, `:179`=2, `:199`=3) — interactive/headless/ide엔 코스트 캡 자체가 없음.

**측정 (정적 fixture):** `model="lane-alias-unpriced"`, `inputTokens=1_000_000`.

| sink | 결과 |
|---|---|
| meter | cost tick 없음 → `maxCostUsd`/`wouldExceedCost` 미발동 |
| ledger | sonnet `$3/M in` → **$3.00**. `ledgerHardBreachCondition`으로 hard stop 가능 |
| 주석 `:115-116` | “same SSOT … never disagree” — **이 경로에서 거짓** |

**귀속:** pre-existing (ADR-0136 fail-loud vs MR-05 skip-unpriced).
**meter/ledger 포트 병합 금지** (per-run tick vs UTC daily USD는 다른 계약).
**A 쓰기 셋:** `budget-ledger.ts`가 pre-priced `eventCost`를 쓰거나 이 fan-out에서 fallback 끄기. 선택: `emit-helpers.ts` ledger sink 패스스루.
**금지:** `@/observability/usage-accounting`, host persist.

A3 1차는 P2로 내렸고, A3b가 assembler 항상-meter + 주석 모순을 확인해서 **P1로 올림**. 코디네이터가 `budget-ledger.ts` fallback 주석·`resolvePricing`·`record()` 반환·`emit-helpers` sink를 직접 읽음.

---

### P2-A-01 — PTL / context-window 이중 classifier (unknown/raw)

**불변식:** prompt-too-long이면 compact이지 retry/error가 아님.

**오너 A:** `src/agent/retry.ts:131-139` `PTL_MARKERS`

```
"prompt is too long", "prompt too long", "context length", "context_length",
"context window", "maximum context", "too many tokens"
```

빠진 것: `"context_window_exceeded"`, `"tokens exceed"`.

**오너 B (foreign, W2-X):** `src/shared/error-classifier.ts:61-71` `CONTEXT_WINDOW_MARKERS`에 그 두 개가 있음. 같은 파일이 “Drawn from … `PTL_MARKERS` in `agent/retry.ts` plus Codex wording”이라고 적혀 있어서 **파생 원본이 agent 쪽인데 집합이 어긋남**.

**오너 C (누락됐던 것, 실제로 도는 리스트):** `src/shared/errors.ts:488-497` `ADAPTER_CONTEXT_WINDOW_MARKERS` — `LLMError.fromSdkError` → `classify` → `classifyBadRequest` 경로, 즉 **모든 provider 어댑터 경계**. `context_length_exceeded` + `tokens exceed`는 있고 `too many tokens`·`context_window_exceeded`는 없어 위 두 집합 어느 쪽과도 불일치. 마커 리스트는 **2개가 아니라 3개**.

**소비자:**

- `recovery.ts:244-256` `classifyLLMError` (agent PTL)
- `stream-consume.ts:312-326` shared `classify` (텔레메트리)
- typed `kind === "context_window_exceeded"`는 `codexSpecRoute`로 정렬됨

잔여는 `kind:"unknown"` / 비-`LLMError` + overflow 문구. `decideTypedStreamError`가 typed 경로에서 먼저 빠지면 compact가 안 나고 `{do:"error"}`.

**N7 아님.** kind 테이블은 `retryDispositionForKind` 하나. HITL `no_retry`는 유지.
**더티 `retry.ts`는 주석만.**
**증명 한계:** `fromSdkError` F-CTX-4가 `"tokens exceed"`를 typed kind로 찍으면 이 경로는 숨음. unknown/raw만 남음.

**A 쓰기 셋:** `retry.ts`가 unknown/raw overflow를 `classify`→`codexSpecRoute`에 위임하거나 마커 집합을 맞춤. 선택: `recovery.ts` unknown이 overflow를 마커 retry보다 먼저 봄.
**금지:** `src/shared/error-classifier.ts`, `src/shared/errors.ts`(`ADAPTER_CONTEXT_WINDOW_MARKERS`).

직접 확인: `isRetryable`는 `retryDispositionForKind` 먼저, `consult_markers`만 레거시 마커. `PTL_MARKERS`는 별도 메시지 스캔으로 남음 (kind에 `prompt_too_long` 멤버가 없어서).

---

### P2-A-02 — LSP `--version` 캐시 복제, false-eviction 드리프트

**불변식:** “이 language-server 바이너리가 뜨는가?”는 프로세스당 답이 하나.

**오너 A (정본):** `src/agent/lsp-bridge/availability.ts:14-62`

- 성공만 캐시.
- settled `false`는 evict. 이유: 5s startup timeout 한 번이 프로세스 전체 LSP를 죽이는 풋건 (audit #4).
- in-flight Promise는 공유.

**오너 B:** `src/agent/shadow-verify-adapters/check-lsp-test.ts:63-91`

- 거의 같은 `Bun.spawn([bin,"--version"])` + 5s race.
- **false도 영구 캐시.** evict 코드 없음.
- 주석: “mirrors `@/agent/lsp-bridge` but scoped so this adapter does not depend on bridge internals.”

**소비자 (2곳):** `createShadowVerifyAdapters` → `observability-wire/wire.ts:236` **및 `apps/cli/repl/surface-compose/core-state.ts:233`**. 둘 다 default-OFF 게이트 뒤 (`QUANTA_OBSERVABILITY` / `QUANTA_SHADOW_VERIFY`).

**측정 드리프트:** shadow-verify 경로에서 5s timeout 한 번이면 그 bin의 lint/typecheck가 빈 diagnostics로 skip (graceful skip). bridge 경로는 다음 호출에 재probe.

**A 쓰기 셋:** `check-lsp-test.ts`가 `lspBinaryAvailable`/`isAvailable`을 호출.
**금지:** `@/lsp` (C), shared probe dump.

코디네이터가 두 파일을 나란히 읽음. 프로브 본문은 복사, eviction 정책만 다름.

---

### P2-A-03 — permission auto-classifier 캐시 비유계

**SE축 7** (unbounded memory). 단일 오너. duplicate-authority 아님.

**오너:** `src/agent/auto-classifier.ts:137-165` `Map<string, CacheEntry>`.

- TTL ~1h. 만료 삭제는 **같은 키 get** 때만.
- size cap 없음. 키가 다시 안 오면 엔트리가 안 죽음.
- deterministic allow/block만 캐시. fail-safe block은 안 캐시 (올바름).

**소비자:** `src/runner/assemble/llm.ts:209`, `src/agent/tier1/auto-classifier.ts:23`. 둘 다 `permission.mode === "auto"` 게이트 뒤.

**대조:** `effort-classifier/store.ts`는 이미 ring/LRU.

**부가 냄새 (재현 전엔 inventory):** `parseDecision` `:109` `norm.startsWith("no")` → `notsure`/`noblock`도 allow. 문서 계약은 exact `no`.

**A 쓰기 셋:** max entries + eager TTL sweep 또는 LRU. 선택: exact-token parse.
**금지:** `@/permission` AutoModeClassifier (F).

코디네이터가 `createAutoClassifierPort` 클로저 캐시와 `parseDecision`을 직접 읽음.

---

## 6. 기각·inventory (실패 모드 없음)

세션에서 “같아 보이지만 계약이 다름”으로 내린 것들.

| 항목 | 왜 파인딩 아님 |
|---|---|
| cohort 3파일 | 크기만. 새 실패 모드 없음 |
| `dispatchTool` 크기 | **god-FUNCTION 아님** — 113-190(78줄), body 71. `dispatch.ts` 최장은 `dispatchToolInner` 75줄. 검출기 위반 0 |
| `error-routing` 16-arm vs `codexSpecRoute` 18-kind | `errorRouting`이 `src/apps/**` / `runner/assemble/llm.ts`에 안 붙음. 데드 슬롯 |
| `StreamIdleError` fatal vs `llm/stream-timeout` network-retry | `createDefaultWatchdog`의 `src/` compose 사이트 **0**. A1이 P2로 냈고 코디네이터가 **inventory로 강등** (라이브 소비자 없음) |
| disk vs sqlite GC | 같은 포트의 LSP 어댑터. 저장 단위가 다름 (라인 truncate vs session-row). TTL 14d 둘 다. 동일 입력 픽스처는 안 돌림 |
| 두 skill 팩토리 | 프로덕션 인그레스는 composite `createSkillResolver` 하나. `createSkillOnlyResolver`는 테스트/export만. empty-target 가드는 composite만 있음 → 복사라 듀얼 라이브 오너 아님 |
| S8 first-line | 로컬 `firstLineOf` 없음. 더티 resolver 5개가 `mentionFirstLine` 호출 |
| LLM error bridges | ADR-0237 병렬 암. kind/knob이 다름 (`thread_rollback_failed` vs `sandbox_error`). rollback 브릿지 default-OFF·언와이어 |
| `objective/authority` vs `agent/objective-decision.ts` | policy+CAS writer vs decision-stream 카운터 |
| activity progress vs objective receipts vs observation vs attention vs focus-chain | 네 불변식 |
| glob-rules vs repo-rules vs agent-requested-rules | 경로 패밀리 분리. 후자는 로더가 아니라 matcher. `prompt.ts`는 다른 파일을 같이 넣음 |
| prompt.ts vs prompt-graph vs system-prompt | assembler + atom SSOT + identity projection |
| `stop-category` vs `stop-reason` vs `decideOnAssembled` | outcome vs provider stop_reason vs recovery. `stopReasonPolicy` default-OFF |
| closeout critic fail-open | 문서화된 advisory |
| `execute.ts` source-class merge | introduced, fail-closed. rank가 tool/pty·node-repl과 같음 |
| verification-bundle FAIL-OPEN | 문서화된 oracle 규칙 |
| `parseDecision` startsWith("no") | `notsure` 소비자 재현 없음 |
| `work-metrics-collector.emit` 219줄 | 이 트리에 없음 |
| `RecoveryReason` 두 타입 | `recovery.ts` vs `recovery-reason/types.ts` — 계약이 다름 |
| `session-resources.ts` vs `SessionResourceRegistry` | turn/span/guard 백 vs 레지스트리. 이름만 비슷 |
| sandbox-escalation vs skill-scope-escalation | **셋** 다 `EscalationRequest` export (`skill-scope-escalation.ts:45`, `sandbox-escalation/orchestrator.ts:111`, 레인 밖 `subagent/coordination/broker.ts:44`). OS unsandbox vs skill allowlist. basename 충돌만 |
| plugin-discovery vs plugin-mcp-launcher vs session-resource-registry | 아이덴티티 도메인이 다름 |
| `authority-core-adapter.ts` no-op stubs | prod `asObjectiveAuthority`는 실 authority identity. bare port wrap은 latent LSP |
| prompt-graph `AgentMode`가 `AGENT_PROMPT_MODES`에서 derive 안 됨 | 현재 리터럴은 같음. 드리프트 **위험**, 측정 아님 |
| `HookBus.emit` | 이미 split됨 |
| `approval-state-machine/store.ts` `machineState` | 선언 286-438(153줄)이나 ratchet가 재는 **body는 140줄** ⇒ 150 캡 미만, **ratchet 초과 아님**(검출기 위반 0, `allowlist.functions=[]`). 실패 모드 없음 |
| memory persist vs consolidator | `PersistentStorePort` vs `Stage1StorePort`. 둘 다 session-end에 불리지만 계약이 다름 |
| `verify-guard` vs `prompt-graph/verify` | 루프 finish vs 그래프 정적 검증 |
| `hydrating-scheduler` persist swallow | 단일 오너, 알려진 honesty |
| ownership-policy bash 타깃 미파싱 | 문서화된 fail-open |
| fork-session vs fork-turns vs subagent-background vs side-conversation vs side-agent-runner vs auto-background | 전부 다른 계약 (A3c watch축) |
| model-routing vs sticky-model vs effort vs effort-classifier vs effective-model | 선택 권한 / durable store / 세션 티어 / 키워드 에스컬 / display projection |
| converge vs repro-test vs verification-bundle vs verification-plan vs shadow-verify vs branch-search/verify vs multi-voter vs n-phase | 같은 “green” 단어, 다른 invariant |
| command-hooks vs hooks.ts | disk shell hooks vs HookBus. event-types는 vocabulary split |
| sqlite GC `WHERE cum > ${maxTotalBytes}` | 숫자 interpolation. auto-sweep이 raw env 숫자를 안 넣음. NaN 인그레스 미증명 |

---

## 7. 퇴역 ID — HEAD vs WT 이중진실 (갭필 정정)

1차 원장은 **워킹 트리 overlay**를 shipped처럼 보고 N7/S8을 닫음. W0가 HEAD-only면 그건 잘못임. 형제 W1-E E-N7 / W1-G G-F2가 캠페인 HEAD에서 맞음.

현재 git HEAD는 `9b05cd33` (overlay가 이후 커밋됨). 캠페인 프리즈는 여전히 `0b14f5cf`.

| ID | HEAD `0b14f5cf` | WT / `9b05cd33` | 1차 agent-7 |
|---|---|---|---|
| **N7** | **REOPEN.** `decorator-policy.ts`는 `auth`만 결정적 `no_retry`. `cyber_policy`/`sandbox_*` → `consult_markers`. `retry.ts` `isRetryable` 실행부는 양 트리 동일. `"503 overloaded timeout, try again"` + `kind:cyber_policy` → HEAD **retry**, WT **no_retry**. 결함 오너는 E 파일. A는 소비자 | **WT-ONLY-FIXED** (`hitl_handoff` 전부 `no_retry`) | 잘못 닫음 |
| **S8 / D8** | **REOPEN.** `src/shared/mention-text.ts` **ABSENT**. A 리졸버 5개 로컬 `firstLineOf`. skill/plugin은 **trim 없음** → `"  hello  \\nworld"` = `"  hello  "`. mcp/subagent는 trim. G host/CLI도 trim. 측정 드리프트 | **WT-ONLY-FIXED** (5곳 `mentionFirstLine`) | 잘못 닫음 |
| N12 DAP | 레인 B. A 밖 | — | 유지 |
| S9 lock | 레인 F. A 밖 | — | 유지 |
| SEP5 D7–D30 나머지 | 트리거 미재현 | — | 유지 |

`isRetryable` 본문은 comment-only diff. “kind 테이블이 하나”는 N7을 닫지 않음. HEAD 결함은 HITL이 `consult_markers`로 떨어지는 것임.

file-resolver / git-resolver는 양 트리 first-line 헬퍼 없음. KEEP.

---

## 8. W2-X로 넘긴 fingerprint

레인 A가 외국 슬라이스를 고치지 않음. 비교용.

1. PTL/overflow — `agent/retry.ts#isPromptTooLong` × `shared/error-classifier.ts#classify` × `llm/retry/codex-spec-router.ts` (P2-A-01)
2. same-provider retry disposition — `decorator-policy.ts#retryDispositionForKind` × `agent/retry.ts#isRetryable` × `recovery.ts#decideTypedStreamError` (`not_implemented`: 루프 backoff vs 데코레이터 `no_retry`). 레이어는 다름 (pre-stream vs post-escape)
3. USD — ledger × meter × observability `usageAccounting.record` × host persist (P1-A-02)
4. session registry mint — `global.ts` × `caller-owned-builder.ts` × host assembler G (P1-A-01)
5. mention first-line — HEAD `0b14f5cf`는 A 로컬 `firstLineOf` 5곳 + shared 모듈 없음 (S8 재오픈). WT/`9b05cd33`은 `mentionFirstLine`
6. LLM error bridges — rollback bridge × `runtime/os-sandbox/llm-error-bridge.ts` (B). 모양만 같고 kind/knob 다름. A에서 프로덕션 와이어 없음
7. sensitivity max-merge — `dispatch/execute.ts` × `tool/pty/port.ts` × `tool/node-repl/index.ts` (B). rank 일치. 알고리즘 재사용
8. MCP `Tool[]` mint — `mcp-bridge.ts` × plugin-mcp / mcp-resolver. 인그레스 둘
9. subagent run — `subagent-runner.ts` implements `@/subagent` `SubagentRunner` (H). 포트+어댑터
10. named agentType — `named-agent-registry.ts` 디스크 vs H well-known types
11. attention — `@/attention` × G CLI `/attention`
12. spawn depth — `spawn-depth.ts` × H `DEFAULT_MAX_DEPTH=3`. 생산 `tier1/subagent.ts`는 `effectiveCap`을 넣음
13. `::git-*` parse — A `git-directives/parser` × H `src/git/directive-emit` × B `src/tool/git` (H가 이미 들고 있을 수 있음)
14. quorum/vote — `multi-voter` fail-closed × `repro-test/select` majority × `verification-bundle` k-of-n FAIL-OPEN
15. classifier cache — A auto-classifier × F AutoModeClassifier
16. stream timeout — `llm/stream-timeout.ts` 어댑터 상시 × A `stream-timeout` opt-in 언와이어
17. TypedError 16 × LLMErrorKind 18 — 데드 `errorRouting`
18. `EscalationRequest` basename — sandbox vs skill-scope
19. glob-rules vendor dual-read — `.cursor/rules` + `.quanta/rules` 후 compose. 프롬프트 이중 주입은 아님 (레인 E `src/rules`)
20. sticky lock — `sticky-model/fs-backed-store`가 `@/permission/json-state-file/locking` 재사용 (F). A 쓰기 아님

`src/shared`에 정책 덤프 금지. 마커 리스트는 알고리즘 재사용. recovery **action**은 agent/llm retry 오너에 남김.

---

## 9. 제안 쓰기 셋 (구현 안 함)

| ID | 파일 | 금지 |
|---|---|---|
| P1-A-01 | `src/agent/session-resource-registry/{global,caller-owned-builder,auto-sweep}.ts` (`unified-api.ts`는 프로덕션 호출자 0이라 제외) | host assembler, CLI session-registry-cmd |
| P1-A-02 | `src/agent/budget-ledger.ts`; 선택 `src/agent/loop/emit-helpers.ts` | observability pricing, host persist |
| P2-A-01 | `src/agent/retry.ts`; 선택 `src/agent/recovery.ts` | `src/shared/error-classifier.ts` |
| P2-A-02 | `src/agent/shadow-verify-adapters/check-lsp-test.ts` | `@/lsp` |
| P2-A-03 | `src/agent/auto-classifier.ts` | `@/permission` orchestrator |
| P2-A-04 | `src/agent/session-resource-registry/{global,caller-owned-builder}.ts` 기본 cap+TTL 또는 인메모리 evict | host/CLI |
| P2-A-05 | `src/agent/lsp-diagnostics-hook.ts` — settled null/reject evict | `@/lsp` |

---

## 10. 직접 연 핵심 파일 (grep-only 아님)

워커 패킷 외에 코디네이터가 Read한 것:

- `src/agent/retry.ts` (헤더 계약, `PTL_MARKERS`, `isRetryable`, `RetryingLLM`)
- `src/agent/error-routing/default-router.ts`
- `src/shared/error-classifier.ts` (CONTEXT_WINDOW_MARKERS, 왜 `fromSdkError`와 분리인지)
- `src/agent/mention-runner/skill-resolver.ts`
- `src/agent/plugin-app-resolver/skill-resolver.ts` (empty-target 가드 차이, 같은 `mentionFirstLine`)
- `src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts`
- `src/runtime/os-sandbox/llm-error-bridge.ts` (외국 계약만)
- `src/agent/session-resource-registry/global.ts`
- `src/agent/session-resource-registry/caller-owned-builder.ts`
- `src/agent/session-resource-registry/auto-sweep.ts` (path-set sweep)
- `src/host/runtime/agent-config-assembler.ts:650-727` (XOR mint)
- `src/agent/budget-ledger.ts` (fallback 정책, `resolvePricing`, `record`)
- `src/agent/loop/emit-helpers.ts` (USAGE_SINKS, “never disagree” 주석)
- `src/agent/lsp-bridge/availability.ts`
- `src/agent/shadow-verify-adapters/check-lsp-test.ts`
- `src/agent/auto-classifier.ts`
- `src/agent/recovery.ts` `decideOnStreamError`
- SEP5-11, SEP6 tickets README / P2 register / SEP6-01, sep-06/sep-05 bugbash, ARCHITECTURE, AGENTS/CORE/PLAYBOOK, tests/README, `.ai/guide-development.md`

`streamWatchdog`/`createDefaultWatchdog`는 `src/` compose 사이트 0으로 확인해서 StreamIdleError P2를 기각함.
`createShadowVerifyAdapters`·`createAutoClassifierPort` 소비자는 grep 후 호출 사이트 확인함.

---

## 11. no-finding으로 닫은 구역

- N7 HITL retry 정렬됨
- S8 A 레인 first-line 로컬 오너 없음
- objective 정책 오너는 `policy.ts` + `authority.ts` 하나. `goal-wake-controller`는 타이머
- attention ≠ focus-chain
- activity spine 단일 reducer. progress 바 ≠ objective receipts
- follow-up queue max 32/thread
- `RECOVERY_CAPS` same-turn
- untrusted-envelope default-off identity wrap
- 파인딩 오너에서 peer-library value-import 위반 관찰 없음 (`@/agent`는 허브)

---

## 12. 미검사·증명 한계

- 테스트/타입체크/런타임 루프 미실행. 정적 owner+consumer + fixture 산술만
- 781파일 AST 함수 길이 / biome complexity 전량은 W2-P
- P1-A-01 라이브 `cfg.metrics` assembler 런 없음 (구성만 증명)
- 어댑터가 `kind:"unknown"` + `"tokens exceed"`를 아직 내는지 (F-CTX-4는 래핑 SDK에선 아니라고 봄)
- disk vs sqlite 동일 입력 GC 픽스처 없음
- 얇은 `index.ts`/`types.ts`는 export 역할만
- `src/` 밖 호스트가 `streamWatchdog`/`errorRouting`을 켜는지
- `DISK_DIR` 크로스 프로세스 두 writer (어댑터가 single-writer OOS로 문서화)
- A3 remaining 중 <400줄 다수는 헤더+디렉터리 fingerprint. ≥400은 A3b가 읽음

---

## 13. 디렉터리 역할 (요약)

fingerprint: authority / invariant / input / output / state / effect / failure-policy / lifecycle.

- `loop/` — 세션/턴 FSM. 소비자 `runAgent`
- `dispatch*` — 툴 파이프라인 0–11. deny는 tool_result
- `retry.ts` / `recovery.ts` / `error-routing/` — same-provider retry vs same-turn recovery vs 죽은 16-arm
- `compaction*` — transcript compact. cohort
- `admissibility-gate*` — HITL/permission. cohort `gates.ts`
- `session-resource-registry/` — P1-A-01. disk/sqlite는 어댑터
- `plugin-*` / `mention-*` — discovery/activation vs mention identity. 라이브 skill은 composite
- `per-tool-checkpoint/` — granular + three-way restore + default-OFF rollback bridge
- `budget-ledger.ts` / `budget/` — P1-A-02
- `prompt.ts` / `prompt-graph/` / `system-prompt/` — assembler / atom SSOT / identity
- `observation/` — pre-task owner-hint. activity 아님
- `objective/**` — CAS authority + policy. wake는 타이머
- `activity/**` — UX spine. progress = ratio\|indeterminate
- `attention/**` — lineage-gated HITL next-operator. 3파일 순수
- `subagent-*` — `@/subagent` 포트 위 어댑터 (H)
- `tier1/` — default-OFF capability builders
- `types.ts` + `wire-slots-*` + `optional-ports.ts` + `mode.ts` + `hooks.ts` — 합성 백, cohort 접근, ISP 냄새
- 나머지 (`plan/`, `converge/`, `repro-test/`, `issue-hint/`, `branch-search/`, `model-routing/`, `sticky-model/`, `fork-session/`, `command-hooks/`, `verification-*`, `shadow-verify*`, `lsp-bridge/` …)는 보완 계약. 전체 경로는 W1-A appendix

---

## 14. 캠페인 프로토콜 메모 (이 세션에서 실제로 겪은 것)

- 디스패치는 W0 직렬 프리즈 후 A+B+C인데, 이 세션은 **W0 없이 A가 먼저** 나감. 형제 B–H도 같은 HEAD에 영수증을 씀.
- 더티 공유 체크아웃. 언커밋 파일은 detached worktree 밖에 있으므로 완료 주장에 조용히 넣으면 안 됨. A는 더티 A 파일을 **명시적으로 워킹 트리 진실**로 적음.
- W1이 영수증을 쓰면 untracked 해시가 바뀜. 엄격 STALE로 보면 병렬 W1이 불가능함. 이 세션은 HEAD/staged/unstaged/권한 문서가 같으면 프로덕션 스냅샷 안정으로 처리하고, 형제 영수증 델타만 기록함.
- `src/shared/**`·루트 테스트·arch config·카탈로그·캠페인 문서는 W1 쓰기 금지. A가 쓴 건 `W1-A.md`뿐.
- 크로스레인 import는 증거. A가 host/CLI/runtime/shared를 고치자고 쓰지 않음.
- duplicate 파인딩 = 라이브 오너 둘 + producer-contract-consumer + 측정 드리프트 또는 dual-write race. SOLID 냄새만은 inventory.
- 이 파일(`agent-7.md`)과 `W1-A.md`는 같은 세션의 인간용/캠페인용 이중 기록임. 1차 본문과 갭필이 충돌하면 **§16 + 코드**가 이김. `W1-A.md` 상단 Gap-fill 표가 영수증 채점이나, **그 표는 아직 미커밋** — HEAD `9b05cd33`의 `W1-A.md:63`은 여전히 "SEP6 N7/S8 not reopened"로 되어 있어 커밋 전까지는 영수증이 이 파일과 모순됨.

---

## 15. 한 줄 성적 (1차, 덮어씀)

레인 A 781파일 1차 분류. 아래 §16이 최종 채점임.

---

## 16. 갭필 보완 (2026-09-08, 병렬 3워커 + 코디네이터 재검증)

구멍: (1) HEAD vs WT 이중진실 (2) P1 도달성 (3) Map 형제 / git / MCP / ticker / spawn-depth / glob / wrap 헤더-온리.

### 16.1 채점 변경

| ID | 1차 | 갭필 | 이유 |
|---|---|---|---|
| N7 / S8 | 재오픈 안 함 | **캠페인 HEAD에서 재오픈** | §7. WT/`9b05cd33`만 고침. N7 오너는 E. S8 로컬 `firstLineOf`는 overlay가 이미 제거 |
| P1-A-01 레지스트리 스플릿-브레인 | P1 | **P2 강등** | 프로덕션 CLI/web/headless는 `looksLikeMetricsRegistry`를 통과 못 함. `QUANTA_METRICS=1`도 레거시 `Metrics`(increment 없음) → 항상 싱글톤+auto-sweep. assembler metrics-on은 죽은 분기. `unified-api.ts` 프로덕션 호출 0 |
| P1-A-02 USD 재가격 | P1 | **KEEP P1** | batch `$5` / daemon `$3` / ci-bot `$2` 미터 캡 기본. ledger env 켜면 같은 `emitUsage`. unknown-model: 미터 cost arm 미발동, ledger sonnet fallback으로 hard STOP. `eventCost`를 `ledger.record`에 안 넘김 |
| P2-A-01 PTL 이중 classifier | P2 | **P3 강등** | shared `classify`는 스팬 라벨만. recovery는 `classifyLLMError`만. 평문 `"tokens exceed"`는 compact 안 남. 마커 불일치는 남음 |
| P2-A-02 LSP false 캐시 | P2 | **KEEP** | `--version` 프로브는 두 곳뿐 |
| P2-A-03 classifier Map | P2 | **KEEP** | 형제 우주 전수 후 승격은 P2-A-04뿐 |

`errorRouting` / `streamWatchdog`: `src/apps`, `src/host`, `src/runner` 와이어 0.

### 16.2 신규

#### P2-A-04 — 인메모리 세션 레지스트리 기본 mint 무상한

`in-memory-registry.ts:54-80` — `maxEntries`/`idleTtlMs` 없으면 sweep no-op. `global.ts:131`과 `caller-owned-builder.ts:126`이 인자 없이 mint. auto-sweep은 disk/sqlite path만. 롱라이브 데몬에서 세션 `{store,cache}`가 안 죽음. P1-A-01(인스턴스 둘)과 다른 축.

**쓰기 셋:** `global.ts`, `caller-owned-builder.ts` 기본 cap+TTL 또는 인메모리 evict. **금지:** host/CLI.

#### P2-A-05 — diagnostics hook이 null open을 영구 캐시

`lsp-diagnostics-hook.ts:81-88`이 `Promise<DiagnosticsSession | null>`을 ext 키로 영구 보관. 소비자 `lsp-bridge/diagnostics.ts:98`, `loop/entry.ts:102`. availability.ts는 false eviction인데 hook은 null을 안 지움. 첫 edit timeout이면 그 확장자 injection이 세션 내내 꺼짐.

**쓰기 셋:** `lsp-diagnostics-hook.ts` — null/reject settled이면 evict. **증명 한계 해소:** `lsp-bridge/diagnostics.ts:33-45`의 `open()`은 null을 3경로에서 반환 — `!spec`(언어 미지원), `!(await isAvailable(spec.bin))`(**5s 프로브 타임아웃**), `client.start()` throw(**핸드셰이크 실패**). 3중 2가 transient ⇒ inventory 아니라 확정 파인딩이며, `availability.ts`의 의도적 false-eviction을 무력화함.

### 16.3 닫힌 구멍 (훔치지 않음)

| 구멍 | 결과 |
|---|---|
| H-GIT-01 | A parser/emitter 프로덕션 호출 0. 라이브는 H emitter. A 쓰기 셋 없음 |
| MCP Tool[] | `loadMcpTools` 하나. isolated-launcher는 항상 Isolated (C-F1 소비자) |
| G-F4 ticker | 다른 불변식. A는 타이머 와이어 |
| spawn-depth vs H depth=3 | A 생산은 항상 `effectiveCap` 주입. omit 0 |
| E-FM-01 glob-rules | 벤더 YAML 재파싱 없음. fingerprint만 |
| B-F1 wrap | `internal`이면 identity. origin은 B |
| write-guard remaining% | 호스트 G. A 금지 |
| 기타 Map | dispatch-dedup key cap 없음 등은 inventory |

### 16.4 코디네이터 재검증

- 지금 `HEAD=9b05cd33`. `0b14f5cf:src/shared/mention-text.ts` 없음. **`0b14f5cf`의 decorator-policy만 `auth` 결정적 + HITL 잔여 `consult_markers`이고, HEAD(`9b05cd33`) `decorator-policy.ts:84`는 이미 `action === "hitl_handoff" → no_retry`.** WT 컬럼은 소멸(src/ clean)
- `looksLikeMetricsRegistry` = increment+gauge. 레거시 Metrics는 increment 없음
- in-memory sweep는 cfg 없으면 return
- diagnostics hook null Promise 캐시 확인

### 16.5 최종 성적 (캠페인 HEAD `0b14f5cf`)

| 등급 | ID |
|---|---|
| P0 | 없음 |
| P1 | **P1-A-02** unknown-model 폴백 발산 (priced 모델은 센트까지 일치 — "dual-STOP"은 과장: `maxCostUsd`가 batch/ci-bot/daemon에만 있어 정지 권한은 사실상 하나). N7은 E 오너로 `0b14f5cf` 기준 재오픈 (A는 소비자; **HEAD `9b05cd33`에선 이미 CLOSED**) |
| P2 | P1-A-01 강등, P2-A-02, P2-A-03, **P2-A-04**, **P2-A-05**. S8은 HEAD A 로컬 firstLineOf (overlay가 고침) |
| P3 | P2-A-01 PTL 마커. **단 잔여 피해는 "텔레메트리"가 아니라 놓친 reactive compaction** — `kind:"unknown"` + overflow 문구는 `recovery.ts:271`에서 빠져 `{do:"error"}`가 됨 (실행 확인). 강등 근거를 이 기준으로 다시 볼 것 |

구현 없음. W2-X는 `0b14f5cf`와 `9b05cd33`을 섞지 말 것.
