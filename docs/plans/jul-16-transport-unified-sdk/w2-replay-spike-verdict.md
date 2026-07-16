# W2 deterministic-replay 스파이크 verdict — ADR-0540 Wave 2 GO/NO-GO

- **Date:** 2026-07-16
- **Status:** SPIKE COMPLETE (read-only recon; 소스 무수정)
- **질문:** 프로세스 재시작 후, LLM 재샘플 없이 죽기 전 턴을 승인점까지 결정적으로 replay해서 `awaiting_approval`(pending approval + 그 시점 대화 상태)를 복원할 수 있는가? (ADR-0540 W2 item 4의 전제)

---

## Verdict: **GO-with-rescope**

- **item 4가 명시한 문자 그대로의 "결정적 full-turn replay" = NO-GO.** 실코드 확증: (a) replay에 필요한 원료(턴 내부 LLM 응답·툴 결과)가 어디에도 영속되지 않고, (b) 영속시켜도 재실행 경로가 결정적이지 않으며(request에 per-turn 동적 블록·randomUUID), (c) **모범이라던 Codex rollout replay 자체가 "턴 재생"이 아니라 full-item 트랜스크립트 재구성**이다(아래 §4b). 두 차례 recon의 "대형 신규 scheduler 작업" 수렴은 **맞다** — 그리고 그 작업은 지을 필요가 없다.
- **문제 재정의 후 GO:** W2가 실제로 필요로 하는 것은 "턴 재생"이 아니라 **"승인점 checkpoint 영속 + 상태 복원 + exactly-once 재개"**다. 승인점은 툴 실행 *직전*이므로, 그 시점의 대화 상태는 `[…history, 조립완료 assistant 메시지]` + 이미 실행된 슬롯들의 tool_result로 **완전히 물질화 가능**하며 — 전부 승인 대기 시점에 메모리에 실존한다(§3). 이걸 기존 세션 스냅샷 스토어(atomic-rename JSONL, 이미 온디스크)에 싣고, 재개는 pending 툴부터 exactly-once로 실행 후 **fresh continuation LLM 콜**(재샘플이 아니라 최초 샘플)로 잇는다. LLM 재샘플 0, 툴 중복실행 0 — item 4가 지키려던 두 invariant를 replay 없이 달성.
- 권장 경로 = **Path B(승인점 checkpoint)**, 크기 **M**. 상세 §5-6.

---

## 1. 지금 뭐가 영속되나 — "죽기 전 턴의 mid-turn 상태" 원료는 **0**

| 표면 | 실코드 | mid-turn에 주는 것 |
|---|---|---|
| 세션 스냅샷 스토어 | [persist-turn.ts:44-65](../../../src/runner/orchestrate/persist-turn.ts) — `persistTurn`은 `runRuntimeTurn`의 **성공 return 후**에만 호출([turn-runner.ts:154](../../../src/host/runtime/internal/context-binding/turn-runner.ts)); web도 `turn.completed`에만 저장([transcript-persist.ts:79](../../../src/apps/web-daemon/server/transcript-persist.ts)) | **없음** — 턴 경계 스냅샷뿐. 단, 스토어 자체는 full `Message[]` 무손실 JSON([store.ts:340-356](../../../src/session/store.ts), `SavedSession.messages`) — **checkpoint를 실을 그릇으로는 이미 충분** |
| 승인점의 kernel 상태 | 스케줄러 `onApprovalRequested`가 `status:"awaiting_approval"`+`pendingApproval`+`messages:[...result.messages]` 커밋([scheduler.ts:238-245](../../../src/kernel/session/scheduler.ts)) — 그러나 그 `result.messages`는 approval-throw catch가 돌려준 **pre-turn history 그대로**([turn-runner.ts:186-192](../../../src/host/runtime/internal/context-binding/turn-runner.ts) `messages: [...args.history]`) | **없음** — 조립된 assistant 메시지·실행된 tool_result 전부 메시지 레벨에서 버려짐. `transcript.messages()` 무손실 read([session.ts:95](../../../src/sdk/runtime/session.ts) `[...box.state.messages]`, [types.ts:116-120](../../../src/sdk/runtime/types.ts))도 같은 걸 읽으므로 승인점에선 pre-turn history 반환 |
| reload | [state.ts:92-113](../../../src/kernel/session/state.ts) `createKernelSessionState` — 무조건 `status:"idle"`, `pendingApproval:null`, `seq:0` | **없음** (ADR 관측 그대로; rehydrate 입력 슬롯 자체가 없음) |
| crash-resume 마커 | [crash-resume.ts](../../../src/session/crash-resume.ts) + [types.ts:82-91](../../../src/session/types.ts) `PersistedInterruptedTurn = {userText, partialAssistantText, reason, interruptedAt}` | **prose 2필드뿐.** 주석이 명시적으로 실토: 구조화 블록은 못 실어서 resume 메시지에 "이미 적용된 변경 재실행 금지" 경고문을 붙임([crash-resume.ts:220-239](../../../src/session/crash-resume.ts) `RESUME_INSPECT_GUIDANCE`) — **재실행 문제를 프롬프트로 완화 중인 현장 증거** |
| kernel event log | [event-log.ts:4-14](../../../src/kernel/session/event-log.ts) `InMemorySessionEventLog` 유일 구현, 배열 push | **없음** (프로세스와 소멸; ADR W2 item 0 전제 그대로) |
| web-daemon sqlite | [persistence-sqlite.ts:10-14](../../../src/apps/web-daemon/persistence-sqlite.ts) "does NOT mutate the runtime — just observes"; restart-rehydrate 경로 0 | **재사용 불가 판정 확정 + 정량 근거**: 이벤트 자체가 손실 — projection이 tool args/results를 **256자 preview로 clamp**([session-host-turn-event-bridge.ts:141-147](../../../src/host/runtime/internal/session-host-turn-event-bridge.ts) `PREVIEW_MAX = 256`, :65 `argsPreview`, :73 `resultPreview`). transcript-persist.ts:5-6 주석도 동일 진단 |

