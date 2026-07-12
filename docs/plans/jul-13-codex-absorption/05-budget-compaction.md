# RFC: Codex `rollout_budget` + `remote_compaction_v2` 흡수 판정 (LOW candidate)

> ## ⚠️ 정정 (HEAD 검증 리뷰 2026-07-13 — 본문 상충 시 이 블록 우선)
> - **budget = record-and-skip 맞음. 단 "USD가 항상 token budget의 superset"이라 쓰지 말 것.** cache pricing·model switching·reasoning-token 가격차 때문에 같은 token 수↔비용이 단조롭게 같은 정책이 아님. 정확한 표현 = **"비용 폭주 방지가 목적이면 USD가 더 적합"** 까지만.
> - **compaction = "우리 것이 superset" 표현 낮춰야 함.** 우리는 trigger/breaker/background/salvage가 더 풍부하나, **장기실행 SOTA(append-only canonical session log → versioned context projection → compaction, 원본 보존으로 복구가능)의 superset은 아님.** 현 `ConversationSummaryArchive`는 session-local bounded recent window·FIFO 64·**event log of record 아님·version/provenance stamp 없음**(`src/agent/conversation-summary-archive.ts:107`).
> - **comp_hash 단독 = detection만, recovery 불가.** 보강 시 단일 hash가 아니라 provenance envelope 필요: `source_event_range·source_digest·compactor_contract_version·static_authority_digest·model_id·summary_digest·created_at`. **hash 대상은 dynamic prompt(날짜·시각 포함 시 매턴 drift) 아니라 static compaction contract + repo/AGENTS authority digest + model/strategy version.** mismatch 시 재compact할 canonical source log 없으면 stale 표시만·수리 불가.
> - **정확한 판정:** finite session만 목표 → comp_hash LOW ROI backlog. restart/resume 넘는 long-horizon managed agent 목표 → **versioned context projection + canonical log가 중간+ 우선순위.** hash 단독 구현 = 비추천.

- **상태**: Evaluation / verdict = **거의 record-and-skip** (아래 §판정)
- **날짜**: 2026-07-13
- **North-star 제약**: measure-first. 이건 audit가 "이미 등가물 보유" 플래그를 단
  LOW-흡수 후보다. RFC의 임무는 흡수 명분 만들기가 아니라 **정직한 델타 산정**이다.
  등가물이 있으면 그대로 "기록하고 스킵". 좁은 갭이 있으면 이름만 정확히 짚고
  ROI를 따진다. 없는 일을 만들지 않는다.
- **범위**: Codex 5059의 두 기능만.
  1. `rollout_budget` — session-scoped 토큰 예산 (`limit_tokens` +
     `reminder_at_remaining_tokens` + weighted `sampling_token_weight` /
     `prefill_token_weight`), hard limit에서 `session_budget_exceeded`.
  2. `remote_compaction_v2` — token limit 근처에서 history를 1st-class
     `ContextCompaction` 아이템으로 요약하는 server-side state machine.

---

## 0. Codex 증거 (인용)

`.extracted_source/codex/_codex-bin-symbols.txt` 기준:

- **rollout_budget**: `RolloutBudgetConfigToml{limit_tokens,
  reminder_at_remaining_tokens, sampling_token_weight, prefill_token_weight}` —
  goal의 per-goal `token_budget`과 대비되는 **session-scoped**. sampling/prefill
  토큰을 가중합. hard limit에서 `session_budget_exceeded`, 그 전에 reminder.
- **remote_compaction_v2**: token limit 근처에서 history가 1st-class
  `ContextCompaction` 아이템으로 요약됨. trigger enum =
  `manual | memento | prefix_compaction | context_limit | model_downshift |
  user_requested | comp_hash_changed`. scope = `GLOBAL | WORKSPACE`. `comp_hash`가
  prompt-version drift를 가드.

---

## 1. 현황 (anti-dup, 실 repo 검증)

### 1.A Cost / budget

두 개의 독립 primitive가 이미 있고, 둘 다 pricing SSOT 하나에서 파생된다.

