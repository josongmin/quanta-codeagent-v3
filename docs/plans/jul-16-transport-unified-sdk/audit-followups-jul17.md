# 적대 어딧 후속 목록 (jul-17 3R 재검증 배치)

랜딩된 스택(01 connect/handle · W4-b+05 durable)을 신선 어태커 2명이 재검증. **KILL/HIGH 0** — 어제 수정 전부 견고 재확인. 아래는 SOTA++ 마감용 잔여 하드닝. 각 항목은 **겹치는 워크스트림 랜딩 시 묶어 처리**(검증된 스택 단독 편집 회피).

## 어딧B — 01 connect/handle (3R, HEAD daa3214ac)
어제 hang-3 수정 4건(approval_voided·superseded·M-2 replayEvents·M-4 prune) **전부 재검증 PASS**. approve-path 오탐 의심 = kernel의 resolved(seq+1)→state.updated(seq+2) 원자 순서 + 클라 순서보존으로 **구조적 도달 불가**. conformance oracle은 실 RuntimeSession, seal negative control 진짜 이빨.

| # | 심각도 | 내용 | 최소 하드닝 | 처리 시점 |
|---|---|---|---|---|
| B-MED-7 | MED | marker-ON(`serverAutoContinues`) 모드에서 awaitTurnEnd 입양 arm이 "다음 미청구 turn.started"를 입양 — 3-peer + interleaved `input.append`가 공유 draft 오염 시 draft-blended terminal 배달(**hang 아님·type-lie 아님**, 의미상 틀린 terminal). single-peer/CLI 무해. | daemon이 auto-continuation turn.run에 originating **approvalId 스탬프** → 입양이 guess 대신 match. (wire 메타 additive) | **multi-peer 서피스 티켓** (ticket-01 sign-off 불요 — W1-B 데몬측과 함께) |

## 어딧C — W4-b+05 durable (HEAD daa3214ac)
crash/torn·lock·seq·replay·누출·게이트·v1정직성 7축 실행 repro **전부 검증됨 = SOTA급**. torn-write prefix가 valid JSON일 확률 0(실측), 8-프로세스 하드링크 race 정확히 1획득, pigeonhole 공격 snapshot fallback 강등, replay가 sendMessages chokepoint 우회 0.

| # | 심각도 | 내용 | 최소 하드닝 | 처리 시점 |
|---|---|---|---|---|
| C-LOW-1 | LOW | `tryCreateLock`(event-log-jsonl.ts:139-149) 획득자가 writeFileSync↔finally rmSync 사이 크래시 시 `<lock>.<pid>.tmp` orphan 영구 잔존 — 향후 open 미차단(cosmetic litter). | acquire 시 `<lockPath>.*.tmp` dead-pid 소유분 청소 | durable 스택 편집 배치 |
| C-LOW-2 | LOW | `SessionDurableEventLogReader.readFrom` 계약(types.ts:120) "in seq order" 주석 vs 구현 append order 반환 — planDurableReplay가 어차피 sort라 benign, 타 소비자엔 함정. | readFrom에 `.sort((a,b)=>a.seq-b.seq)` 추가(계약 강화) or docstring 정정 | **J(05 door) 랜딩 배치** (types.ts 겹침) |

## 배선 감사(어딧A) 잔여
- GAP-1 → N 에이전트가 배선-회귀 e2e 진행 중
- GAP-2(durable resume 클라 소비자 0) → J(05 door)가 채움
- GAP-3(transport "inproc" 거짓 스탬프) → I(02 serve --stdio)가 채움

## J(05 door) 어딧 follow-up (1f578f28f, 선존·05 무관)
| # | 심각도 | 내용 | 처리 |
|---|---|---|---|
| J-MED-1 | MED(PRE-EXISTING) | bridge.ts:523-539이 peer.connected를 async handleConnect 전 동기 설정 → concurrent publishEvents가 handshake replay 창 중간에 live 이벤트 interleave(seq 순서 뒤바뀜). **pre-05 plain connect에도 동일** — resume이 재접속-후-drop 빈도를 높여 hit rate만 상승. resumed 마커는 여전히 strictly last, servedThroughSeq 정직. | fan-out gating 별도 티켓(live fan-out을 connect replay 완료까지 게이트 or per-peer send queue) |
| J-LOW-1 | LOW | events-only resume이 다음 live snapshot까지 serverAutoContinues=false 시작(connect.ts:286). false→클라 재발행이라 safe-by-default, M-3 pending-approval seed도 대응 skip. consistent. | 무조치(문서화됨) |

## 02 serve --stdio follow-up (a83e28cd4, 7/8 green)
| # | 심각도 | 내용 | 처리 |
|---|---|---|---|
| ~~02-approval~~ ✅ DONE(5b4110f18) | MED | serve --stdio가 approval을 WIRE 클라(connect onApproval)에게 위임하려면 kernel `awaiting_approval`+`approval.requested` wire 이벤트→`approval.respond` 재개 경로 필요. headless approval은 W1-A inline auto / OFF deny 두 모드뿐 — "wire-defer"(onConfirm이 deny 대신 wire respond 대기) 3번째 모드 미구현. CLI attach가 daemon 세션서 쓰는 flow와 동형. e2e approval round-trip visible-skip. | serve wire-approval 위임 배선(kernel approval 경로) 별도 작업. 가설: session-bridge에서 transport 모드일 때 onConfirm을 wire-defer resolver로 |
