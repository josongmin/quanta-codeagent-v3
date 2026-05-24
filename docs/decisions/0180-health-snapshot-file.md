# ADR-0180: File-based health snapshot — `~/.quanta/health.json` JSON mirror of the wired-gauge

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0144 (MetricsRegistry typed port), ADR-0161 (withFullObservability composition-root helper), ADR-0169 (skipped-slice warning — operator-facing sibling), ADR-0172 (`observability.wired.total` machine-readable gauge — direct parent)
- **참조**: `src/observability/metrics/health-snapshot.ts`, `src/observability/metrics/observability-helper.ts`, `tests/unit/observability-health-snapshot-hellgate.test.ts`

## 맥락

ADR-0172의 `observability.wired.total{slice}` gauge는 PromQL/AlertManager를 운영하는 팀에는 완벽하다 — 그러나 **Prometheus 스택이 없는 운영자**(개인 개발자, 단일 머신 staging, embedded use)에게는 gauge에 접근할 표준 경로가 없다. metrics snapshot을 in-process로 조회하려면 코드를 띄워야 하고, OTel push collector를 따로 세워야 한다.

따라서 두 채널이 더 필요하다:

1. **사람 (operator) → 로그**: ADR-0169 처리.
2. **기계 (PromQL) → gauge**: ADR-0172 처리.
3. **사람 또는 스크립트 → 파일**: 본 ADR. `cat ~/.quanta/health.json | jq '.summary.completenessRatio'` 한 줄로 wiring 상태를 본다. shell 외에 의존 없음.

### Research grounding — "no SOTA agent writes a JSON health file"

- `docs/analysis/경쟁사리뷰/code-agent-loop/claude.md` 전수 grep: `health` / `liveness` / `ready` 키워드 **0 hits**. Claude Code v2 표준 도구셋과 13 노출 도구(`claude-desktop-1-7196-catalog` 메모)에 health probe surface 없음.
- `docs/analysis/경쟁사리뷰/code-agent-loop/cursor.md` 전수 grep: **0 hits**. Cursor의 `TurnEndedUpdate`는 token usage이지 wiring health도, 파일도 아님.
- 메모 `claude-desktop-1-7196-catalog.md`: **Sentry(@sentry/electron|node|opentelemetry) + Statsig + growthbook 3-tier** observability — 모두 enterprise event/feature-flag SaaS로 출력. **파일로 dump되는 health surface 없음**. `cowork_memory_sync_*` 22개 이벤트도 sink가 Sentry이지 file이 아님.

**핵심 인사이트**: 어느 SOTA 에이전트도 file-based health surface를 노출하지 않는다 — 모두 Sentry 이벤트 또는 in-process IPC RPC. **quanta first**.

**SOTA reference parallel**:
- Kubernetes pod `livenessProbe.exec.command: ["cat","~/.quanta/health.json"]` + `jq` — file-based probe는 HTTP 서버, 포트 관리, scrape 설정이 전부 불필요. **universal** (어떤 shell이든 동작).
- systemd `notify` 소켓 — 같은 정신: tiny well-known file로 "up + what is wired" 만 표현. in-process server 없음.

## 결정

신규 모듈 `src/observability/metrics/health-snapshot.ts` 도입 + `withFullObservability` 에 1 신규 opt 추가 (default-OFF):

```ts
export interface HealthSnapshot {
  readonly version: 1                  // wire-stable envelope; bump for breaking shape change
  readonly writtenAt: number           // epoch ms (build-time)
  readonly quantaVersion: string       // env QUANTA_VERSION || "unknown"
  readonly slices: ReadonlyArray<SliceHealth>
  readonly summary: {
    readonly wiredCount: number
    readonly totalCount: number
    readonly completenessRatio: number // wiredCount / totalCount; 0 when totalCount=0
  }
}

export interface SliceHealth {
  readonly slice: keyof ObservabilityBag
  readonly wired: boolean
  readonly note: "wired" | "missing" | "skipped intentionally"
}
```

`ObservabilityOpts` 확장:

