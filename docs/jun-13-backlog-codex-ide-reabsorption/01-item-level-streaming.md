# T01 — `item/*` fine-grained 스트리밍 프로토콜

**현황:** 🟡 PARTIAL · **ROI:** ★★★ · **게이트:** `QUANTA_ITEM_STREAM`(default-OFF)

## 무엇 (코퍼스 증거)
Codex app-server(codex-ide `extension.js`)는 턴 내부를 **item 단위**로 스트리밍한다. `item/started` → 0..N delta → `item/completed`. delta 종류:
- `item/agentMessage/delta`
- `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`
- `item/plan/delta`
- `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`
- `item/mcpToolCall/progress`
- `item/autoApprovalReview/started`·`completed` (→ T03)

또한 `collab_*`(spawn/interaction/waiting/resume begin·end)로 서브에이전트 생명주기를 같은 결로 관측.

## 왜 가져오나
사용자 북극성 = **agent state 가시성**(뭐하는지/왜 멈췄는지/다음)([[agent-state-observability-northstar]]). turn-level 이벤트보다 item-level이 이 질문에 직접 답하는 spine. CLI/web 양 surface가 같은 입자도로 렌더 가능.

## quanta 현황 (코드 앵커)
- 경계 프로토콜: `src/protocol/session/events.ts`(`SessionEventEnvelope` eventId/seq/revision/causedByCommandId), `SESSION_PROTOCOL_VERSION="session.v1"` (`src/protocol/session/version.ts`).
- in-proc rich stream: `src/stream/types.ts`(`AgentEvent`).
- projection: `src/kernel/session/scheduler.ts`(hand-written reducer) + `src/protocol/agent-state/messages.ts`(9-event subset).
- 거침의 원인: AgentEvent→SessionEvent projection이 item-level subtype을 안 내보냄.

## 제안 접근
1. `session.v1`에 item 이벤트 subtype 추가(versioned, additive — 기존 consumer 무영향). `itemId/itemType/phase(started|delta|completed)/delta payload`.
2. projection을 중앙화([[jun-11-surface-protocol-unification]] §1.3 진단과 합류): AgentEvent→item-level SessionEvent mapper 단일화. scheduler 안 reducer와 agent-state mapper의 drift 제거.
3. CLI 렌더: 기존 진행표시에 item-level(reasoning/command-output/patch) 연결. web: agent-state push 확장.
4. delta는 누적 후 `completed`에서 flush(event-driven, [[jun-09-crash-resume-shell-adr-impl]] L3 partial 패턴 재사용).

## 함정
- canonical boundary는 `AgentEvent`가 아니라 `SessionProtocol`(jun-11 정정). item 이벤트도 session.v1에 올린다. AgentEvent를 wire SSOT로 승격 금지.
- additive only — 기존 9-event subset consumer가 깨지면 안 됨(red-on-injection 테스트).

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — 도구가 아니라 관측 프로토콜(session.v1 subtype) 확장. tool-surface manifest 무관.
- **CLI+Web:** 동일 session.v1 item 이벤트를 양 surface가 소비. **CLI** = 진행 렌더 레이어(reasoning/command-output/patch delta 연결, slash 불필요). **Web** = `src/protocol/agent-state/projection.ts`의 9-event subset projection에 item subtype 추가(push 확장; 별도 web-frontend 없이 web-daemon agent-state 채널). projection은 **단일경로**로 중앙화(scheduler reducer ↔ agent-state mapper drift 제거, jun-11 §1.3).
- **knob:** `QUANTA_ITEM_STREAM`(bool, default false) → `src/config/knob-inventory.ts`에 `{group:"observability", home:"runtime-config", readSite:"protocol/agent-state/projection.ts"}` 등록. **orphan ratchet(ORPHAN_CEILING=0) 때문에 등록 필수.** 게이트는 @/shared `gateOn`.
- **config:** N/A — 런타임 게이트로 충분. verbosity 필요 시 기존 observability config 재사용(신규 config 키 금지).

## DoD
- session.v1 item subtype + 중앙 projection; default-OFF byte-identical.
- CLI에서 reasoning/command-output/patch item 실시간 관측 e2e(실 loop 관통).
- drift 가드: projection 단일경로 라쳇(scheduler reducer ↔ agent-state mapper 동치 증명).
- ≥3R 적대어딧(특히 delta 누적/flush race, seq 단조성).
