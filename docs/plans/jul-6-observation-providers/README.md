# jul-6 — Observation Providers (`<quanta_observations>` 구조화 evidence 주입)

## 문제 (확인됨)

엔진·LSP는 **있는데** structural evidence가 프롬프트에 안 들어감:

| 신호 | 존재 | pre-inject |
|---|---|---|
| LSP owner/refs | ✅ | ❌ tool-call (턴 소모) |
| codegraph impact/callgraph (semantica) | ✅ | ❌ repro-grounding에만 |
| Agentless file-hint | ✅ | ✅ 근데 `file + 한줄 이유`뿐 |

지금 주입되는 유일 evidence = [agentless-localize.ts](../../../src/agent/issue-hint/agentless-localize.ts) `## Issue Hints` (파일 후보 + 한줄). owner-symbol·confidence·impact-surface·forbidden-scope는 없음. 프롬프트는 "localize→lsp_document_symbol→lsp_references 해라"라고 **말로** 시킴 = 리뷰가 지적한 "설득 vs 먹임"의 정확한 예.

## 목표

정적엔진(semantica IR/CFG/DFG/callgraph) + LSP + 외부 신호(MCP 등)를 **상황에 맞춰 골라 넣고, 프로바이더 단위로 A/B 실험**할 수 있는 추상화. "정적분석 잘 써라"를 프롬프트에 쓰는 대신, 현재 문제의 owner/impact/금지범위를 **구조화 evidence로 task 앞에 주입**.

## 적대 어딧 (3R) → 반영

**R1 — net-negative / overtrust**
- **A1 HINT_OVERTRUST**: confident-wrong 정적 owner는 약한 힌트보다 **더 세게** 틀린 곳에 anchor. 정적분석은 dynamic dispatch/reflection 못 봄(우리 anti-signals 룰 그대로). → §4 routing-hint 권위 렌더 + §5 critic(refute) + wrong_owner_edit_rate 계측.
- **A2 자기검증 억제**: authoritative 블록이 모델의 "verify with tools"를 죽임. → "presence evidence, verify" 프레이밍 유지.
- **A3 토큰비용 미검증**: impact/contracts 장황하면 매 턴 비용. → 스키마 **owners만**부터, 나머지 필드는 각자 A/B 통과해야 추가.

**R2 — over-engineering / 조기 추상화**
- **B1**: 7-프로바이더 파이프라인을 **신호 나오기 전** 짓는 건 over-engineer 함정(SWE-agent/Agentless=simple wins). → P1은 **프로바이더 1개**(static-owner)를 기존 agentless seam 뒤에 swap해서 A/B. 파이프라인 추상화는 **신호 확인 후**.
- **B2**: 통일 confidence 0..1 = 프로바이더 간 척도 비교불가 → 머지 garbage. → 숫자 머지 폐기, SOURCE 권위순 dedup만.
- **B3**: Fragment 스키마 추측. → owners 최소부터, 필드별 A/B 게이트.

**R3 — 측정이 거짓말 / 결정성**
- **C1**: marginal 프로바이더 A/B는 **조합 상호작용** 놓침 + Verified 오염. → stratified heldout + **factorial**(최종조합) + USAGE 계측.
- **C2**: 프로바이더 "무효과"가 useless인지 ignored인지 모호. → **usage attribution**(제안 owner 편집 적중률).
- **C3**: observation 단계 nondeterminism이 replay/cassette 깸. → fragment **record/replay**(cassette seam), 엔진쿼리 결정적.
- **C4 (SOTA++)**: pure feed-forward는 verify/refute loop 없음 = robustness 갭. → §5 critic + §6 evidence⊗enforcement.

## 핵심 추상화

단일 **port + pipeline + renderer + 주입 seam 1지점**. 프로바이더 추가 = 등록 + 노브, **프롬프트 텍스트 변경 0**.

### 1) `ObservationProvider` port (leaf, 순수 인터페이스)