```ts
/** ADR-0180: when set, write a JSON health snapshot at construction time.
 *  Absolute path used verbatim; relative path anchored to `${homedir()}/.quanta/`.
 *  `true` = use default `${homedir()}/.quanta/health.json`. Default = no write. */
readonly healthSnapshotPath?: string | true
```

`withFullObservability` 동작 (ADR-0172 + ADR-0169 baseline 보존):

1. 기존 7 slice wrap / warn / gauge 모두 그대로.
2. `opts.healthSnapshotPath !== undefined` 인 경우:
   - `buildHealthSnapshot(out, { skippedExpected })` 로 envelope 구성.
   - `writeHealthSnapshot(snap, { path })` fire-and-forget 호출 — sync 시그니처 보존 (construction time이지 hot path 아님).
   - 결과 promise는 `lastHealthSnapshotInFlight()` 로 노출 (테스트 deterministic await용).
   - build/write 실패는 `opts.warn` (또는 `console.warn`) 로 swallow — snapshot은 운영자 편의지 hot-path failure 모드가 아니다.

`writeHealthSnapshot` 의 atomic 패턴: `mkdir -p $(dirname)` → emit별 unique tmp 파일 (`${final}.tmp.${pid}.${ordinal}`) 작성 → `rename` (POSIX atomic). 같은 프로세스의 concurrent write도 scratch path를 공유하지 않는다.

### skippedExpected → snapshot 의미 (ADR-0172 와 분리)

ADR-0172 의 gauge는 "ground truth"였다 — skippedExpected가 gauge value를 distort하지 않는다. 본 ADR의 snapshot은 **다른 사용자 경험**: 운영자가 `cat health.json` 으로 한눈에 본다. 따라서:

- `slice.wired` 필드는 여전히 ground truth (수치 검증용).
- `slice.note` 필드는 운영자 의도를 표현: `"wired" / "missing" / "skipped intentionally"`.
- `summary.wiredCount` 는 ground truth만 본다 (`wired === true` 개수).

요컨대 snapshot은 truth + intent **둘 다** 노출. dashboard alert 룰은 (gauge처럼) truth로 풀고, 사람은 note로 의도를 본다. 같은 데이터, audience-tuned 표면.

## Default-OFF (byte-identical 증명)

`healthSnapshotPath` 미지정 → `if (opts.healthSnapshotPath !== undefined)` false → return. ADR-0161/0169/0172 호출 경로 0건 변경. 파일 시스템 접근 0건. 동작 byte-identical.

## Hellgate

`tests/unit/observability-health-snapshot-hellgate.test.ts` — **12 신규 case**:

| # | scope | case |
|---|---|---|
| 1 | buildHealthSnapshot | empty bag → 7 slices all wired=false, summary 0/7/0 |
| 2 | buildHealthSnapshot | all 7 wired → all wired=true note="wired", ratio=1 |
| 3 | buildHealthSnapshot | partial 3 wired → 3 "wired" / 4 "missing", ratio≈3/7 |
| 4 | buildHealthSnapshot | skippedExpected → note="skipped intentionally" for listed slices |
| 5 | buildHealthSnapshot | quantaVersion override reflected |
| 6 | writeHealthSnapshot | happy path → file readable, parses to HealthSnapshot |
| 7 | writeHealthSnapshot | atomic — injected writer records 1 call to FINAL path |
| 8 | writeHealthSnapshot | write failure → HealthSnapshotError("write-failed") |
| 9 | writeHealthSnapshot | concurrent default writes allocate distinct tmp paths before rename |
| 10 | helper integration | custom absolute path → file written, read back, 7 slices |
| 11 | helper integration | `true` → default `~/.quanta/health.json` resolved (success-OR-swallow-warn dual accept for CI sandboxing) |
| 12 | determinism | same bag + injected clock → `JSON.stringify` byte-identical, slice order = ALL_KEYS |

## Operator query examples

```sh
# wiring completeness ratio (one-line health summary)
cat ~/.quanta/health.json | jq '.summary.completenessRatio'

# list every unwired slice
cat ~/.quanta/health.json | jq -r '.slices[] | select(.wired == false) | .slice'

# list slices that are unwired AND not intentionally skipped (= action items)
cat ~/.quanta/health.json | jq -r '.slices[] | select(.wired == false and .note != "skipped intentionally") | .slice'

# wiring health probe (exit 0 = fully wired)
[ "$(jq -r '.summary.completenessRatio' ~/.quanta/health.json)" = "1" ]
```

