# L9 — CRITICAL / HIGH findings

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준.

이 레인의 1순위 렌즈는 **integration-boundary · durability · determinism**: 외부 입력/네트워크/서브프로세스 경계에서 타임아웃·취소·원자성이 무너지는가, 그리고 무결성/멱등 키가 비결정적으로 깨지는가. 아래 14건은 적대 패스가 소스 재정독으로 confirmed 한 것만 추렸다.

---

## 🔴 CRITICAL

### C1. lima 어댑터 셸 커맨드 인젝션 (VM 내 임의 코드 실행)
- **위치:** [src/remote/runner/lima-adapter.ts:68,76](../../../../src/remote/runner/lima-adapter.ts#L68)
- **카테고리:** security · integration-boundary · **상태:** [적대-확인]
- **근거:** `spec.image`·`spec.cmd`를 공백 join 후 `bash -c '<cmd> ...'` 문자열에 raw 보간한다:
  ```ts
  const cmd = [spec.image, ...spec.cmd].join(" ")
  // → limactl shell {vm} -- bash -c `nohup ${cmd} > /tmp/${id}.log 2>&1 & echo $! > /tmp/${id}.pid`
  ```
  `validateSpec`는 image 비어있음·cmd 배열-shape·env-key regex만 검사하고 **셸 이스케이프를 하지 않는다**. `cmd` 원소에 `; rm -rf ~ #` 또는 백틱/`$(...)`를 넣으면 VM 내에서 임의 코드가 실행된다. **docker 어댑터는 `composeDockerRunArgv`로 argv 배열을 넘겨 이 문제를 회피하는데, lima만 문자열 연결로 회귀**했다. `status`/`cancel`도 `handle.id`를 `cat /tmp/${id}.pid`에 보간하지만 id는 `${prefix}-${uuid()}`라 안전.
- **수정:** 셸 문자열 대신 argv 벡터로 전달 (docker처럼). 불가피하면 `cmd`/`image`를 `shell-quote` 또는 single-quote 이스케이프하여 보간. `validateSpec`에 셸 메타문자 거부 추가.

---

## 🟠 HIGH

### H1. OTel export POST에 타임아웃/abort 없음 → exporter 전체 영구 wedge
- **위치:** [src/observability/otel-exporter.ts:397-423](../../../../src/observability/otel-exporter.ts#L397) (+ `inFlight` 게이트 [:453-465](../../../../src/observability/otel-exporter.ts#L453))
- **카테고리:** integration-boundary · resource-leak · **상태:** [적대-확인] ("가장 심각")
- **근거:** `await fetchImpl(...)`에 `method/headers/body`만 넘기고 `signal`이 없다. collector 연결이 hang하면 flush promise가 영영 pending. `flushAll`은 그 promise를 `inFlight`에 저장하고 이후 모든 flush가 동일 promise를 short-circuit 반환하므로([:455](../../../../src/observability/otel-exporter.ts#L455)) **타이머 flush·batch flush·`teardown()`까지 전부 그 멈춘 promise에 묶인다**. 한 번의 hang이 exporter를 영구 정지시키고 프로세스가 clean exit 못 함.
- **수정:** `AbortController` + `AbortSignal.timeout(ms)`를 fetch에 주입. 타임아웃 시 `inFlight` 해제하고 다음 flush가 재시도하도록.

### H2. OTel 버퍼가 죽은 collector에 무한 증가 → OOM
- **위치:** [src/observability/otel-exporter.ts:425-445](../../../../src/observability/otel-exporter.ts#L425)
- **카테고리:** durability · resource-leak · **상태:** [적대-확인]
- **근거:** `recordSpan`/`recordMetric`은 무조건 push하고 `batchSize` 도달 시 flush만 *트리거*한다. `post`가 `false`면 `flushSpans`/`flushMetrics`는 `if(ok)` 안에서만 splice하므로 collector가 계속 죽어있으면 버퍼가 무한히 자란다. max-size eviction이 어디에도 없다. 헤더 주석의 "no infinite growth because batchSize caps the buffer"는 **거짓** — batchSize는 캡이 아니라 flush 트리거. 긴 세션 + 다운 collector = OOM. (H1과 합쳐지면 hang→버퍼증가 복합.)
- **수정:** 버퍼 max-size 캡 + 초과 시 oldest drop(+ drop-count 메트릭). flush 실패가 누적되면 backpressure/포기 정책.

### H3. whisper.cpp stdout 미배수 → 파이프 버퍼 가득 차면 deadlock
- **위치:** [src/voice/transcriber/local-whisper-transcriber.ts:60,164-172](../../../../src/voice/transcriber/local-whisper-transcriber.ts#L164)
- **카테고리:** integration-boundary · resource-leak · **상태:** [적대-확인]
- **근거:** spawner가 stdout·stderr 둘 다 `pipe`로 열지만 `runBinary`는 `readAll(child.stderr)`만 한다 — **stdout은 절대 읽지 않는다**. whisper.cpp는 stdout으로 진행상황/배너를 출력한다(`-nt`로 줄지만 0은 아님). 실제 OS 파이프(Bun.spawn)의 stdout 버퍼(~64KB)가 차면 child가 write에서 block → `await child.exited`가 영영 resolve 안 되고 120s 타임아웃 SIGTERM까지 hang. 테스트는 주입 fake의 `exited`가 독립 resolve해서 통과.
- **수정:** stdout도 `readAll`로 배수(또는 `stdout:"ignore"`로 spawn). stderr/stdout 동시 drain.

### H4. STT 어댑터에 타임아웃·취소 전무
- **위치:** [src/media/stt/deepgram-adapter.ts:64-79](../../../../src/media/stt/deepgram-adapter.ts#L64), [src/media/stt/openai-whisper-adapter.ts:39-51](../../../../src/media/stt/openai-whisper-adapter.ts#L39)
- **카테고리:** integration-boundary · **상태:** [적대-확인]
- **근거:** 두 ADR-0202 어댑터 모두 `fetchFn(endpoint, {...})`에 `signal`도 타임아웃도 없다. `AudioBlob`/`CaptureOpts` 경로엔 thread할 signal 자체가 없다. hang난 Deepgram/OpenAI 연결이 호출자를 무한 차단. 신형 형제 transcriber(ADR-0208, [deepgram-transcriber.ts](../../../../src/voice/transcriber/deepgram-transcriber.ts))는 타임아웃 `AbortController` + caller signal 체이닝을 제대로 하는데 미디어 어댑터는 안 받았다.
- **수정:** ADR-0208 transcriber의 signal-체이닝 패턴을 미디어 어댑터에 이식. 포트에 `signal?` 추가.

### H5. scheduler — errored automation 영구 사망 (문서화된 retry 계약 위반)
- **위치:** [src/scheduler/automation-engine/ticker.ts:80-83](../../../../src/scheduler/automation-engine/ticker.ts#L80) + [sqlite.ts:309-310](../../../../src/scheduler/automation-engine/sqlite.ts#L309) + [in-memory.ts:175-176](../../../../src/scheduler/automation-engine/in-memory.ts#L175)
- **카테고리:** missing-feature · durability · **상태:** [적대-확인]
- **근거:** ticker 주석은 "핸들러 throw 시 row는 `scheduled`로 남아 다음 tick에 retry(rule 소진 시에만 `errored`)"를 약속한다. 그러나 두 엔진 모두 `nextStatus = outcome==="errored" ? "errored" : (nextRunAt===null ? "fired":"scheduled")`로 **`nextRunAt`가 유효한 미래값이어도 무조건 errored 설정**. `next()`는 `WHERE status='scheduled'`만 select([sqlite.ts:197](../../../../src/scheduler/automation-engine/sqlite.ts#L197))하므로 일시적 실패 1회로 반복 automation이 영구 폐기. 더 나쁜 건 **`automation-engine-hellgate.test.ts`의 케이스 [8]/[10]이 깨진 동작을 박제**(미래 nextRunAt인데 `status==="errored"` 단언)해서 문서 계약이 도달 불가.
- **수정:** `outcome==="errored" && nextRunAt!==null`이면 `scheduled` 유지(rule 소진 시에만 errored). 박제 테스트 케이스도 계약대로 수정.

### H6. reactor pr-comment — `repoSlug`/`prNumber` raw 보간 → gh api path/query injection
- **위치:** [src/reactor/trigger-source-pr-comment.ts:89](../../../../src/reactor/trigger-source-pr-comment.ts#L89)
- **카테고리:** integration-boundary · security · **상태:** [적대-신규]
- **근거:** path가 `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments?since=${encodeURIComponent(watermark)}` — **watermark만 escape**, `repoSlug`/`prNumber`는 검증 없음. `repoSlug = "foo/bar/comments?per_page=100&x="` 또는 `../`가 GitHub REST 엔드포인트를 재작성(path traversal / query injection). 임의 코드 실행은 아니나 네트워크 경계의 미검증 외부입력. CI source는 `prRef`를 positional arg로 넘겨 이를 회피.
- **수정:** `repoSlug`를 `^[\w.-]+/[\w.-]+$`로 검증, `prNumber`를 `Number.isInteger` 가드, 또는 URL 조립을 `URLSearchParams`/path-segment escape로.

### H7. connectors `list()`가 outage를 빈 카탈로그로 collapse
- **위치:** [src/connectors/rest-registry.ts:139-145](../../../../src/connectors/rest-registry.ts#L139) (+ dead ternary [:108-109](../../../../src/connectors/rest-registry.ts#L108))
- **카테고리:** integration-boundary · silent-error · **상태:** [적대-신규]
- **근거:** `list()`가 `await refresh()`의 `RefreshOutcome`를 **버리고** `return memo ?? []`. 서버 unreachable + 캐시 없음이면 `doFetch`가 `"cached-degraded"` + `memo===undefined` → `list()`가 `[]` 반환 — 건강한 빈 레지스트리와 byte-identical. `get()`도 상속(미스 시 `undefined` = "그런 커넥터 없음" 인데 실제론 "레지스트리 다운"). [:108-109](../../../../src/connectors/rest-registry.ts#L108)의 `return memo!==undefined ? "cached-degraded" : "cached-degraded"`(양 arm 동일 dead code)가 누락된 honesty 구분을 드러낸다 — `RefreshOutcome`에 "empty-and-down" arm이 없다.
- **수정:** `RefreshOutcome`에 `unavailable` arm 추가, `list()`/`get()`가 outcome을 caller에 전파(또는 throw)하여 outage와 empty를 구분.

### H8. custom-3p 레지스트리 비원자 in-place write → 영구 데이터 손실
- **위치:** [src/connectors/custom-3p/jsonl-store.ts:119-123](../../../../src/connectors/custom-3p/jsonl-store.ts#L119) (+ 증폭 [in-memory-registry.ts:206-211](../../../../src/connectors/custom-3p/in-memory-registry.ts#L206))
- **카테고리:** durability · **상태:** [적대-확인]
- **근거:** `persist()`가 `writeFile(config.path, body)`로 전체 스냅샷을 **직접 덮어쓴다**(tmp+rename 없음). 크래시 시 truncated/half-written. 다음 `loadOnce()`는 torn tail 라인을 `parseRow` 실패로 **조용히 drop**([:99-105](../../../../src/connectors/custom-3p/jsonl-store.ts#L99))하고, `_seed`가 `rows.clear()` 후 살아남은 것만 재적재 → 잃은 row가 메모리에서도 사라지고 다음 mutation이 축소된 셋을 재persist → **영구 손실**. 헤더(line 6)는 sibling atomic-write를 mirror한다 주장하지만 `token-store.ts`의 tmp+rename invariant를 빠뜨렸다.
- **수정:** `${path}.tmp` write → `rename`. corrupt-row drop 시 count/warn 관측. (cross-cutting theme #1의 일부 — 공용 atomic-write 포트로.)

### H9. webhook 멱등 store `persistPath` no-op (durability 주장 거짓)
- **위치:** [src/integrations/github/idempotency.ts:44-62](../../../../src/integrations/github/idempotency.ts#L44)
- **카테고리:** missing-feature · durability · **상태:** [적대-확인]
- **근거:** docstring(6,41-44)과 `DeliveryStoreOpts.persistPath`(28)가 "lazy load + best-effort save"와 "store still records persistPath"를 광고하지만, `createDeliveryStore`는 `opts.maxEntries`/`opts.seed`만 쓰고 **`persistPath`를 저장도 load도 save도 안 한다** — 순수 in-memory. 재시작 시 delivery-id dedup 상태 전부 소실 → GitHub webhook 재전송(`X-GitHub-Delivery` 재사용)이 트리거를 재발화. 막으려던 바로 그 중복 실행이 발생. webhook 경로(long-lived 프로세스)가 진짜 노출 지점.
- **수정:** `persistPath` 실제 구현(lazy load + atomic save) 또는 docstring/타입에서 제거하고 in-memory임을 명시. webhook 경로엔 atomic-persist 권장.

### H10. PR 출력 dedup이 `postComment`에만 wired → review 중복 POST
- **위치:** [src/integrations/github/pr-output-sink.ts:121-128](../../../../src/integrations/github/pr-output-sink.ts#L121) (vs `postComment` [:109-120](../../../../src/integrations/github/pr-output-sink.ts#L109))
- **카테고리:** missing-feature · **상태:** [적대-확인]
- **근거:** `postComment`은 find-existing → patch-or-post → reconcile를 다 하지만, `postReview`(213-233)·`postReviewComment`(235-264)는 **marker만 body에 stamp하고 곧장 POST** — find-existing/patch/reconcile 없음. 재시도(네트워크 flake, 러너 재시작, webhook 재전송)마다 review/inline-comment 중복 생성. 클래스 docstring("each body ... PATCHes existing")은 3개 verb 중 2개에 거짓.
- **수정:** `postReview`/`postReviewComment`도 `findExistingComment`+reconcile 분기 적용(marker는 이미 stamp 중이니 쿼리만 추가).

### H11. remote 어댑터가 양수 `timeoutMs` 미집행 (lima/vz는 참조 0개)
- **위치:** [src/remote/runner/docker-adapter.ts:104-108](../../../../src/remote/runner/docker-adapter.ts#L104) (+ lima/apple-vz 어댑터)
- **카테고리:** missing-feature · integration-boundary · **상태:** [적대-확인]
- **근거:** `RemoteSpec.timeoutMs`는 "Wall-clock budget in ms" 약속이지만 docker는 `timeoutMs===0`(즉시 실패)만 처리하고 **양수값은 조용히 무시**(--stop-timeout 없음, 타이머 없음). `timeoutMs:5000` 잡이 영원히 실행. 더 심한 건 **lima/apple-vz 어댑터엔 `timeoutMs` 참조가 0개** — `timeoutMs:0`조차 workload를 spawn해서 HELL-RR-07 위반.
- **수정:** 양수 `timeoutMs`에 `setTimeout(→cancel)` 또는 docker `--stop-timeout`/`timeout` 래퍼. lima/vz에 최소 `===0` 가드 + 타이머.

### H12. MCP HTTP-SSE POST 취소 불가 → 소켓·스트림 누수
- **위치:** [src/mcp/transports/http-sse.ts:184-217](../../../../src/mcp/transports/http-sse.ts#L184), [:143-151](../../../../src/mcp/transports/http-sse.ts#L143)
- **카테고리:** resource-leak · integration-boundary · **상태:** [적대-확인]
- **근거:** `send()`가 `void this.post(...).catch(...)`로 background fire하고 `post()`의 fetch init은 `{method,headers,body}`만 — `signal` 없음. `close()`는 `serverStreamAbort`(standalone GET)만 abort하고 in-flight POST와 그 `consumeSseBody` reader는 untracked. 서버가 POST에 무한 SSE를 흘리면 reader/소켓이 `close()` 이후에도 누수. 30s 요청 타이머는 promise만 reject하고 HTTP 레이어는 안 건드림. (적대 신규: standalone GET도 idle/connect 타임아웃 없음 [:118-122](../../../../src/mcp/transports/http-sse.ts#L118).)
- **수정:** POST별 `AbortController`를 추적 셋에 보관, `close()`에서 전부 abort + reader cancel. fetch에 idle 타임아웃.

### H13. git conflict 파서 통째 중복 + 이미 분기
- **위치:** [src/git/conflict-parser.ts](../../../../src/git/conflict-parser.ts) (548 LOC, 배럴 export, 소비자 0) vs [src/tool/git/conflict-parser/parse.ts](../../../../src/tool/git/conflict-parser/parse.ts) (wired)
- **카테고리:** code-quality · **상태:** [적대-확인]
- **근거:** 실제 wired는 `conflict-inspect.ts`가 import하는 `src/tool/git/conflict-parser/parse.ts`. in-scope `src/git/conflict-parser.ts`는 `@/git` 배럴([index.ts:32](../../../../src/git/index.ts#L32))에서만 export되고 **non-test 소비자 0**(grep 확인). 적대 패스가 두 파일이 **이미 분기**(`scan.baseIdx` vs `baseStartIdx`, marker-length tolerance 주석 블록 한쪽만, `=======xyz` separator-reject 주석 한쪽만)함을 확인 → "썩을 수 있다"가 아니라 "썩고 있다". 배럴이 공유 SSOT인 척하지만 공유 아님.
- **수정:** dead copy(`src/git/conflict-parser.ts`) 삭제 + 배럴 export 제거, 또는 wired 파서를 `@/git`로 정본화하고 `src/tool/git`이 재사용. 둘 중 하나로 SSOT 단일화.

### H14. `diff3` union 멤버 도달 불가 (양 파서 공통)
- **위치:** [src/git/conflict-parser.ts:91,98,465](../../../../src/git/conflict-parser.ts#L465) (wired 사본 [parse.ts:478](../../../../src/tool/git/conflict-parser/parse.ts#L478)도 동일)
- **카테고리:** determinism · code-quality · **상태:** [적대-확인]
- **근거:** `ConflictMarkerStyle`/`ALL_MARKER_STYLES`가 `"diff3"`를 광고하지만 `parseBlock`은 `scan.baseStartIdx!==-1 ? "three-way" : "two-way"`만 할당 — 어느 경로도 `"diff3"` 안 냄. 의도적 forward-compat라 문서화돼 있으나 `ALL_MARKER_STYLES` 위 exhaustive switch는 절대 안 fire하는 arm을 갖고, `diff3` 단언 테스트는 불가능 상태를 단언. H13의 중복까지 겹쳐 양 사본 모두 동일 dead arm.
- **수정:** `diff3` 실제 파싱하거나 union/`ALL_MARKER_STYLES`에서 제거. forward-compat면 주석에 "현재 미생성" 명시 + exhaustive switch에 명시적 unreachable.

---

## 적대 강등 고지

Round-1이 HIGH로 올린 **session/storage/migration의 fsync-부재**(`store.ts:61` / `atomic-write.ts:71` / `persistence.ts:78`)는 적대 패스가 "process-crash엔 안전, power-loss fsync 생략은 비-DB 로컬 스토어의 업계 표준 + rename atomicity는 유효"라며 **HIGH→MEDIUM 강등**(02 문서 cross-cutting #1). 단 connectors jsonl-store(H8)는 `_seed` clear-then-repopulate 증폭으로 HIGH 유지. 그 외 강등/오탐은 [03-false-positives.md](03-false-positives.md) 참조.
