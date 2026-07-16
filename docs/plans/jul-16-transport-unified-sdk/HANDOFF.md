# HANDOFF — transport-unified-sdk 남은 작업 (2026-07-16 코드기준 검증)

> 다음 세션/작업자용 자기완결 핸드오프. 각 항목 = 뭘/목적/배경/방법/함정. 검증 시점 HEAD = `02be29346` (branch `feat/fc-evidence-relink` — 동시세션과 공유 중).

## 배경 (30초 요약)

quanta 내부에는 세션 substrate 3층(RuntimeSession / session.v1 프로토콜 / @/ipc/session transport)이 완성돼 있는데 공개 SDK는 `createAnalysisAgent` façade뿐이라 외부가 wire를 탈 수 없다. 이걸 단일 공개 seam `connect({transport})`로 승격하는 계획이 [이 디렉토리](README.md)에 있고, **적대어딧 3라운드 수렴 완료(CLEAN)** + 코드기준 재검증(07-16) 완료 상태다. **구현은 0줄** — 계획 문서가 산출물의 전부.

핵심 설계 결정(재litigate 금지, 근거는 [00-MASTER-PLAN.md](00-MASTER-PLAN.md) §0/§3):
- `RuntimeSession extends SessionHandle` **기각**(컴파일 불성립 반증됨) → `SessionVerbSurface<R>` generic + `toSessionHandle` 어댑터
- verb 반환 = `{commandId, submitted}` (성공 ack 프레임이 프로토콜에 없음 + engine.ts:57 dispatch 큐 직렬화가 구조적으로 강제)
- `awaitTurnEnd`는 approval 재발행 commandId **승계 상관** 필수(안 하면 hang)
- inProcess/loopback transport는 내부·conformance 전용(외부 in-process = jul-4의 createAnalysisAgent)
- embed의 session.v1 rebase 기각(충실도 회귀) — 수렴은 04 fidelity opt-in만

## 현재 상태 (07-16 실측)

| 축 | 상태 |
|---|---|
| 계획 문서 | 완료·커밋됨 (85d48fc6f 스윕 + a0ed7fb5b + 02be29346) |
| 구현 | **0줄** — `SessionVerbSurface`/`toSessionHandle`/`createSessionHandle` grep 0건 확인 |
| ADR-0540 (인접) | **W1-A 랜딩됨**(4a26c828d, headless inline resolver, `QUANTA_INLINE_APPROVAL_RESOLVER` default-OFF) · W1-B(daemon continuation) 미착수 추정 · **W2(온디스크 이벤트로그) 미랜딩**(`InMemorySessionEventLog`가 유일 구현 — event-log.ts:4 확인) |
| jul-4 P8 (인접) | `.d.ts` 여전히 부재(dist/sdk=index.js뿐, package.json types 필드 없음) |
| 크로스레퍼런스 | ADR-0540에 전달 완료(02be29346): W2 seq 연속성 요구 + W1-B server-auto-continues 표식 예약 |

## 남은 작업 (착수 순서대로)

### 1. 01-S0 스파이크 — 타입/인코딩 3판정 ⟨XS, 의존 0, 01 전체의 게이트⟩
- **뭘**: ① `RuntimeSession satisfies SessionVerbSurface<SessionDispatchResult>` 실코드 컴파일 판정 ② `turn.cancel` verb 신설 확정(유일한 RuntimeSession 표면 변경 — dispatch 위임 한 줄, `TurnCancelCommand`는 프로토콜에 이미 존재) ③ rejected `reason` 인코딩 확정(권장: 기존 `protocol_validation` + `issue` 문자열 재사용 — 구클라 decode 가능한 유일 경로; codec.ts:121-127이 reason을 클로즈드 4종 체크하기 때문)
- **목적**: 01 설계의 타입 전제를 실코드로 확정 — 불성립이면 어댑터-only로 후퇴(계획에 후퇴 경로 명시돼 있음)
- **배경**: R1이 extends 설계를 KILL(반환 타입 공변 불성립), R2가 generic 대체안의 할당성을 사전검증(trailing optional param은 표준 할당성으로 흡수)했으나 **실제 tsc 판정은 미실행**
- **방법**: scratch .ts 파일에 verb 표면 선언 + `declare const rs: RuntimeSession; const x: SessionVerbSurface<SessionDispatchResult> = rs` → `bun run typecheck` 경로로 판정 → 결과를 [01 티켓](01-connect-session-handle.md) §0에 추기
- **함정**: scratch 파일을 repo에 두면 동시세션 "done" 스윕커밋에 쓸려감 — 판정 후 즉시 삭제