```ts
type ObservationKind = "localization" | "impact" | "scope-guard" | "contract" | "history" | "external"

interface ObservationProvider {
  readonly id: string               // "agentless-localize" | "static-owner" | "callgraph-impact" | "lsp-prefetch" | "scope-guard" | "git-history" | "external-mcp"
  readonly kind: ObservationKind
  /** 상황 게이트: task kind·language·capability·엔진 가용성으로 이 프로바이더가 도는지. 순수. */
  applicable(ctx: TaskContext): boolean
  /** budget-bounded 생산. null = 이번 태스크엔 신호 없음(생략, byte 0). */
  produce(ctx: TaskContext, budget: ProviderBudget): Promise<ObservationFragment | null>
}
```

### 2) 타입드 evidence fragment (구조화 신호)

```ts
// 숫자 confidence 폐기 (B2). 정적엔진은 보정확률 안 뱉음 → 순서형 강도만.
type EvidenceStrength = "high" | "medium" | "low" | "unknown"

interface OwnerHint   { file: string; symbol?: string; strength?: EvidenceStrength; evidence: string; source: string }
interface ImpactHint  { likelyRuntimePaths: string[]; riskyCallers: string[]; testsNotToEdit: string[] }
interface ScopeHint   { allow: string[]; avoid: string[] }        // grader-only protect-tests와 연동
interface ContractHint{ signature?: string; raises?: string[]; adjacent: string }

interface ObservationFragment {    // fragment-level 숫자 confidence 없음
  providerId: string
  owners?: OwnerHint[]
  impact?: ImpactHint
  scope?: ScopeHint
  contracts?: ContractHint[]
  notes?: string[]
}
```
- **랭킹/dedup은 policy 내부 규칙으로만**: `sourceAuthority`(static def-use > LSP > LLM) + `evidenceType` + recency/budget. 프로바이더 간·owner 간 **비교 숫자 없음** — 척도가 애초에 비교불가라(B2).

### 3) `ObservationPipeline` (조립·선택·머지)

```ts
class ObservationPipeline {
  constructor(providers: ObservationProvider[], policy: ObservationPolicy) {}
  // 상황별 applicable 필터 → 병렬 produce(budget) → 머지/랭크/dedup → bundle
  gather(ctx: TaskContext): Promise<ObservationBundle>
}
```
- **policy**: 어느 프로바이더 on(노브), 순서, per-provider budget, 머지 전략(owner dedup by file+symbol, confidence 우선).
- 모두 off / bundle 비면 → 주입 0 (byte-identical).

### 4) renderer + 주입 seam (1지점)

```ts
renderObservations(bundle): string   // <quanta_observations> ... </quanta_observations>
```
- 주입 위치 = **user[0]** (지금 issue-hint 자리). system 캐시프리픽스 아님(per-task 동적).
- 기존 `composeIssueHint`([compose.ts](../../../src/agent/issue-hint/compose.ts)) seam을 이 renderer로 승격 → issue-hint는 프로바이더 1개로 흡수.
- **trust-ladder 정렬 (A1/A2 mitigation)**: 블록은 **ROUTING HINT 권위**로 렌더 — 프롬프트 trust-ladder의 "tool/engine 신호 = presence evidence, never proof"와 일치. 헤더에 `# routing hints — verify against source before editing` 명시, "authoritative owner" 어투 금지. confidence는 **calibrated-or-omitted**(정적분석은 보정된 확률 안 뱉음 → 숫자 대신 `high/med/low` + evidence 문장). 프로바이더 간 **숫자 머지 금지**: dedup은 SOURCE 권위순(static def-use > LSP > LLM vibe)으로만.

### 5) localization critic (SOTA++ — feed-forward만 아니라 verify/refute)

pure 주입은 **wrong-owner-anchor** 리스크(A1). SOTA++ 품질은 feedback loop에서 나옴:

