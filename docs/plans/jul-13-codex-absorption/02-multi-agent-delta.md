# RFC: Codex `multi_agent_v2` 델타 흡수 (rebuild 아님)

> ## ⚠️ 정정 (HEAD 검증 리뷰 2026-07-13, targeted rail 26 pass/0 fail — 아래 본문 상충 시 이 블록 우선)
> **가장 먼저 고칠 문장 = "fork_turns 이미 있음 = 델타 없음". 틀렸다.**
> - **fork_turns = ALREADY-HAVE core / XS activation gap (완전 already-have 아님).** core(`dispatch-6.ts` forkPrompt none|all|number, handler)는 있으나 **strict 6-tool `SpawnAgentInputSchema`(`tools-6.ts:139`)에 `fork_turns` 필드가 없어 모델 호출이 schema 단계에서 reject**된다(parse: `success:false, unrecognized key: fork_turns`). 기존 parity 테스트도 `as never`로 schema를 우회함을 명시(`subagent-6-fork-parity-hellgate.test.ts:60`). 즉 **모델-visible 경로가 inert.** 작업 = (1) `SpawnAgentInputSchema`에 optional `fork_turns` 추가, (2) schema parse→handler→live-WM last-N preamble end-to-end 테스트 추가, (3) 기존 cast 기반 parity는 보조 rail 유지.
> - **slot accounting = already-have, 단 두 사실 분리.** registry slot 반환(running만 세고 terminal 즉시 반환 = Codex close-to-release보다 운영상 나음)이 green이라고 **child process/worktree/channel/resource가 실제 reaped됨을 자동 증명하지 않는다.** 후자는 OmO R-lane `StopReceipt`/Run Ledger가 소유(현 계획 유지).
> - **delegation suppression = true gap (유일한 진짜 gap), 그리고 default-ON 후보.** 억제 문구를 tool description 2곳에 흩지 말고 **system-level delegation policy 1곳을 SSOT**로 두고 두 tool surface가 투영. spawn 허용조건 명시(explicit authorization ∧ independent subtasks ∧ write-set 분리/read-only ∧ 예상 wall-time 이득 > coordination cost). 메트릭을 unnecessary-spawn rate 하나로 끝내지 말 것 → task success·total tokens·wall time·duplicated exploration·write collision·child error propagation·parent synthesis failure. 현 프롬프트가 적극 fan-out 권장 + 외부근거(Google 180-config: sequential에서 multi-agent 39–70% 악화)가 single-agent-first 지지 → **eval corpus 회귀확인 후 default-ON 전환**이 default-OFF A/B보다 타당.

- **상태**: Draft design / 구현 미착수
- **범위**: 우리 기존 subagent orchestration 위에 Codex 5059 `multi_agent_v2`의 **델타 3개만** 얹는다. spawn/message/wait/registry 재구현 금지.
- **관련 코드**:
  - `src/subagent/dispatch-6.ts` (`Subagent6Deps` — forkPrompt/maxConcurrent seam)
  - `src/subagent/handlers-6.ts` (`handleSpawnAgent`/`countRunning`/`buildSubagentRequest`)
  - `src/subagent/registry.ts` (`TaskStatus`/`pendingIds`/`complete`/`close`)
  - `src/subagent/tools-6.ts` (spawn_agent 6-tool 계약·description)
  - `src/subagent/agent-tool.ts` (trio `agent` tool description)
- **증거**: `.extracted_source/codex/_codex-bin-symbols.txt` (`multi_agents_v2` 핸들러·spawn_agent 프롬프트 문자열)
- **교차**: 델타 (b) concurrency-slot은 OmO 티켓 `docs/tickets/jul-12-agent-runtime-correctness.md`(R-lane lifecycle)와 **겹친다 — 한 번만 한다**(§4.2).

---

## 0. North-star 제약 (no-dup)