### 2. 03-A field-shape 라쳇 ⟨XS, 의존 0, 즉시 착수 가능⟩
- **뭘**: 기존 [web-frontend-protocol-drift-contract-hellgate.test.ts](../../../tests/unit/web-frontend-protocol-drift-contract-hellgate.test.ts)(366줄)에 **필드 타입/optionality 수준** 대조 추가. 신규 파일 금지(계약 분산 방지), 기존 equality 계약 약화 금지
- **목적**: 현 가드가 못 잡는 마지막 드리프트 class 마감 — union 멤버는 같은데 필드 타입이 어긋나는 경우
- **배경**: 초안이 "가드 0"이라 오판→R1 KILL로 기존 hellgate 발견→"추가만"으로 재스코프. **방향 규칙 확정됨**([03 티켓](03-protocol-copy-drift-guard.md)): copy에 있는 필드는 canonical과 일치 필수(red) / canonical-only 필드는 optional일 때만 green(04의 `argsFull?` additive 확장과 정합)
- **방법**: TypeScript 컴파일러 API로 양쪽 소스 파싱(전례: tests/unit/_arch/slice-boundary-scanner.ts의 `import ts from "typescript"`; **ts-morph 금지** — 미설치+installs blocked). red-on-injection 셀프체크(타입 변형·optionality 뒤집기 주입→red→revert) 필수
- **acceptance**: 주입 드리프트 red / 현행 copy green(드리프트 0 확증) / 기존 hellgate 단언 전부 무수정 green

### 3. 선존버그 verify — session.created 미전달 ⟨XS–S, 의존 0⟩
- **뭘**: [티켓](../../tickets/jul-16-session-created-tail-filter-drop.md)의 verify 액션 — 실 WS attach에서 session.created 수신 여부 런타임 캡처
- **목적**: 코드리딩 2회 교차확인(R1·R2 독립) 상태를 런타임으로 확증/반증 — 확증 시 수선 방향 결정(seq+1 발행 vs "snapshot이 정본" 공식화)
- **배경**: `attachSessionTransport`가 합성 session.created를 `seq=현재 tip`으로 발행(engine.ts:172) → bridge tail 필터(`seq > snapshot.seq`)에서 탈락 + 발행 시점 peer 미핸드셰이크 게이트에서도 탈락 의심 — "freshly-attached client에게 전달" 주석과 실동작 불일치
- **방법**: 기존 attach e2e(실 데몬 loop — gate inventory가 존재 확인)를 재사용해 수신 이벤트 목록 캡처. 이 버그가 실재해도 **01은 영향 없음**(첫-프레임 계약이 이미 snapshot 정본으로 설계됨)

### 4. 01 본체 — connect + SessionHandle ⟨L, S0 후⟩
- **뭘**: 슬라이스 S1–S7 ([01 티켓](01-connect-session-handle.md) §2 표가 SSOT): builder hoist(`@/protocol/session/builders` — 원본 sdk/runtime/session/commands.ts는 이미 leaf) → verb 표면+핸들 → attach-flow hoist(핸드셰이크+approval 재발행, **이동+재수출만, 복사 금지**) → liveness(SessionTransport에 close/error 통지 additive) → 프로토콜 수선 2건(dispatch-error→rejected 승격, 버전 lenient reject — 도달성 스펙 §S5 준수: peer version echo 필수) → conformance(loopback oracle 열+정규화 클로즈드 리스트) → 외부 소비 실증+DX 문서
- **목적**: 외부가 wire 타는 단일 공개문 — 계획 전체의 keystone
- **함정**: `src/sdk/runtime`·`src/ipc/session`·headless는 동시세션(ADR-0540 W1-B 예상)과 겹침 — 편집 전 HEAD 재확인. awaitTurnEnd 승계 상관 누락 시 approval 낀 턴 영구 hang(§3.2). 외부 소비 acceptance는 repo 밖 빈 디렉토리+`file:` 의존+`tsc --noEmit`으로 — in-repo alias import는 vacuous. `.d.ts` 부재에 걸리면 jul-4 P8 항목을 선행 요구로 당김(소유는 그쪽 유지)
- **헬게이트 규율**: RED e2e 선행 + 적대어딧 ≥3R (repo 표준)

