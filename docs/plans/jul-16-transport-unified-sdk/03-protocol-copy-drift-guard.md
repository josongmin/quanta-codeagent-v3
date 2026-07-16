# Ticket 03 — copy 드리프트 가드 보강 (field-shape) → 패키지 소비 → 클라 2벌 평가

- **Date:** 2026-07-16
- **Status:** DRAFT v2 — **R1 KILL 반영 전면 재스코프.** Phase A 즉시 착수 가능.
- **기능:** (A) **기존 hellgate에 필드 타입 수준 대조 추가** — 신규 발명 아님. (B) protocol 번들을 web-frontend가 소비하고 copy 삭제 + **기존 hellgate 개편 동반**. (C) WS 클라 수렴 평가 문서.
- **왜:** ~~"가드 0/수동 체리픽뿐"~~ ← **거짓으로 반증됨(R1 KILL)**: [web-frontend-protocol-drift-contract-hellgate.test.ts](../../../tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts)(366줄)가 이미 union 멤버십 양방향 equality·envelope decode-gate·SESSION_PROTOCOL_VERSION·escalation 버튼 순서를 CI 봉인 중(과거 실드리프트 2건 적발 이력 주석). **남은 진짜 갭 = 필드 타입 수준**: union 멤버는 같은데 필드 타입/optionality가 어긋나는 드리프트는 현 가드가 통과시킨다.
- **ROI:** A = 남은 드리프트 class 마감(XS). B = 신규 필드 1회 랜딩 + copy 유지비 소멸. 04(프로토콜 확장)의 안전망.
- **Design SSOT:** [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §2 — **기존 hellgate 계약 약화 금지.**
- **Effort:** A=XS · B=M · C=XS
- **의존:** A 즉시. B←01(번들 인프라)+A.

---

## Phase A — field-shape 대조 추가 (기존 hellgate 확장)

- 위치: **기존 hellgate 파일에 추가**(신규 파일 금지 — 계약 분산 방지). 기존 equality 정책(canonical 전 타입이 frontend에 존재해야 green)을 **그대로 유지** — v1 초안의 "부분집합 허용" 정책은 기존 계약보다 약해서 폐기.
- 방식: TypeScript 컴파일러 API로 양쪽 소스의 command/event 선언을 파싱해 필드명·타입 텍스트·optionality 대조. 전례 = [slice-boundary-scanner.ts:10](../../../tests/unit/_arch/slice-boundary-scanner.ts)의 `import ts from "typescript"`(devDep 존재; ts-morph는 **미설치+installs blocked** — R1 정정으로 1순위 아님).
- red-on-injection 셀프체크: copy 필드 타입 변형(string→number)·optionality 뒤집기 주입 → red 확인 후 revert.

## Phase B — 번들 소비 + copy 삭제 (01 이후)

- `build:protocol`: `src/protocol/session` → 타입+코덱 번들. **주의(R1 LOW)**: codec.ts가 `@/shared`(errMessage) value import — tree-shake 확인 or 경계 정리.
- web-frontend가 번들 소비(vite 독립 빌드 유지), copy 삭제.
- **기존 hellgate 개편 동반 필수**: 그 테스트는 copy 파일을 `readFileSync`로 읽음 — copy 삭제 시 throw. equality 계약을 "번들 소비 지점 검증"으로 승계(계약 소멸 금지, 형태 전환).
- Phase A의 field-shape 대조는 "copy 부재+번들 단일 소스" 확인으로 강등.

## Phase C — WS 클라 수렴 평가 (문서 1페이지)

- **전제 정정(R1)**: "heartbeat/reconnect가 양쪽에 독립 구현"은 거짓 — ipc 클라엔 **없다**(web-frontend SessionClient만 보유: 25s ping-pong, 지수백오프, resume). 질문은 "중복 제거"가 아니라 **"유일 구현을 공용으로 hoist할 가치"**: 01이 liveness 통지까지만 공개(자동 재접속 non-goal)한 상태에서, reconnect/백오프를 ipc로 내리면 외부 소비자·attach·web-frontend 3자가 공유 가능한가, 빌드 분리와 양립하는가. 권고+근거 1페이지, 구현은 별도 티켓.

## Acceptance

- [ ] A: 필드 타입 변형·optionality 주입 각각 red, revert 후 green — 기존 hellgate 단언 전부 무수정 green(계약 무약화 증명)
- [ ] A: 현행 copy가 field-shape 대조 통과(현시점 드리프트 0 확증)
- [ ] B: copy 삭제 + 기존 hellgate 계약의 승계 형태 green + vite 독립 빌드 유지
- [ ] C: 평가 문서(권고+근거)
