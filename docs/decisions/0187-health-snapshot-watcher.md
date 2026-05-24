# ADR-0187: Health snapshot watcher — periodic re-emit + SIGHUP hot-reload

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0180 (file-based health snapshot — construction-time only; **direct parent**), ADR-0169 (observability-skipped warning — operator-facing sibling), ADR-0172 (`observability.wired.total` machine-readable gauge — sibling)
- **참조**: `src/observability/metrics/health-snapshot-watcher.ts`, `src/observability/metrics/health-snapshot.ts`, `tests/unit/observability-health-snapshot-watcher-hellgate.test.ts`

## 맥락

ADR-0180은 `~/.quanta/health.json` 을 **composition-time 1회**만 write한다 — 충분한 케이스가 많지만, 운영자 사용 패턴 3가지가 갭으로 남는다:

1. **K8s livenessProbe / shell loop / cron**가 30초마다 `cat health.json | jq ...` 한다. 그 사이 프로세스 안에서 slice가 wire-up되거나(plan-queue 늦 init) tear-down되면, 파일은 startup 상태에서 freeze — 운영자가 보는 건 stale.
2. **Config hot-reload** 시나리오. external orchestrator(Helm release, ConfigMap rollout)가 wiring을 토글한 뒤 SIGHUP을 던지는 게 POSIX 컨벤션. quanta는 신호를 무시 → 운영자가 재시작 외 refresh 수단 없음.
3. **Admin RPC / 테스트**에서 "지금 한 번 다시 write" 명령. construction-only 모델은 별도 export 없이는 불가능.

### Research grounding — Cursor 3-tier drift defense + systemd notify + K8s liveness

- `docs/analysis/경쟁사리뷰/code-agent-loop/cursor-localization.md §17` — Cursor의 watcher drift 방어는 **4단(in-band overlay + Rust debounce + 60s subtree-walk + handshake)**. 핵심 사상: *"FS watcher는 힌트이고 ground truth는 60초마다 *서버가 검증*한다"* — **이벤트 한 줄에 안 맡긴다**. 본 ADR은 같은 layering 사상을 file refresh로 옮긴다: timer(periodic) + signal(event) + manual(explicit). 채널 3개 → 어느 하나 빠져도 drift 복구.
- **systemd `notify` 소켓** — daemon이 heartbeat마다 well-known file을 갱신하는 standard pattern. 본 ADR의 interval-driven re-emit과 정확히 동일 구조.
- **Kubernetes livenessProbe `periodSeconds: 30`** — file-based probe의 *de facto* polling 간격. interval 기본값을 30_000ms로 고정해 K8s 운영자가 probe와 watcher cadence가 같다는 가정을 즉시 깔 수 있다.

**핵심 인사이트**: SOTA 어느 에이전트도 file-based health surface 자체를 안 노출하므로(ADR-0180에 기록), 그 위에 hot-reload 패턴을 얹는 것도 quanta first. 그러나 **layering 사상은 Cursor에서 학습**.

## 결정

신규 모듈 `src/observability/metrics/health-snapshot-watcher.ts` 도입. ADR-0180의 build/write 프리미티브를 재사용 (no copy) + 3채널 refresh를 stoppable handle 뒤로 캡슐화:

```ts
export interface WatcherOpts {
  readonly getBag: () => { readonly [K in keyof ObservabilityBag]: ObservabilityBag[K] | undefined }
  readonly snapshot?: HealthSnapshotOpts        // forwarded to writeHealthSnapshot
  readonly intervalMs?: number                  // default 30_000 (K8s liveness norm)
  readonly hotReloadOnSighup?: boolean          // default true
  readonly onSignal?: (sig: "SIGHUP", h: () => void) => void   // test seam
  readonly offSignal?: (sig: "SIGHUP", h: () => void) => void  // test seam
  readonly setInterval?: (h: () => void, ms: number) => unknown
  readonly clearInterval?: (h: unknown) => void
  readonly warn?: (msg: string) => void         // default noop
}

export interface WatcherHandle {
  stop(): void                  // idempotent: clearInterval + removeListener
  emitNow(): Promise<void>      // manual trigger; resolves AFTER write
}

export const startHealthSnapshotWatcher: (opts: WatcherOpts) => WatcherHandle
```

3채널 동작 사양:

| 채널 | 발화 trigger | 발화 빈도 | 보장 |
|---|---|---|---|
| **1 timer** | `setInterval(fire, intervalMs)` (default 30s) | 시간 기반 | watcher가 살아있는 한 항상 drift 복구 — 외부 trigger 0건이어도 OK |
| **2 SIGHUP** | `process.on("SIGHUP", fire)` (default on) | 외부 신호 | orchestrator/스크립트의 즉시 refresh — interval 기다릴 필요 없음 |
| **3 manual** | `handle.emitNow()` | admin/test | 결정적 await; resolves AFTER write completes |

**비교**: Cursor 17.2 — `(1) chat-turn overlay + (2) Rust debounce + (3) 60s subtree-walk + (4) handshake`. quanta는 4채널 중 (1) overlay는 file-write 도메인에 의미 없어 빼고(파일은 모델이 안 봄), (2) debounce는 watcher 자체가 light-touch이므로 생략, (3) interval은 채택(30s), (4) handshake는 manual `emitNow()`로 운영자가 RPC로 invoke. 갯수 ↓ 의미 동등.

### emitNow() 실패 모드