### 5. 02 serve --stdio ⟨M, 01 후⟩
- **뭘**: session.v1 stdio 서버 진입점 + heartbeat 응답기 daemon→ipc hoist + capabilities transport 스탬프 seam(base.ts:77 "inproc" 하드코드 관통)
- **배경/함정**: 배선은 `createSessionStdioTransport({reader,writer})`를 `openHeadlessRuntimeSession`의 기존 `input.transport` 옵션에 주입(신규 코드 최소). **게이트는 CLI_FEATURE_GATES에 넣지 말 것**(미설정 시 "1" 시드 = default-ON 사고) — 직접 env 체크, "성숙 게이트"로 명명(보안 서사는 R1이 기각 — stdio는 부모-자식 신뢰 경계). stdout 순결성 라쳇의 진짜 위험원 = 자식 tool/MCP 프로세스 stdio inherit. **선례**: `quanta mcp-server`(src/apps/cli/mcp-server-setup.ts)가 CLI stdio 서브커맨드 등록+stdout 규율의 in-repo 레퍼런스
- **acceptance 주의**: transport 3-way "다름이 정답" 단언은 stdio≠inproc 필수, ws 정정은 별 커밋 랜딩 시 승격(R3 F로 조건화돼 있음)

### 6. 03-B/C — protocol 번들 소비 + 클라 수렴 평가 ⟨M+XS, 01 후⟩
- **뭘**: B = `build:protocol` 번들을 web-frontend가 소비, copy 삭제, **기존 hellgate 개편 동반 필수**(그 테스트가 copy를 readFileSync — 삭제 시 throw; 계약을 "번들 소비 지점 검증"으로 승계). C = WS 클라 수렴 평가 1페이지(전제 주의: heartbeat/reconnect는 web-frontend에만 있음 — ipc 클라엔 없다는 게 R1 정정)
- **함정**: codec.ts가 `@/shared`(errMessage) value import — "런타임 deps 0" 번들 주장 전에 tree-shake 확인

### 7. 04 wire fidelity opt-in ⟨L, 최고 리스크 — 착수 전 미니 RFC 1회 권장⟩
- **뭘**: opt-in full payload(tool args/result 전문 + mid-turn usage). 기본 preview byte-identical
- **배경**: 실지형이 초안 예상보다 깊음(R1 HIGH-2) — truncate는 host-bridge(PREVIEW_MAX=256, session-host-turn-event-bridge.ts:141)+커널 포트 타입부터 preview만 → **4레이어 관통** additive 확장. "협상"은 기존에 없음(신규 wire 표면). blast radius = in-proc 구독자·sqlite 아카이브까지 스펙해야(생산 게이트 knob OFF면 전 경로 byte-identical이 1차 방어)
- **함정**: peer-로컬 확정 응답으로(공유 snapshot manifest에 넣으면 per-peer 리라이트 스코프 폭발). thinking delta는 v1 제외(별도 정책 축)

### 8. 05 durable resume ⟨S, **BLOCKED**⟩
- **착수 조건 3개** ([05 티켓](05-durable-resume-composition.md) §3): ① ADR-0540 W2 온디스크 KernelEventLogPort 랜딩(**07-16 미랜딩 확인** — InMemory 유일) ② seq 연속성 보장 확인(요구는 ADR-0540 W2 item 0에 박아둠 — 02be29346) ③ 01 랜딩
- **그 전에 하는 일 없음**(설계 선반영 금지 — W2 포맷/seq 결정에 종속). W2 랜딩 시그널 = event-log.ts에 디스크 구현 등장 or ADR-0540 W2 커밋

## 조율/리스크 (전 항목 공통)

- **동시세션 활동 강함**: ADR-0540 구현이 실시간 진행(W1-A 랜딩, approval fix 후속 흐름) — W1-B가 오면 attach-flow hoist(01 S3)와 같은 파일대를 만짐. 편집 전 HEAD 재확인, ref rewrite 금지.
- **"done" 스윕커밋 패턴**: 동시세션이 무관 신규 파일까지 쓸어담음(이 계획 문서도 그렇게 커밋됨) — untracked로 두는 것도 안전하지 않으니 작업 단위마다 명시 경로로 즉시 커밋.
- **브랜치**: 현재 feat/fc-evidence-relink 공유 중. 구현(src 변경)은 별도 feat 브랜치 강력 권장 — docs만 여기 얹힌 상태.
- **knob 신설 전 3벌 시스템 grep**(@/runner/knobs · runtime-config · 고아 env) — 재발명 전과 3회.

## 레퍼런스

- 설계 SSOT: [00-MASTER-PLAN.md](00-MASTER-PLAN.md) (§0 어딧 요지, §3 아키텍처, §6 hazards)
- 어딧 이력: README.md (R1 KILL3·HIGH10 / R2 MED5·LOW4 / R3 CLEAN)
- 메모리 키: `jul-16-transport-unified-sdk-plan` (+ `jul-16-sdk-thin-audit-and-inline-approval-adr`)
- 커밋: 85d48fc6f(본체, 스윕) · a0ed7fb5b(R3 델타+선존버그 티켓) · 02be29346(현행화+ADR 크로스레퍼런스)
