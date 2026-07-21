# 적대 어딧 후속 목록 (jul-17 3R 재검증 배치)

랜딩된 스택(01 connect/handle · W4-b+05 durable)을 신선 어태커 2명이 재검증. **KILL/HIGH 0** — 어제 수정 전부 견고 재확인. 아래는 SOTA++ 마감용 잔여 하드닝. 각 항목은 **겹치는 워크스트림 랜딩 시 묶어 처리**(검증된 스택 단독 편집 회피).

## 어딧B — 01 connect/handle (3R, HEAD daa3214ac)
어제 hang-3 수정 4건(approval_voided·superseded·M-2 replayEvents·M-4 prune) **전부 재검증 PASS**. approve-path 오탐 의심 = kernel의 resolved(seq+1)→state.updated(seq+2) 원자 순서 + 클라 순서보존으로 **구조적 도달 불가**. conformance oracle은 실 RuntimeSession, seal negative control 진짜 이빨.

| # | 심각도 | 내용 | 최소 하드닝 | 처리 시점 |
|---|---|---|---|---|
| ~~B-MED-7~~ ✅ DONE(27e191b5a) | MED | marker-ON(`serverAutoContinues`) 모드에서 awaitTurnEnd 입양 arm이 "다음 미청구 turn.started"를 입양 — 3-peer + interleaved `input.append`가 공유 draft 오염 시 draft-blended terminal 배달(**hang 아님·type-lie 아님**, 의미상 틀린 terminal). single-peer/CLI 무해. | daemon이 auto-continuation turn.run에 originating **approvalId 스탬프** → 입양이 guess 대신 match. (wire 메타 additive) | **multi-peer 서피스 티켓** (ticket-01 sign-off 불요 — W1-B 데몬측과 함께) |

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
| ~~J-MED-1~~ ✅ DONE(29f8359eb) | MED(PRE-EXISTING) | bridge.ts handshake replay 창에 live 이벤트가 interleave해 seq가 뒤바뀔 수 있었음 | per-peer send tail + async interleave hellgate로 순서 봉인 |
| J-LOW-1 | LOW | events-only resume이 다음 live snapshot까지 serverAutoContinues=false 시작(connect.ts:286). false→클라 재발행이라 safe-by-default, M-3 pending-approval seed도 대응 skip. consistent. | 무조치(문서화됨) |

## 02 serve --stdio follow-up (a83e28cd4, 7/8 green)
| # | 심각도 | 내용 | 처리 |
|---|---|---|---|
| ~~02-approval~~ ✅ DONE(5b4110f18) | MED | serve --stdio가 approval을 WIRE 클라(connect onApproval)에게 위임하려면 kernel `awaiting_approval`+`approval.requested` wire 이벤트→`approval.respond` 재개 경로 필요. headless approval은 W1-A inline auto / OFF deny 두 모드뿐 — "wire-defer"(onConfirm이 deny 대신 wire respond 대기) 3번째 모드 미구현. CLI attach가 daemon 세션서 쓰는 flow와 동형. e2e approval round-trip visible-skip. | serve wire-approval 위임 배선(kernel approval 경로) 별도 작업. 가설: session-bridge에서 transport 모드일 때 onConfirm을 wire-defer resolver로 |

## jul-19 3바퀴 어딧 (β/γ API rate-limit 즉사 → 직접 검증)
α(정확성)·β(통합)·γ(보안) 병렬 3바퀴가 서버 rate-limit으로 2회 즉사 → 직접 실행검증+코드리딩으로 대체. **최근 미검종합 랜딩(04·B-MED-7·02approval·J-MED-1) 견고**.

**검증 통과**: 04 strip 4경로(sendReplay→sendMessages 단일 chokepoint, durable 포함)·codec 8종 exhaustive·B-MED-7 exact-match(approvalId 내용 무관)·04 크기캡 4MiB 정확·correlator 전 arm 공존(70pass)·closePeer 누수0(peers.delete GC)·02 approve/deny/연속 2회 approval(10/10 real-spawn).

| # | 심각도 | 내용 | 처리 |
|---|---|---|---|
| ~~γ-sqlite~~ ✅ DONE(b177f24af) | MED-보안 | threads.db가 `new Database` mode 미지정→0o644 world-readable. 04 full 전문(비밀) 저장 시 노출. H1(JsonlSessionEventLog 0o600) sqlite 대응 누락 | mkdir 0o700+chmodSync 0o600+회귀테스트 |
| ~~β-gate-combo~~ ✅ DONE(2026-07-19 closeout) | MED-설정안전 | serve --stdio(wireDefer)+QUANTA_INLINE_APPROVAL_RESOLVER 동시 ON시 inherited env가 wire onApproval을 조용히 우회할 수 있었음 | explicit wire delivery가 우선하도록 fail-closed 변경 + runtime-controller unit/usage/0543 봉인 |
| ~~02-deny-e2e~~ ✅ DONE(2026-07-19 closeout) | LOW | serve --stdio approval deny/다중 직접 spawn e2e 부재 | deny typed settlement+무실행, 연속 2회 exact-id approve+두 tool effect를 실제 child 경로로 봉인(10/10) |
