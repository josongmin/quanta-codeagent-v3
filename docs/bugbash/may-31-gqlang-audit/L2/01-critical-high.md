# L2 — Critical/High 확정 findings

> 전부 독립 재검증 워크플로우(Explore agent, 소스 직접 재독)로 confirmed. H6/H7은 동일 root cause.

## H6+H7. disk-store `lastTouched` 미갱신 → 활성 세션 silent data loss (silent-error / race)

- **심각도:** High (라이브 — 단 `QUANTA_SESSION_REGISTRY_DISK_DIR` env-gated)
- **분류:** silent-error, race
- **위치:** [disk-store.ts:210](../../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts#L210) (append), [disk-store.ts:253](../../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts#L253) (getOrBuild), [gc.ts:184](../../../../src/agent/session-resource-registry/disk-adapter/gc.ts#L184) (TTL eviction)
- **상태:** 확정 (재검증 confirmed/high)

### 근거

```typescript
// disk-store.ts:210-220  — append()는 in-memory inner.append만 하고 lastTouched 미갱신
append(event: TypedHistoryEvent): void {
  inner.append(event)
  const line = serializeEventLine(event)
  void lockReady.then((lock) => {
    if (lock === null) return
    return ensureDir(sessionDirOf(cfg, sessionId)).then(() => appendFileSafe(eventsPath, line))
  })
}
```

`lastTouched` / `writeMeta` 갱신은 오직 `getOrCreate` 경로에만 존재:

```typescript
// disk-store.ts:414-415, 423, 460 — getOrCreate에서만 갱신
if (hit !== undefined) { hit.lastTouched = t }   // :415 (in-memory)
return writeMeta(cfg, sessionId, t)               // :423 / :460 (disk meta.json)
```

`getOrBuild`(cache 미러, :253-270)도 동일하게 `lastTouched` 미갱신.

GC sweep은 meta.json의 `lastTouched`만 보고 evict:

```typescript
// gc.ts:184 — meta.json 기준 TTL 판정 후 디렉토리 전체 removeSession
if (meta !== null && currentNow - meta.lastTouched >= ttlMs) { ... removeSession(sessionDir) }
```

### 영향

`getOrCreate` 1회 후 수천 건 `append()`만 하는 세션(가장 흔한 패턴)은 `lastTouched`가 생성시각에 **동결**. TTL 경과 후 sweep이 **활성 세션 디렉토리를 `rm -rf`** →
1. in-memory `entries` Map에는 엔트리 생존
2. 다음 `append()` → `ensureDir`가 빈 디렉토리 신규 생성 → 빈 `events.jsonl`에 미러
3. **삭제된 디렉토리의 기존 이벤트/캐시 영구 손실, 에러 0건** (모든 연산이 재생성된 디렉토리에서 성공)

문서 주석(disk-store.ts:11 "in-memory cache hit ⇒ touch lastTouched")이 의도를 명시하나 append 경로가 이행 안 함.

### 수정

`append()`와 `getOrBuild()` 미러 경로에서 in-memory `lastTouched` 갱신 + (throttle하여) `writeMeta` 호출. 또는 GC가 meta.json 대신 `events.jsonl`의 mtime으로 freshness 도출. 추가로 sweep에 in-process `entries` id를 do-not-evict 허용목록으로 전달하면 이중 안전망.

### 재현/검증

`tests/.../disk-store-active-session-gc.hellgate.test.ts` — getOrCreate 1회 + N append + 시계 ttlMs 전진 + sweep → 기존 이벤트 보존 단언.

---

## H9. lane-manager abort 시 park된 waiter Promise 영구 deadlock (cancellation)

- **심각도:** High (잠재 — `defaultLaneManager` 미instantiate, dead-wired → 현재 런타임 영향 0)
- **분류:** cancellation
- **위치:** [default-manager.ts:85](../../../../src/agent/lane-manager/default-manager.ts#L85) (waiter park), [default-manager.ts:90](../../../../src/agent/lane-manager/default-manager.ts#L90) (releaseSlot), [default-manager.ts:100-104](../../../../src/agent/lane-manager/default-manager.ts#L100) (managerCtrl abort)
- **상태:** 확정 (재검증 confirmed/high, 단 dead-wired 명시)

### 근거

```typescript
// default-manager.ts:76, 85 — queue-mode에서 plain Promise를 waiters에 park
const waiters: Array<() => void> = []
...
await new Promise<void>((resolve) => waiters.push(resolve))   // :85 — signal과 무연결

// :90-94 — releaseSlot만이 park된 Promise를 settle
const releaseSlot = (): void => { running -= 1; const next = waiters.shift(); if (next !== undefined) next() }

// :100-104 — parent abort → managerCtrl.abort()만 호출, waiters drain 없음
const managerCtrl = new AbortController()
if (parentSignal !== undefined) {
  if (parentSignal.aborted === true) managerCtrl.abort()
  else parentSignal.addEventListener("abort", () => managerCtrl.abort(), { once: true })
}
```

`managerCtrl.abort()` 발화 시 `waiters` 배열을 drain/reject하는 코드가 **전무**. park된 Promise는 sibling 완료(releaseSlot)로만 깨어남.

### 영향

lane이 `maxConcurrency` 초과로 queue-mode 진입 + parent abort 발생 시: park된 Promise가 영구 미settle → `acquireSlot()`가 `await`에서 영구 정지 → `runLane()` 미반환 → handle.promise 미settle → `awaitAll()`의 `Promise.all`이 **영구 hang**. `awaitAll`에만 timeout이 있고 `acquireSlot`의 waiter Promise 자체엔 timeout 없음 → 복구 불가.

현재 `defaultLaneManager`가 production에서 instantiate되지 않아(테스트 외 사용처 0) 런타임 영향은 없음. **배선되는 순간 cascade-abort 계약(Contract 3) 위반 → 관측 가능한 hang.**

### 수정

`acquireSlot`을 abort-aware로: waiter park를 `managerCtrl.signal`과 race시키고, abort 시 `waiters`를 전부 drain하며 park된 Promise를 reject(또는 LaneResult `aborted`로 resolve). H8과 같은 함수라 함께 점검(H8은 오탐).

### 재현/검증

`tests/.../lane-manager-abort-drains-waiters.hellgate.test.ts` — maxConcurrency=1로 2 lane 큐잉 후 parent abort → `awaitAll`이 유한시간 내 settle 단언.
