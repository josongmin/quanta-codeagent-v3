# 통합 로드맵 — transport-unified-sdk × ADR-0540 (2026-07-16 확정)

## 구현 대조 원장 (HEAD c2c0e77ad 전수 검증)

**이미 있음 → 재사용 (짓지 말 것)**

| 자산 | evidence |
|---|---|
| 세션 substrate 3층 | RuntimeSession(sdk/runtime/types.ts:51) · session.v1(커맨드8/이벤트23) · @/ipc/session(stdio/WS/bridge/tail-replay 128) |
| conformance 하네스 | tests/unit/ipc/ stdio×WS 매트릭스 + in-memory duplex pair |
| copy 드리프트 가드 | web-frontend-protocol-drift-contract-hellgate(366줄, union equality — field-shape만 갭) |
| **W1-A 인라인 resolver** | **DONE** 4a26c828d — approval-wiring.ts + knob-inventory 등록 + session-bridge 배선, gate default-OFF |
| CLI stdio 서브커맨드 선례 | `quanta mcp-server`(mcp-server-setup.ts) — 02의 등록/stdout 규율 레퍼런스 |
| attach 클라+e2e | handshake/approval 재발행 플로우(01 S3 hoist 원본) + 실 데몬 e2e |
| approval 결정타입 SSOT | runner/orchestrate/approval-decision.ts (01이 재사용, 신규 발명 금지) |

**전 계획 항목 미착수 확정 (grep 0건 검증, 07-16)**

