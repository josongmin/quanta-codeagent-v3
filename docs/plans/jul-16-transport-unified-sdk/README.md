# jul-16-transport-unified-sdk — 상태 보드

내부에 완성돼 있는 3층(RuntimeSession / session.v1 / SessionTransport)을 단일 공개 seam `connect({transport})`으로 승격하는 계획. 설계 SSOT = [00-MASTER-PLAN.md](00-MASTER-PLAN.md).

**v2 (2026-07-16)**: 적대어딧 R1(2어태커 병렬)에서 KILL 3·HIGH 10 적발 → 전면 반영. 핵심 반전: extends 증명→generic verb 표면, receipt→submitted 정직화, inProcess 공개→내부 강등, 03 전제 거짓(가드 이미 존재)→field-shape 추가로 재스코프, 04 effort M→L(4레이어 관통 실지형).

**R2 수렴 (2026-07-16)**: 신선 어태커가 R1 반영 5축 코드 재검증 — 4축 성립 확인(satisfies 할당성·commandId builder-mint·createSessionStdioTransport 실존·ports.ts 인용), 오인용 0건. 신규 MED 5·LOW 4는 전부 문서-국소 → **선반영 완료**(F1 bad_version echo+모집단 정직화 / F2 transport 단언 02 이동 / F3 snapshot.capabilities로 좁힘 / F4 resumeFromSeq+lastSeq 통일 / F5 강등 채널 명명 / F6-F9). **판정: 구현 착수 가능.**

**R3 최종 (2026-07-16)**: R2-후 편집 11건 자체가 미검증이라 3라운드째 투입(적대어딧 ≥3회 하드룰) — F1-F9 반영 9건 전부 정상, 신규 코드 인용 2건 line-exact, 잔여 = MED 2(02 acceptance 3-way 스코프 충돌 조건화 / 03-A↔04 방향 규칙 명시)·LOW 4(버전스큐 구제 모집단을 "구 피어 공히"로 대칭화, resumeFromSeq 다이어그램 잔여 토큰, 05 의존 +01, MASTER §7 단서) → **전부 반영 완료. 판정: CLEAN — 계획 문서로서 수렴 종료.** 다음 감사 표면은 구현물(01 S0 스파이크부터).

| 티켓 | 내용 | Effort | 상태 | 의존 |
|---|---|---|---|---|
| [00](00-MASTER-PLAN.md) | MASTER — evidence(R1 정정)·목표 아키텍처 v2·경계·hazards | — | DRAFT v2 | — |
| [01](01-connect-session-handle.md) | `connect()`(ws/stdio) + generic verb 표면 + hoist 3종 + liveness/버전스큐/rejected 채널 + conformance 정규화 계약 | **L** (S0 스파이크 선행) | DRAFT v2 | — |
| [02](02-serve-stdio-entrypoint.md) | `quanta serve --stdio` + heartbeat hoist + transport 스탬프 seam | M | DRAFT v2 | 01 |
| [03](03-protocol-copy-drift-guard.md) | **기존 hellgate에** field-shape 대조 추가(A) → 번들 소비+copy 삭제(B) → 클라 수렴 평가(C) | XS+M+XS | DRAFT v2 | A즉시 / B←01 |
| [04](04-wire-fidelity-negotiation.md) | fidelity opt-in full payload (4레이어 additive 관통 + peer-로컬 협상) | **L** | DRAFT v2 (최고 리스크 — 착수 전 미니 RFC 권장) | 01, 03-A |
| [05](05-durable-resume-composition.md) | `connect({resume})` durable resume | S | **BLOCKED**←ADR-0540 W2 (+seq 연속성 요구 전달) | 01 |

## 인접 워크스트림 경계 (중복 금지 지도)

- **jul-4-sdk-embed-dx**: in-process embed façade + public-surface 스냅샷 + `.d.ts` 소유 — 우리는 wire 보완재. **외부 in-process 소비 = createAnalysisAgent** (세션 팩토리 비공개 유지).
- **ADR-0540**: inline resolver·turn-driver 소멸·온디스크 이벤트로그 소유 — 05는 소비자. approval continuation 과도기는 `server-auto-continues` capability 표식으로 공동 조율.
- **ADR-0520**: reverse-MCP(MCP 프로토콜) — 02(session.v1)와 다른 문.
- **기존 drift hellgate**(web-frontend-protocol-drift-contract): equality 계약 유지 — 03은 추가만, 약화 금지.

## 핵심 설계 결정 (v2)

1. **generic verb 표면** `SessionVerbSurface<R>` — RuntimeSession(R=SessionDispatchResult)과 SessionHandle(R=CommandReceipt)이 같은 verb 형태임을 컴파일로 강제. extends 증명은 R1에서 불성립 반증되어 폐기.
2. **submitted receipt** — wire에 성공 ack 프레임이 없다는 사실을 API가 그대로 노출. 서버 거부는 비동기 채널+awaitTurnEnd 승계 상관(approval 재발행 hang 방지).
3. **additive 프로토콜 수선 동반** — dispatch-에러 침묵·버전스큐 무언 드롭(선존 버그 2종)을 01이 수선.
4. **embed rebase 기각 유지** — 수렴은 04 fidelity opt-in으로만, 비용(L) 정직 표기.
5. **전부 default-OFF/additive** — serve --stdio 성숙 게이트(CLI_FEATURE_GATES 시딩 함정 회피), fidelity 생산 knob OFF 시 전 경로 byte-identical.

## R1이 발견한 선존 이슈 (이 계획 밖, 추적 후보)

- capabilities.transport 전 세션 "inproc" 하드코드(base.ts:77) — 02가 수선
- 합성 session.created가 tail 필터에서 탈락(engine.ts:172 seq=tip) — 주석과 실동작 불일치 의심
- bridge가 dispatch 에러를 peer 무통지 삼킴 — 01 S5가 수선