이건 멀티에이전트 **rebuild가 아니다**. 선행 어딧이 "우리는 subagent/side-agent/team equivalent를 이미 가졌다"로 판정했고, 이 문서는 그 판정을 뒤집지 않는다. Codex `multi_agent_v2`를 우리 것과 대조해 **진짜 델타 3개만** 골라 기존 seam에 얹는다.

- **absorb-only**: 새 orchestrator·새 registry·새 tool set 만들지 않는다. `Subagent6Deps` / `handleSpawnAgent` / `TaskRegistry`의 기존 주입점 하나씩만 건드린다.
- **measure-first / default-OFF**: 델타마다 knob으로 opt-in. §5 효능 metric이 개선을 못 보이면 **삭제**.
- **no arbitrary threshold**: concurrency cap·suppression 강도 같은 값을 하드코딩 안 한다(우리 코드가 이미 이 invariant를 pin — `handlers-6.ts:673-676`).

---

## 1. 흡수 대상 델타 (Codex 증거)

`.extracted_source/codex/_codex-bin-symbols.txt`에서 `multi_agents_v2` 핸들러 트리(`spawn.rs`/`wait.rs`/`send_message.rs`/`followup_task.rs`/`interrupt_agent.rs`/`list_agents.rs`, line 7795-8045)와 spawn_agent 프롬프트를 깠다. 우리와 **다른** 지점 3개:

- **(a) fork_turns context inheritance** — `spawn_agent`이 `fork_turns` 파라미터로 부모 컨텍스트 상속을 제어. `none`=상속 없음, `all`=전체 상속, positive-N=최근 N턴만 partial fork.
  > 증거 line 8097: *"passing `fork_turns="none"` will not pass any surrounding context ... whereas `fork_turns="all"` will provide the subagent with all surrounding context."*
- **(b) concurrency-slot accounting** — Codex의 slot 회계는 "완료된 에이전트도 close될 때까지 slot을 점유"하는 모델(별도 `close_agent` 핸들러 line 8032, `list_agents` line 8044로 lifecycle 관측).
- **(c) delegation-default-suppression 프롬프트** — spawn_agent description이 위임을 default로 억제.
  > 증거 line 8053-8054: *"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn."*

---

## 2. 현황 (anti-dup, REPO 실증)

각 델타를 우리 실제 spawn 계약에 대고 대조했다. **cite = file:line.**

### 2.1 우리 spawn 계약 요약

- 6-tool spawn: `handleSpawnAgent` (`handlers-6.ts:642`) — depth cap(`:662-669`), concurrency cap(`:677`), fork 프리앰블 합성(`:598-600`)을 이미 태운다.
- registry: `TaskRegistry` (`registry.ts`) — `TaskStatus = "running" | "completed" | "failed" | "stopped"` (`:3`). `complete`/`fail`/`stop`이 status를 settle시키고 `settlers`/`owners`/`aborters`를 정리(`:127-152`).
- context 상속: `Subagent6Deps.forkPrompt?: (prompt, spec: "none" | "all" | number) => string` (`dispatch-6.ts:73`). `handleSpawnAgent`은 `input.fork_turns ?? "none"` → `deps.forkPrompt(...)` (`handlers-6.ts:598-600`). trio `agent` tool과 **동일한** `applyForkPromptIfNeeded` 클로저를 composition root가 주입(byte-identical).
- concurrency limit: `deps.maxConcurrent` (`dispatch-6.ts:76`) → `countRunning(registry) >= maxConcurrent`이면 spawn deny (`handlers-6.ts:677-680`). `countRunning = registry.pendingIds().length` (`:561`), `pendingIds()`는 **status === "running"만** 반환 (`registry.ts:119-125`).
- suppression 프롬프트: trio `agent` description은 `agent-tool.ts:648-656`, 6-tool `spawn_agent` semantics는 `tools-6.ts:329` — 둘 다 **위임 억제 문구 없음**(repo-wide grep 0건).

