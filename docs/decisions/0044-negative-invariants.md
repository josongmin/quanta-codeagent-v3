# ADR-0044 (잠정 번호) — Negative invariants (Codex/Claude Desktop에서 의도적으로 채택 안 하는 패턴들)

- **상태**: Accepted (negative-space 결정)
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2 / §16 (SOTA++ 흡수의 negative space),
  [[codex-feature-catalog-2026-05-21]] (negative invariants 12개),
  [[codex-desktop-build-2867-round-2]] R3-7 (critical security)

## 맥락

[[cc-v2-sota-absorption]]과 [[codex-absorption-complete]]는 흡수한 패턴을
정리한다. 그러나 **채택하지 않기로 결정한 패턴**도 동등하게 명시적으로
기록되어야 미래의 회귀를 막을 수 있다. 본 ADR은 Codex Desktop / Claude Desktop
audit ([[codex-desktop-build-2867-round-2]], [[claude-desktop-1-7196-catalog]],
[[codex-feature-catalog-2026-05-21]])에서 본 패턴 중 **v3가 의도적으로
채택하지 않을** 항목과 그 이유를 reserve한다.

negative invariants는 "지금 안 한다"가 아니라 "v3의 신뢰 모델 / surface 제약과
근본적으로 양립하지 않는다"는 더 강한 선언이다. 변경 시 별도 ADR로 invariant를
명시적으로 해제해야 한다.

## 결정 — 12개 negative invariants

### N1. 상시 화면 캡처 데몬 (`codex_chronicle` 동등물)

**왜 안 함**: 사용자 컴퓨터에 항상 OCR + 메모리 파이프라인 데몬을 띄우는 것은
v3의 "사용자가 명시적으로 turn을 시작할 때만 작동" 신뢰 모델과 충돌. opt-in
flag로도 회피 불가 — 데몬은 1급 시민으로 설치되거나 아예 없거나여야 함.
**예외**: v3에 별도 surface로 "Quanta Recorder" 같은 명시적 제품을 분리할
경우 — 그건 별도 binary + 별도 ADR.

### N2. 글로벌 modifier 키 후킹 (`bare-modifier-monitor` 동등물)

**왜 안 함**: macOS 전역에서 키 입력을 관측하는 헬퍼는 CLI/Web surface와
무관 + 신뢰 표면 거대. 활성화 surface가 데스크톱 native (Tauri 등)일 때만
유효 — 그때 별도 ADR.

### N3. 비샌드박스 Electron + JIT + 임의코드 실행 entitlements

**왜 안 함**: Codex Desktop은 `app-sandbox: false`, `allow-jit: true`,
`allow-unsigned-executable-memory: true`로 OpenAI 코드사이닝 신뢰에 100%
의존. v3는 sandbox-by-default — Tauri/Electron surface 진출 시 OS sandbox
유지 + 모든 entitlement 명시적 justification 필수 ([[codex-seatbelt-sandbox-profile]]).

### N4. personality 시스템 (pragmatic/friendly system prompt 분기)

**왜 안 함**: 사용자별 personality로 system prompt를 갈라치면 byte-identical
prompt cache (ADR-0004) invariant 깨짐 + 행동 일관성 손실. v3는 사용자 명시적
instruction(`USER_INSTRUCTION` 슬롯)으로 동등 효과 달성.

### N5. Chrome native messaging host plugin (사용자 인증 세션 흡수)

**왜 안 함**: Codex Chrome plugin은 "browser data may be used for training"
명시. 사용자가 Chrome으로 들어간 인증 세션 + 페이지 콘텐츠가 OpenAI로 전송.
v3는 인앱 브라우저(IAB)만, 사용자 Chrome session 흡수 금지.

### N6. 14GB 누적 로컬 trace DB (`logs_2.sqlite` 동등물)

**왜 안 함**: Codex의 14.8GB 로컬 trace는 [[codex-logs-retention-pattern]]
sliding window로 cap되지만, v3의 jsonl-recorder 보존 정책은 더 보수적인
default(예: 1GB cap)로 시작. 사용자 opt-in으로만 확장. 디스크 footprint를
agent 사용량에 비례하게 만들지 않음.

### N7. `runWidgetCode` 임의 JS 실행 (Skybridge `runWidgetCode` 포트 동등물)

