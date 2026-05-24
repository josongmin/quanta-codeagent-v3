# ADR-0189: Per-tool TTL drift detector — config-vs-preset divergence as typed signal

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0179 (per-tool TTL config — parent; this ADR closes the §"Follow-up" gap of operator awareness when caller config drifts from the audited preset), ADR-0169 (skipped-warning — sibling dual-audience pattern: operator log), ADR-0175 (wired-gauge — sibling dual-audience pattern: machine counter)
- **참조**: `src/observability/metrics/instrument-tool-dedup.ts`, `tests/unit/observability-tool-dedup-drift-hellgate.test.ts`, `tests/unit/observability-metrics-tool-dedup-ttl-hellgate.test.ts` (parent regression)

## 맥락

ADR-0179 박았다: `defaultToolCallCache({ perToolTtlMs })` per-tool TTL + `RECOMMENDED_PER_TOOL_TTL_MS` 상수 (audited staleness table). 그러나 caller가 preset과 다른 값을 쓰면 (e.g. `read: 90_000` vs preset `60_000`, 또는 `bash`만 빼먹어서 caching 활성화) **누구도 안 알아챈다** — preset은 JSDoc에만 문서화되고 caller의 config과 실제로 비교되지 않는다.

두 가지 drift hazard:

1. **Operator-facing**: 새 tool이 RECOMMENDED preset에 추가됐는데 (`grep` → `git_grep` 추가 같은) caller config 업데이트를 까먹음 → 안전한 default 못 받음.
2. **Cost optimization**: caller가 의도 없이 `read: 5_000` 같이 너무 짧게 설정 → cache hit 거의 없음, 비용 분석에서만 사후 발견.

ADR-0169(skipped-warning) + ADR-0175(wired-gauge)가 동일한 운영-vs-기계 두-청중 분리를 이미 사용 — 같은 패턴을 per-tool TTL config에 적용.

## Research grounding

**Cursor `FastRepoInitHandshakeV2`** (`cursor-localization.md` §17.6, verbatim 발췌):