### 2.2 델타별 판정

#### (a) fork_turns → **ALREADY-HAVE**
`Subagent6Deps.forkPrompt`의 타입이 정확히 `"none" | "all" | number` (`dispatch-6.ts:73`). Codex의 none/all/positive-N을 이미 다 태운다 — `number`가 partial-N-turn fork다. `handlers-6.ts:598`이 `input.fork_turns`를 읽어 프리앰블을 합성하고, trio `agent` tool과 동일 클로저를 공유해 byte-identical. **주석에 이게 ALBB-16 #2로 이미 랜딩됐다고 명시됨.** 델타 없음.

⚠️ 단, seam이 **inert일 수 있다**: `fork_turns`는 frozen 6-tool 스키마에 아직 없어서(`handlers-6.ts:595-596` 주석 자백) post-parse에 사라질 수 있고, 그럼 항상 `"none"`으로 degrade. 즉 partial-N fork가 **선언은 됐지만 LLM이 실제로 값을 넣을 표면이 없을 수 있다**(§3.1에서 검증).

#### (b) concurrency-slot accounting → **PARTIAL (의미론이 반대)**
우리는 slot을 **settle 즉시 반납**한다: `pendingIds()`가 `status === "running"`만 세므로(`registry.ts:122`), 완료/실패/정지된 task는 cap에서 빠진다. `complete`(`:127`)/`fail`(`:141`)이 running→terminal 전이 시 곧바로 `evictIfOverCap()`까지 부른다. Codex 델타는 **반대** — "완료된 에이전트도 `close_agent`될 때까지 slot 점유". 우리에겐 close-to-reclaim lifecycle 자체가 없다(settle=reclaim).

이건 단순 "구현 여부"가 아니라 **정책 선택**이다. 그리고 이 lifecycle 질문(완료 subagent가 slot/자원을 언제 놓는가 = orphan 회수)은 OmO 티켓 R-lane과 **정확히 같은 표면**이다(§4.2). TRUE-GAP이 아니라 PARTIAL로 분류하는 이유: 우리 회계는 이미 결정론적이고 leak-free다; Codex 모델은 다른 tradeoff(close 강제 → 명시적 lifecycle 관측)일 뿐 우월하지 않다.

#### (c) delegation-suppression → **TRUE-GAP**
우리 spawn description 어디에도 억제 문구 없음(`agent-tool.ts:648-656`, `tools-6.ts:329`, repo grep 0). Codex는 "depth/thoroughness/research는 위임 허가로 치지 않는다"까지 못박는다(line 8054). 우리 description은 오히려 fan-out을 **권장**한다("For running MANY children concurrently ... use spawn_agent", `agent-tool.ts:654`). 순수 프롬프트 델타 — 흡수 값싸고 명확.

---

## 3. 제안 (PARTIAL/GAP만, 기존 seam 재사용)

### 3.1 (a) fork_turns — seam 활성 검증만 (거의 무작업)
구현은 이미 있으니 **재구현 금지**. 할 일은 partial-N 경로가 inert가 아님을 pin:
- `SpawnAgentInputSchema`(`tools-6.ts:139~`)에 `fork_turns?: "none" | "all" | number`가 실제로 있는지 확인. 없으면(주석 자백대로) 스키마에 **optional 필드 하나 추가** — 이게 유일한 코드 변경. 핸들러/클로저는 손대지 않는다(이미 `number`를 받음).
- red-on-injection 테스트: `fork_turns: 2`로 spawn → `forkPrompt`가 2턴짜리 프리앰블을 실제로 합성하는지(현 클로저가 `number`를 partial로 처리하는지 실증). 처리 안 하면 그건 trio `agent` tool 쪽 `applyForkPromptIfNeeded`의 별도 gap이며 **거기서 한 번만** 고친다(SSOT).
- default-OFF는 자동: `forkPrompt` 미주입 ⇒ raw prompt(byte-identical). 스키마 필드는 추가돼도 LLM이 안 쓰면 `?? "none"`.

