# ADR-0169: Observability skipped-slice warning — opt-in operator log + `skippedExpected` allowlist

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0161 (withFullObservability), ADR-0144 (MetricsRegistry), ADR-0158 (24-metric recipe)
- **참조**: `src/observability/metrics/observability-helper.ts`, `tests/unit/observability-metrics-skipped-warning-hellgate.test.ts`

## 맥락

ADR-0161에서 박힌 `withFullObservability(bag, opts)`는 bag의 어떤 key가 `undefined`이면 **조용히** 통과시킨다 (그 슬라이스 wrap을 skip + `out[key] = undefined`). 점진적 wire-up을 위한 의도된 설계지만, 운영자가 **"의도된 skip"** 과 **"잊어버린 wire-up"** 을 구분할 수 없는 drift hazard가 생긴다:

- 새 슬라이스가 추가됐고 bag 키도 늘었는데 composition root가 wiring 코드 한 줄을 빠뜨림 → metric 한 줄도 안 나오지만 누구도 모름.
- 반대로 read-only observability bot처럼 의도적으로 LSP client 없이 돌리는 deployment도 정상 — 매번 경고하면 alert fatigue.

기존 ADR-0161 follow-up 리스트에도 명시: *"AutoMetrics with ledger of skipped slices: composition root에서 wire 안 한 slice → warning log."*

## 결정

`ObservabilityOpts`를 3 옵션으로 확장하되 **전부 default-OFF**:

```ts
export interface ObservabilityOpts {
  readonly metrics: MetricsRegistry
  readonly prefixes?: Partial<{ ... }>          // 기존
  readonly warnOnSkipped?: boolean              // 신규: opt-in
  readonly skippedExpected?: ReadonlySet<keyof ObservabilityBag>  // 신규: 의도 skip 허용목록
  readonly warn?: (msg: string) => void         // 신규: 주입 가능 sink (default console.warn)
}
```

`withFullObservability` 동작:
1. 기존대로 7 slice를 wrap (또는 undefined 통과).
2. `opts.warnOnSkipped === true`인 경우에만 **한 번** 다음을 수행:
   - `ALL_BAG_KEYS` 7개 중 `bag[k] === undefined && !skippedExpected?.has(k)` 인 key들을 모은다 (`actuallySkipped`).
   - `actuallySkipped.length > 0` 이면 `opts.warn ?? console.warn` 으로 단 **하나의** combined message 출력:
     `[observability] withFullObservability: ${N} slice(s) unwired and not in skippedExpected: ${keys.join(", ")}. Set 'skippedExpected' to silence intentional skips.`
3. 반환값(`InstrumentedBag`)은 그대로 — 경고 경로는 부수효과만, return shape 영향 없음.

**핵심 분리**: 운영자-facing은 `warn` 포트 (사람이 startup 직후 보는 로그), 기계-facing은 metrics — 본 ADR에서는 metric emission **안 함** (follow-up에서 `observability.wired.total{key}` 0/1 gauge로 분리).

## Default-OFF (byte-identical 증명)

`warnOnSkipped` 미지정 → 기존 ADR-0161 호출 경로와 **byte-identical** (조건문 한 번 false → return). 기존 13 unit + 11 e2e + 4 helper case 0건 변경 무엇도 영향 없음 (그대로 pass).

## Hellgate

`tests/unit/observability-metrics-skipped-warning-hellgate.test.ts` — **6 신규 case**:

1. **[1]** `warnOnSkipped` 생략 (default) → 7 key 모두 undefined여도 capture-warn `[]` (silent baseline).
2. **[2]** `warnOnSkipped: true` + 7 key 모두 undefined → 1번 호출, 메시지에 7 key 전부 + `"7 slice(s) unwired"` + `"skippedExpected"` 포함.
3. **[3]** 3 key wire (`planQueue`/`budgetLedger`/`tools`) + 4 undefined → 메시지에 누락 4 key만 (`llmProvider`/`scheduler`/`shadowOdb`/`lspClient`), wired 3 key는 delimiter-aware 검사로 부재 확인 + `"4 slice(s) unwired"`.
4. **[4]** `skippedExpected: Set([llmProvider, scheduler])` → 그 둘 빠지고 나머지 5 key 등장 + `"5 slice(s) unwired"`.
5. **[5]** 모든 missing key가 `skippedExpected` 안 → warn 0번 호출 (전부 의도된 skip).
6. **[6]** custom `warn` port → 우리 sink 1번 호출 + `console.warn` 0번 호출 (port wiring 증명).

## Alternatives rejected

1. **Always-warn (no opt-in flag)** — startup 로그가 매번 노이즈로 깔리면 운영자가 진짜 신호를 놓침. opt-in이 hexagonal.
2. **Metric-only (`observability.wired.total{key}` gauge만 emit)** — Prometheus dashboard에 가야만 보이므로 dev/CI 등 운영자가 인지하기 어려움. log + metric은 별개 follow-up.
3. **`throw` on skipped** — caller가 점진 wire-up 못함; ADR-0161의 핵심 설계 (missing → undefined 통과) 깸. 호환성 깨는 hard fail은 부적절.
4. **자동 `skippedExpected` 추론 (production env에선 모두 expected)** — env-dependent 동작은 byte-identical 깸 + 운영자가 정확히 어떤 슬라이스 의도 skip인지 명시해야 운영 가치 있음.
5. **자체 ADR 대신 ADR-0161에 patch** — follow-up bullet이 별 결정 (sink shape + allowlist + opt-in flag) 3가지를 동시에 도입하므로 독립 ADR이 추적 용이.

## Follow-up

- **Machine-readable observability-health metric**: `observability.wired.total{key}` 0/1 gauge per bag key. log는 사람용, gauge는 alerting용. 분리해서 각각의 SLO 다르게.
- **Deployment-profile 기반 skippedExpected 자동 주입**: `profiles/observability-bot.ts`처럼 known shape의 expected-set을 export하면 caller `skippedExpected: profiles.observabilityBot`만 쓰면 됨.
- **테스트 helper export**: `expectAllWired(bag)` 단언 유틸리티로 spec 테스트가 wiring 누락을 컴파일 전에 잡도록.
