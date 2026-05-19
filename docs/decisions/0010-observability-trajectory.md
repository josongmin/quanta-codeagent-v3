# ADR-0010: 관측 플랫폼 — Trajectory 스키마 + Probe (SDK 비의존)

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0002(전체), RFC-0001 §3.1(슬라이스 격리)·§9.2(앱 추가=ADR 트리거)·§12(의존성 1순위 위험), ADR-0003(test-pyramid), ADR-0006(env-scrub allowlist 재사용)

## 결정

에이전트 실행의 관측 증거를 **인스턴스별 append-only JSONL trajectory**(`quanta.trajectory.v1`)로 정본화한다. 메트릭/요약/probe 출력은 전부 그로부터 파생. 구현:

- `@/shared`: `RunContext`(상관키) + `TrajectoryEvent` 스키마 레지스트리 + `makeEvent`/`isTrajectoryEvent`/`redactValue`(`secrets.v1`). **스키마를 shared에 둔 이유**: `@/stream`이 정본 스키마를 알아야 하는데 Biome 격리상 stream은 `@/shared`만 import 가능(ADR-0001) — observability에 두면 경계 위반.
- `@/observability`: 버전드 정적 가격표 `pricing.v1` + `costUsd()`. 신규 npm 의존성 0.
- `@/llm`: provider 응답의 `usage`(폐기 중이던 것)를 `StreamEvent.usage`로 흘림.
- `@/stream`: `TeeStream`(팬아웃) + `JsonlRecorder`(seq·deterministic span·redaction·strict/degraded·line-cap) 어댑터. 정본 작성자.
- `agent`/`apps/cli`: `AgentConfig.run?`(옵셔널, 미설정 시 바이트 동일) + `StreamEvent.usage→AgentEvent.usage` 브리지 + `--observe-dir`.
- `apps/bench`: `NullStream`→`Tee`, `sandbox`/`patch_*`/`verify` 증거, eval strict → recorder 실패 시 `verdict:degraded`(resolved 집계 제외), `metrics.json`/`summary.json`.
- **신규 앱 `apps/probe`**: read-only·**비권위** inspector. SDK 비의존: OpenTelemetry/수집기 코드 의존을 두지 않고 OTel GenAI 의미모델(span 트리·네이밍)만 차용.

## 근거

- RFC-0001 §12가 의존성 폭증을 1순위 위험으로 명시. OTel SDK = 트랜시티브 다수 + 런타임 무게. 단일 바이너리·로컬 우선 제품에 수집기 불필요. 포트/어댑터 구조라 후속 OTLP exporter는 *어댑터*로 추가 가능 → 지금 SDK 박는 건 YAGNI.
- 정본을 JSONL 이벤트로 두면 SWE-bench 실패 1건을 **재실행 없이** 단일 아티팩트로 진단 가능(RFC-0002 §1.1). SWE-agent `.traj`/AISI Inspect/LangSmith의 공통 형태를 무의존으로 재현.
- 관측은 순수 부수효과여야 정확성을 안 해침: 미설정 시 동작 불변, product=실패 삼키되 `observability_degraded`로 흔적, **eval=strict→degraded verdict**(관측 불능 결과를 정상 점수로 집계하지 않음).
- 비밀 누출은 선언이 아니라 게이트: `redactValue` 단일원천(ADR-0006 allowlist 정신 계승) + redaction 골든 테스트.
- probe가 권위적 진단을 내리면 오용 위험 → `triage_hint`/`likely_failure_class`/`confidence`(≤0.9)·원증거 동시 제시, 단정 필드 부재.

## 트레이드오프

- **얻은 것**: SWE-bench/세션 사후 100% *관측증거* 재구성, run→instance→attempt→turn→span 상관, 토큰·비용(pricingVersion 박혀 재계산 가능)·지연 집계, `bun run probe` 한 줄 진단. 신규 의존성 0, 신규 슬라이스 0, 전 웨이브 TDD(red→green), RFC-0002 산출 10파일 tsc0/biome0, 891 테스트 통과.
- **잃은 것/비용**: 신규 앱 1개(`apps/probe`) — RFC-0001 §9.2 트리거이므로 본 ADR로 정당화. JSONL은 500-instance에서 비대 가능(인스턴스별 파일·line-cap·tail+path로 완화, 전체 stdout 저장 금지). 스키마 진화 부담 → `schema`+`v`+골든으로 후방호환은 probe 책임. 비용은 정적 가격표라 실가 드리프트 → `pricingVersion`으로 재계산 가능하되 표 자체는 수기 갱신.
- **명시 비목표**: 완전 replay(LLM 비결정성), 원격 수집기/대시보드, 실시간 분산 트레이싱 — 필요 시 별도 RFC + 외부통합 ADR.

## 후속

- OTLP exporter 어댑터는 별도 RFC + 외부 통합 ADR 대상(현 포트/어댑터에 무파괴 추가 가능).
- 가격표 갱신 주기 정책, trajectory 파일 회전/압축 임계는 RFC-0002 §14 미해결로 둠(막힐 때 결정).