### 3.2 (b) concurrency-slot — OmO R-lane과 **한 번만** (핵심 교차)
> 🔴 **이 항목은 OmO 티켓 `docs/tickets/jul-12-agent-runtime-correctness.md` R-lane(process/resource lifecycle, `ResourceScope.close()` terminal-await)과 겹친다. 두 번 하지 않는다.**

두 관점의 관계:
- OmO R-lane: **OS process/resource** lifecycle — child가 terminal/reaped될 때까지 close가 await(`side-agent-fork-port.ts:78` stopgap). "완료됐지만 자원 아직 안 놓은" 상태를 닫는 것.
- 이 델타: **registry slot** 회계 — "완료된 task record가 cap에서 언제 빠지나". 우리는 settle 즉시 반납(`pendingIds` running-only).

**결론: 별도 작업을 만들지 않는다.** 이유:
1. 우리 slot 회계는 이미 leak-free이고 결정론적(settle=reclaim, `evictIfOverCap`). Codex의 "close까지 점유" 모델로 **바꿀 이유가 없다** — 그건 orphan 관측을 위한 명시적 lifecycle이 필요할 때의 선택인데, 그 lifecycle receipt는 이미 OmO R-lane이 `ResourceScope` StopReceipt + Run Ledger(`src/agent/run-ledger/`, OmO RFC §0.2)로 짓고 있다.
2. 따라서 흡수할 델타의 **가치 있는 부분**(완료 subagent가 자원을 언제/어떻게 놓았는지 관측)은 R-lane이 이미 owner다. 여기서 할 일은 **cross-reference 한 줄**: subagent settle 시 registry가 R-lane StopReceipt를 Run Ledger로 report하는지 확인(신규 event stream 금지, OmO §0.2 준수). 이미 배선돼 있으면 무작업.
3. registry의 running-only cap 의미론은 **그대로 둔다**. Codex 모델로 재작성 = net-negative(결정론적 회계를 명시적 close 요구로 바꿔 orphan slot 위험 신설).

즉 이 델타는 사실상 **"R-lane이 subagent lifecycle receipt를 커버하는지 확인"**으로 축약되며, 새 코드는 R-lane 티켓에만 있다.

### 3.3 (c) delegation-suppression — 프롬프트 흡수 (우리가 더 약함)
우리 description이 Codex보다 약하다(억제 0 vs 명시적 금지). 흡수:
- `agent-tool.ts:648-656` (trio `agent`)와 `tools-6.ts:329` (6-tool `spawn_agent` semantics)의 description에 Codex line 8053-8054 취지 추가:
  > "명시적 요청(user 또는 AGENTS.md/skill이 sub-agent·위임·병렬 작업을 지시) 없이는 spawn하지 마라. depth·thoroughness·research·investigation·상세 분석 요구는 위임 허가로 치지 않는다."
- **기존 fan-out 권장 문구와 조율**: `agent-tool.ts:654`("For running MANY children concurrently ... use spawn_agent")는 삭제하지 말고 **조건화** — "명시적 병렬 위임이 승인된 경우, N개 동시 실행/mid-run steering은 spawn_agent"로. 우리 강점(spawn_batch·send_input)은 유지, default 억제만 얹는다.
- knob으로 gate: `QUANTA_SUBAGENT_DELEGATE_SUPPRESS`(default-OFF). description 문자열은 프롬프트-경로라 A/B가 곧 두 description variant 스왑. off=현행 byte-identical.
- Codex 프롬프트 line 8055-8078의 "when to delegate / disjoint write set / do meaningful non-overlapping work" 세부는 **이번 스코프 밖**(그건 우리 병렬 워크플로가 이미 실무로 커버; 흡수하면 프롬프트 비대). suppression 한 문단만.

---

## 4. 측정 (per-delta, default-OFF, 효능 없으면 삭제)

