# ADR-0045 (잠정 번호) — Context-usage metrics + surface-agnostic status line

- **상태**: Accepted (small slice; behavior-preserving)
- **날짜**: 2026-05-21
- **관련**: [[claude-desktop-1-7196-catalog]] (`getContextUsage` IPC),
  RFC §8 (observability), ADR-0024 (CLI slice isolation),
  ADR-0032 (OTel vocabulary), [[surface-model]] (CLI / Tauri / Web)

## 맥락

Claude Desktop 1.7196.3는 `getContextUsage` IPC를 통해 UI sidebar에
실시간 컨텍스트 사용량 (used / max / pct / model)을 노출한다
([[claude-desktop-1-7196-catalog]]). v3는 같은 정보를 이미 내부에서
계산하지만 (`estimateTokens`, provider `usage` StreamEvent) 어떤 surface도
이를 user에게 표시하지 않는다.

- `src/observability/vocabulary.ts`는 `gen_ai.usage.input_tokens` /
  `output_tokens` / `cache_read_input_tokens` enum을 이미 정의해 둠.
- `src/agent/loop.ts`의 `emitUsage`/`teeUsage`는 `usage` StreamEvent를
  AgentEvent로 bridge하지만 `AgentRecorder`에 push하지 않음.
- `AgentRecorder`에는 `tokensUsed` 메서드가 부재.

## 결정

1. `AgentRecorder.tokensUsed(input, output, cacheRead?)` 추가 — vocabulary의
   canonical OTel GenAI key로 forward. `cacheRead` 미전달 시 카운터 미생성
   (lazy registry → no-op 보존).
2. `METRIC.tokensInput` / `tokensOutput` / `cacheRead` 상수를 vocabulary에서
   직접 reference (drift 방지).
3. `src/apps/cli/status-line.ts` (신규) — surface-agnostic pure function
   `formatContextUsage(used, max, model?)`. 20-cell bar (5% / cell),
   k-suffix 숫자, oversize `!` 마커, model fallback `unknown`.
4. `loop.ts::emitUsage`에 `recorder?.tokensUsed(...)` 1-line fan-out.
   Recorder 부재 ⇒ no-op (byte-identical 유지).

## Negative invariants (이 ADR이 채택하지 않는 것)

- **상시 토큰 stream subscription IPC**: Claude Desktop은 sidebar update
  push를 위해 IPC subscription을 운영한다. v3는 pull-only — recorder
  snapshot을 호출자가 polling. (Cowork microVM은 surface 활성 시 ADR-0043).
- **per-model 컨텍스트 max 자동 lookup**: caller가 max를 명시 전달.
  Anthropic 200k / OpenAI 128k / ... lookup table은 별도 ADR에서 도입.
- **status line의 자동 stdout 인쇄**: helper는 string return only.
  surface가 표시 정책을 결정 (CLI prompt prefix vs Tauri sidebar vs REPL header).

## 영향

- `AgentRecorder` API 확장 (additive, breaking 없음).
- `loop.ts`: `teeUsage` 시그니처에 `recorder?` 1개 추가. 호출자 1곳
  (`streamConsume`) 동시 갱신. 다른 surface / 테스트 영향 0.
- `apps/cli/status-line.ts`는 `@/agent` import 0 — Tauri / Web 미래 surface가
  copy-paste 없이 import할 수 있도록 surface-agnostic.

## 테스트

- `tests/unit/agent/metrics-tokens.test.ts` — 6 cases (counter forwarding,
  cacheRead optional, 부수 효과 0).
- `tests/unit/cli/status-line.test.ts` — 14 cases (bar shape / oversize /
  model fallback / 숫자 rendering / invariants).
- `tests/integration/agent-metrics-e2e.test.ts` — 3 cases (single turn,
  cacheRead path, metrics-absent byte-identical branch).
