# 최종 계획 — 100점 마감 (jul-17, 종합 어딧 3바퀴 종합)

α(완성도)·β(아키텍처)·γ(프로덕션준비도) 3바퀴 종합. **코드 갭은 거의 없음**(어제 3R에서 KILL 0 확인) — 남은 건 γ가 잡은 출시차단 1건 + 하드닝 몇 + 아키텍처 드리프트 2 + 진행 중 3개 완주.

## 우선순위 실행 (헬게이트/헬어딧 프로토콜, 병렬)

| # | 항목 | 출처 | 크기 | 파일 | 헬게이트 RED |
|---|---|---|---|---|---|
| **O / B1** | **출시차단**: eventlog terminal-append가 disk-full로 throw 시 turn.completed/failed 유실 + awaitTurnEnd 영구 hang. terminal 이벤트가 persistence 실패해도 subscriber/bridge에 도달하게. | γ | M | kernel/session/scheduler.ts terminal appendEvents sites | flaky log Nth append throw → terminal 이벤트 여전히 도달 + awaitTurnEnd settle(hang 아님) |
| **P1 / H1** | 보안: eventlog 파일 world-readable(0o644) → 전체 트랜스크립트(프롬프트/tool I/O/비밀) 노출. mode 0o600/dir 0o700/lock 0o600. | γ | S | event-log-jsonl.ts:139,256,264 | statSync().mode & 0o077 === 0 |
| **P2 / H3** | 누수: eventlog 생성 throw 시 이미 만든 hostSession 누수(PTY/fd 뒤). try/finally close. | γ | S | sdk/runtime/runtime.ts:11-23 | throwing persistence 주입 → hostSession.close 호출 단언 |
| **P2 / H2** | 관측성: wire attach 시 model pill 죽음(session.created 미fanning). snapshot.modelSlug로 렌더. | γ (티켓 render.ts:86 확정) | S | attach-client.ts, render.ts:86 | 알려진 modelSlug 세션 attach → pill이 snapshot에서 렌더(wire에 session.created 0) |
| **Q / P0-A** | 아키텍처 실비용: 37 테스트가 CapabilityManifest 9필드 손복제(normalizer 경유 1개뿐) = 필드 추가 = 37파일 수정(W1-B 지옥 재발). 공유 fixture hoist + raw-리터럴 금지 라쳇. | β | M | tests/support/session-fixtures.ts(신규)+37파일 | 필드 추가 시 fixture만 고쳐 전 테스트 green + 신규 raw 리터럴 red |
| **R / P0-B** | 규율 자인 위반: pure protocol leaf 4파일이 @/llm heavy barrel import(verb-surface.ts:14 docblock이 금지 선언). src/llm/types leaf 경로/shared로. | β | S | protocol/session/{verb-surface,commands,builders,events}.ts + slice-boundary 가드 | protocol slice가 @/llm 배럴 import 시 red |

## 배치 처리 (겹치는 워크스트림 랜딩 시 흡수)
- **C-LOW-2** readFrom seq-sort (event-log-jsonl.ts) — O/B1과 같은 durable 배치
- **C-LOW-1** lock orphan .tmp 청소 — H1과 같은 event-log-jsonl 배치
- **P1(β) resume-cursor 네이밍 통일** — 05door(J) 랜딩 배치
- **P2(β) `_tmp_diskfull_repro.test.ts` 삭제** — γ repro 잔재, 커버리지 중복 확인 후
- **B-MED-7** multi-peer 입양 approvalId 스탬프 — 별도 multi-peer 티켓

## 진행 중 (완주 대기)
- **02 serve --stdio** (GAP-3 transport 스탬프 + 0543 fc)
- **05 door-resume** (`resumed` 프레임 + GAP-2 클라 소비자)
- **jul-4 P8 .d.ts** (외부실증 무조건부 승격)

## 확정 상태 (건드리지 말 것 — 3R+3바퀴 검증)
concurrency(단일 큐+lease), correlator/fd/lock/child cleanup, stdio env 비주입, WS constant-time auth, sessionId traversal 가드, default-OFF byte-identical, poisoned-tail 가드, SSOT(builder/decision/receipt), OCP(exhaustive switch), conformance oracle 아키텍처.