| 항목 | 판정 근거 |
|---|---|
| 01 connect/SessionHandle | `SessionVerbSurface\|toSessionHandle\|createSessionHandle` src+tests 0건 |
| W1-B daemon-ownership | `serverAutoContinues` 0건 · ws-handlers에 turn.run 재발행 없음 · 브라우저 `shouldContinueAfterApproval` 잔존(session-hooks.ts:939) · attach 재발행 잔존 |
| W2 durability | `implements KernelEventLogPort` = InMemory 1개뿐 · state.ts 무조건 idle/null 리셋 그대로 · deterministic-replay 작업물 0 |
| 03-A field-shape | hellgate에 컴파일러API/optionality 대조 0건 |
| 02 serve --stdio | `QUANTA_SERVE_STDIO` 0건 |
| 03-B 번들 | `build:protocol` package.json 0건 |
| 04 fidelity | `argsFull\|resultFull\|requestedFidelity` 0건 |
| jul-4 P8 `.d.ts` | dist/sdk/*.d.ts 없음 · package.json types 필드 0 |

⇒ **완료 = W1-A 하나. 나머지 전부 그린필드 — 아래 웨이브 순서가 그대로 최종 실행 계획이다.**

> 두 워크스트림(공개 SDK 문 / 인라인·durable 승인 resolver)의 **합본 실행 계획**. 공유 서피스 3개(capability 마커·온디스크 이벤트로그·protocol mirror) 때문에 단독 진행 금지 — 이 문서가 순서/경계 합의의 SSOT.
> 세부 설계는 각자: [00-MASTER-PLAN.md](00-MASTER-PLAN.md)(SDK 문) · [ADR-0540](../../decisions/0540-inline-resumable-approval-resolver.md)(승인 resolver) · [HANDOFF.md](HANDOFF.md)(SDK 남은작업 상세)

## 얽힘 3개와 해소 방식

| 공유물 | 양쪽 수요 | 해소 |
|---|---|---|
| `server-auto-continues` capability 마커 | W1-B(브라우저 재발행 중지 신호) ↔ SDK 01 §3.3(wire 클라 재발행 생략) | **스펙 지금 고정(§아래)**, 구현은 W1-B가 선착지·01이 소비 |
| 온디스크 이벤트로그 + seq 연속성 | W2 item 0(substrate) ↔ SDK 05(connect resume 소비) | W2가 소유·05는 소비만(이미 ADR-0540에 요구 박음, 02be29346). **deterministic-replay 스파이크가 W2 전체의 GO/NO-GO** |
| web-frontend protocol mirror | W1-B(capability 필드 미러 동기) ↔ SDK 03(드리프트 가드/번들) | **03-A(field-shape 라쳇)를 W1-B보다 먼저** — 강화된 가드 아래서 미러 변경 |

### 마커 스펙 (지금 고정 — 양 트랙 공동 소유)

- `CapabilityManifest`에 `serverAutoContinues: boolean` additive(기본 false, normalize 폴백 false — 기존 `?? "inproc"` 패턴 동일).
- ON 조건: daemon이 `QUANTA_INLINE_APPROVAL_RESOLVER` gate ON에서 approval.respond(approve/escalation) 처리 후 `turn.run`을 서버측 재발행할 때만 true 선언.
- 클라 계약: 마커 true ⇒ 승인 후 turn.run 재발행 **생략**(브라우저 session-hooks + attach CLI + 향후 SDK wire 클라 공통). 마커 미탑재 구클라의 이중 turn.run은 **서버측 무해화**(같은 turn 활성 중 도착한 bare turn.run 흡수 — W1-B 스코프).
- 미러 동기 필수(기존 drift hellgate equality 계약이 강제).

## 웨이브 순서

### Wave 0 — 지금 병렬 (전부 의존 0, 파일 disjoint)

| # | 항목 | 트랙 | 크기 | 내용/판정 |
|---|---|---|---|---|
| 0-1 | 01-S0 타입 스파이크 | SDK | XS | satisfies 판정·turn.cancel 확정·rejected 인코딩(권장: issue 재사용) → [01](01-connect-session-handle.md) §0 추기. **01 전체의 게이트** |
| 0-2 | 03-A field-shape 라쳇 | SDK | XS | 기존 hellgate에 필드 타입/optionality 대조 추가(방향 규칙 확정됨). W1-B 미러 변경 전 선행 |
| 0-3 | session.created verify | SDK(티켓) | XS–S | [선존버그](../../tickets/jul-16-session-created-tail-filter-drop.md) 런타임 확증/반증. 01 영향 0(첫-프레임 계약이 snapshot 정본) |
| 0-4 | **deterministic-replay 스파이크** | 0540 | S–M | 재시작 후 LLM 재샘플 없이 승인점까지 턴 재생이 성립하는가 — **W2 전체(→SDK 05)의 GO/NO-GO**. NO면 W2 보류(measure-first), durability 트랙 동결 |
| 0-5 | 마커 스펙 합의 | 공동 | 0 | 이 문서 §위로 완료 |

### Wave 1 — W1-B: web leak을 daemon-ownership로 (0540 트랙, M)

ADR-0540 핸드오프의 6-7파일 풀사이클 그대로 + 마커 스펙 준수: ws-handlers 재발행 + capabilities 필드 + 미러 동기 + 브라우저 게이팅(session-hooks/App) + **attach CLI 게이팅**(attach-client 재발행도 마커 따름) + 구클라 이중 turn.run 서버측 무해화 + hellgate(gate ON: client 재발행 없이 daemon 재발행으로 tool 디스패치). 게이트 `QUANTA_INLINE_APPROVAL_RESOLVER` 재사용, OFF = byte-identical.

**왜 01보다 먼저**: W1-B가 더 작고(0540 트랙 모멘텀 живой — W1-A 방금 랜딩), 01의 attach-flow hoist(S3)가 **마커-aware 최종형을 한 번에 hoist**하게 됨(랜딩 순서 반대면 hoist 후 한 번 더 수정).

### Wave 2 — SDK 01 본체: connect + SessionHandle (SDK 트랙, L)

S0 판정 반영해 S1–S7([01](01-connect-session-handle.md) §2): builder hoist → verb 표면 → **마커-aware attach-flow hoist** → liveness → 프로토콜 수선 2건(dispatch-error→rejected, 버전 lenient reject) → conformance(loopback oracle+정규화 클로즈드 리스트) → 외부 소비 실증(+jul-4 P8 `.d.ts` 당김). 헬게이트 규율(RED e2e 선행+적대어딧 ≥3R).

### Wave 3 — 병렬 확장 (01 후)

- **02 serve --stdio** (SDK, M): headless input.transport 주입 배선 + heartbeat hoist + transport 스탬프 seam. CLI_FEATURE_GATES 금지, `quanta mcp-server`가 등록/stdout 규율 선례.
- **03-B 번들 소비+copy 삭제** (SDK, M): 기존 hellgate 개편 동반(readFileSync throw). codec의 @/shared value import tree-shake 확인.

### Wave 4 — durability 합류 (0-4 스파이크 GO 시에만)

- **W2** (0540, L+): 온디스크 KernelEventLogPort(JSONL) → state.ts:108 rehydrate → persist-before-await + replay short-circuit → crash-resume 마커 확장 → crown hellgate(SIGKILL→재시작→재surface→디스패치). **seq 연속성 요구 이행**(로그 tip에서 이어 발급 — SDK 05가 witness).
- **SDK 05** (S): W2 랜딩 후 `connect({resume})` 합류 — bridge 폴백 3경로에 로그 포트 주입 + 강등 표면화(onConnectionState resume 필드).

### Wave 5 — seam 붕괴 + fence 재평가 (endgame)

W1-B+W2 후 driveSessionTurn `for(;;)`가 vestigial → turn primitive를 engine으로 흡수, apps는 `@/sdk/runtime` 단일 seam. 마커가 universal이 되면 attach-flow 재발행 로직 은퇴(wire 클라 추가 단순화). biome fence는 **재평가만**(W1-A 셀프어딧 보류 판정 존중 — cli/headless 정당 사용이 사라진 뒤에).

### Value 트랙 (독립, 01+03-A 후 아무 때나)

**04 wire fidelity opt-in** (SDK, L): 착수 전 미니 RFC 1회 — 4레이어 관통+신규 협상 표면+blast radius(in-proc/아카이브) 때문에 이 로드맵 최고 리스크.

## 판정 포인트 (계획이 바뀌는 곳)

1. **0-1 S0**: satisfies 불성립 ⇒ 01은 어댑터-only로 후퇴(acceptance 대체 경로 계획에 있음).
2. **0-4 replay 스파이크**: NO-GO ⇒ Wave 4 전체 동결, 05는 BLOCKED 유지, W2 보류 — durability는 "same-process 재접속(이미 됨)"까지가 정직한 한계로 공식화.
3. **0-3 verify**: 버그 확증 ⇒ 수선 방향 결정(seq+1 vs snapshot-정본 공식화) 별도 소슬라이스.

## 공통 규율 (전 웨이브)

- 동시세션 hot-path: 편집 전 HEAD 재확인, 작업 단위마다 명시 경로 즉시 커밋("done" 스윕이 untracked까지 쓸어감), ref rewrite 금지.
- src 변경은 별도 feat 브랜치(현 feat/fc-evidence-relink는 공유 중 — docs만 얹힌 상태).
- knob 신설 전 3벌 시스템 grep. 신규 게이트는 CLI_FEATURE_GATES 금지 원칙 유지.
- 구현 헬게이트 5단계(RED e2e→TDD→적대어딧≥3R→셀프어딧→구조 보완) 전 웨이브 적용.
