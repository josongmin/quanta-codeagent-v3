# ADR-0013: 완료 전 검증 가드 (verify-before-finish)

- **상태**: Accepted
- **날짜**: 2026-05-20
- **관련**: RFC-0001 §1.1(측정 정직성)·§1.2·§16(SOTA++ 흡수), ADR-0011(Tier 0 하드닝·동작 보존 패턴), ADR-0004(루프 nudge/recovery 머시너리)

## 맥락

실측: v3 에이전트가 SWE-bench Easy django 인스턴스에서 source `edit`
직후 검증(test/repro) **0회**로 종료 → 오답 패치 제출(예: instance
10999 등). 단일 trajectory resolution ≈50–60%이며 프롬프트 지시문·
Best-of-N 레버는 plateau — 실측 n=1=n=3=3/5로 분산 문제가 아니라 능력
격차다. SWEBENCH_DIRECTIVE에 "edit 후 반드시 테스트" 문구를 넣어도
gpt-4o가 검증을 스킵하는 것이 재현된다.

정직성: resolution%는 본 레포가 산출하지 않는다 — 외부 Docker/Python
채점에서만 나오는 값이다(RFC §1.1). 본 가드는 "오답서 조기 종료 방지"
메커니즘이지 resolution% 보장이 아니다.

## 결정

`AgentConfig.verifyGuard?: { maxTrips?: number }`를 도입한다. 부재 시
가드 완전 OFF — 루프 byte-for-byte 불변(memory/compaction/hooks/plan과
동형, ADR-0011 동작 보존 패턴).

마지막 mutating tool(`edit`|`write`) 이후 **검증 호출 0회**인데 모델이
완료를 시도하면, **기존 nudge/recovery 머시너리**로 1턴을 강제한다
(recovery reason `"unverified"`). `maxTrips`(기본 2) cap으로 무한 강제·
턴예산 소진을 방지한다.

검증으로 인정되는 기준(정밀 규칙, `verify-guard.ts`):

- `test_runner` 도구: **항상** 검증으로 인정.
- `bash` 도구: 명령 문자열이 test/repro 휴리스틱(`TEST_LIKE_RE`)에
  매칭될 때**만** 인정. 대표 매칭: `pytest`, `python -m unittest`,
  `bun test`, `node --test`, `npm test`, `yarn test`, `go test`,
  `cargo test`, `make test|check`, `.py` 스크립트 실행, `reproduce`/
  `repro`. 평범한 셸(`git status`/`ls`/`echo`/`cat`/`grep`)은
  **인정 안 됨** — 이 루프홀이 본 가드가 닫으려는 결함이다.

정책은 순수·결정론 모듈 `@/agent/verify-guard.ts`에 격리한다 — LLM·I/O
없음, 슬라이스 무신설(agent 내부, Tier 0). bench는 `instance.swebench`일
때만 config로 ON(custom-corpus 무영향); 정책 자체는 슬라이스 격리 유지.

## 근거

- 프롬프트 지시문만으로는 모델이 검증을 스킵(실측) → best-effort
  강제 게이트가 필요(견고한 증명은 아님, 한계 §a 참조).
- Best-of-N은 분산 문제가 아니라 능력 격차라 무효(실측 n=1=n=3=3/5).
- 기존 recovery 머시너리 재사용 → 신규 루프 경로·신규 npm dep 0.

## 대안

- **프롬프트만 강화**: 기각 — 실측상 스킵 재현, 효과 plateau.
- **외부 repair 라운드(b2)**: 별도·연구급 범위라 보류.
- **무제한 강제**: 기각 — 턴예산 소진·무한루프 위험, maxTrips cap으로 갈음.

## 결과·트레이드오프

- **얻은 것**: 미검증 edit 직후 종료라는 #1 실패 모드에 대한 **best-effort
  휴리스틱 게이트**. 구조적 "증명"이 아니라 조기 종료를 한 번 더 막는 장치다.
- **비용**: 가드 트립 시 턴 추가 소비(maxTrips 바운드). 상승 보장 없음 —
  루프가 오답서 안 멈추게 할 뿐, 올바른 수정 생성은 모델 몫. default-OFF라
  기존 동작·테스트·다른 앱 무영향.

## 한계 (LIMITATIONS)

- **(a) 휴리스틱은 best-effort**: `TEST_LIKE_RE`는 명령 문자열 위의
  정규식일 뿐이다 — 의도적으로 꾸민(또는 우연한) 명령은 false-positive
  (검증 아닌데 인정)·false-negative(실제 검증인데 미인정)가 날 수 있다.
  검증의 견고한 증명이 **아니다**.
- **(b) maxTrips cap은 의도적 누수**: `maxTrips`(기본 2)회 강제 후에는
  미검증 완료를 그대로 통과시킨다(턴예산 안전을 위한 고의 설계 —
  무한 강제 방지).
- **(c) resolution% 무관**: 본 가드는 그 자체로 resolution%를 올리지
  않는다 — 조기-종료-없는-검증만 유도할 뿐, 올바른 수정 생성은 여전히
  모델 몫이고 점수는 외부 채점 산출이다(RFC §1.1).
- **(d) Empirical inertness (실측, 2026-05-20)**: Easy-5 real SWE-bench 런에서
  `unverified` recovery 이벤트 = **0회** (5/5 인스턴스). 강화된
  SWEBENCH_DIRECTIVE 하에서 모델이 edit 직후 `test_runner`를 이미 돌리므로
  가드가 강제할 여지가 없다. 결론: 구조적으로 정확하지만 본 에이전트/모델
  조합에서 운영상 **no-op**. 깨진 게 아니라 발동 안 됨.

## 변경 이력

- 초기 설계는 `bash` 호출이면 무조건 검증 인정 → 실 SWE-bench 런에서
  **0회 발동(no-op)**. `TEST_LIKE_RE` 휴리스틱으로 타이트닝하여
  실제로 발동하도록 교정(본 ADR은 교정된 설계를 문서화 — code-after,
  RFC §9.1).
- `DEFAULT_MAX_TRIPS: 2 → 1` (2026-05-20). 근거: Codex App agent loop가
  관측한 `should_verify` default-OFF 스탠스와 정합하며, ADR-0014의
  repair-rounds 실측(negative delta — 추가 강제가 over-correction 유발)이
  default-OFF 방향을 empirically 받친다. 덜 강제하는 쪽으로 캡을 좁힘.

## 불변식 영향

- **슬라이스 격리 유지**: 정책은 `@/agent` 내부, bench는 `@/agent`만 의존.
- **RFC/ADR 동기(불변식 #2)**: RFC §16·§1.1 동기 충족.
- **신규 npm dep 0**.