**⇒ 핵심 함의(W2 설계 결함 발견):** item 0(온디스크 event log)과 item 4(persisted transcript replay)는 **합성이 안 된다.** 현행 `SessionEvent` 어휘는 preview-clamped라 정확한 `Message[]`를 재구성할 수 없다 — 이벤트 로그를 디스크에 내려도 replay 원료가 못 된다(Codex rollout이 되는 이유는 §4b: full `ResponseItem`을 기록하기 때문). 온디스크 event log의 진짜 고객은 승인 durability가 아니라 **ticket 05 wire replay**다.

## 2. LLM record/replay 인프라(카세트) — 부품으로 쓸 수 있나

- 실체: `LLMPort` 레벨 record/replay 어댑터 페어([recording-llm.ts:380-399](../../../src/llm/replay/recording-llm.ts), [replay-llm.ts:69-122](../../../src/llm/replay/replay-llm.ts)), JSONL 스토어 + 요청해시 매칭([jsonl-store.ts:95-113](../../../src/llm/replay/jsonl-store.ts)). default-OFF, bench 컴포지션에서만 배선.
- 결정성 계약: `exact` 해시 = `{messages, system, tools, thinking, toolChoice, promptCacheKey, promptCacheRetention}` sorted-key SHA-256([jsonl-store.ts:98-106](../../../src/llm/replay/jsonl-store.ts)); metadata는 REPLAY-NEUTRAL([types.ts:56-63](../../../src/llm/replay/types.ts)); 동일요청 반복은 first-unused 매칭([types.ts:128-133](../../../src/llm/replay/types.ts)).
- **full-turn replay 부품으로는 부적격 2가지:**
  1. **기록 내용이 부족**: 카세트는 LLM stream event만 기록. **tool_result는 어디에도 없다** — 다음 라운드 request의 `messages` 안에 내용물로만 간접 존재하고, **마지막 라운드(승인 라운드)에서 이미 실행된 슬롯들의 결과는 후속 request가 없어 영원히 소실**. full replay를 해도 툴 결과 주입원이 없어 재실행(부작용 중복)으로 후퇴한다.
  2. **해시가 재시작을 못 넘는다**: request `messages`에 per-turn 동적 블록이 실린다 — `Today's date is YYYY-MM-DD` 라인이 injected-clock으로만 결정화되는 설계([prompt.ts:320-325](../../../src/agent/prompt.ts)), hook injects·plan notice도 동적([prompt.ts:326-342](../../../src/agent/prompt.ts)). crash 전후 어떤 바이트든 다르면 `exact` miss → `ReplayMissError` 또는 live 폴백(=재샘플, 보장 소멸).
