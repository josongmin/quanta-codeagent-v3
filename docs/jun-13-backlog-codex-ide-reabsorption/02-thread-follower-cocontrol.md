# T02 — `thread-follower` co-control 프로토콜 + queue modes

**현황:** 🟡 PARTIAL · **ROI:** ★★★ · **게이트:** `QUANTA_THIN_CLIENT_DISPATCH`(기존, default-OFF) 확장

## 무엇 (코퍼스 증거)
Codex IDE는 한 라이브 스레드를 **보조(follower) 클라이언트가 공동조종**한다. 모든 verb가 request/response/**timeout** 3종 세트:
- `start-turn`, `steer-turn`, `interrupt-turn`
- `compact-thread`, `edit-last-user-turn`, `load-complete-history`
- `submit-user-input`, `submit-mcp-server-elicitation-response`
- `command-approval-decision`, `file-approval-decision`, `permissions-request-approval-response`
- `set-queued-follow-ups-state`

부수: follow-up queue modes `queue | steer | interrupt` (Cmd/Ctrl+Shift+Enter로 한 메시지만 invert). app-server는 WS-RPC 사이드카로 상주(per-turn fork 아님) — reconnect/multi-window/restart-without-state-loss.

## 왜 가져오나
정확히 quanta의 **CLI↔web parity + mid-turn-channel** 문제의 SOTA 답([[jun-09-cli-web-parity-plan-and-existing-mechanism]]). timeout-bounded approval relay는 우리 lease/single-writer 모순(running 턴에 WS 세션커맨드 throw) 해소의 단서.

## quanta 현황 (코드 앵커)
- transport: `src/ipc/session/index.ts`(`bindSessionTransportServer`, stdio/WS wrapper, codec), `src/shared/jsonrpc/correlation.ts`.
- 명령 채널: `src/protocol/session/commands.ts`(`SessionCommand` 들 — `ApprovalRespondCommand:42` 등).
- thin-client: `src/agent/thin-client-dispatch/types.ts`(default-OFF), control-request(ADR-0496, mutation용).
- inbound 3-mode: `QUANTA_INBOUND_MODE` queue/weave/interrupt([[jun-07-inbound-mode-3way]]) — Codex queue/steer/interrupt와 매핑 가능(weave≈steer).
- **부재:** follower 협약(보조 클라이언트의 timeout-bounded verb set). running 턴 single-writer lease가 외부 steer를 throw.

## 제안 접근
1. session.v1에 follower verb 추가 — 단, **mutation/steering은 typed control channel 또는 session verb**로(readout은 out-of-band 유지; generic queue로 평탄화 금지, jun-11 §0).
2. timeout 규율 박제: 각 verb는 request/response/timeout. approval relay는 follower가 대리 제출하되 HARD_DENY/lease 경계는 그대로(자기모순 회피).
3. queue modes는 기존 inbound 3-mode에 매핑 + per-message invert 핫키.
4. **slash.run 재발명 금지** — control-request/session verb 위에 올린다.

## 함정
- running 턴 single-writer lease가 steer를 throw하는 자기모순([[jun-09-cli-web-parity-plan-and-existing-mechanism]] 🔴). follower steer는 lease holder에게 **inject**하는 경로여야지 별도 writer가 되면 안 됨.
- readout=out-of-band(HTTP), mutation=typed channel split 유지.
- edit-last-user-turn은 turn 재실행 트리거 — [[jun-10-hitl-inline-approval-restructure]] inline-confirm과 reconcile.

## 통합 계획 (LLM도구 / CLI+Web / knob / config)
- **LLM 도구:** N/A — 제어 프로토콜(session.v1 follower verb), 도구 아님.
- **CLI+Web:** 핵심 양-surface 기능. follower verb를 양쪽이 발행하되 **mutation/steering은 typed control channel/session verb**(readout은 out-of-band 유지). **CLI** = 기존 inbound-mode 핫키 + 필요 시 slash(`/steer`,`/interrupt`)를 `src/apps/cli/slash/registry-session.ts`에 등록(session-scoped). **Web** = control-request(ADR-0496)/session verb 위. **slash.run 재발명 금지**([[jun-09-cli-web-parity-plan-and-existing-mechanism]]).
- **knob:** 신규 최소화 — 기존 `QUANTA_THIN_CLIENT_DISPATCH`(default-OFF) 확장으로 follower verb 게이팅. queue-mode는 기존 `QUANTA_INBOUND_MODE` enum(queue/weave/interrupt) 재사용(weave≈steer 매핑). knob-inventory 신규 등록 불필요(기존 엔트리 describe 갱신만).
- **config:** N/A — queue mode default는 기존 inbound-mode config 경로 재사용. follower 권한은 lease/posture가 결정(신규 config 금지).

## DoD
- follower verb set + timeout; default-OFF.
- e2e: 보조 클라이언트가 running 턴을 steer/interrupt, lease 위반 없이 관통.
- queue mode invert 핫키 동작.
- ≥3R 적대어딧(특히 lease race, timeout 후 stale-decision relay).

## 구현 현황 (2026-06-13)
**🟢 LANDED (default-OFF, gate=`QUANTA_THIN_CLIENT_DISPATCH`, 신규 knob 없음):**
- 순수 프로토콜 코어 `src/agent/thread-follower/`:
  - `types.ts` — `planFollowerVerb(verb, ctx)` 순수 NO-THROW 플래너. verb 4종(steer-turn/interrupt-turn/command-approval-decision/set-queue-mode) → 기존 lease-safe effect(inject/interrupt/approval-relay/queue-mode-set) 매핑. 드리프트 가드·exhaustive 배열.
  - `timeout.ts` — `FollowerVerbTracker`: request/response/**timeout**. deadline INCLUSIVE, late response=stale(적용 안 됨), sweep는 fallback 1회만, **중복 register가 deadline 못 늘림**, garbage clock fail-safe. (UC4)
- **UC3 HARD_DENY relay-boundary fail-closed** — 2겹:
  - 프로토콜 코어 `planFollowerVerb`(실 hardDenyReason 주입, relay-approve of dangerous ⇒ rejected).
  - **🟢 LIVE 리졸버 배선**: `context-binding.ts resolveApproval`에서 pending record에 proposed `ToolAction` 캡처→approve 시 `hardDenyReason` 재검(히트면 grant 0). **모든 `approval.respond`(웹/ide 팔로워 relay 포함)에 라이브 적용**. tests/unit/host/runtime-approval-harddeny-relay-recheck-hellgate. **mutation red-on-injection 증명**(가드 제거 시 dangerous approve가 lease mint→RED; 동시sweep이 실제로 가드 wipe했을 때 RED 관측됨).
- **fc 등록**: `tools/feature-catalog/features/10-app/thread-follower-cocontrol.yaml`(L3, cli:full/web:partial, evidence.code 6파일). `bun fc validate` 970 features all resolved, check-changed ok.
- **UC5 per-message invert** — `invertInboundModeOnce`(inbound-mode SSOT), `/inbound invert` 배선.
- CLI 팔로워 verb: `/steer`(lease-safe inject via pushUserMessage), `/interrupt`(lease-bypass cancel via pushCancel) — 기존 ConversationActionSurface 재사용.
- **lease-safety 통합 헬게이트**(실 conversation-action transport + 실 `decideAction`): steer→lease holder 주입, turn-id mismatch→reject(잘못된 턴 기록 0), interrupt→cancel control. **별도 writer 안 됨** 증명.
- 테스트: 코어 29 + 통합 3, 두 보안 가드 모두 mutation teeth 확인. tsc 0. knob-inventory describe 갱신.

**🟢 LIVE DISPATCHER (추가 랜딩):**
- `src/agent/thread-follower/dispatch.ts` `FollowerCoControlDispatcher` — verb→effect를 실 sink(inject/interrupt/setQueueMode/relayApproval)에 묶는 라이브 apply seam. 2-cadence: FIRE verb(steer/interrupt/queue-mode)는 즉발; **approval relay만 request/response/timeout**(openApproval=요청+deadline, relayApproval=응답, 늦으면 stale-drop, sweep=fail-safe DENY fallback). `tests/unit/thread-follower-dispatch-live-hellgate.test.ts` 9개가 **실 collaborator로 end-to-end 관통**(실 conversation-action surface+실 decideAction+실 resolveApproval+실 hardDenyReader). UC3 dispatcher 경로도 mutation red-on-injection 확인.

**🟢 웹 2nd-client transport — 풀 라이브 (4/4 verb):**
- conversation-action surface를 `@/agent/conversation-action-surface`로 **hoist**(slice fence상 웹 데몬이 `apps/cli/**` 못 import → 공용 슬라이스로 승격; CLI 경로는 thin re-export로 byte-identical). surface-coupling 라쳇 green.
- 웹 데몬 [runtime-factory.ts](src/apps/web-daemon/runtime-factory.ts): `QUANTA_THIN_CLIENT_DISPATCH` 게이트로 surface+inbound ref+`FollowerCoControlDispatcher` mint, `conversationActionPort`+`activeTurnRef`를 AgentConfig에 배선, dispatcher를 facade에 노출.
- [server.ts](src/apps/web-daemon/server.ts): `followerVerb` WS 프레임을 세션브리지 앞에서 peek([follower-verb-frame.ts](src/apps/web-daemon/follower-verb-frame.ts) `peekFollowerVerb`)→`dispatcher.dispatch`→실 surface inject. [index.ts](src/apps/web-daemon/index.ts): eager-mint 게이트에 follower 추가+dispatcher 스레딩.
- 결과: 웹 2nd-client가 steer-turn/interrupt-turn/set-queue-mode를 `followerVerb` 프레임으로 **실 transport 관통**(steer=lease holder 주입, 별도 writer 0). approval-relay는 `approval.respond`+LIVE HARD_DENY 재검. **4/4 verb 웹 LIVE.** decoder hellgate가 프레임→dispatcher→실 surface inject end-to-end 증명.
- mid-turn steer→모델출력 PTY e2e는 결정론 replay로 불가 → 실 `decideAction`/실 surface 경계로 대체증명.
