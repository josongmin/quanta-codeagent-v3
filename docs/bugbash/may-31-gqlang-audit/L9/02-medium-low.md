# L9 — MEDIUM / LOW / Info findings + positive controls

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준. 적대 패스가 confirmed/신규로 표시한 것 위주.

---

## 🟡 MEDIUM

### M1. OTLP counter·histogram이 per-sample delta를 CUMULATIVE temporality로 전송
- **위치:** [src/observability/otel-exporter.ts:318-326](../../../../src/observability/otel-exporter.ts#L318), 341 · **상태:** [적대-확인] (1차는 counter만, 적대가 histogram 추가)
- **근거:** 각 counter sample을 `asDouble:m.value`(delta)로 `aggregationTemporality:2`(CUMULATIVE)+`isMonotonic:true` dataPoint로 직렬화. CUMULATIVE은 "프로세스 시작 이후 running total" 의미라 per-event delta를 먹이면 spec-correct 백엔드가 reset/double-count로 오표시. histogram(341)도 동일(single-observation `count:1`). 모든 카운터가 wire에서 조용히 손상.
- **수정:** per-sample emission은 `aggregationTemporality:1`(DELTA), 또는 exporter가 누적.

### M2. gauge 첫 관측값 0이 영영 export 안 됨
- **위치:** [src/observability/metrics/otel-sink.ts:277](../../../../src/observability/metrics/otel-sink.ts#L277) · **상태:** [적대-확인]
- **근거:** gauge→UpDownCounter delta 브리지가 `prev = get(k) ?? 0`. 첫 sample이 `value===0`이면 `delta=0`, `if(delta===0)return`이 `add` 전에 단락 → collector가 그 시리즈를 비-0 도착 전까지 못 봄. `==0`으로 알람 거는 게이지([observability-helper.ts:191](../../../../src/observability/metrics/observability-helper.ts#L191) `observability.wired.total{slice}=0`)가 OTel 백엔드에서 invisible.
- **수정:** 첫 sample은 delta=0이어도 emit(또는 sentinel로 "미관측" 구분).

### M3. health-snapshot-watcher 타이머 `.unref()` 미적용 → 프로세스 exit 차단
- **위치:** [src/observability/metrics/health-snapshot-watcher.ts:190-193](../../../../src/observability/metrics/health-snapshot-watcher.ts#L190) · **상태:** [적대-신규]
- **근거:** 테스트 seam 미주입 시 production 분기가 `setInterval(fire, intervalMs)`를 호출하고 핸들 저장하지만 `.unref()` 안 함. 30s liveness 타이머가 이벤트 루프를 pin → CLI one-shot/`stop()` 잊은 테스트가 exit 거부. SIGHUP 리스너(205)도 동일. 다른 타이머-소유 슬라이스는 unref하는데 이것만 빠짐.
- **수정:** production 타이머에 `.unref()`.

### M4. session digest가 키 순서 의존 → benign 재직렬화에 false-tamper
- **위치:** [src/session/import-export.ts:347-361](../../../../src/session/import-export.ts#L347) · **상태:** [적대-확인]
- **근거:** v2 무결성 digest가 `sha256(JSON.stringify(body))` — 키 정렬 없음. exporter의 `cloned` 키순서로 계산되므로, 재직렬화 프록시·Postgres `jsonb`(키 reorder)·hand-build envelope를 거치면 멀쩡한 body에 `digest-mismatch`. canonical serializer(`stringifyCanonical`, [envelope-encoder.ts:51](../../../../src/session/envelope-encoder.ts#L51))가 100줄 옆에 있는데 안 씀. (GH delivery fallback [github/event-payload.ts:227](../../../../src/integrations/github/event-payload.ts#L227)도 같은 패턴.)
- **수정:** digest를 `stringifyCanonical` 위에서 계산.

### M5. session `reconcileIndexFromMeta`가 매 load마다 O(전체 세션)
- **위치:** [src/session/store.ts:242-263](../../../../src/session/store.ts#L242) · **상태:** [적대-확인]
- **근거:** 모든 `loadSessionById`가 `reconcileIndexFromMeta` → `listSessions({includeArchived:true})`로 `index.jsonl` 전체 read+parse 후 `.find` 한 항목. 주석의 "bounded(one session)"은 write 기준이고, 한 세션 load 비용이 O(전 세션)+중복 디스크 read. 큰 index에서 per-load 세금.
- **수정:** load 핫패스에서 단일 meta lookup(전체 list 회피), reconcile는 주기/background.

### M6. session index upsert 실패 시 snapshot-ahead-of-index (보상 없음)
- **위치:** [src/session/store.ts:229-230, 379-380](../../../../src/session/store.ts#L229) · **상태:** [적대-신규]
- **근거:** 모든 mutator가 `writeSessionFile` 후 `upsertMeta`. `upsertMeta`가 throw(index rename EACCES)하면 snapshot JSON은 이미 commit됐는데 예외가 전체 save 실패처럼 전파 → 세션이 디스크엔 있으나 listing엔 없음. reconcile-on-load 자가치유는 그 id를 누가 load해야만 fire하는데 listing-driven UI는 안 listed라 영영 안 함.
- **수정:** snapshot+meta 쌍을 보상 트랜잭션으로 묶거나, upsert 실패를 부분-성공으로 surfacing.

### M7. scheduler at-least-once 중복 mutating dispatch
- **위치:** [src/scheduler/runtime.ts:194-209](../../../../src/scheduler/runtime.ts#L194) · **상태:** [적대-확인 (self-documented)]
- **근거:** `enqueueUserMessage`(step4, 179)가 `store.save`(step5, 197)보다 먼저. 사이 크래시면 anchor 미advance로 다음 tick에 mutating 프롬프트 재dispatch. ADR이 "at-least-once by design"이라 하나 mutating agent prompt엔 idempotency key가 없어 실위험.
- **수정:** dispatch에 idempotency key 전달, 또는 persist-before-dispatch.

### M8. scheduler 동일-ms run id UNIQUE 충돌 → tx rollback → 재발화
- **위치:** [src/scheduler/automation-engine/sqlite.ts:162-163, 317-318](../../../../src/scheduler/automation-engine/sqlite.ts#L162) · **상태:** [적대-신규]
- **근거:** `defaultIdAlloc`가 `run-${automationId}-${firedAt}` / `inbox-...-${firedAt}` (둘 다 PK). 재진입 overlapping tick(M11) 또는 manual+timer가 같은 `firedAt` ms에 발화하면 insert가 UNIQUE 충돌 → `db.transaction()` 전체 rollback → markRun이 `io-failed` 반환 → 핸들러는 이미 실행됐는데(ticker.ts:99) run 미기록·`nextRunAt`/`fireCount` 미advance → **다음 tick 재발화**. in-memory 엔진은 같은 id 스킴이나 uniqueness 미강제(`push`로 중복) → 두 어댑터가 same-ms refire에서 divergence(byte-equal 패리티 깨짐).
- **수정:** id에 monotonic counter/nonce 추가. in-memory도 동일 유니크 가드로 패리티 유지.

### M9. scheduler JSONL store 동시성 race + load 에러 삼킴
- **위치:** [src/scheduler/store-jsonl.ts:259-263](../../../../src/scheduler/store-jsonl.ts#L259), 296-303 · **상태:** [적대-확인]
- **근거:** (a) `load()`가 non-ENOENT(EACCES/partial-IO)를 `[]`로 매핑, no log → 권한 오류가 "no automations"와 구분 불가. (b) `delete()` tombstone append 실패를 empty `catch{}`로 삼키고 success 반환 → 사용자는 삭제됐다 믿지만 매 tick 계속 firing. (c) `appendFile` fsync/lock 없음 → concurrent runtime이 torn-write/lost-update.
- **수정:** non-ENOENT는 sink/throw로 surfacing. delete 실패는 caller에 전달. 워크스페이스 advisory lock 또는 단일-writer 강제.

### M10. scheduler error 영속 실패가 이중 침묵 (NO-THROW 관측 약속 위반)
- **위치:** [src/scheduler/runtime.ts:222-233](../../../../src/scheduler/runtime.ts#L222) (`persistError`) · **상태:** [적대-신규]
- **근거:** 모듈 헤더는 "모든 실패는 sink로 surfacing" 약속이나 `persistError`의 `store.save` 실패를 empty `catch{}`로 삼킨다. 주석 "다음 load 시도의 failure에서 관측됨"은 거짓 — load 실패도 `[]` 침묵(M9). error-state save 실패 시 디스크 상태 error 전이 안 됨 + 아무 emit 없음 → `active`로 남아 실패 model probe를 매 tick 무한 재발화.
- **수정:** save 실패를 sink로 emit. 상태/이벤트 일관성 보장.

### M11. scheduler 재진입 tick 가드 부재 → 더블 dispatch
- **위치:** [src/scheduler/runtime.ts:99-101](../../../../src/scheduler/runtime.ts#L99) + [src/agent/loop-helpers.ts:380-395](../../../../src/agent/loop-helpers.ts#L380) · **상태:** [적대-확인]
- **근거:** `setInterval(()=>void tickOnce())`에 in-flight 가드 없음. 핸들러(awaits enqueue)가 `tickIntervalMs` 초과하면 tick 중첩 → 두 `tickScheduler`가 같은 due row를 `markRun` 전에 select(엔진에 next↔markRun 락 없음) = 더블 dispatch. M8과 복합.
- **수정:** `inFlight` boolean 가드(이전 tick 완료 전 skip).

### M12. storage shadow-odb cross-process `registerHead` lost-update
- **위치:** [src/storage/shadow-odb/default.ts:335-349, 406-445](../../../../src/storage/shadow-odb/default.ts#L406) · **상태:** [적대-신규]
- **근거:** `serialize` mutex가 factory-local `Map`(317) 기반 = in-process only. 같은 워크스페이스를 가리키는 두 프로세스가 on-disk shadow `.git`은 공유하나 chain은 안 함. `registerInner`는 `add -A`→`commit`→`rev-parse`→`update-ref` 4-step 트랜잭션인데 cross-process 락 없음(git의 `index.lock`은 단일 sub-command만 보호). 두 `update-ref SHADOW_LAST_REF`가 last-writer-wins로 race → 한 스냅샷 ref 소실.
- **수정:** `.git` 위 flock/`O_EXCL` 락파일로 4-step 트랜잭션 직렬화.

### M13. storage shadow-odb cleanup이 cap을 under-enforce
- **위치:** [src/storage/shadow-odb/cleanup.ts:21-44, 75-94](../../../../src/storage/shadow-odb/cleanup.ts#L21) · **상태:** [적대-확인] ("가장 날카로운")
- **근거:** `dirSize`가 readdir/stat 실패 시 `0` 반환, `evictLru`가 `fs.rm` 실패를 empty catch. 읽기 불가 subtree가 0바이트로 계산 → `total` under-count → LRU cap 조용히 미달 적용: store가 `maxBytes` 초과해도 evictLru는 under cap이라 믿고 아무것도 evict 안 함. 단순 로그 갭이 아니라 조용한 correctness drift.
- **수정:** dirSize 실패를 0이 아닌 "unknown"으로 전파 → 보수적으로 eviction 트리거 또는 경고.

### M14. migration import 로그 stale-lock 영구 self-DoS
- **위치:** [src/migration/persistence.ts:57-83](../../../../src/migration/persistence.ts#L57) · **상태:** [적대-확인]
- **근거:** lock을 `writeFile(lock, pid, {flag:"wx"})`로 만들고 `finally`에서 제거. SIGKILL/하드 크래시가 acquire와 finally 사이에 나면 lock 파일 영구 잔존 → 이후 모든 `appendImportLog`가 `ImportLogBusyError` 무한. PID를 쓰지만 읽지 않음(liveness 체크 의도만 있고 미구현). 비정상 종료 후 import 로그 영구 self-DoS.
- **수정:** lock 획득 시 기록된 PID의 liveness(`kill -0`)/mtime TTL 확인 후 stale이면 reclaim.

### M15. git cloud-snapshot 사이즈 캡 fail-open
- **위치:** [src/git/cloud-branch-snapshot.ts:450-453](../../../../src/git/cloud-branch-snapshot.ts#L450), 460-461 · **상태:** [적대-확인] (미배선-잠복)
- **근거:** `estimateDirtyBytes`가 `git diff --numstat` 비-0 exit 시 `0` 반환 → 500MB 캡이 트리 상태가 이상한(=거대일 가능성 높은) 바로 그 경우에 fail-open. 바이너리는 flat `200×200=40KB`로 계산 → 600MB 바이너리(캡 존재 이유)가 통과. `snapshotDirtyToCloudBranch`는 현재 production 미배선이라 blast radius 잠복.
- **수정:** probe 실패는 캡 초과로 간주(fail-closed). 바이너리는 `git cat-file`/stat로 실제 크기.

### M16. git cloud-snapshot happy-path checkout-restore 실패 무시
- **위치:** [src/git/cloud-branch-snapshot.ts:344](../../../../src/git/cloud-branch-snapshot.ts#L344) · **상태:** [적대-확인]
- **근거:** push 후 `git checkout <originalRef>`의 `GitProcessResult` exit code를 통째 무시하고 `{branch,sha}` success 반환. checkout 실패(stash pop 잔여 conflict 등) 시 작업트리가 스냅샷 브랜치에 남은 채 success 보고 — "원래 브랜치 복귀" 계약 위반. unwind 경로와 달리 이건 success 경로라 실패가 invisible.
- **수정:** restore 결과 검사, 실패 시 error/경고 surfacing.

### M17. MCP skybridge가 정책 버리고 `sandboxApplied:true` 보고
- **위치:** [src/mcp/skybridge/lima-microvm.ts:252, 88-137](../../../../src/mcp/skybridge/lima-microvm.ts#L252) (apple-vz는 compile 단계 자체 없음) · **상태:** [적대-확인]
- **근거:** `spawn`이 `compileLimaConfig`에서 `{runArgs}`만 구조분해하고 `limayaml`(mounts/memory/networks) 폐기. `ensureVmRunning`은 `lima start <vm>`만 — config 파일 안 씀. `hostReadAllowlist`/`hostWriteAllowlist`/`memoryMb`/`networkAllowlist`가 guest에 안 닿는데 핸들은 `sandboxApplied:true` 무조건 반환 → honesty 계약 위반("isolation 적용했다"는데 정책 미적용). apple-vz는 compile 단계조차 없어 더 심함.
- **수정:** `limayaml`을 실제 config로 적용하거나, 정책 미적용 시 `sandboxApplied:false`+`degradeReason` 정직 보고.

### M18. ipc — 다수 (commandStates 누수 / stdio error 미관측 / control version 미검증)
- **위치:** [src/ipc/session/bridge.ts:277](../../../../src/ipc/session/bridge.ts#L277) · [src/ipc/transports/stdio.ts:95](../../../../src/ipc/transports/stdio.ts#L95) · [src/ipc/session/codec.ts:72](../../../../src/ipc/session/codec.ts#L72) · **상태:** [적대-신규/확인]
- **근거:** (a) `commandStates` map이 command별 insert만, evict 없음 → long-lived 세션(daemon)에서 무한 증가 + dedup 윈도우가 bounded replay 윈도우와 divergence. (b) stdio transport가 `"data"`만 구독 → `'error'`/`'end'`/`'close'` 미관측 → broken pipe/dead partner가 조용히 drop, half-open peer가 `peers`에서 안 reap. (c) `decodeConnectMessage`/`decodeRejectedMessage`가 `envelope.version`을 안 본다(sibling `@/protocol/session` codec은 `bad_version` reject) → control frame이 negotiation hole.
- **수정:** commandStates에 cap/prune. stdio에 error/end 핸들러 + peer 정리. control decode에 `isSessionProtocolVersion` 가드.

---

## 🔵 LOW / Info (선별)

- **observability**: jsonl-sink `appendFileSync` per-sample no-fsync, 큰 라인 inter-process tear([jsonl-sink.ts:34](../../../../src/observability/metrics/jsonl-sink.ts#L34)) · cache-metrics decorator가 inner를 double-evaluate(`peek`+real, recency 교란)([cache-metrics-decorator.ts:40](../../../../src/observability/codex-r2-metrics/cache-metrics-decorator.ts#L40)) · coverage `generatedAt:Date.now()` 5파일 clock 미주입 → 리포트 해시 비결정 · coverage V8-shape/line-math 4어댑터 copy-paste · cost-dashboard stopReasons 비정렬 출력.
- **session**: index-store 읽기 에러 → 빈 map → 다음 upsert가 전체 listing wipe([index-store.ts:31](../../../../src/session/index-store.ts#L31)) · `forkSession`이 JSONL rail 미복사인데 rewind.ts는 "full-state clone" 광고([store.ts:348](../../../../src/session/store.ts#L348)) · `archiveSession` write-then-delete 크래시 창([store.ts:298](../../../../src/session/store.ts#L298)) · git-fingerprint abort를 failure와 동일 취급([git-fingerprint.ts:79](../../../../src/session/git-fingerprint.ts#L79)) · `iterateSessionFile` AbortSignal 미수용(대용량 replay 취소 불가) · `removeFileIfExists`가 EACCES까지 삼킴(주석은 ENOENT만 약속).
- **remote/reactor**: docker `cancel`이 stop/rm exit 무시하고 cancelled 보고([docker-adapter.ts:319](../../../../src/remote/runner/docker-adapter.ts#L319)) · lima `status`가 non-running 전부 `succeeded`로([lima-adapter.ts:107](../../../../src/remote/runner/lima-adapter.ts#L107)) · lima pid-file spawn/read race + temp 미정리 · `--network=none`이 env-loop 블록 안에 중첩(security 플래그 SRP 위험)([docker-adapter.ts:87](../../../../src/remote/runner/docker-adapter.ts#L87)) · pr-comment watermark가 trigger 구체화 전 advance → URL-less 코멘트 영구 drop([trigger-source-pr-comment.ts:117](../../../../src/reactor/trigger-source-pr-comment.ts#L117)) · updated_at/created_at watermark 혼용 → edit 시 재발화.
- **connectors**: `health()`가 read인데 매번 전체파일 persist → 부패 창 확대([jsonl-store.ts:145](../../../../src/connectors/custom-3p/jsonl-store.ts#L145)) · oauth discovery/registration fetch 타임아웃 없음([oauth-discovery.ts:42](../../../../src/connectors/oauth-discovery.ts#L42)) · 멱등 add가 recency 미갱신(insertion-FIFO, hot key가 retry 전 evict) · `availability.ts` 재-export 스텁.
- **integrations(github)**: `findExistingComment`가 "조회실패"="없음"으로 collapse → 중복 POST([pr-output-sink.ts:158](../../../../src/integrations/github/pr-output-sink.ts#L158)) · webhook 동시 중복 POST 둘 다 enqueue(reservation 없음)([webhook-server.ts:188](../../../../src/integrations/github/webhook-server.ts#L188)) · 헤더 사이즈 가드가 `.length`(UTF-16) vs `MAX_HEADER_VALUE_BYTES` · poll splice 크래시 시 트리거 소실 · node transport per-request 에러 무관측 swallow · trigger-build 로직 두 소스 copy-paste · `resolveScope` owner 판정이 HMAC 게이트와 decouple(미인증 transport 재사용 시 escalation).
- **mcp**: tasks default-store FIFO eviction이 upsert recency 미갱신 + cursor가 insertion-index([default-store.ts:24](../../../../src/mcp/tasks/default-store.ts#L24)) · VM-name 32-bit FNV 충돌 가드 없음 · `isValidEnvelope`/result-mapping 두 client copy-paste · client `Number(msg.id)` NaN silent-drop.
- **shared**: env-files `readFileSync` TOCTOU + unguarded throw([env-files.ts:21](../../../../src/shared/env-files.ts#L21)) · errors.ts↔error-classifier.ts 마커셋 "kept in sync" 주석 이미 거짓(context-window/policy 양방향 분기)([errors.ts](../../../../src/shared/errors.ts) ↔ [error-classifier.ts](../../../../src/shared/error-classifier.ts)) · `channel-naming` 주석이 regex가 불허하는 hyphen 허용 주장 · byte-compare UTF-16 code-unit(doc 정확성).
- **storage**: atomic-write EXDEV copyFile fallback 비원자(헤더는 crash-safety 보존 과장)([atomic-write.ts:90](../../../../src/storage/atomic-write.ts#L90)) · service.ts↔fs-jail-lib.ts `lexicalNormalize`/`realResolve` 통째 중복(보안 코드) · 모듈-global `fsJailDecisionSink` last-writer-wins · 미-jailed default baseDir seam.
- **migration**: claude-code translator `SKIP_TYPES.has` dead branch([claude-code.ts:104](../../../../src/migration/translators/claude-code.ts#L104)) · importer count tautology · cursor/aider 스텁이 fake success(`ok:true, sessionsTranslated==fileCount` while importing nothing) · dedup이 전체 트랜스크립트를 메모리에 buffer(스트리밍 해시 부재).
- **voice/media**: deepgram `wordsToSegments`가 모든 word를 단일 segment로 collapse([deepgram-transcriber.ts:96](../../../../src/voice/transcriber/deepgram-transcriber.ts#L96)) · default-recorder oversize 시 전체 버퍼 폐기 · parec headerless PCM을 `format:"wav"`로 반환([default-recorder.ts:99](../../../../src/voice/default-recorder.ts#L99)) · deepgram confidence 누락 시 `1.0` → HITL confirm 우회([deepgram-adapter.ts:48](../../../../src/media/stt/deepgram-adapter.ts#L48)) · sox `stop()`이 잘린 blob을 success+거짓 durationMs로([sox-capture.ts:135](../../../../src/media/voice/sox-capture.ts#L135)) · whisper temp가 swallowed cleanup으로 privacy-sensitive 오디오 잔존 · `RecorderHandle._internal`이 포트 타입으로 impl 누출.
- **ipc**: re-connect가 멱등/rate 가드 없이 full replay 재전송([bridge.ts:314](../../../../src/ipc/session/bridge.ts#L314)) · event-bridge fanOut 주석은 logging 약속하나 코드는 silent swallow([event-bridge.ts:201](../../../../src/ipc/event-bridge.ts#L201)) · codec가 control frame당 `JSON.parse` 2회 · uds/ws 서버 미구현 스켈레톤(loud-throw, 추적된 갭).

---

## ✅ Positive controls (잘 된 것 — 기록)

- **shared**: `correlation.ts` 시드 가능 id 생성기 + overflow 명시 throw(silent wrap 없음), no `Date.now`/`Math.random`. `codec.ts` 디코더 전부 no-throw Result. `errMessage`가 hostile `toString`/`@@toPrimitive` throw에 per-probe try/catch.
- **mcp**: stdio transport idempotent `close()` + read pump await, client pending/timeout 라이프사이클(failAllPending이 전 타이머 clear), poller가 양 경로에서 abort listener/timer 정리, elicitation fail-closed(synthesized answer 없음), negotiator 알파순 freshly-allocated 직렬화.
- **observability**: pricing.ts null-proto TABLE + provider-aware carve-out, log-rate-limit bounded LRU(cold-start tokens=1), spans/logger의 swallow가 문서화된 no-throw observability 경계.
- **git**: lock `finally` 해제, `randomUUID`가 브랜치 *이름*에만(persisted 해시 아님), serializer 알파-sort + UTC stamp 결정적, `findStashIndex` line-index≡stash-index 정확(의심스럽지만 sound — 03 문서 기록).
- **connectors/reactor**: registry `assertNever` exhaustive + import-safe, `validateSpec` 순수 함수, reactor `safeRun`/`safeJson` catch-to-Result가 문서화된 의도적 degradation(+`onError` sink로 watermark fault surfacing).
- **integrations**: `signature-verify.ts` timing-safe(length pre-check), webhook-transports body-drain(`req.resume()`)·force-close keep-alive, slice-fence(네트워크는 webhook-transports.ts만).
- **voice**: `chainSignals`가 already-aborted 처리 + `{once:true}`, `validateOpts`가 programmer-bug를 Err로(throw 아님), headless 스텁 결정적(byte-stable 44-byte RIFF), registry `fallbackOnError`가 input-shape 에러엔 fallback 안 함.

---

## Cross-cutting themes (상세)

1. **fsync 없는 "atomic" write 4중 재구현** (README #1). session/storage/migration/connectors가 각자 `Bun.write`+`rename`. 적대 패스가 session/storage/migration은 HIGH→MEDIUM 강등(power-loss fsync 생략은 비-DB 로컬 스토어 표준 + rename atomicity 유효), connectors는 `_seed` 증폭으로 HIGH 유지. **공용 atomic-write 포트(fd+dir fsync 옵션)로 통합** = 4곳 동시 수정 + 메모리 `lib-swap-wheel-reinvention`의 `write-file-atomic` 라인과 일관.
2. **외부 경계 타임아웃/취소 누락** (README #2). otel·mcp·STT·connectors·integrations의 모든 `fetchFn`/subprocess `run`에 `signal` 미전달. **포트 시그니처에 `signal?`+기본 deadline 강제**가 횡단 수정.
3. **죽은 `AbortController().signal`** (README #3). reactor·integrations가 `new AbortController().signal`만 보관 → 영원히 abort 불가. 실 poll signal을 thread하거나 inert임을 타입/주석에 명시.
4. **비-canonical 직렬화가 무결성/dedup 키 손상** (README #4). session digest·GH delivery fallback이 `JSON.stringify` 키순서 의존. canonical serializer가 같은 슬라이스에 존재 → 그걸 사용.
5. **observability 없는 안전-방향 swallow** (README #5). scheduler load·connectors corrupt-row·ipc fanOut·session index-read가 무관측 삼킴. 안전 방향이나 "고장"과 "비어있음" 구분 불가 → count/warn/sink 추가.
6. **honesty 계약의 함정.** skybridge(M17)·remote lima status·migration 스텁이 미적용/실패를 `success`/`sandboxApplied:true`로 보고. degrade를 정직하게 *계산*하는 슬라이스(observability)도 있으나 일부 소비처가 그 신호를 *폐기* — L8 감사의 "honest-degrade 함정"과 동일 패턴.