각 델타는 독립 metric. 개선 미실증 시 해당 델타 revert.

### 4.1 fork_turns = context tokens saved
- metric: `fork_turns: N`(partial)로 spawn된 child의 seed prompt 토큰 vs `all`. partial이 컨텍스트 손실 없이 토큰을 줄이는지.
- gate: partial이 `all` 대비 seed 토큰 감소 AND child 성공률 비열화. 개선 0이면 스키마 필드 제거(핸들러는 이미 있으니 no-op으로 남음).

### 4.2 concurrency-slot = orphan subagents
- **OmO 티켓 §11.1 baseline 공유**(별도 baseline 안 만든다): "orphan/leaked process가 실패·stuck 세션 몇 %를 유발하는지(trajectory 스캔)". subagent slot 관점 = "settle됐는데 registry/자원 회수 안 된 record 수".
- gate: R-lane receipt 배선 후 orphan subagent slot = 0(현 회계가 이미 0이면 델타 무작업 확정). §11.1이 orphan을 무의미하다고 판정하면 이 델타는 CUT과 함께 사라진다.

### 4.3 delegation-suppression = unnecessary-spawn rate
- metric: trajectory에서 "user/AGENTS.md 명시 요청 없이 spawn된 subagent" 비율(unnecessary-spawn). suppression variant on/off A/B.
- gate: unnecessary-spawn rate 하락 AND task 성공률·latency 비열화(억제가 필요한 위임까지 죽이면 안 됨). 개선 0 또는 성공률 하락 시 description 원복.

---

## 5. Effort / Risk

| 델타 | 판정 | Effort | Risk | 비고 |
|---|---|---|---|---|
| (a) fork_turns | ALREADY-HAVE | XS (스키마 필드 1개 + inert 검증 테스트) | 낮음 | 핸들러 이미 존재; partial-N inert 여부만 pin |
| (b) concurrency-slot | PARTIAL | **0 (R-lane에 흡수)** | 중 | 🔴 OmO R-lane 중복 — 별도 작업 만들면 double-work. cross-ref만 |
| (c) delegation-suppress | TRUE-GAP | S (description 2곳 + knob + A/B) | 낮음 | 순수 프롬프트; fan-out 문구 조율 주의 |

**리스크 플래그(명시)**: (b)는 OmO 티켓 R-lane lifecycle work와 **표면이 겹친다**. 이 RFC는 (b)에 대해 **새 구현을 지시하지 않는다** — registry 회계는 현행 유지, 관측 receipt는 R-lane/Run Ledger가 owner. 누군가 이 RFC를 보고 registry slot 재작성을 시작하면 double-work이자 net-negative(결정론적 회계 훼손). §3.2를 SSOT로.

---

## 6. 요약 (3줄)

1. **fork_turns는 ALREADY-HAVE** — `dispatch-6.ts:73`이 이미 `none|all|number`(partial-N)를 태우고 trio와 클로저 공유; 유일 잔여는 6-tool 스키마에 `fork_turns` 필드가 있어 LLM이 값을 넣을 수 있는지 inert 검증(XS).
2. **concurrency-slot은 PARTIAL이지만 무작업** — 우리는 settle=즉시반납(leak-free, `registry.ts:122`)이라 Codex "close까지 점유" 모델로 바꿀 이유 없음; 가치 있는 lifecycle-receipt는 OmO R-lane이 이미 owner라 **cross-ref만**(double-work 금지).
3. **delegation-suppression만 진짜 TRUE-GAP** — 우리 description은 억제 0이고 오히려 fan-out 권장(`agent-tool.ts:654`); Codex line 8053-8054 취지를 description 2곳에 knob-gated(default-OFF)로 흡수, unnecessary-spawn rate로 A/B, 효능 없으면 원복.

**진짜 gap = (c) 하나. (a)=already-have, (b)=already-have한 회계 + R-lane로 흡수됨.**
