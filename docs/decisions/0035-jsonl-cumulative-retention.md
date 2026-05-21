# ADR-0035: jsonl-recorder cumulative-bytes sliding-window retention

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §3.1(슬라이스 격리), §16(SOTA++ 흡수), ADR-0010(observability trajectory), Codex `codex-logs-retention-pattern` 메모(14.8 GB 폭증 사례)

## 맥락

`JsonlRecorder`는 `appendFileSync`로 단조 증가하는 jsonl 파일을 만든다.
현재 보호 장치는 line-count cap (`maxLines` 기본 100k, ADR-0010 §line_cap
degraded line) 하나뿐이다 — line별 byte 크기 변동(예: 큰 `tool_result`
preview)에 취약하다. Codex가 production에서 같은 패턴을 운영하다
`codex-logs-retention-pattern` 메모에 따르면 한 thread의 jsonl이 **14.8 GB**
까지 자란 사례가 보고됨 — line cap만으로는 디스크 footprint를 예측할 수
없다는 증명.

Codex의 fix는 cumulative-bytes sliding-window: 가장 최근 row부터 byte를
누적하다 cap을 넘기 시작하는 row 이전을 drop, atomic rewrite. v3가 같은
패턴을 흡수한다.

추가 제약:
- 슬라이스 격리(RFC §3.1): retention 로직은 `@/stream` 내부에만 존재해야 함.
  스케줄링/policy 결정은 `@/agent`가 책임.
- 기존 `JsonlRecorder` API breaking 금지 — 새로운 add-only 함수로 노출.
- zero swallowed error: 충돌 가능 시 throw, retry 금지.

## 결정

### Part 1 — Retention 함수 (`src/stream/adapters/jsonl-retention.ts`, NEW)

```
applyRetention(filePath, opts: { maxCumulativeBytes, dryRun? })
  → { keptRows, droppedRows, droppedBytes }
```

알고리즘:
1. `.tmp` 파일 존재 확인 → 있으면 `JsonlRecorderRetentionBusyError` throw
   (aborted prior run 또는 concurrent writer). retry/silent skip 없음.
2. 파일 read (`readFile`). 없으면 no-op return.
3. `\n` split, trailing empty 제거.
4. **tail-first walk**: 최신 row부터 `Buffer.byteLength(row, "utf8") + 1`
   (newline 포함)을 누적 — `cumulative + rowBytes > cap`이면 break.
5. `firstKeptIndex` 이전은 drop, 이후는 keep. `droppedBytes`는 dropped row의
   payload byte (newline 제외) — caller가 잃은 데이터 양 보고용.
6. dry-run이면 여기서 return.
7. atomic rewrite: `<file>.tmp`에 `wx` (O_EXCL) flag로 새로 만들고 keptRows를
   `\n`-join + trailing `\n`로 write, `fsync`, `rename(tmp, file)`.

byte 계산 invariant:
- on-disk 회계: `row utf-8 bytes + 1 (newline)` — cap 비교에 사용.
- `droppedBytes` 보고: newline 제외한 row payload만.

### Part 2 — Stream slice public surface (`src/stream/types.ts`)

`RetentionPolicy` interface 추가:
```ts
interface RetentionPolicy {
  maxCumulativeBytes: number    // 필수, 디폴트 없음
  intervalMs?: number           // 스케줄링 metadata (mechanism 아님)
}
```

기본값 없음 — caller(즉 `@/agent`)가 policy를 명시 declare해야 함 (ADR-0035:
"defaults belong to the policy layer, not the mechanism").

### Part 3 — 부수 API

- `inspectRetentionState(filePath)` → `{ fileBytes, rowCount }`: dashboard/
  운영자가 mutation 없이 retention 압력 확인.
- `JsonlRecorderRetentionBusyError`: 명시 export, `.tmpPath` / `.code` 노출.

## 근거

- **Codex production-verified 패턴**: 14.8 GB 폭증 → byte-based sliding
  window가 line-count cap보다 disk footprint 예측 가능.
- **Atomic rewrite via rename**: POSIX `rename`은 동일 filesystem 내 atomic.
  crash window는 step 2~3 사이로 한정 — 원본은 절대 손상 안 됨, `.tmp`만
  남고 다음 retention 호출이 명시적 throw로 알린다.