> 매 `doUpdate`에서 `FastRepoInitHandshakeV2{rootHash, simhash[], pathKeyHash, do_copy}` → 서버 응답 per-codebase status:
> - `UP_TO_DATE` → skip
> - `OUT_OF_SYNC` → subtree walk (#3)
> - `EMPTY` → `startRepoUpload()` 풀 재업로드

**The insight** — Cursor의 drift defense는 **typed verdict**다: handshake가 expected (server view) vs actual (client view) 의 차이를 `UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY` 3-arm closed enum으로 반환하고, 그 verdict가 caller 동작을 트리거 (skip / walk / re-upload). 차이가 있다는 사실 자체가 1급 시그널.

**The analog** — per-tool TTL drift는 **construction-time** handshake다: caller `perToolTtlMs` map(actual) vs `RECOMMENDED_PER_TOOL_TTL_MS`(expected) 를 cache 생성 시 한 번 비교. 4-arm closed enum (`too-permissive` / `too-restrictive` / `missing` / `unknown-tool`)으로 분류, operator log + machine counter 두 채널로 emit.

(Memory `agent-loop-4way-comparison.md` 확인 — drift defense는 sandbox / verify gate에서만 다루고 config preset drift 패턴 없음.)

## 결정

`DefaultCacheOpts`에 3 옵션 추가, 전부 default-OFF:

```ts
export interface DefaultCacheOpts {
  // ... 기존 (maxEntries / ttlMs / perToolTtlMs / now)
  readonly checkRecommendedDrift?: boolean
  readonly onDriftWarn?: (msg: string) => void
  readonly metrics?: MetricsRegistry
}
```

`defaultToolCallCache` 동작:

1. 기존대로 cache 생성 (TTL/LRU/clear 동일).
2. `opts.checkRecommendedDrift === true` 인 경우 **construction time에 1번**:
   - `computePerToolTtlDrifts(caller, RECOMMENDED_PER_TOOL_TTL_MS)` — caller + preset union을 deterministic order로 walk.
   - 각 tool당 4-arm closed enum `PerToolTtlDriftKind` 으로 분류:
     - `too-permissive` — caller value > preset value (caching MORE than recommended → staleness risk)
     - `too-restrictive` — caller value < preset value (caching LESS → cost optimization missed; `0` < `N` 도 여기)
     - `missing` — preset has entry, caller doesn't (fallthrough to global `ttlMs`, may not match preset)
     - `unknown-tool` — caller has entry, preset doesn't (custom tool, informational)
   - 각 drift 당 `metrics?.increment("tool.dedup.config_drift.total", 1, { tool, kind })` (metrics 있을 때만).
   - 모든 drift를 **하나의** combined message로 build (kind별 grouping) → `onDriftWarn(msg)` (sink 있을 때만).

### 핵심 분리

- **운영자-facing**: `onDriftWarn` 1회 호출 + combined message (alert fatigue 방지) — ADR-0169 pattern.
- **기계-facing**: per-drift counter w/ `{tool, kind}` labels — ADR-0175 pattern (machine queries PromQL `tool_dedup_config_drift_total{kind="too-permissive"} > 0`).
- **Graceful degradation**: `metrics` 없으면 counter skip, warn은 여전히 fire. `onDriftWarn` 없으면 warn skip, counter는 여전히 emit. 두 channel 독립.
- **No-throw invariant**: `safe(...)` wrap 으로 throwing registry/sink가 cache construction을 깨면 안 됨 (HELL-DRIFT-10/12).

### Combined message format

```
[tool-dedup] N drift(s) vs RECOMMENDED: too-permissive=[A,B] too-restrictive=[C] missing=[D,E] unknown=[F]. Set 'checkRecommendedDrift:false' to silence or update perToolTtlMs to match.
```

비어있는 kind는 생략. 운영자가 1줄로 무엇/얼마나 drift됐는지 보고, machine query는 counter 라벨로 별도 dimension.

## Default-OFF (byte-identical 증명)

`checkRecommendedDrift` 미지정 → `if (opts.checkRecommendedDrift === true)` false → return. ADR-0179 호출 경로 0건 변경. 비교 비용 zero, counter 0건 emit, warn 0회 호출. HELL-DRIFT-1 pins this.

## Hellgate (12-case summary)

`tests/unit/observability-tool-dedup-drift-hellgate.test.ts`:

**A. Default-OFF (2)**
- **HELL-DRIFT-1**: `checkRecommendedDrift` 미지정 → drifty config 줘도 counter 0건 + warn 0회 (byte-identical).
- **HELL-DRIFT-2**: `checkRecommendedDrift: true` + no `perToolTtlMs` → preset의 모든 key가 `missing` drift 발생; combined message에 `missing=[...]` + N drift(s).

**B. Drift kinds (4)**
- **HELL-DRIFT-3**: caller `read: 90_000` vs preset `60_000` → `too-permissive` counter for `read`.
- **HELL-DRIFT-4**: caller `read: 30_000` vs preset `60_000` → `too-restrictive`.
- **HELL-DRIFT-5**: caller `my_custom: 5_000` not in preset → `unknown-tool`.
- **HELL-DRIFT-6**: caller가 preset과 완전 일치 → counter 0건 + warn 0회.

**C. Combined message (2)**
- **HELL-DRIFT-7**: 4 drift across 3 kinds → `onDriftWarn` 1회만 호출, message에 kind별 그룹 + `4 drift(s)`.
- **HELL-DRIFT-8**: custom `onDriftWarn` port → 그 sink 1회 호출, `console.warn` spy 0회 (port wiring 증명).

**D. Edge — graceful degradation + no-throw (4)**
- **HELL-DRIFT-9**: `metrics: undefined` + `onDriftWarn` set → warn fires, counter 0건 (graceful).
- **HELL-DRIFT-10**: `metrics.increment` throws → swallowed, cache 생성 성공 + 정상 동작.
- **HELL-DRIFT-11**: caller `read: 0` (never-cache) vs preset `60_000` → `too-restrictive` (0 < N).
- **HELL-DRIFT-12**: `onDriftWarn` throws → swallowed, counter는 여전히 record.

Parent regression `observability-metrics-tool-dedup-ttl-hellgate.test.ts` (10 cases) + `observability-metrics-instrument-tool-dedup-hellgate.test.ts` (20 cases) re-run untouched: 0 fail.

## Alternatives rejected

1. **Silent diff in JSDoc only** (operator reads RECOMMENDED doc + own config side-by-side manually) — invisible. Operators miss the comparison because it requires opening the source file. Rejected: rejected for the same reason ADR-0169 rejected JSDoc-only skip docs.
2. **`throw` on drift** — caller가 점진 wire-up / 의도된 override 못 함; ADR-0179의 핵심 설계(override 가능)를 깸. Rejected: hard fail은 부적절.
3. **Per-tool individual warn** (각 drift당 한 번씩 `console.warn`) — noisy. preset이 9 tool인데 caller가 다 다르면 9줄 warn → alert fatigue. Combined message가 hexagonal. Rejected: same alert-fatigue reasoning as ADR-0169.
4. **Auto-correct (silently override caller with preset when drift detected)** — caller 의도 위반. caller가 일부러 `read: 90_000`로 long-cache 선택했을 수도 있음. Rejected: prescriptive auto-fix가 default-OFF override 정신과 충돌.
5. **Gauge instead of counter** (현재 drift 수를 gauge로) — drift는 construction-time event, point-in-time이 아닌 cumulative. Counter가 PromQL semantic match. Rejected: wrong shape. (단, follow-up에서 "drift gauge"는 별도 metric으로 가능 — 본 ADR이 닫지 않는 것 참고.)
6. **Periodic re-check (background timer로 N초마다 drift 다시 평가)** — `perToolTtlMs`는 immutable Readonly config; 한 번 construct되면 변화 없음. Refresh 의미 없음. Rejected: no use case.
7. **Tier-0 default-ON with `checkRecommendedDrift: true`** — premature; 운영자가 처음으로 preset과 비교했을 때 알람 폭주 가능. Default-OFF + 운영자 opt-in이 ADR-0179 default-OFF philosophy와 일관. Rejected: 같은 caution as ADR-0179 §Alternatives #4.

## SOTA matrix

| Agent | config-vs-preset drift detection | typed verdict? | operator + machine split? |
|---|---|---|---|
| Cursor 3.2 | `FastRepoInitHandshakeV2` per-codebase status (`UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY`) — **REPO** drift, not config drift | ✅ 3-arm closed enum | ❌ (server-only) |
| Claude Code 2.1 | (no per-tool config preset, no drift detection) | — | — |
| Codex 0.130 | (rule-DSL prefix_rule matching, but no preset vs caller drift) | — | — |
| **quanta** (이 ADR) | **`checkRecommendedDrift: true` → 4-arm closed enum + dual operator/machine emit** | **✅ 4-arm `PerToolTtlDriftKind`** | **✅ ADR-0169/0175 sibling pattern** |

= "Cursor handshake drift pattern을 construction-time per-tool TTL 비교로 transposition; closed-enum verdict + 운영자/기계 dual-audience emit으로 typed."

## Follow-up (이 ADR이 닫지 않는 것)

- **Drift gauge** (`tool.dedup.config_drift.count` 현재 drift 수 gauge): counter는 construction event를 cumulative하게 잡지만 "현재 caller가 N개 drift가 있다"는 point-in-time view를 알려면 gauge 필요. construction 시점 1회만 의미가 있으니 우선순위 낮음.
- **Periodic re-check**: 현재 construction-time only. hot-reload config seam이 들어오면 (예: `defaultToolCallCache.reconfigure(opts)`) drift 재평가 시점 추가 필요. 오늘은 immutable config이라 deferred.
- **Drift severity threshold** (e.g. `read: 65_000` vs preset `60_000`는 8% 차이 → `too-permissive` 발생; 5% 이하 차이는 noise로 무시할까?): policy 결정은 caller 몫이지 우리가 임계 박을 사안 아님. 운영 데이터 쌓이면 별 ADR.
- **Auto-suggest fix**: combined message에 "use `perToolTtlMs: { ...RECOMMENDED_PER_TOOL_TTL_MS, read: 60_000 }`" 같이 정확한 patch 제안 첨부. 좋은 UX지만 message 길이 vs 시그널 trade-off; default-OFF로 starting.
- **`unknown-tool` 화이트리스트**: custom tool은 informational이지만 매번 noise. `unknownToolAllow?: ReadonlySet<string>` 로 silence할 수 있게. drift counter 통계 보고 결정.