- **단, 승인점 checkpoint 경로에서는 훌륭한 재사용 부품**: 재개 시 "기록된 최종 assistant 스트림 이벤트를 1회 yield 후 live 위임"하는 one-shot port가 필요하면 `replayLlmPort`의 `onMiss:"passthrough"` 패턴([replay-llm.ts:34-50](../../../src/llm/replay/replay-llm.ts))이 그대로 원형이다(§5 Option R1).

## 3. 턴 재생의 실제 요구사항 — 승인점 해부 (핵심 난제 답)

턴 anatomy (approval까지의 경로, 전부 실코드):

1. same-turn 엔진이 `for(;;)`로 LLM 라운드 반복([same-turn-engine.ts:27](../../../src/agent/loop/same-turn-engine.ts)) → `streamConsume` → `streamingTurn`.
2. `streamingTurn` phase 계약([streaming-dispatch.ts:577-656](../../../src/agent/streaming-dispatch.ts)): 스트림 소비 중 **read-only 툴만** early-dispatch(FIX 6: `earlySafe = isReadOnly`, [streaming-dispatch.ts:379-386](../../../src/agent/streaming-dispatch.ts)) → 스트림 종료 → assistant 메시지 조립(:600) → Phase 2 early join(:609-615) → **Phase 3 serial drain**(:517-539) — mutating 툴은 전부 여기서 모델콜 순서대로 실행.
3. ask-branch가 `onConfirm` await([gates.ts:412-414](../../../src/agent/admissibility-gate/gates.ts)) → deferred surface면 `runOnConfirm`이 pending mint + **throw**([approval-protocol.ts:248-276](../../../src/host/runtime/internal/context-binding/approval-protocol.ts); `approvalId: crypto.randomUUID()` :249), inline surface(CLI)면 same-turn await(:221-246).
4. throw는 drain에서 즉시 재전파([streaming-dispatch.ts:531](../../../src/agent/streaming-dispatch.ts)) → 루프 밖으로([turn-loop.ts:130-138](../../../src/agent/loop/turn-loop.ts)) → turn-runner catch가 **pre-turn history로 강등**(:186-192).

**⇒ 승인 대기 시점(=슬롯 N의 gate)에서 메모리에 실존하는 것:**
- 조립완료 assistant 메시지(+원본 rawEvents) — ask-gated 툴은 사실상 전부 Phase-3(post-assembly)이므로 완전함. (예외 각주: read-only이면서 ask-gated인 조합만 Phase-2 join에서 잡히는데, 이때도 join은 스트림 종료 후다 — :609-615.)
- 슬롯 0..N-1의 settled tool_result(부작용 이미 커밋됨), slot N의 action/actionKey(pending record가 full action 보유, [approval-support.ts:23-41](../../../src/host/runtime/internal/context-binding/approval-support.ts)), N+1.. 미실행 콜 목록.

**핵심 난제("앞선 툴들 재실행이냐 결과주입이냐")의 답: 지금의 deferred 경로는 이미 '재실행+재샘플'이다.** 승인 후 `driveSessionTurn` `for(;;)`([session-turn-driver.ts:141-145](../../../src/runner/orchestrate/session-turn-driver.ts))가 bare `turn.run` 재발행 → reducer가 보존된 draft로 **턴 전체를 처음부터 재실행**([reducer.ts:260-274](../../../src/kernel/session/reducer.ts); `onApprovalRequested`는 draft를 안 지움) → LLM 재샘플(~140k 토큰 재지불, ADR 관측) + **슬롯 0..N-1 부작용 중복실행**(lease는 승인된 actionKey 하나만 커버, [approval-protocol.ts:89-104](../../../src/host/runtime/internal/context-binding/approval-protocol.ts)). 이 double-exec class는 코드베이스가 이미 알고 문서화한 위험이다([streaming-dispatch.ts:356-373](../../../src/agent/streaming-dispatch.ts) FIX 6 "double-exec risk", [crash-resume.ts:220-231](../../../src/session/crash-resume.ts)). **따라서 checkpoint 경로는 기존 보장을 깎는 게 아니라 crash-durability와 함께 in-process 재실행 낭비까지 수리한다.**