```ts
// 3-way — 정적엔진은 incomplete하니 "반증 실패"를 "승인"으로 읽으면 안 됨.
// not_refuted(못 깠음) ≠ confirmed(맞음). inconclusive는 명시적 3번째 상태.
type RefuteResult =
  | { verdict: "refuted"; reason: string }        // 엔진이 명확히 반증 (도달불가/override로 안 돎)
  | { verdict: "not_refuted"; reason?: string }   // 반증 못 함 — 승인 아님, 그냥 안 걸림
  | { verdict: "inconclusive"; reason: string }   // 엔진이 판단 불가 (dynamic dispatch 등)

interface OwnerCritic {
  /** 모델이 고른/편집한 owner를 엔진(callgraph/def-use)으로 REFUTE 시도. 편집 전/patch 전 게이트. */
  refute(edited: EditTarget, ctx: TaskContext): Promise<RefuteResult>
}
```
- 엔진을 **owner seed**에만 아니라 모델의 선택을 **반증**하는 데 씀(적대 검증). callgraph상 도달 불가·override로 실제 안 도는 심볼을 편집하려 하면 `refuted` → 모델에 typed 신호. `not_refuted`/`inconclusive`는 **아무것도 주장 안 함**(엔진 incomplete 존중).
- 이게 confident-wrong 정적신호보다 robust: 틀린 owner를 **미리 확신시키는** 대신 모델이 **건드릴 때** 잡고, 못 깔 땐 침묵(anchor 오염 0).

### 6) evidence ⊗ enforcement 커플링 (SOTA++)

`scope-guard`는 **힌트로만 두지 말고** 실제 런타임 reject와 **같은 규칙원**을 공유: `QUANTA_BENCH_PROTECT_TESTS` 가드가 막는 경로 == observation의 `avoid` == critic이 refute하는 편집. 프롬프트로 설득 + evidence로 표시 + 런타임으로 강제, 셋이 **단일 SSOT**.

### `<quanta_observations>` 스키마 (렌더 예)

**top-1 금지 — 최소 top-k + `anti_signals` 항상 동반** (큰 리스크: owners-only여도 top-1만 주면 dynamic-dispatch slice에서 HINT_OVERTRUST 터짐). 숫자 confidence 대신 순서형 strength.

```
# routing hints — verify against source before editing (presence evidence, not proof)
<quanta_observations>
candidate_owners:              # top-k, 1개로 좁히지 않음
  - file: requests/models.py
    symbol: PreparedRequest.prepare_url
    strength: high
    evidence: def-use — idna encode raises UnicodeError uncaught here
    source: static-owner
  - file: requests/exceptions.py
    symbol: InvalidURL
    strength: medium
    evidence: target exception type referenced in issue
    source: static-owner
  - file: requests/adapters.py
    strength: low
    evidence: caller on the runtime path
    source: callgraph-impact
anti_signals:                  # 항상 붙음 — anchor 해독제
  - dynamic dispatch / reflection may bypass the static owner above
  - verify with read/LSP before editing; a candidate is a locator, not the owner
impact_surface:
  likely_runtime_paths: [Session.get → prepare → prepare_url]
  risky_callers: [adapters.HTTPAdapter.send]
  tests_not_to_edit: [tests/test_requests.py]
recommended_scope:
  allow: [requests/models.py, requests/exceptions.py]
  avoid: [tests/, docs/, *.lock]
</quanta_observations>
```

## 프로바이더 카탈로그 (초기, 각 swap-seam + 노브 default-OFF)

| id | kind | 백엔드 | 상태 |
|---|---|---|---|
| `agentless-localize` | localization | LLM 서브에이전트 | **있음** → 프로바이더로 흡수 |
| `static-owner` | localization | semantica def-use/AST | 신규 (semantica swap-seam) |
| `callgraph-impact` | impact | semantica callgraph | 신규 |
| `lsp-prefetch` | localization/contract | LSP (loop 전 미리 resolve) | 신규 (턴 절약) |
| `scope-guard` | scope-guard | protect-tests + 경로규칙 | 신규 (grader-only 연동) |
| `git-history` | history | blame/recent-change | 신규 |
| `external-mcp` | external | MCP 신호원 | 신규 (플러그) |

## 실험 설계 (usage-first, 조합 인지)

- 각 프로바이더/critic = 노브 default-OFF. 단일 주입 seam이라 조합 자유.
- **outcome 말고 USAGE부터 (C2)**: bundle attribution. `owner_edit_hit_rate`만으론 "따라 편집했다"만 보이고 좋은지/나쁜지 약함 → **행동 경로**까지 계측:
  - `hint_read_rate` — observation 있는 턴 이후 해당 file을 read 했나
  - `hint_verify_rate` — edit 전에 LSP/read/test 중 하나로 검증했나
  - **`hint_follow_without_verify_rate`** — 후보를 **검증 없이 바로** edit (← **overtrust 조기경보**, 이게 오르면 A1 발동)
  - `critic_saved_edit_rate` — critic refute 후 실제 다른 owner로 이동 & pass