Kubernetes livenessProbe wiring:

```yaml
livenessProbe:
  exec:
    command:
      - sh
      - -c
      - 'test "$(jq -r ".summary.completenessRatio" /home/quanta/.quanta/health.json)" = "1"'
  periodSeconds: 30
```

## Alternatives rejected

1. **HTTP `/health` 엔드포인트**. 운영자가 `curl localhost:9090/health` 친다. **거부**: quanta는 오늘 HTTP 서버 없음. 도입 시 port 충돌·바인딩·shutdown 처리·인증이 모두 따라옴. file은 OS-level primitive, 의존 0. HTTP가 정식 도입되면 본 ADR의 follow-up으로 JSON mirror.
2. **OTel resource attributes**. wired 상태를 service.instance 의 resource attribute로 노출. **거부**: resource는 process-start에 1회 기록 (immutable per Otel spec). snapshot은 잠재적으로 refresh 가능해야 함 (follow-up). 시멘틱이 wrong shape.
3. **SQLite metric DB**. 본 ADR 외의 모든 metric을 같이 dump. **거우**: 1KB JSON one-shot에 SQLite 의존, schema migration, WAL/journal — overkill. file은 read-only operator script가 grep + jq 만으로 모든 정보를 빼낸다.
4. **gauge에 file write를 묶기** (ADR-0172 안에 patch). **거부**: 두 audience (PromQL 운영팀 vs 단일 머신 운영자) / 두 lifecycle (gauge: scraped, file: cat) / 두 sink — 분리해야 SLO·롤백·테스트가 깔끔.
5. **Async helper signature 변경** (`withFullObservability` 를 `async` 로). **거부**: 기존 8+ 호출 사이트 모두 sync — breaking change ROI 없음. fire-and-forget + `lastHealthSnapshotInFlight()` 테스트 seam 패턴이 byte-identical 보존 + deterministic test 둘 다 만족.
6. **`.quanta/` 디렉토리 외부 위치** (e.g. `$XDG_RUNTIME_DIR`). **거부**: ADR-0144/0161 가족이 이미 `~/.quanta/` 컨벤션. XDG는 Linux-only 의미 (macOS는 매핑 모호). 일관성 + 단순성.

## Follow-up (이 ADR이 닫지 않는 것)

- **Periodic refresh**. 오늘은 construction-time 1회. composition root가 hot-reload되면 (subagent fork 등) 재작성 필요. `withFullObservability(bag, { healthSnapshotPath, refreshIntervalMs: 30_000 })` 옵션 추가 시점에 별 ADR.
- **HTTP `/health` 엔드포인트**. quanta에 HTTP 서버 자체가 도입될 때 JSON snapshot을 그대로 mirror (re-use serialization).
- **Multi-process aggregation**. 여러 quanta 인스턴스가 같은 노드에서 동작 시 per-pid 파일 (`health.${pid}.json`) + 합산 read 헬퍼. 오늘은 single-process가 100%.
- **Schema versioning policy**. `version: 1` envelope. 2 로 bump 시 호환성 정책 (parallel write, dual read) 별 ADR.
- **wired note 확장**. `"deprecated"`, `"experimental"` 등 lifecycle hint. 현재 closed 3-arm union이라 추가 시 명시적 ADR amendment.

## SOTA matrix (좁은 갱신)

| Agent | file-based health surface | shell-grep-friendly |
|---|---|---|
| Claude Desktop 1.7196 | Sentry/Statsig events | ❌ (SaaS-side only) |
| Cursor 3.2.16 | `TurnEndedUpdate` IPC | ❌ (token accounting, not wiring; in-process) |
| Codex Desktop 0.131 | 70+ OTel attribute trace | ❌ (push-based collector required) |
| **quanta** (본 ADR) | **`~/.quanta/health.json` versioned envelope** | ✅ `cat \| jq` one-liner |

= "wiring health을 file-based health surface로 노출한 첫 single-process agent observability artifact."
