# jun-15 기능 흡수 — UI/UX 제안 + 내부 통합 설계

- 작성: 2026-06-15
- 짝 문서: [00-기능흡수-백로그.md](./00-기능흡수-백로그.md) (갭 정의·근거·ROI)
- 이 문서: 백로그 최종 리뷰 → **기깔나는 UI/UX** + **내부 통합 아키텍처**(하나의 spine으로 수렴)

---

## 0. 최종 리뷰 — 핵심 통합 인사이트 2개

백로그를 다시 보면 갭들이 **따로가 아니다**. 두 축으로 수렴한다:

**① 관측 갭(G2·G3 + 기존 subagent 뷰)은 같은 것의 다른 줌 레벨이다.**
fleet(모든 에이전트) → run(한 워크플로의 phase들) → agent(한 에이전트의 tool들) → node(why-stuck). 따로 3개 UI를 짜면 안 되고, **하나의 zoomable activity 트리**(분산 트레이싱 UI를 에이전트용으로)로 짜야 한다. 이게 북극성("뭐하고/왜멈췄고/다음")의 정답 형태.

**② 발동 갭(G1 키워드·G4 deep-link·G5 origin)의 consent는 한 게이트다.**
"에이전트가 비싼/위험한 액션을 자동 발동하려 함 → 사용자 동의" 라는 동일 패턴. 3개 별도 모달이 아니라 **하나의 agent-action consent 게이트**(admissibility-gate / HITL 재사용)에 verb만 다르게.

⇒ 설계 목표: **2개의 공유 spine**(관측 spine + consent 게이트)에 5개 갭을 얹는다. 중복 인프라 0.

---

## 1. 내부 통합 아키텍처 — Agent Activity Spine

### 1.1 한 장 그림

```
   [producers]                  [SPINE]                    [projectors → surfaces]

  workflow executor ┐                                  ┌→ CLI  /activity (TUI 트리)
   (WorkflowEvent) ──┤                                 │
  subagent registry ─┤                                 ├→ Web  Mission Control 카드
   (TaskRecord) ─────┤──→  AgentActivityEvent  ──→ ────┤    (fleet→run→agent 줌)
  side-agent reg ────┤      (canonical 1-model)        │
   (SideAgentStatus)─┤            │                    ├→ embedded  compact strip
  reactor / remote ──┤            ↓                    │
  scheduler ─────────┘      OTel span tree  ───────────┴→ history / diff / cost (영속)
                            (S2: durable backbone)
```

- **1 이벤트 모델**: `AgentActivityEvent`(node 생성/상태전이/tool/토큰/why-stuck/완료). 기존 셋(item-stream + agent-state + WorkflowEvent)을 이걸로 통일.
- **1 emit 지점, N projector**: jun-13-t01에서 증명한 **dual-plane projector + drift-ratchet** 패턴 그대로. 각 surface는 PURE projector(코어 누출 금지, t07 패턴).
- **OTel가 durable backbone(S2)**: 라이브 UI = span 트리 tail; 히스토리/diff/cost = 완료 span 쿼리. → G3 히스토리·cost(ADR-0536 bench cost와 동일 철학) 공짜로 따라옴.

### 1.2 기존 substrate에 어떻게 얹나 (재발명 0)

| spine 요소 | 재사용 quanta 자산 | 추가할 것 |
|---|---|---|
| 이벤트 채널 | `src/stream/item-stream-projector.ts`, `web-daemon/agent-state-source.ts` | `AgentActivityEvent` 스키마 + 통합 토픽 |
| workflow producer | `src/workflow/executor.ts:53` `opts.sink?.emit` (seam 존재) | sink→spine 어댑터(G3) |
| in-proc agents | `src/apps/cli/agents-fleet-panel.ts` TaskRegistry | spine producer로 승격 |
| out-of-proc agents | `src/side-agent/process-registry.ts` `list()` | FleetSource 어댑터(G2) |
| 영속/트레이스 | `src/observability/otel` | phase/agent/tool = span(S2) |
| consent 게이트 | admissibility-gate / HITL(inline approval) | verb 3종(keyword/deeplink/origin) 라우팅 |

### 1.3 줌 레벨 = 같은 트리, 다른 깊이

```
 L0 Fleet     모든 에이전트(kind 무관) 행            ← G2
 L1 Run       한 워크플로의 phase swimlane           ← G3
 L2 Agent     한 에이전트의 tool 테이프              ← 기존 subagent
 L3 Node      why-stuck 사유 + 제안 액션             ← S6 (북극성 payoff)
```

---

## 2. UI/UX 제안 (기깔나는 부분)