- 지표: resolved_rate · owner_edit_hit_rate · **wrong_owner_edit_rate** · hint_follow_without_verify_rate · source_only_diff_rate · over_exploration_tool_calls · time_to_first_edit · diff_size_median · hidden_grader_pass_rate.
- 실패 taxonomy: LOCALIZATION_WRONG_OWNER · **HINT_OVERTRUST**(제안 따라가서 틀림) · PATCH_TOO_NARROW/WIDE · UNRELATED_DIFF · STOP_TOO_EARLY/LATE.
- **측정 레일 (C1)**: picks-3=smoke뿐. 효능은 **stratified heldout**(one-file/multi-file/ambiguous-owner/misleading-hint/dynamic-dispatch/lockfile-trap)에서, 최종조합은 **marginal 아니라 factorial**. Verified 오염 고려 → net-gain은 heldout/Pro 기준.
- **overtrust 반증 셀 필수**: `misleading-hint`·`dynamic-dispatch` 슬라이스에서 provider-on이 provider-off보다 **나쁘지 않은지** 확인(A1 회귀가드). 나빠지면 그 프로바이더는 net-negative → 삭제.

## 페이징 (measure-first, single-provider 먼저)

- **P0 — critic만 (제일 싸고 제일 안전)**. `OwnerCritic.refute` 하나. seed 안 바꾸고 모델의 owner 편집을 callgraph로 반증만. `critic_saved_edit_rate` A/B. **주입 0 → overtrust 리스크 0**, 순수 upside. 여기서 신호 없으면 엔진 localization 가치 자체를 의심.
- **P1 — static-owner SHADOW mode (주입 전 precision 게이트)**. 모델에 **안 보여주고**, static-owner가 실제 성공 patch의 owner를 맞혔는지만 오프라인 측정. **precision 낮으면 주입 자체를 안 함** — 틀린 owner 먹이는 최악 경로를 발사 전에 차단. 비용 0(observe-only).
- **P1b — static-owner INJECTED A/B**. shadow precision 통과 시에만 주입 켬. 기존 agentless seam 뒤 swap(**파이프라인 안 지음**), top-k + anti_signals + routing-hint 렌더. `owner_edit_hit_rate`↑ & `wrong_owner_edit_rate`↔/↓ & `hint_follow_without_verify_rate` 무증가면 통과. **default byte-identical**(off일 때 지금 `## Issue Hints`).
- **P2 — 조건부 파이프라인**. P0·P1b 둘 다 신호 나올 때만 port+Pipeline+merge 추상화 정식 도입(B1). agentless+static-owner dedup(SOURCE 권위순). fragment record/replay(C3).
- **P3 — impact/scope**. `callgraph-impact`(impact_surface, 각 필드 A/B) + `scope-guard`(§6 protect-tests SSOT 커플). `lsp-prefetch`(턴절약, cost-neutral 확인).
- **P4 — 확장**. `git-history` · `external-mcp`. 각자 overtrust 반증 셀 통과해야 랜딩.

**게이트 규칙**: 각 페이즈는 앞 페이즈가 heldout에서 **net-positive + overtrust-무회귀** 증명해야 진행. 안 나오면 거기서 멈추고 삭제(measure-first, no-heuristics).

## 기존 재사용 seam

- issue-hint 조립: [compose.ts](../../../src/agent/issue-hint/compose.ts) `composeIssueHint` → renderer로 승격.
- semantica: repro-grounding swap-seam(jun-29) → `static-owner`/`callgraph-impact` 백엔드.
- scope: `QUANTA_BENCH_PROTECT_TESTS` 런타임 가드 → `scope-guard`가 같은 규칙을 evidence로도 노출.
- 방향 근거: jul-05 evidence-driven runtime kernel(observation→evidence 계층)이 정확히 이 층.

## 비목표

- 런타임 enforcement(edit-requires-read, forbidden-cmd 등)는 **이미 있음**(stale-read-guard·HARD_DENY·admissibility-gate·protect-tests). 이 문서는 evidence **주입**만. enforcement 갭은 별 트랙.
- 23KB 프롬프트 손rewrite 안 함. 프롬프트는 그대로, evidence를 앞에 먹임.