- **O_EXCL guard**: check-then-write race를 막는 진짜 가드. `pathExists` check
  는 빠른 fail에 쓰고, 실제 보호는 `open(tmp, "wx")`.
- **Zero new dep**: `node:fs/promises`만 사용.
- **슬라이스 격리**: `@/stream` 내부 파일, `@/observability`/`@/agent` import
  없음. Biome `noRestrictedImports`로 enforce (biome.json L145-167).

## 대안

- **시간 기반 TTL (Z일 전 row drop)**: 기각. traffic burst (예: bench run)
  에서 짧은 시간 안에 많은 row가 쏟아지면 cap이 의미 없음.
- **row-count cap (현재의 `maxLines`)**: 기각. row size 변동성에 무방비.
  큰 `tool_result` 한 줄이 disk를 폭증시킬 수 있음 (Codex 사례).
- **JsonlRecorder가 매 write마다 인라인 retention**: 기각. write hot path가
  매번 전체 파일을 walk하면 O(n²) — 별도 retention pass가 합리적.
- **로그 rotation (logrotate-style)**: 기각. 별도 파일이 누적되면 traversal/
  분석 도구가 다 깨짐 — single canonical jsonl이 RFC-0002 §5.2 trajectory
  invariant.
- **Lock file 도입**: 기각. 별도 ADR. 본 ADR은 retention pass 한 가지만
  책임. concurrent writer는 `.tmp` 존재로 detect → 명시 throw.

## 결과·트레이드오프

- **얻은 것**:
  - 정해진 disk footprint (cap = upper bound, 정확히 ≤ cap).
  - 예측 가능한 retention (newest-first 보존, gap 없음).
  - byte-accurate 보고 (test가 `expect(droppedBytes).toBe(X)`로 잠금 — ±
    tolerance 없음).
  - 19 unit + 2 integration test, all green. 2 MB synthetic file에 1 MB cap
    적용해서 정확한 prefix 보존 검증.
- **비용**:
  - 매 retention call이 전체 파일 read + write. 100 MB jsonl이면 약 200 MB
    I/O. 호출 빈도는 `RetentionPolicy.intervalMs`로 조절 (caller 책임).
  - dry-run mode가 있어 dashboard는 mutation 없이 압력 확인 가능 → I/O 부담
    은 retention 결정 시점에만.
  - retention 진행 중 (step 2 시작 ~ step 7 rename 직전) 다른 writer가 같은
    파일에 append하면, retention이 그 append를 못 본 결과로 마지막에 rename
    이 그 append를 지운다. 본 ADR 범위에서 concurrent writer 조정은 caller가
    책임 (예: `JsonlRecorder.close()` 후 retention 호출).

## 한계

- **(a) 동시 writer 조정 없음**: 위 비용 마지막 항목 참고. lock 파일은 별도
  ADR. 본 ADR은 retention pass 한 가지만 책임.
- **(b) memory footprint**: 전체 파일을 string으로 read. v3 default `maxLines`
  = 100k, row 평균 ~1 KB라 ~100 MB. streaming line reader는 별도 ADR로
  분리 (필요해질 때).
- **(c) rename 원자성은 동일 filesystem에서만**: caller가 `filePath`를 다른
  mount에 두면 rename이 fallback copy를 트리거할 수 있음 (Node fs 동작).
  retention 파일은 trajectory 파일 옆에 두므로 실제로는 same fs.
- **(d) busy error는 운영자 개입 요구**: silent retry 안 함. `.tmp` 발견 →
  throw → caller가 결정 (지우고 재시도, 또는 investigate). RFC §16의
  "ZERO swallowed errors" invariant.

## 불변식 영향

- **슬라이스 격리 유지**: `@/stream` 내부 신규 파일, `@/agent`/`@/observability`
  import 없음.
- **RFC 동기**: RFC §16 (no swallow / no fallback) 강화. RFC-0002 §5.2
  trajectory invariant 유지 — single canonical jsonl, 형식 변경 없음.
- **신규 npm dep 0**.
- **`JsonlRecorder` API breaking 없음**: 새 파일 add-only, 기존 클래스 미수정.
- **byte-exact accounting**: 모든 test가 `toBe()`로 ± tolerance 없이 잠금.
