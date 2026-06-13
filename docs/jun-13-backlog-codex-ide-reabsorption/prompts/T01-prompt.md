# 구현 프롬프트 — T01: `item/*` fine-grained 스트리밍 프로토콜

## 미션
session.v1에 item-level 스트리밍 subtype을 additive로 추가하고, AgentEvent→item-level SessionEvent projection을 중앙화해 CLI/web 양 surface가 동일 입자도로 에이전트 내부 상태를 실시간 관측하게 한다. default-OFF byte-identical.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/01-item-level-streaming.md` 정독 후 시작. 통합 시밍은 `00-index.md §8`.

## 🛑 헬게이트 프로토콜 (이 순서로 — 메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 아래 핵심 유즈케이스를 e2e로 먼저 작성, 전부 RED 확인(기능 없으니 실패; red-on-injection 포함). 실 loop 관통(synthetic green 금지). 이 묶음 통과 못 하면 미완성.
2. **핵심 로직 TDD + 구조적 구현**: red-first 유닛으로 projection 단일경로 구현. 구조적으로(SessionProtocol 경계 유지, scheduler reducer↔agent-state mapper 동치). default-OFF byte-identical.
3. **적대적 어딧 ≥3R**: delta 누적/flush race, seq 단조성, 기존 9-event subset consumer 회귀, projection drift.
4. **셀프 어딧**: vacuous test/실 effect 미관찰/wiring 자가보고 거짓 점검.
5. **구조적 TDD 보완**: 발견점을 휴리스틱 말고 구조적으로 TDD 보완.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** 긴 턴 중 reasoning 진행 관측: 게이트 ON에서 reasoning이 진행되면 `item/reasoning/textDelta`가 순차 emit → e2e가 delta 누적 후 `item/completed`에서 최종 텍스트 단언.
- **UC2** 명령 실행 출력 스트리밍: shell 도구 실행 시 `item/commandExecution/outputDelta`가 라이브로 흐르고 `item/completed`에 exit/최종 출력.
- **UC3** 패치 진행 관측: edit/apply_patch 시 `item/fileChange/patchUpdated` emit.
- **UC4** default-OFF 동일성: 게이트 OFF면 기존 SessionEvent 시퀀스와 **byte-identical**(스냅샷 비교).
- **UC5** (web) agent-state push: web-daemon agent-state 채널에 item subtype이 projection되어 도달.

## 코드 앵커 (실측)
- 경계: `src/protocol/session/events.ts`(`SessionEventEnvelope`), `src/protocol/session/version.ts`(session.v1).
- in-proc stream: `src/stream/types.ts`(`AgentEvent`).
- projection 분산(중앙화 대상): `src/kernel/session/scheduler.ts`(hand reducer) + `src/protocol/agent-state/{messages,projection}.ts`(9-event subset).

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A. **knob**: `QUANTA_ITEM_STREAM`(bool,false) → `src/config/knob-inventory.ts` `{group:"observability",home:"runtime-config",readSite:"protocol/agent-state/projection.ts"}` 등록(orphan ratchet ORPHAN_CEILING=0). 게이트 `@/shared gateOn`.
- **CLI**: 진행 렌더에 item delta 연결. **Web**: projection 단일경로에 item subtype 추가(별도 web-frontend 없음, agent-state 채널). **config**: N/A.

## 규율
- canonical boundary=SessionProtocol(NOT AgentEvent 승격). item 이벤트는 session.v1 **additive**.
- drift 가드: projection 단일경로 라쳇(reducer↔mapper 동치 증명).
- claim-100 ⇒ ≥3R. worktree 디스패치 시: HEAD==main 확인 + ff merge, stale base 금지.
