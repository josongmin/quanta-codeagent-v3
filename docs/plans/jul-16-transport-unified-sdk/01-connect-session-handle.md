# Ticket 01 — `connect({transport})` + SessionHandle (공개문 개방)

- **Date:** 2026-07-16
- **Status:** DRAFT v2 (적대어딧 R1 반영) — 구현 미착수. **S0 스파이크가 선행 게이트.**
- **기능:** 공개 `connect()`(ws/stdio) + generic verb 표면(`SessionVerbSurface<R>`) + builder/handshake/approval-flow SSOT hoist + 연결상태·버전스큐·rejected 비동기 채널 + conformance 확장(정규화 계약 명문화) + DX 문서.
- **왜:** 외부가 wire를 탈 공개 경로 0. 클라 liveness(연결사망 통지)와 버전 스큐 진단도 0 — 지금 공개하면 소비자의 "첫 1시간"이 전부 미정의 행(hang)으로 끝난다. builder 2벌·approval 결정 타입 3벌은 드리프트 씨앗.
- **ROI:** 외부 프론트·봇·사이드카가 한 API. 부수로 선존 침묵 버그 2종(dispatch 에러 무통지·버전 불일치 무언 드롭) 수선.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §3.1–3.4. 충돌 시 MASTER 우선.
- **Effort:** **L** (S0 스파이크 XS 선행 — R1이 M 판정을 자기모순으로 반증: 4레이어 관통+프로토콜 접점+헬게이트 규율 전제)
- **의존:** 없음. jul-4 P8 snapshot 게이트·`.d.ts` 트랙과 조율(§6).

---

## 0. S0 — 선행 스파이크 (XS, 결과가 설계를 게이트)

> **✅ 판정 완료 (2026-07-16, 실 tsc 스파이크 — positive/negative control 동반):**
> 1. **성립(GO)** — protocol 타입에서 파생한 `SessionVerbSurface<R>` 정의에 대해 `RuntimeSession → SessionVerbSurface<SessionDispatchResult>` 할당이 컴파일 성립(에러 0). trailing `options?` 파라미터는 예상대로 표준 할당성으로 흡수. 음성 대조(`SessionVerbSurface<CommandReceipt> = runtimeSession`)는 @ts-expect-error가 실에러를 소비 — R 파라미터가 실제로 분리를 강제함을 확인. positive control(고의 타입에러 주입→검출→제거)로 파일 포함 여부 확증.
> 2. **turn.cancel = 공유 표면에서 제외 + RuntimeSession에 additive verb 신설 확정** — `TurnCancelCommand`는 프로토콜 8종에 실존(commands.ts:18), 신설은 dispatch 위임 한 줄(유일한 RuntimeSession 표면 변경).
> 3. **rejected 인코딩 = 기존 `protocol_validation` reason + `issue` 자유문자열 재사용 확정** — 수신측 closed-4 체크(codec.ts:121-127) 때문에 신규 reason은 구클라 무언 드롭; issue 재사용이 구클라도 decode 가능한 유일 경로. ⇒ acceptance의 rejected 사유 = **5종**.
> 스파이크 파일은 판정 후 삭제(스윕커밋 위생). S1-S7 착수 가능.

1. `RuntimeSession satisfies SessionVerbSurface<SessionDispatchResult>` 성립 여부를 실코드로 판정 — R2 사전검증: 잉여 trailing optional 파라미터(`options?: SessionDispatchOptions`)는 표준 할당성으로 흡수, meta 타입도 동일 파생이라 성립 예상. 예상 밖이면 어댑터-only로 후퇴하고 satisfies acceptance 삭제(MASTER acceptance도 "S0 판정 따름" 단서).
2. `turn.cancel` verb 신설 — R2 확인으로 리스크 하향: `TurnCancelCommand`는 프로토콜 8종에 이미 존재(commands.ts:18)하고 reducer가 처리하며 attach가 close 시 실제 wire 전송 중(attach-client.ts:294-300) — 신설은 dispatch 위임 한 줄, 프로토콜/커널 무변경. **유일한 RuntimeSession 표면 변경(additive 1건)**.
3. rejected `reason` 인코딩 확정 — R2 검증 반영: 수신측 `decodeRejectedMessage`가 reason을 클로즈드 4종 체크(codec.ts:121-127)라 **신규 reason 값은 구클라에서 무언 드롭**(크래시 아님). 선택지 = 기존 `protocol_validation` reason + `issue` 자유문자열 재사용(구클라도 decode 가능한 유일 경로) vs 신규 reason(구클라 침묵 감수). 판정 결과가 acceptance의 rejected 사유 카운트(5종/6종)를 결정.