- **Pricing SSOT**: `src/observability/pricing.ts` — `MODEL_RATE_CARD`
  (`ModelPrice{inPerM,outPerM,cacheReadPerM,…}`), `PRICING_VERSION = "pricing.v2"`
  (pricing.ts:8). 모델 가격이 사는 유일한 장소.

- **`BudgetLedger`** (`src/agent/budget-ledger.ts`, ADR-0136): 토큰 × pricing → USD
  누적 원장. **session-scoped 예산**을 이미 보유 —
  `BudgetPolicy.sessionSoftLimit` / `sessionHardLimit`
  (budget-ledger.ts:154-156), `perSession` 롤업(budget-ledger.ts:131,532),
  soft→hard 2단 breach(`BudgetLimitKind = session-soft|session-hard|daily-soft|daily-hard`,
  budget-ledger.ts:140), breach debounce(각 (scope,kind) 1회, ledger 계약 #5),
  그리고 loop이 turn마다 읽어 runaway를 STOP하는
  `hardBreach()`(budget-ledger.ts:199,727). 즉 **soft-reminder → hard-stop** 흐름이
  session scope로 이미 성립.
  단, 예산 단위가 **USD**다 (토큰 아님).

- **`BudgetMeter`** (`src/agent/budget/meter.ts`, per-run pure 상태머신): **토큰
  단위** 예산을 보유 — dials `maxInputTokens / maxOutputTokens /
  maxReasoningTokens / maxTotalTokens`(`budget/types.ts:36-43`),
  `checkExhausted()`가 propositional hard-stop
  (`check(dials.maxTotalTokens, totalTokens, "total_tokens")`,
  meter.ts:306-309), reminder에 해당하는 `remainingPercent()`(meter.ts:231) —
  가장 tight한 dial의 잔여 비율을 %로 반환(soft 경고 렌더용). 별도로
  `providerRateLimitRemainingPct`(meter.ts:77)로 **실 provider quota** 신호까지
  분리 보유.

  판정: 토큰-단위 예산 + reminder(%) + hard-stop(`checkExhausted`)이 이미 있다.
  스코프는 **per-run**이다 (Codex의 session-scoped와 대비).

- **자율 loop 집행**: jun-28 cost cap 작업에서 `emitUsage` seam
  (`src/agent/loop/emit-helpers.ts:141`)이 usage를 원장/meter로 흘리고,
  hard-breach가 실제로 run을 멈추는 L0~L4가 랜딩됨(MEMORY: jun-28-cost-cap).

- **model-facing soft budget**: `task-budget` knob
  (`src/runner/knobs/knobs/task-budget.ts`) — Claude의 `task_budget:{tokens:N}`을
  모델에게 노출하는 advisory self-moderation 라인(never a hard stop). Codex의
  reminder와 취지 동일.

**분류 (budget):**
| 축 | 상태 | 근거 |
|---|---|---|
| session-scoped 예산 (USD) | **ALREADY-HAVE** | budget-ledger.ts:154-156,531 |
| 토큰-단위 예산 + reminder + hard-stop | **ALREADY-HAVE (per-run scope)** | meter.ts:231,306-309; types.ts:36-43 |
| session-scoped **토큰** 예산 (per-run 아님) | **PARTIAL** | ledger=USD·session, meter=token·per-run — 조합이 정확히 겹치진 않음 |
| weighted sampling/prefill 토큰 | **TRUE-GAP** | 우리 counter는 in/out/reasoning 원자, 가중치 없음 |

### 1.B Compaction

우리 compaction은 Codex `remote_compaction_v2`보다 **훨씬 풍부한** 클라이언트-측
상태머신이다.

- **트리거 / 임계값** (`src/agent/compaction.ts`): `compactIfNeeded`가 model
  context window에서 파생된 threshold(`resolveThreshold(thresholdTokens, model)`,
  compaction.ts:639)를 쓰고, provider의 마지막 실측을 앵커로 삼는
  authoritative `tokenBaseline`(`triggerTokenCount`, compaction.ts:644, D5)로
  chars/4 under-count를 닫는다. token limit 근처 자동 트리거 = 있음.

- **다층 트리거 실체** (Codex의 flat enum보다 세분화):
  - proactive (임계 초과 시 사전 요약) — `compactIfNeeded`.
  - reactive (PTL 에러 후 강squeeze) — `reactiveCompact`(compaction.ts:378),
    Codex `context_limit` 대응.
  - background speculative (여유 15%에서 미리, ADR-0473) —
    `makeBgCompactionController`(compaction.ts:910), `QUANTA_BG_COMPACTION` gate.
  - drop-oldest salvage (요약 불가 시 오래된 턴 hard-drop, §13.3) —
    `dropOldestSalvage`(compaction.ts:563). 주석이 Codex
    `thread_rollout_truncation`을 명시적 참조(compaction.ts:554).
  - manual/on-demand (`/summarize-now`, `force:true`, compaction.ts:150) —
    Codex `manual`/`user_requested` 대응.
  - pre_compact HITL hook + post_compact provenance (ADR-0075/0133/0409,
    compaction.ts:199,215,221) — Codex enum엔 없는 것.

- **archive / 1st-class 아이템**: `archive?:boolean`
  (`types/compaction-config.ts:98`)이 켜지면 `ConversationSummaryArchive`에
  `ConversationSummaryEntry`를 append하고 `event_msg:context_compacted`
  AgentEvent를 emit — Codex의 1st-class `ContextCompaction` 아이템에 해당.

- **안전 불변식** (Codex 심볼엔 안 보이는 것): orphan-safe boundary
  (`findBoundary`, tool_use/tool_result 쌍 안 쪼갬, compaction.ts:78),
  empty-summary 시 history 파괴 금지(compaction.ts:717), thrash circuit-breaker
  (`compactionBreaker`, reactive/proactive cap, compaction-breaker.ts).

**분류 (compaction):**
| 축 | 상태 | 근거 |
|---|---|---|
| token-limit 근처 자동 요약 | **ALREADY-HAVE** | compaction.ts:637-649 |
| 다중 트리거 (manual/limit/user/truncation…) | **ALREADY-HAVE (더 세분화)** | 위 다층 실체 |
| 1st-class 요약 아이템 + 이벤트 | **ALREADY-HAVE** | compaction-config.ts:98 |
| `comp_hash` prompt-version drift 가드 | **TRUE-GAP** | repo에 등가물 0 (아래 §1.C) |
| scope GLOBAL/WORKSPACE | **N/A** | 서버-측 멀티-워크스페이스 개념, 단일-agent 클라이언트엔 무의미 |

### 1.C `comp_hash` (prompt-version drift 가드) — 별도 확인

`comp_hash / promptVersion / systemPromptHash / prompt.*drift` grep 결과 repo에
등가물 **없음**. 나온 히트는 전부 무관(`foundry-watch` npm 버전, memory 랭킹
tolerance, repo-version-specs). 즉 "요약이 만들어진 시점의 프롬프트 버전이 지금과
다르면 그 요약을 무효/재생성" 하는 가드는 우리에게 없다.

---

## 2. 판정 (정직한 델타)

### 2.A rollout_budget → **record-and-skip** (좁은 갭 2개는 명시만)

session-scoped 예산 자체는 **이미 보유**한다: `BudgetLedger`가 session soft/hard
breach를, `BudgetMeter`가 토큰 dial + reminder(%) + hard-stop을 준다. Codex의
"reminder → `session_budget_exceeded`" 흐름은 우리 soft-breach → `hardBreach()`와
1:1 대응. → **흡수 대상 아님. 기록하고 스킵.**

남는 진짜 델타 2개, 둘 다 착수 비추천:

1. **session-scoped *토큰* 예산** (per-run 아님): 현재 토큰 dial은 `BudgetMeter`의
   per-run scope, session-scope 예산은 `BudgetLedger`의 USD scope. 정확히
   "session 누적 **토큰** 상한"을 원하면 조합 갭이 있다. 그러나 USD가 이미 pricing
   SSOT로 토큰에서 파생되므로 **USD session cap이 토큰 cap의 상위 집합**이다
   (토큰↑ ⇒ USD↑). 별도 토큰-session dial은 중복. ROI ≈ 0. **스킵.**

2. **weighted sampling/prefill 토큰** (`sampling_token_weight` /
   `prefill_token_weight`): 우리 counter는 in/out/reasoning을 가중 없이 잰다.
   이건 서버가 예산을 청구 방식(prefill이 sampling보다 싸다)에 맞춰 가중하려는
   Codex 내부 회계 디테일이다. 우리는 이미 pricing SSOT에서 **실 USD**로 정확히
   청구하므로(cacheRead/cacheWrite 버킷까지 분리, budget-ledger.ts:83-86), 인위적
   토큰 가중치는 오히려 실 비용보다 부정확한 프록시다. **채택 시 net-negative. 스킵.**

### 2.B remote_compaction_v2 → **record-and-skip** (comp_hash만 backlog 후보)

우리 compaction은 Codex 것의 **상위 집합**이다: 다층 트리거(proactive/reactive/
bg-speculative/drop-oldest/manual) + model-window-derived threshold +
authoritative baseline + orphan-safe boundary + empty-summary 파괴 방지 + thrash
breaker + HITL/provenance. Codex의 flat trigger enum + GLOBAL/WORKSPACE scope는
서버-측 멀티-워크스페이스 사정이지 단일-agent 클라이언트에 이식할 표면이 아니다.
→ **흡수 대상 아님. 기록하고 스킵.**

유일한 TRUE-GAP = **`comp_hash` prompt-version drift 가드**. 현재 우리 요약은
"어느 프롬프트 버전에서 만들어졌는지" 태그가 없어서, 시스템 프롬프트가 바뀐 뒤
옛 요약을 그대로 재사용하면 stale 지침으로 이어질 수 있다.

- **가치**: 우리는 이미 `PRICING_VERSION` 같은 버전 상수 패턴이 있으므로,
  `ConversationSummaryEntry`에 "요약 생성 시 system-prompt hash"를 스탬프하고
  hydrate/재사용 시 현재 hash와 다르면 무효화(재요약)하는 좁은 가드는 저비용이다.
- **왜 지금은 아닌가 (measure-first)**: (1) 우리 요약은 session 내 in-memory가
  기본이라 프롬프트 버전이 한 session 안에서 바뀌는 경우가 드묾 — drift 창이 작다.
  (2) 실 fail taxonomy(jun-29-gap-essence: 병목은 synthesis 수렴)에 "stale-summary
  프롬프트 drift"가 관측된 바 없다. 즉 **측정된 need가 0**.
- **ROI 판정**: (기능) 요약 재사용 시 프롬프트-버전 가드 · (왜) archive/hydrate
  경로에서 옛 요약이 새 지침을 밀어낼 잠재 위험 · (ROI) **LOW** — drift 창 작음 +
  측정 need 0. **backlog에만 이름 등재, 착수는 archive-hydrate 재사용이 실제로
  cross-version이 되는 관측이 나올 때까지 보류.**

---

## 3. 요약 + verdict

1. **budget**: session-scoped 예산(USD, soft→hard)은 `BudgetLedger`, 토큰-단위
   예산(reminder%+hard-stop)은 `BudgetMeter`로 **이미 보유**. 둘 다 pricing SSOT
   하나에서 파생. Codex와 1:1 대응.
2. **compaction**: 우리 다층 compaction(proactive/reactive/bg/drop-oldest/manual +
   orphan-safe + breaker + HITL/provenance)은 Codex `remote_compaction_v2`의
   **상위 집합**. GLOBAL/WORKSPACE scope는 클라이언트에 무의미.
3. **유일 TRUE-GAP** = `comp_hash` prompt-version 가드 하나뿐이고, 측정된 need 0 +
   drift 창 작음이라 backlog 등재만.

| 기능 | verdict |
|---|---|
| `rollout_budget` (session token budget) | **record-and-skip** (weighted-token/session-token 델타는 net-negative·중복, 미착수) |
| `remote_compaction_v2` (compaction state machine) | **record-and-skip** (상위 집합 보유) |
| ↳ `comp_hash` prompt-drift 가드 (narrow) | **absorb-narrow-delta = backlog only** (LOW ROI, measured-need까지 보류) |
