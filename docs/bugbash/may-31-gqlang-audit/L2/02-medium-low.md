# L2 — Medium/Low findings

3개 신뢰 구간으로 분리: **(A) 확정 Medium**, **(B) 확정 Low** (1라운드 verifier 정상 처리), **(C) 미검증 Medium** (verify 단계 rate-limit 장애로 미검증 — 같은 HIGH 환각률 ~45% 가정 시 신뢰도 낮음, 재검증 필요).

---

## (A) 확정 Medium

### H3. `continue_from` owner_token gate 부재 → cross-agent 정보유출 (isolation)

- **심각도:** Medium · **위치:** [agent-tool.ts:151](../../../../src/subagent/agent-tool.ts#L151) · **상태:** 재검증 confirmed/medium

```typescript
// agent-tool.ts:151-156 — token 검증 없이 task_id만으로 finalText 반환
const resolvePriorAttempt = (registry: TaskRegistry, continueFrom: string): string | undefined => {
  const rec = registry.get(continueFrom)
  if (!rec) return undefined
  return rec.result?.finalText && rec.result.finalText.length > 0 ? rec.result.finalText : undefined
}
```

대비 — `task_stop`은 owner_token gate 보유:

```typescript
// task-tools.ts:157-161
stop(id: string, ownerToken: string): ... {
  const expected = this.owners.get(id)
  if (expected === undefined || ownerToken !== expected) return "denied"
```

**영향:** settled task의 finalText를 task_id(UUID)만 알면 다른 lineage/session child가 탈취 가능. running/중간상태는 불가, settled 요약 한정 + UUID 노출 전제라 Medium. **수정:** `continue_from`을 owner_token gate 뒤로, 또는 같은 부모 lineage/session으로 조회범위 한정.

---

## (B) 확정 Low (1라운드 verifier 통과)

> 전부 default-OFF/미배선 seam이거나 자가치유 경로라 Low. 대부분 1줄 수정. 배선 전 봉합 권장.

### H5(부분). owned/forbidden surface 기계적 미강제 (isolation, partial)
[subagent-runner.ts:176](../../../../src/agent/subagent-runner.ts#L176) — surface가 seed-prompt 텍스트일 뿐 강제 레이어 없음은 **사실**(재검증 partially-confirmed). 단 1라운드의 "concurrent race-write"는 과장 — 각 child 독립 envelope·직렬화로 FS race 아닌 **의미적 coordination 위험**. advisory boundary로 설계됨. → 강제 필요 시 child runner의 write/edit 경계에서 ownedSurface를 write-jail로.

### H10(부분). thread-tools dead code (dead-code, low)
[thread-tools/index.ts](../../../../src/agent/thread-tools/index.ts) — importer 0, [types.ts:1232](../../../../src/agent/types.ts#L1232) type-only 참조뿐, 인스턴스화/set 경로 없음. (mention-injection/mention-runner/auto-background은 실제 wired — 03 참조.) <200 LOC 유지부채. → 배선 or 삭제 결정.

### L1. mutating-recoverable cache-hit가 shadowCommit 없으면 복원 없이 replay (silent-error)
[tool-replay.ts:236](../../../../src/agent/subagent-resume/tool-replay.ts#L236) — 복원 분기가 `shadowCommit !== undefined` 게이트라 shadowCommit 없는 record는 bare replay-from-cache로 fall-through. 모듈 불변식 위반. *데이터 손실 클래스 — default-OFF여도 배선 전 봉합.* → halt push.

### L2. saveLiveHandle이 store.save 실패 삼키고 in-memory 스냅샷 삭제 (error-swallow)
[hydrating-scheduler.ts:197](../../../../src/agent/subagent-persistence-store/hydrating-scheduler.ts#L197) — fork-time save throw(디스크풀/EPERM) 시 영속 실패 + 로그/메트릭 0. → 에러 surface, save throw 시 delete 생략.

### L3. 하이드레이트된 running handle await가 stale 스냅샷으로 즉시 resolve (cancellation)
[hydrating-scheduler.ts:254](../../../../src/agent/subagent-persistence-store/hydrating-scheduler.ts#L254) — cross-process running handle await가 non-terminal running 즉시 반환 → `while(running) await` busy-spin. → cross-process running이면 null/re-load.

### L4. load/delete가 첫 workspace 매치로 해소 — workspace scoping 무시 (isolation)
[jsonl-store.ts:136](../../../../src/agent/subagent-persistence-store/jsonl-store.ts#L136) — id-walk 첫 매치 반환, workspace 경계 cross. 64-bit id라 충돌 극희박 + 현 consumer 미호출. → load/delete에 workspace 스레딩.

### L5. background scheduler가 spec.workspace를 runner에 미전달 (isolation)
[subagent-background.ts:236](../../../../src/agent/subagent-background.ts#L236) — workspace가 수집·영속·안전검사엔 쓰이나 runner엔 미전달 → 자식이 부모 cwd 실행. → SubagentRequest에 workspace 전달.

### L6. fork()의 unawaited running-save가 completion-save 뒤에 착지 (race)
[hydrating-scheduler.ts:233](../../../../src/agent/subagent-persistence-store/hydrating-scheduler.ts#L233) — 두 unordered append, 빠른 settle 시 running이 마지막 라인 → readLatestHandle이 완료 handle을 running으로 보고(stale label). → running-save await 또는 monotonic seq.

### L7. interrupted handle이 cap-exceeded 재fork에서 영구 interrupted + 매 sweep 재시도 (race)
[resumer.ts:287](../../../../src/agent/subagent-resume/resumer.ts#L287) — cap+1 fork throw 시 status 미변경 → 다음 sweep 재발행. 자가치유. → transient cap vs hard fail 구분.

### L8. applyResume가 fork 실패 전 비가역 shadow-ODB 복원 수행 (cancellation)
[resumer.ts:248](../../../../src/agent/subagent-resume/resumer.ts#L248) — restoreToCommit(트리 rewind)을 fork 전 실행 → cap throw 시 트리 rewind됐는데 자식 미기동, 롤백 없음. → 슬롯 선점/fork 선시도 후 복원.

### L9. JSONL per-handle 파일 무한 성장 — orphaned running 파일 prune 면제 (leak)
[jsonl-store.ts:217](../../../../src/agent/subagent-persistence-store/jsonl-store.ts#L217) — compaction 없음, prune이 running 파일 무조건 skip. 부팅 hydration이 dead-pid running을 interrupted로 재분류해 자가치유. → compaction + dead-pid reclaim.

### L10. findHandleFileAcrossWorkspaces가 full readFile을 존재 probe로 사용 (code-quality)
[jsonl-store.ts:147](../../../../src/agent/subagent-persistence-store/jsonl-store.ts#L147) — probe가 전체 파일 로드 후 버림, load가 재독 → 이중 full read. KB급이라 비용 미미. → access/stat probe.

### L11. jsonl-store.prune()이 Date.now() 하드코딩 (code-quality)
[jsonl-store.ts:287](../../../../src/agent/subagent-persistence-store/jsonl-store.ts#L287) — sibling 전부 clock 주입인데 단독 하드코딩 → 비결정 테스트. → `now?: () => number` opt.

### L12. disk clear()가 lock release를 await 안 하고 rm과 경합 (race)
[disk-store.ts:502](../../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts#L502) — release fire-and-forget이라 "release BEFORE rm" 주석 미강제. ensureDir+append-only 자가치유, swallowed ENOENT benign. → id별 release await 후 rm.

---

## (C) 미검증 Medium (verify 단계 장애 — 재검증 필요)

> ⚠️ 아래 M1~M21은 1라운드 적대 패스가 보고했으나 **skeptic verify가 rate-limit으로 실패**해 코드 재확인 못 함. HIGH 재검증에서 환각률 ~45%였으므로 **이 목록도 절반은 오탐/강등 가능**. 수정 착수 전 H1~H11과 같은 독립 재검증 권장.

- **M1.** [handlers-6.ts:506](../../../../src/subagent/handlers-6.ts#L506) `leak` — close_agent가 소유 PTY 미kill(ptyTable 배선만, 본문 미사용).
- **M2.** [handlers-6.ts:277](../../../../src/subagent/handlers-6.ts#L277) `cancellation` — attach된 PTY가 turn 취소 넘어 생존(고아 자식).
- **M3.** [handlers-6.ts:415](../../../../src/subagent/handlers-6.ts#L415) `cancellation` — spawn/launchBackground가 floating promise로 runner 발사, 종료 시 미정리.
- **M4.** [handlers-6.ts:480](../../../../src/subagent/handlers-6.ts#L480) `silent-error` — wait_agent가 settle+evict 동시 turn으로 완료 task를 'disappeared'로 보고(결과 silent 손실).
- **M5.** [handlers-6.ts:570](../../../../src/subagent/handlers-6.ts#L570) `silent-error` — send_input delete-before-invoke, receiver throw 시 채널 소실 영구 wedge.
- **M6.** [agent-tool.ts:263](../../../../src/subagent/agent-tool.ts#L263) `leak` — foreground `fg_<uuid>` registry 미등록 → 고아 .subagent-state 파일 누적.
- **M7.** [default-runner.ts:7](../../../../src/agent/delegation-runner/default-runner.ts#L7) `dead-code` — runBoomerang import만 하고 미호출, drive 결과 verbatim 반환(정규화 우회). *(재검증 H2에서 default-runner는 별 시스템으로 확인됨 — 이 항목 재확인 시 우선순위 높음)*
- **M8.** [subagent-runner.ts:92](../../../../src/agent/subagent-runner.ts#L92) `cancellation` — drain()이 Promise.all로 첫 reject에 rethrow, 나머지 await 포기(고아 자식). → allSettled.
- **M9.** [default-runner.ts:30](../../../../src/agent/delegation-runner/default-runner.ts#L30) `cancellation` — drive 시작 후 abort 무시(race에 abort leg 없음).
- **M10.** [sqlite-adapter/gc.ts:328](../../../../src/agent/session-resource-registry/sqlite-adapter/gc.ts#L328) `leak` — sweep가 2번째 연결로 경합, RESTART/TRUNCATE SQLITE_BUSY인데 PASSIVE는 무조건 checkpointed=true(메트릭 오도).
- **M11.** [dispatch-6.ts:145](../../../../src/subagent/dispatch-6.ts#L145) `silent-error` — close_agent ownerToken 부재가 host-authority forceStop로 silent 승격(S17 우회). *(dispatch-6는 H4에서 dead-code 확인 — 영향 재평가 필요)*
- **M12.** [file-lock.ts:461](../../../../src/agent/session-resource-registry/disk-adapter/file-lock.ts#L461) `leak` — holder-map clear 후 release가 .lock 파일 미unlink(다음 acquire 30s 대기).
- **M13.** [in-memory-registry.ts:97](../../../../src/agent/session-resource-registry/in-memory-registry.ts#L97) `error-swallow` — catch-fallback이 미등록 pair 반환, same-ref 불변식 위반(분기된 store).
- **M14.** [disk-store.ts:275](../../../../src/agent/session-resource-registry/disk-adapter/disk-store.ts#L275) `dead-code` — rewriteCacheFile no-op, invalidate가 디스크 미러 무효 → 재시작 시 무효화 엔트리 부활(SQLite sibling은 DELETE 정상 — drift).
- **M15.** [identity-pool/default-minter.ts:18](../../../../src/agent/identity-pool/default-minter.ts#L18) `dead-code` — identity-pool 슬라이스 src 소비자 0.
- **M16.** [lane-manager/default-manager.ts:66](../../../../src/agent/lane-manager/default-manager.ts#L66) `dead-code` — lane-manager 소비자 0 (H9 버그가 여기 잠재 — 확정됨).
- **M17.** [fork-session/default-forker.ts:231](../../../../src/agent/fork-session/default-forker.ts#L231) `dead-code` — branchId 발행/반환만, ParentLink/BranchInfo에 필드 없어 listBranches 복구 불가(write-only).
- **M18.** [thread-tools/in-memory-store.ts](../../../../src/agent/thread-tools/in-memory-store.ts) `leak` — threadId당 무제한 Map 성장, LRU/prune 없음. (H10에서 thread-tools dead 확인 — 영향 낮음.)
- **M19.** [mention-injection/symbol-resolver.ts](../../../../src/agent/mention-injection/symbol-resolver.ts) `error-swallow` — LSP 실패를 빈 결과로 삼킴('not found'와 구분 불가). (mention-injection은 wired — 재검증 우선순위 높음.)
- **M20.** [mention-injection/resolver.ts](../../../../src/agent/mention-injection/resolver.ts) `solid` — concrete adapter `new()`, 포트 미주입(DIP 위반).
- **M21.** [auto-background/stuck-detector.ts](../../../../src/agent/auto-background/stuck-detector.ts) `code-quality` — 주입 clock 없는 wall-clock + 미검증 임계값(no-heuristics 불변식 충돌).