**왜 안 함**: Codex Skybridge의 `runWidgetCode`는 `{code, context}` 임의
JS를 sandboxed iframe에서 실행 — 사실상 RCE 표면. v3가 widget surface 채택
시(ADR-0043) `runWidgetCode`는 제외하거나 capability-gate 의무
([[codex-desktop-build-2867-round-2]] R3-7).

### N8. `setAdditionalGlobals` 무제한 전역 주입 (Skybridge 동등물)

**왜 안 함**: 임의 전역을 widget에 주입하는 패턴은 N7과 결합해 강력한 RCE.
v3 widget surface는 freezeWidgetGlobals + 명시적 allowlist만.

### N9. `dangerously-bypass-approvals-and-sandbox` CLI flag (Codex 동등물)

**왜 안 함**: 사용자가 한 번 누르면 모든 게이트 무력화되는 escape hatch는
v3 reviewer 3-tier (ADR-0029) + admissibility-gate (ADR-0026)와 충돌. v3는
per-action approval만 허용 — global bypass 금지.

### N10. `claude-code-import`가 다른 에이전트 auth 토큰 자동 흡수

**왜 안 함**: Codex의 external-agent-migration은 `~/.claude/auth.json`까지
read해서 토큰 마이그레이션. v3 external-agent import (ADR-0038)는 **세션
히스토리 + skill 매니페스트만** 흡수, auth credential은 명시적 사용자 확인
없이 절대 read 안 함.

### N11. cleartext HTTP 허용 (`NSAllowsArbitraryLoads: true`)

**왜 안 함**: Codex Info.plist는 임의 HTTP 허용. v3는 HTTPS only + 명시적
사용자 opt-in으로만 cleartext (디버그용).

### N12. Anthropic SDK auto-instrumentation 없이 dormant vendoring

**왜 안 함**: Codex는 Anthropic SDK를 Sentry hook 용도로 dormant vendoring
([[anthropic-sdk-in-codex]]). v3는 `@anthropic-ai/sdk`를 명시적 LLM adapter
([[quanta-v3-state]] dual provider)로 active 사용 — dormant 패턴은 supply
chain 표면만 키움. 사용 안 하는 dep는 제거.

## 근거

- **negative space의 가치**: 흡수 결정만 기록하면 "왜 X는 안 했지?"라는
  미래 회귀 위험. 명시적 negative invariants는 그 회귀를 막는다.
- **trust model 응집**: 12개 invariant는 v3의 일관된 trust model — 명시적
  사용자 의사 + sandbox default + minimum credential read.
- **변경 비용 명시**: invariant 해제는 별도 ADR이 필요하다는 규칙으로,
  drift를 막는다.

## 대안

- **각 흡수 ADR에 분산**: 기각 — 분산되면 일관성 검증 불가. 단일 SSOT가 필요.
- **메모리에만 기록**: 기각 — 메모리는 자동 stale 위험. ADR이 더 안정적.
- **wiki / README 섹션**: 기각 — discoverability 낮음, ADR 트리가 표준.

## 결과·트레이드오프

- **얻은 것**: 12개 명시적 invariant로 미래 PR 리뷰에서 "이거 Codex처럼
  해보자" 같은 회귀를 자동 차단.
- **비용**: ADR 슬롯 1개. invariant 변경 시 별도 ADR 비용.

## 한계 (LIMITATIONS)

- (a) **12개는 sample**: 모든 가능한 negative pattern을 enumerate하지 않음.
  새 audit에서 발견 시 본 ADR에 append.
- (b) **invariant 강제는 코드 게이트 아님**: 본 ADR은 문서 + 리뷰 컨벤션.
  실제 게이트(예: HTTP-only 차단)는 코드/CI에서 별도 enforce.

## 불변식 영향

- **슬라이스 격리 유지**: doc-only.
- **RFC/ADR 동기**: RFC §16 (흡수)의 짝.
- **신규 npm dep 0**.
- **byte-identical**: 코드 변경 없음.

## 변경 절차

negative invariant를 해제하려면:

1. 별도 ADR ("ADR-00XX: N7 (`runWidgetCode`) 해제 결정")을 작성.
2. 해제 이유 + trade-off + 새 trust model 설명.
3. 본 ADR의 해당 N항목 상태를 "Superseded by ADR-00XX"로 변경.
4. RFC §16 changelog에 추가.
5. PR 리뷰는 최소 2인 (해당 surface 오너 + security 오너).