### 2.1 ★ 중심: Unified Activity 트리 (CLI/TUI)

`/activity` (또는 `/agents` 확장). 라이브, 접기/펼치기, why-stuck 인라인, 토큰 burn.

```
 ▌ ACTIVITY   6 agents · 2 running · 1 stuck · 1.8M tok · $4.20         ⏱ 3m12s
 ───────────────────────────────────────────────────────────────────────────
 ▾ ⏳ review-pr          workflow  run#a3f  phase 2/4  ███████░░ 9/17  1.2M tok
   ▾ ✓ Find (5)          phase     done · 5 agents · 12s
   ▾ ⏳ Verify (4/8)      phase     running
   │  ▸ ✓ verify:auth     agent     done   3 tools  18k
   │  ▸ ⏳ verify:perf     agent     running · Bash(pytest…) 4s
   │  ▸ 🛑 verify:race     agent     STUCK · waiting approval → Write src/x.ts  [a]
   │  ▸ ⏳ verify:io       agent     running · Read 2 files
   ▸ ◌ Synthesize        phase     pending
 ▾ ⏳ reactor:pr-1421     reactor   running · turn 3 · 240k
 ▸ 💤 side:indexer        daemon    idle · last woke 4m
 ▸ ✓ remote:grade-500    remote    done · report.json ↓
 ───────────────────────────────────────────────────────────────────────────
  ↑↓ nav   ⏎ zoom   [a]pprove [c]ancel [r]esume   [w]hy   [/] filter   [h]istory
```

기깔포인트:
- **한 트리에 모든 kind**(workflow/reactor/daemon/remote) — fleet과 run이 분리된 화면이 아니라 줌.
- **🛑 STUCK + 즉시 액션 칩**([a]pprove) — 멈춘 이유와 해소를 같은 줄에서. (북극성)
- phase 진행 바 + 라이브 토큰/비용. `[h]istory`로 과거 run.

### 2.2 ★ Web (Tauri) — "Mission Control" 3-pane

```
 ┌── FLEET ─────────────┐┌── RUN  review-pr #a3f ──────────────┐┌── NODE ─────────┐
 │ ⏳ review-pr   1.2M  ││ Find ████ done        5 agents      ││ verify:race     │
 │ ⏳ reactor:pr  240k  ││ Verify ███▌ 4/8 ⏳                   ││ 🛑 STUCK         │
 │ 💤 side:index   —    ││  auth ▓▓▓ perf ▓▓ race ▓▓▓ io ▓     ││ waiting approval │
 │ ✓ remote:500   ↓    ││ Synth ░ pending                     ││ Write src/x.ts   │
 │                      ││  ← OTel waterfall, bar width=tokens ││ [Approve][Deny]  │
 └──────────────────────┘└─────────────────────────────────────┘└ tool tape ──────┘
```
- 좌: fleet 레인(상태색·kind 아이콘). 중: 선택 run의 **OTel 워터폴 스윔레인**(bar 폭=토큰). 우: 선택 node 디테일(tool 테이프·why-stuck·액션).
- 라이브 업데이트(agent-state push). embedded는 좌 레인만 compact strip.

### 2.3 저장형 워크플로 팔레트 (G1)

```
 ▌ /workflow                                       .quanta/workflows · 4 saved
 ──────────────────────────────────────────────────────────────────────
  review-pr    adversarial PR review (5 finders→verify)   ⏱~3m  ▲"review pr"
  ship-check   typecheck+test+lint fan-out                ⏱~1m
  migrate-api  codemod across call-sites (worktree)       ⏱~8m  ⚠ mutates
  research     multi-source deep research                 ⏱~5m
 ──────────────────────────────────────────────────────────────────────
  ⏎ run   [d]ry-run preview   [t]oggle keyword   [v]ersion-pin   [+]new
```
- `[d]ry-run preview`(S9): 실행 전 phase/agent 수·예상 토큰·mutates 여부를 트리로 미리. ⚠ mutates 뱃지.

**키워드 자동발동 consent 토스트** (§3 게이트 공유):
```
 ⚡ Workflow "review-pr" matched "review pr" — 17 agents · ~1.2M tok · ~$3
    Run now?   [y] once   [a] always in this repo   [n] no
```

### 2.4 Deep-link 핸드오프 confirm (G4 + S7)