## 1. 공개 API (DX 스펙 v2)

```ts
import { connect, transports } from "quanta-codeagent/sdk"

// ① 원격 WS (web-daemon; attach와 동일 경로+동일 auth)
const session = await connect({
  transport: transports.ws({ url, authToken?, webSocketCtor? }),
  onApproval: async (req) => decision,          // 기존 ApprovalDecisionResult SSOT 타입 재사용
  onConnectionState: (s) => {...},              // "connected"(payload.resume: "replayed"|"snapshot_fallback")
                                                //  | "closed"(reason) — v1은 통지까지, 자동재접속 없음
  // ⛔ resumeFromSeq 없음 (jul-16 적대어딧 KILL로 v1에서 제거): handshake ready는
  //    snapshot 프레임에서만 settle하는데 브리지는 서빙 가능한 커서에 events-only
  //    (커서==tip이면 0프레임)로 답함 — ack-less 프로토콜에서 caught-up resume을
  //    handshake가 알 길이 구조적으로 없어 영구 hang. 05가 raw client resume
  //    watcher 경유로 소유. lastSeq()는 순수 관측으로 유지.
})

// ② Codex형 사이드카 (자식 spawn — lifecycle은 transport가 소유)
const session = await connect({
  transport: transports.stdio({ command: [...], env?, cwd? }),  // env 자동주입 없음(02 게이트 명시 설정)
})

await session.input.append("...")           // → {commandId, submitted: true}
await session.turn.run()
const end = await session.awaitTurnEnd()    // 승계 상관(§3.2) — approval 낀 턴도 안전
await session.close()
```

- **미제공(정직)**: in-process transport 공개(외부 in-process = createAnalysisAgent, MASTER §3.3) · 자동 reconnect · **resume 일체**(jul-16 적대어딧 KILL로 `resumeFromSeq` 옵션 자체를 제거 — 위 주석 참조; 메모리 tail이든 durable이든 door-level resume은 05가 raw client resume watcher로 소유).
- **SessionHandle** = `SessionVerbSurface<CommandReceipt>` + `subscribe/snapshot/close/sessionId` + `awaitTurnEnd` + `onConnectionState` + `onCommandRejected` + `lastSeq()`(순수 관측 커서 — 명칭 통일: raw 클라의 currentResumeFromSeq를 이 이름으로 노출; 05의 resume이 소비할 값). `CommandReceipt = {commandId, submitted: true}` — 전송까지만 약속(MASTER §3.2).
- **snapshot()**: wire = 최근 수신 snapshot 캐시(신선도 필드 포함) — dispatch성 재조회 아님을 타입/문서에 명시.

## 2. 구현 슬라이스

