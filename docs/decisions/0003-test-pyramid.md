# ADR-0003: 테스트 피라미드를 4티어로 분리하고 CI로 강제

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §10(테스트 전략), §9.2(ADR 트리거), §12(LLM 비용 폭주·의존성), §3.1(약식→풀 최소주의)

## 결정

테스트를 **결정론성·환경의존성** 축으로 4티어로 나눈다.

| 티어 | 위치 | 결정론 | 게이트 |
|------|------|--------|--------|
| unit | `tests/unit/` | 완전 | 매 push/PR, 차단, <5s(예산 8s) |
| integration | `tests/integration/` | 완전(실 in-proc 어댑터·FakeLLM·tmpdir) | 매 push/PR, 차단 |
| contract | `tests/contract/` | 환경게이트(실 Docker·언어서버) | PR/main, 차단(CI 프로비저닝) |
| eval | `src/apps/bench` | 비결정(실 LLM) | nightly/`eval` 라벨, **비차단**, 점수 추적 |

- 기본 `bun test` = unit+integration만(결정론 게이트). contract는 `test:contract`,
  eval은 `test:eval`로 분리. `test:watch`는 unit만(inner loop).
- contract는 기존 `skipIf` 조용한 스킵을 유지하되, CI가 `REQUIRE_CONTRACT=1`을
  세팅하면 의존성 부재가 **하드 실패**가 된다(`tests/contract/_guard.ts`).
- `.github/workflows/ci.yml`: `pyramid`(차단) / `contract`(main 차단) /
  `eval`(`continue-on-error`, 아티팩트로 리포트). 신규 의존성 0.
- 이동: 환경 프로빙하던 `sandbox-docker`·`lsp-pyright`·`lsp-typescript`만
  contract로. `mcp-client`·`bench`는 자체 mock/FakeLLM이라 결정론적 →
  integration 유지(분리 기준이 깔끔히 떨어짐).

## 근거

- RFC §10은 unit/integration/e2e 3티어를 이미 명시. 핵심 결함은 "integration"이
  결정론적 슬라이스 결선과 환경의존 외부프로세스를 한 버킷에 섞은 것 —
  둘은 *언제 도는가·플래키 예산·게이트 여부*가 달라 같이 관리하면 안 됨.
- 조용한 스킵 = 보이지 않는 커버리지 구멍: "Docker 깨짐"과 "Docker 없음"이
  0-fail로 동일하게 보였다. `REQUIRE_CONTRACT`가 CI에서만 이를 구별.
- 피라미드를 강제할 장치(CI)가 전무했다(`.github` 부재). 게이트 없는
  피라미드는 문서일 뿐.
- 커버리지는 **측정만, 게이트 안 함**(`test:cov`, CI 아티팩트) — RFC §10.4
  "퍼센트 강박 X"를 존중. 라인% 벽 대신 티어 분리가 "core 전 분기"
  의도에 더 가깝다.

## 트레이드오프

- **얻은 것**: 결정론 게이트가 빨라지고(<8s unit 예산 강제), 외부프로세스
  회귀가 더는 스킵 뒤에 숨지 못함. eval이 비차단 메트릭으로 분리돼 LLM
  비용·비결정성이 머지를 막지 않음(RFC §12).
- **잃은 것 / 비용**:
  - 디렉토리 1개 신설(`tests/contract/`), 헬퍼 1개(`_guard.ts`). RFC §3.1
    최소주의 내 — 신규 런타임/의존성 0.
  - "CI 프로비저닝 엔트리 없는 contract 테스트 추가 금지" 규율이 새로 생김
    (스킵 부패 방지 비용). RFC §9.2 ADR 절차에 흡수.
  - eval은 retry-until-green 금지 → 비결정 실패를 *점수 하락*으로만 관측
    (테스트가 아닌 메트릭). baseline 대비 추적은 후속.
  - `bun test` 기본 동작이 바뀜(전체→2티어). 문서·README 동기화 필요(완료).

## 후속

- eval pass-rate를 7일 baseline 대비 추적·알림(현재는 아티팩트 리포트만).
- core 슬라이스(agent/tool/llm/permission/runtime) unit 파일 존재의
  구조적 단언을 CI에 추가 검토(라인% 아닌 "빵꾸" 가드).
- 실 SWE-bench(synthetic 아닌) 작은 서브셋을 eval에 편입(RFC §10.3 P2).

## 이후 정책 (SEP9-TV)

이 ADR의 4티어 분리는 역사적 결정으로 보존한다. 로컬 명령(`verify:*`),
CI job DAG, 캐시 identity, shard membership은
[SEP9-TV 티켓 패킷](../plans/sep-9-test-verification-optimization/tickets/README.md)이
supersede한다. GitHub check 이름 `pyramid (unit + integration)`은 보호 규칙
호환을 위해 aggregator job으로 유지한다.