`quanta://run?workflow=review-pr&repo=…&sig=…` 클릭 → Tauri 모달:
```
 ┌ Open in quanta? ──────────────────────────────┐
 │ Source: github.com PR #1421  (signed ✓)        │
 │ Action: run workflow  "review-pr"              │
 │ Scope : repo quanta-v3 · verbs[run] · TTL 10m  │   ← S7 capability 카드
 │ Route : ▸ new session   ○ active session #2    │
 │                         [ Open ]   [ Block ]   │
 └────────────────────────────────────────────────┘
```
- **서명·스코프·TTL을 카드로 가시화**(S7) — 권한 상승 불가를 사용자가 본다. 미서명 URI는 verb 실행 차단(빨강).

### 2.5 브라우저 origin JIT consent (G5 + S8)

에이전트가 새 origin으로 내비 시 토스트:
```
 🌐 Agent navigated to  evil-tracker.com
    wants: full CDP (cookies · evaluate · downloads)
    [R] read-only here   [T] trust site (full)   [B] block & back
    policy: trusted = github.com, internal.corp  ·  others = read-only
```
- 모바일 권한 모델(S8): origin별 **첫 민감 액션에 JIT**. trust 결정은 per-origin 원장에 누적, 다음부터 무프롬프트.

### 2.6 공통 디자인 토큰 (멀티서피스 일관)

- 상태 글리프 SSOT: `✓done ⏳running 🛑stuck 💤idle ◌pending ✗failed` — CLI/Web/embedded 동일(ui-helpers 레이어, ANSI strip 정책 존중).
- kind 아이콘: workflow/reactor/daemon/remote/subagent.
- 색은 ui-helpers가 결정(off면 글리프만) — `agents-fleet-panel.ts`의 PURE renderer 규율 계승.

---

## 3. Consent 게이트 통합 (G1·G4·G5 공유)

```
                         ┌─────────────────────────┐
  G1 keyword-trigger ──→ │  AgentActionConsentGate │ ──→ [allow / confirm / deny]
  G4 deep-link verb  ──→ │  (admissibility-gate +  │      · once / always / scope
  G5 origin escalate ──→ │   HITL inline approval) │      · capability(S7) 검증
                         └─────────────────────────┘
```
- 한 게이트, verb 3종. 결정 vocab은 기존 HITL 4-verb(approve/deny/steer/always) 재사용.
- "always in this repo / trust this site"는 **세션 grant 원장**(jun-11 prefix-grant 패턴) 공유.
- red-on-injection 하드룰: 미서명/스코프초과 verb는 게이트가 confirm 앞에서 HARD_DENY.

---

## 4. 통합으로 얻는 것 (왜 따로 안 짜나)

1. **새 UI 3개 → 1개 zoomable 트리.** fleet·run·agent가 한 컴포넌트의 줌. 유지보수·일관성·테스트 1/3.
2. **새 consent 모달 3개 → 1 게이트.** 보안 경계가 한 곳에 모여 감사·red-on-injection이 단일 지점.
3. **OTel spine이 라이브+히스토리+cost+diff를 한 번에**(S2). G3 히스토리, ADR-0536 cost 분석, 워크플로 diff가 같은 span 쿼리.
4. **북극성 직결**: "뭐하고(트리)/왜멈췄고(🛑+사유)/다음(pending+제안칩)"이 한 화면.

---

## 5. Phasing (백로그 §5 정렬 + UI 통합 반영)

- **P0-a — Spine 골격**: `AgentActivityEvent` 스키마 + item-stream/agent-state 통일 + workflow `sink→spine` 어댑터(G3) + in-proc/side-agent producer(G2 일부). dual-plane drift-ratchet(t01).
- **P0-b — Unified Activity UI**: CLI `/activity` 트리(줌 L0~L3) + Web Mission Control. why-stuck(S6) 1차.
- **P0-c — 저장형 워크플로(G1)**: registry + name/keyword 발동 + 팔레트 UI + consent 게이트(공유) + dry-run(S9).
- **P1 — 발동 갭**: G4 deep-link(+S7 서명 카드) → 공유 게이트. G5 origin policy(+S8 tier·JIT) → 공유 게이트.
- **SOTA 심화**: S1 durable(저널 resume) → 워크플로; S2 OTel 완전 일원화 → 히스토리/cost/diff; S3 budget fan-out; S5 supervisor tree.

각 단계 표준 5단계(헬게이트 RED→TDD+구조→적대어딧≥3R→셀프어딧→구조TDD). 착수 전 [00 백로그 §4 false-gap](./00-기능흡수-백로그.md) + substrate broad-grep 필수. **메타 규율**: 새 surface/게이트를 짜기 전에 "이게 spine/게이트 줌 레벨 아닌가?"를 먼저 물을 것 — 분리 UI/모달 재발명이 이 설계의 최대 안티패턴.
```