write 실패 시 watcher는 `warn(msg)` 호출 후 **내부 state는 보존**한다. 다음 interval/SIGHUP/manual 호출은 새로운 bag으로 재시도. 스냅샷은 *operator convenience*지 hot-path failure mode가 아니다 — 일시 EROFS/EACCES가 watcher를 죽이면 안 됨. 테스트 [8]이 이 invariant를 봉인.

### stop() 의 의미

- clearInterval + removeListener 둘 다 정확히 한 번.
- **idempotent**: 두 번째 stop()은 no-op.
- stop() **후에도** emitNow()는 살아있음 (primitive는 항상 유효; 자동 발화만 멈춤). 사용 사례: shutdown 중 마지막 1회 emit + 종료.

## Default-OFF

ADR-0180의 file 동작은 byte-identical로 유지. watcher는 **caller가 명시적으로 `startHealthSnapshotWatcher(...)` 호출할 때만** 살아난다. composition root (`withFullObservability`)는 본 ADR에서 자동 watcher 부착을 **하지 않는다** — 그건 별도 follow-up. 그래서 ADR-0180 시점 기존 bootstrap path는 import 0건 변화, 동작 0건 변화.

## Hellgate

`tests/unit/observability-health-snapshot-watcher-hellgate.test.ts` — **12 신규 case**:

| # | scope | case |
|---|---|---|
| 1 | A. interval | `intervalMs:1000` + fake setInterval → handler registered with 1000ms; ticking → write fires |
| 2 | A. interval | 기본 interval = 30_000 |
| 3 | A. interval | clearInterval called on stop() |
| 4 | B. SIGHUP | `hotReloadOnSighup:true` (default) → onSignal called for SIGHUP |
| 5 | B. SIGHUP | firing registered handler → emit |
| 6 | B. SIGHUP | `hotReloadOnSighup:false` → onSignal NOT called |
| 7 | C. emitNow | build snapshot from getBag() + write to snapshot.path |
| 8 | C. emitNow | write throws → warn called; subsequent emitNow still runs (state not poisoned) |
| 9 | C. emitNow | returns Promise resolving AFTER write completes |
| 10 | D. stop | stop() 두 번 → idempotent (no double-clear) |
| 11 | D. stop | after stop(), emitNow() still works manually |
| 12 | E. fresh bag | getBag changes between intervals → snapshot reflects latest state (no stale memoization) |

## Alternatives rejected

1. **`fs.watch` on the bag**. 거부 — bag은 in-memory object. file로 외부화돼있지 않으므로 `fs.watch`는 적용 불가.
2. **WebSocket push 채널**. 거부 — read-only health에 server + connection state는 over-engineering. file은 OS-level primitive (의존 0), WS는 binding + protocol + auth.
3. **SIGUSR1**. 거부 — POSIX hot-reload 컨벤션은 SIGHUP (nginx, dovecot, postgres). SIGUSR1은 application-defined이라 인터프리테이션 충돌. SIGHUP은 stable.
4. **CRON / job scheduler**. 거부 — 별도 scheduler 의존, lifecycle 결합도 ↑. interval은 in-process로 충분.
5. **ADR-0180 자체에 `refreshIntervalMs` 옵션 추가**. 거부 — composition-root `withFullObservability` 시그니처를 건드리면 8+ 호출 사이트 모두 영향. 본 ADR이 stoppable handle을 별 export로 두면 ADR-0180은 0 churn. composition root가 hot-reload을 *원하는* 경우 별도 follow-up에서 호출 추가.
6. **eventEmitter 기반 (`bag.on("change", ...)`)**. 거부 — bag은 plain object지 EventEmitter가 아님; 모든 slice owner가 emit을 추가하라는 cross-cutting 변경은 ADR-0180의 plane-clean 약속을 깬다. polling이 더 단순 + observability에 적합.

## Follow-up (이 ADR이 닫지 않는 것)

- **Change detection / no-op write skip**. 직전 snapshot과 byte-identical이면 write 생략 (Inode mtime preservation, 운영자 cron이 "변경된 파일만 alert"하는 패턴 지원).
- **Snapshot rotation**. 시간별 archive (`health.${ISO}.json`) — disk footprint 작아도 audit trail 필요한 운영자용.
- **Composition root 자동 부착**. `withFullObservability({ healthSnapshotWatcher: { intervalMs, ... } })` opt — 본 ADR은 primitive만, wire-up은 별 ADR.
- **`file mtime watcher`**. 외부 프로세스가 파일을 건드릴 때 fs.watch + emit (race 방지용 self-correction). 의미가 약해 deferred.

## SOTA matrix (좁은 갱신)

| Agent | 파일 health refresh | refresh 채널 | 비고 |
|---|---|---|---|
| Claude Desktop 1.7196 | n/a (file health 없음) | — | Sentry events |
| Cursor 3.2.16 | n/a (file health 없음) | — | in-process state |
| Codex Desktop 0.131 | n/a | — | OTel push |
| **quanta (ADR-0180)** | 1회 (composition-time) | construction | freeze 위험 |
| **quanta (본 ADR)** | **periodic + SIGHUP + manual** | **3-channel layering** | **drift-resistant** |

= "file-based health surface 위에 3-channel hot-reload (timer + signal + manual)를 얹은 첫 single-process agent observability artifact." Cursor의 4-tier drift defense 패턴을 file refresh 도메인으로 옮긴 적용.