| # | 내용 | 비고 |
|---|---|---|
| S0 | 스파이크 (§0) | 결과를 이 티켓에 추기 후 진행 |
| S1 | `@/protocol/session/builders.ts` — builder SSOT hoist | 원본 = 이미 leaf인 [sdk/runtime/session/commands.ts](../../../src/sdk/runtime/session/commands.ts)(이동) + attach 자체조립 치환. turn.cancel builder 신설(S0-2 판정 따름). 기존 테스트 무수정 green = 행동보존 |
| S2 | verb 표면 + 핸들: `SessionVerbSurface<R>` 정의, wire 핸들(raw 클라+builders), `toSessionHandle(runtimeSession)` 내부 어댑터 | **순서 제약(R1 MED)**: raw 클라는 sessionId를 seed와 검증하므로 connect()는 handshake 완료 후 canonical id로 클라를 생성 — sentinel 단계는 hoist된 handshake 모듈이 같은 transport에 직송(attach의 현행 우회를 공식화; 소켓 재연결 아님 — 같은 소켓에 재-connect 프레임). **커서 원자 이관(R2 F9)**: handshake가 수신한 (snapshot, 최종 관측 seq)를 클라 생성 시 원자적으로 넘김 — 안 하면 lastSeq가 handshake 구간만큼 뒤처짐 |
| S3 | attach-flow hoist: handshake + approval 플로우(재발행 포함) → `@/ipc/session/attach-flow.ts`, CLI attach는 소비자로 전환 | 재발행 commandId를 핸들에 보고하는 계약 포함(§3.2 승계 상관의 공급원). 결정 타입 = 기존 `ApprovalDecisionResult` (신규 발명 금지) |
| S4 | liveness/에러 표면: `SessionTransport`에 close/error 통지 additive 확장 + ws/stdio 구현 + `onConnectionState` · stdio spawn lifecycle(kill/exit 전파/stderr drain/zombie 방지)은 transport 소유 | attach의 추상화-밖 raw 리스너 보완(attach-client.ts:322-331)을 공식 채널로 흡수 |
| S5 | 프로토콜 수선 2건(additive): bridge dispatch-error→rejected 승격 · 버전 불일치 회신+클라 typed error | **bad_version 회신 도달성 스펙(R2 F1)**: ① 회신 프레임은 peer가 주장한 version을 echo(자기 버전으로 스탬프하면 상대가 구조적으로 못 읽는 자기모순 — codec.ts:115 requireProtocolVersion) + 클라측은 rejected 프레임에 한해 version 검증 면제, ② 인코딩은 S0-3 판정(issue 재사용 vs 신규 reason), ③ 구제 모집단 정직화(R3 LOW-2): **기출하 구 피어는 클라·서버 공히 구제 불가**(구 데몬엔 회신 로직 자체가 없어 신클라→구서버도 현행 침묵 — SDK 공개 후엔 이쪽 스큐가 더 개연적, S7 에러 카탈로그에 명시) — typed error는 lenient 탑재분부터. OFF 경로 byte-identical(기존 rejected 소비자 = attach 회귀 체크) |
| S6 | conformance 확장: loopback(oracle) 열 + **정규화 계약 명문화**(클로즈드 리스트: eventId/emittedAt/seq-remap 제외; 합성 session.created·snapshot 프레임은 "다름이 정답" 항목) + connect() 레벨 실루프 e2e 1본(jul-15 fake-LLM 하네스) | "통과할 때까지 제외 추가" = red 사유로 주석 봉인. **transport별 positive 단언은 02로 이동(R2 F2)**: 스탬프 seam이 02 소유라 01 시점엔 전부 "inproc" — 01은 "현행 inproc 문서화 단언"까지만(vacuous 단언 금지) |
| S7 | sdk barrel export + 외부 소비 실증 + DX 문서(jul-4 USAGE 확장) | 문서 필수 목차: 첫 프레임 계약(sentinel→rejected(canonical)→snapshot→tail이 정상 핸드셰이크임) · 스트리밍 렌더 레시피(snapshot.streamingAssistantText 시딩→turn.output.delta append) · keepalive 정책 표(ws=클라 ping/서버 pong, **stdio=클라 기본 미발신·서버는 수신 시 pong** — R2 F6 정합) · 무인 운용 3줄(§3.4) · 에러 카탈로그 |

## 3. 시맨틱 스펙 (R1 구멍 마감)

### 3.1 receipt/거부
verb는 전송 성공 시 `{commandId, submitted}` resolve. 서버 거부(rejected: dup/revision/mismatch/validation/dispatch-failed)는 `onCommandRejected` + 상관된 대기자(awaitTurnEnd)에 typed error로. 성공 ack 프레임은 v1 스코프 아님(수요 시 additive followup).

**구조적 근거(07-16 ADR-0540 헬어딧이 공식화한 데드락 팩트)**: 서버 dispatch는 [engine.ts:57](../../../src/sdk/runtime/session/engine.ts) `transportDispatchQueue`로 **직렬화**된다 — turn.run이 큐를 점유한 동안 후속 커맨드는 대기. wire verb가 "완료까지 await"를 약속하면 이 직렬화와 정면 충돌(naive web-inline이 데드락인 이유와 동일) — submitted-receipt + 이벤트 상관은 선택이 아니라 큐 구조가 강제하는 유일한 정직한 계약이다.

### 3.2 awaitTurnEnd — 승계 상관
최초 turn.run commandId → (approval 발생 시) attach-flow가 재발행한 **새 commandId 승계** → 터미널 이벤트(turn.completed/failed/aborted)의 causedByCommandId 매칭. 상관 불가 상태(승계 없이 상관 대상 소실)는 hang 대신 typed error. 멀티피어 세션에서 남의 턴과 crosstalk 금지(자기 체인만).

### 3.3 approval × ADR-0540 과도기
- 현행: approval.requested → onApproval → approval.respond → **클라 turn.run 재발행**(hoist된 attach-flow가 수행).
- W1-B(daemon 자동 continuation) 랜딩 시: 서버가 capability에 `server-auto-continues`(additive) 선언 → 신클라는 재발행 생략, 구클라 이중 turn.run은 서버측 게이트로 무해화 — **이 표식 설계는 ADR-0540 W1-B와 공동 소유**(둘 중 먼저 랜딩하는 쪽이 표식만 예약).
- onApproval 미지정 + approval 발생 = park(타임아웃 없음) — 문서에 명시.
- **07-16 재확인**: ADR-0540 W1-A가 이미 랜딩됨([headless/approval-wiring.ts](../../../src/apps/headless/approval-wiring.ts) — `QUANTA_INLINE_APPROVAL_RESOLVER` default-OFF, confirmSlot overlay, approval-protocol.ts 무수정) — onApproval의 in-process 매핑이 필요해질 때 따라갈 실물 패턴이 생김. wire 쪽(이 티켓)은 영향 0(deferred 플로우 그대로).