full deterministic replay가 요구했을 것들(전부 신규): 라운드별 LLM 응답 영속(항시 녹음) + 라운드별 tool-result journal(신규 substrate — §2-1) + request 바이트 안정화(동적 블록 시계·hook 동결) + `approvalId`/turnId 결정화(:249, [turn-loop.ts:70](../../../src/agent/loop/turn-loop.ts) `crypto.randomUUID()`) + miss-policy(폴백=재샘플이면 보장 자체가 확률화). — "대형 신규 scheduler 작업" 수렴 **확정**.

## 4. 대안 경로 평가

**(a) 승인점 스냅샷 직렬화 — 성립하고, 우월하다.** 승인점의 대화 상태는 `[…history, assistantMsg, user(tool_results 0..N-1 + pending/remaining 처리)]`로 완전 물질화 가능(§3). 이미 있는 무손실 그릇(SavedSession)에 additive 필드로 실린다. "새 continuation 턴" 순수 변형(문제 정의의 (a): pending을 synthetic-interrupted result로 봉인하고 짧은 재샘플)은 **차선**: LLM이 승인된 액션을 다시 제안한다는 보장이 없어 승인 시맨틱이 확률화된다. 우월 변형 = **checkpoint-resume**(§5): 승인된 slot N을 gate-pre-armed로 직접 dispatch → 진짜 result 획득 → 그 다음 LLM 콜은 어차피 처음 도는 continuation(재샘플 아님).

**(b) Codex rollout ground truth — W2 item 4의 전제가 오독이었다.** `.extracted_source/codex/_codex-bin-symbols.txt` 실측:
- rollout = `rollout/src/recorder.rs`·`state_db.rs`·`session_index.rs` + **`RolloutItem`에 `ResponseItem`(196 hits)·`turn_context`·`compacted`·`event_msg`** — 즉 **API-shape full item JSONL**. 우리 256자 preview 이벤트와 달리 트랜스크립트를 무손실 재구성할 수 있는 이유가 이것.
- `rollout-trace/src/reducer/...` — replay = **reducer로 상태 재구성**(UI/히스토리), LLM 호출 재생이 아님.
- 승인 대기는 `WaitingOnApproval`(2 hits) — **in-memory thread status**. ADR-0540 자신도 확인했듯(§반전) Codex도 crash면 pending approval을 잃는다. **"Codex rollout replay와 동형"이 되려면 turn 재생이 아니라 "full-item 로그 + 상태 재구성"이어야 하고, pending-approval durability는 Codex에도 없는 신규 capability다** — 그래서 W2의 차별화 서사(ticket 05 ROI "Codex/Claude 부재 기능")와 오히려 정합.

**⇒ 문제 재정의:** W2에 필요한 건 "턴 재생"이 아니라 **"상태 복원 + 승인 재개"**. 재생은 수단이었고, checkpoint가 같은 목적을 더 작게 달성한다.

## 5. 권장 최소 메커니즘 — 승인점 checkpoint + exactly-once 재개 (Path B)

```
[승인 필요 slot N, gate 도달 — persist-BEFORE-await/throw (W2 item 1)]
  TurnCheckpoint = {
    approvalId, actionKey, action(=pending record의 ToolAction),
    assistantMessage (또는 rawEvents),          // streamingTurn :600 조립본
    completedResults: [slot0..N-1 tool_result],  // settled promises
    remainingCalls:   [slotN+1.. {id,name,input}],
    turnDraft: {prompt, images}                  // reducer가 보존 중인 draft
  }
  → SavedSession.pendingTurn (additive 필드, saveSessionById 기존 atomic-rename)
  → kernel: status="awaiting_approval" 유지 + messages를 pre-turn이 아닌
    [...history, assistantMessage]로 커밋 (turn-runner catch 강등 수리)

[재시작 (W2 item 3)]
  resume-fsm 로드 확장: SavedSession.pendingTurn 있음 →
  createKernelSessionState에 status/pendingApproval/messages rehydrate 입력 추가
  + host `pending` Map 재시드 ← 필수: resolveApprovalDecision은 record 없으면
    silent no-op ([approval-protocol.ts:411-413]) — rehydrate만 하고 이걸 빠뜨리면
    답변이 조용히 삼켜진다 (스파이크가 찾은 최대 배선 함정)

[답변 도착 (approve/deny) — 재개]
  Option R2(권장, 더 작음): 승인 decision을 lease로 mint → "resume turn" 실행:
    slot N을 dispatchTool 바인딩으로 직접 실행(lease가 gate 통과) →
    remainingCalls 순차 dispatch(각자 gate 정상 통과; 새 승인 뜨면 재귀=동일 메커니즘) →
    user 메시지 [completedResults + 새 results] 조립·append →
    같은 messages로 continuation LLM 콜 (최초 샘플) → 이후 정상 루프
  Option R1(대안): checkpoint의 rawEvents를 one-shot replayLlmPort(§2)로 1회 재생,
    streamingTurn에 resultOverrides{toolUseId→block} 주입해 0..N-1 재실행 차단 —
    dispatch 머신러리를 전부 실경로로 태우는 대신 override seam이 추가로 필요

[crash 전에 답변까지 왔었으면 (W2 item 2의 잔존 가치)]
  decision도 checkpoint에 append-persist → 재시작 시 재프롬프트 없이 즉시 재개
  (= claimLease 개념의 디스크 이관; "replay 도달 후 로그 조회"가 아니라 로드 시 1회 조회)
```