### 3.4 무인 운용 가이드 (문서 3줄)
무인(CI/봇) = `permission.set("bypass"|"acceptEdits")` 권장. onApproval은 HITL용(승인마다 park→respond→재발행 왕복 비용). 미지정+approval = 영구 park.

## 4. Acceptance

> **갱신 2026-07-17 (적대어딧 2방향 반영):** `resumeFromSeq` 옵션은 KILL 판정으로
> **descope**(§1 주석) — resume 관련 acceptance는 이 티켓에 없음(05 소유).
> 체크 표기는 E3 worktree 기준 실상.

- [x] S0 스파이크 판정 기록(satisfies 성립 여부·turn.cancel 경로·rejected reason 확장 안전성) — §0에 판정 3건 기록됨
- [x] **외부 소비 실증** — ⚠️ **shim-조건부로만 실증됨**: repo 밖 디렉토리 + `file:` 의존 + `tsc --noEmit`는 통과했으나 **USAGE §9의 alias shim(`paths` @/* 매핑) + ambient `.d.ts` 2본 수동 로딩이 전제**다(`.d.ts` 부재라 순정 `file:`+import만으로는 불성립 — jul-4 P8이 `.d.ts` 산출 시 무조건부로 승격). ws/stdio 시나리오는 in-repo 실루프 e2e(`tests/integration/sdk-connect-session-handle-e2e.test.ts`) + stdio 단챙크 유닛으로 커버
- [x] approval 낀 턴에서 awaitTurnEnd 정상 종료(승계 상관) + 상관 소실 시 typed error(hang 금지) 유닛 — 상관 소실 7 reason 전부(no_turn_run/approval_denied/**approval_voided**/continuation_failed(재발행 실패+respond 발송실패 2 서브케이스)/connection_closed/handle_closed/**superseded**) `tests/unit/ipc/session-handle.test.ts` + e2e
- [x] dispatch-에러(예: empty_turn_input)가 wire 클라에 rejected로 표면화 — red-on-injection 문구 포함(`tests/unit/ipc/transport-dispatch-error-rejected.test.ts`)
- [x] 버전 불일치: **lenient 디코더 탑재 클라**→신서버 typed error 왕복 (`tests/unit/ipc/transport-version-skew.test.ts`; 기출하 구 피어는 침묵 유지가 정답 — S7 카탈로그 명기)
- [x] 연결사망: 서버 프로세스 kill → onConnectionState("closed") 통지 (ws·stdio 각각 — `session-transport-liveness.test.ts` + `session-stdio-spawn.test.ts` 실 child kill)
- [x] conformance: 정규화 계약 아래 동일 + oracle 대조 (`session-handle-conformance.test.ts`; 봉인 negative paired-control 포함 — jul-16 어딧 F5/L-1; transport별 positive 단언은 R2 F2대로 02 소유)
- [x] S1 치환 후 기존 attach/runtime/web-daemon 테스트 무수정 green
- [x] 신규 export가 public-surface 스냅샷에 등록 + `toSessionHandle`/loopback **부재** 확인(내부 전용 증명) — `tests/unit/sdk/public-surface.test.ts`(+공개 시그니처 참조 타입 `SessionTransportClientRejection`/`ImageBlock` 재수출, 어딧 F4)
- [x] rejected 전 사유 각각 typed error 유닛 (S0-3 판정=issue 재사용 ⇒ **5종**, `tests/unit/ipc/rejected-typed-errors.test.ts`)

## 5. Hazards / 금지

- `src/sdk/runtime`·`src/ipc/session` 편집 전 HEAD 재확인(동시세션).
- attach 로직 **이동+소비자 전환**만 — 복사·fork 금지.
- SessionDispatchResult를 wire로 흉내내기 금지. 정규화 리스트에 필드 추가로 conformance 통과시키기 금지.
- approval 결정 타입 신규 발명 금지 — `ApprovalDecisionResult` SSOT.

## 6. jul-4 조율

신규 export는 P8 public-surface 스냅샷 게이트 경유. 외부 소비 실증 acceptance가 `.d.ts` 부재에 걸리면 — 그 산출이 jul-4 P8 소유임을 유지한 채 이 티켓이 P8의 해당 항목을 선행 요구로 당긴다(중복 구현 금지, 순서만 조정).