- **결정성 요구 소멸**: approvalId를 재도출할 일이 없다(민팅 1회 후 영속) → item 1의 "결정적 approvalId" 요구가 "영속된 approvalId"로 완화. 난수/시간 동결 전부 불필요. LLM 재샘플 0(continuation은 미샘플 구간), 툴 부작용 exactly-once.
- **inline(W1)과의 정합**: capture 지점이 deferred-throw(:276)든 inline-await(:221)든 같은 gate 경계라 checkpoint 계약이 동일 — W1 확장과 충돌 없음.

### 크기 추정 (닿는 레이어 · 신규 코드)

| 경로 | 레이어 | 추정 | 판정 |
|---|---|---|---|
| **A. full deterministic replay** | 항시 LLM 녹음 컴포지션(+scrub/rotation) · tool-result journal(신규 substrate) · request 바이트 동결(prompt 동적블록/시계) · id 결정화 · host 재생 스케줄러 · miss-policy | **XL** (~3-5k LOC, 신규 invariant 다수) | **NO-GO** — 비용 대비 얻는 것 = checkpoint와 동일 결과; 마지막-라운드 결과는 어차피 승인점 capture 필요(§2-1)라 자기모순 |
| **B. 승인점 checkpoint + 재개 (권장)** | streaming-dispatch(capture seam ~수십 LOC) · approval-protocol(persist hook + pending 재시드) · turn-runner(catch가 checkpoint messages 반환) · session store(additive 필드) · state.ts(rehydrate 입력) · crash-resume(marker→checkpoint 포인터) · resume 실행기(driver/host 신규 진입점, 최대 덩어리) · hellgate #4 e2e | **M** (~0.8-1.5k LOC+tests) | **GO** |
| **C. 상태복원 + 오늘의 재실행 continuation** | scheduler(승인점 persist) · state.ts(rehydrate) · pending 재시드 · surface 재offer | **S** (~0.2-0.4k) | 보류 — crash-durable해지지만 재샘플+double-exec(§3)를 영속화. B의 부분집합이므로 중간 착지로만 의미(B의 1-2단계와 동일 코드) |

C ⊂ B 관계라 **B를 2웨이브로 착지**(W2-a: persist+rehydrate+재offer=C 상당, W2-b: exactly-once 재개 실행기)하는 게 자연스러운 시퀀싱.

## 6. ADR-0540 W2 items 0-5 정합 — 뭘 바꿔야 하나

| item | 판정 | 변경 |
|---|---|---|
| 0. 온디스크 KernelEventLogPort | **KEEP, 단 역할 재배정** | 승인 durability의 전제조건이 **아니다**(그 원료로 못 씀 — §1 preview-clamp). 고객 = ticket 05 wire replay + seq 연속성. 승인 durability와 **독립 트랙으로 분리** — 서로 블로킹 안 함 |
| 1. persist-before-await | KEEP, payload 교체 | "approvalId를 event log에" → **TurnCheckpoint를 세션 스냅샷 스토어에**. "결정적 approvalId" 요구 소멸(영속이 결정성을 대체) |
| 2. replay short-circuit | **개념만 이관** | 턴 재생 후 같은 승인점 도달 시 로그 조회 → **로드 시 checkpoint의 persisted decision 1회 조회**로 대체. claimLease 개념 이관이라는 문장은 그대로 유효 |
| 3. state.ts:108 rehydrate | KEEP + 확장 | status/pendingApproval에 **messages(=[…history, assistantMsg])** 추가. **+ host pending Map 재시드**(빠지면 approval.respond silent no-op — [approval-protocol.ts:411-413](../../../src/host/runtime/internal/context-binding/approval-protocol.ts)) |
| 4. 결정적 replay 전제 | **DROP → 교체** | "turn이 승인점까지 결정적 replay 가능" → "승인점 checkpoint가 완전 물질화 가능"(§3 실증). Codex 동형성 문구는 "rollout=full-item 로그+상태 재구성"으로 정정(§4b) |
| 5. crash-resume 마커 확장 | KEEP | 마커가 pendingTurn checkpoint를 가리키도록; `buildCrashResumeOffer`에 승인 카드 추가. RESUME_INSPECT_GUIDANCE 프롬프트-완화가 구조 보장으로 승격 |
| Hellgate #4 (durability crown) | KEEP 그대로 | "`awaiting_approval` → SIGKILL → 재시작 → 재surface → 답변 → 툴 디스패치" — checkpoint 경로가 정확히 이 문장을 통과하도록 지어짐. **디스패치되는 툴이 중복 부작용 없이 exactly-once인지 단언 추가 권장**(B의 차별점이 C로 퇴행하는 걸 봉인) |

## 7. Ticket 05(connect resume)에 미치는 영향

05의 blocker 구조가 **좋아진다**: 05가 기다리는 substrate는 온디스크 event log + seq 연속성(item 0)뿐이고, 스파이크 결론은 item 0을 승인-durability 트랙(items 1-5)에서 **분리 독립**시키는 것이므로, 05는 checkpoint 작업의 완료를 기다릴 필요가 없다(역도 성립 — 승인 durability는 event log 없이 착지 가능). 05 §2의 "짓지 않는 것: pending-approval rehydrate/replay short-circuit(W2 항목 1-5)" 경계는 그대로 유효하며, 항목 2·4의 의미만 본 문서대로 갱신해 읽으면 된다. 한 가지 추가 설계 포인트: 재시작 후 `connect({resume})`가 받는 스냅샷은 rehydrate된 `pendingApproval`을 이미 포함하므로([state.ts:140-148](../../../src/kernel/session/state.ts) `toSessionSnapshotLite`) 승인 카드 재렌더는 이벤트 replay가 아니라 **스냅샷 경로로 공짜** — 05의 resume 시맨틱 테스트에 "재시작 후 스냅샷에 pendingApproval 실림"을 acceptance로 넣으면 두 트랙의 봉합이 봉인된다. crash 전 `approval.requested` 이벤트의 seq와 재시작 후 상태의 연속성(재emit이냐 스냅샷-only냐)은 W2-a에서 결정해 05에 통보해야 할 유일한 좌표다.

---

### 부록: 스파이크 중 발견한 부수 사실

- `turn.run`은 status 게이트가 없고 draft-input 게이트뿐([reducer.ts:260-263](../../../src/kernel/session/reducer.ts) `hasDraftTurnInput`) + `onApprovalRequested`가 draft를 보존 — 그래서 오늘의 승인-후 재발행이 성립하고, 같은 이유로 재시작 rehydrate 후에도 draft만 복원되면 기존 wire 시맨틱이 그대로 살아난다(resume 실행기의 진입 표면 재활용 가능).
- deferred 재실행이 **오늘도** mutating 선행 툴을 중복실행한다는 사실(§3)은 ADR-0540 Context의 "~140k 토큰 재지불"보다 강한 논거인데 ADR에 미기재 — Wave 2 착수 시 Context에 추가할 가치. (검증: 스케줄러 approval-이벤트 seq 산술은 의심했으나 projection이 스트림 이벤트마다 seq를 bump해([session-host-turn-event-projection.ts:65](../../../src/kernel/session/session-host-turn-event-projection.ts)) 정상 — 오탐.)
- `session_config`류 parent-seam mutating 툴 주석([streaming-dispatch.ts:346-354](../../../src/agent/streaming-dispatch.ts))이 checkpoint 재개 실행기의 순서 보장(모델콜 순서 serial)을 그대로 요구 — Option R2 실행기는 drainDeferredSlots의 serial 계약을 복제해야 함.
