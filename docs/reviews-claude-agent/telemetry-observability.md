# 텔레메트리 / 관측성 스택

Claude Code v2.1.143 — 측정·전송 메커니즘 전수 분석.

추출 위치: `extracted-functions.js` (라인:바이트오프셋 표기).

핵심 minified ↔ 의미 매핑:

| Minified | 역할 |
|---|---|
| `d(H,_)` | 메인 분석 sink — `(eventName, metadata)` 큐잉 (라인 ~14137 영역) |
| `OpH` | `trackDatadogEvent(H,_)` — Datadog 전송 (확인) |
| `G98` | Datadog batch flush (POST) |
| `HC1` | flush timer 예약 (`OC1()` 간격) |
| `OC1` | `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` 파서 |
| `R98` | `initializeDatadog` (1st-party 게이트) |
| `RF` | `shutdownDatadog` (종료 시 강제 flush) |
| `KC1` | `userBucket` = `sha256(userID) % 30` |
| `pu` | `getOrCreateUserID` (영구 userID) |
| `vi_` | 공통 메타 빌더 (model/sessionId/envContext) |
| `DS1` | per-call 메모리·CPU 스냅샷 |
| `oE1`/`sE1` | 세션 종료 메모리 요약 (`tengu_sdk_memory_summary`) |
| `otelMeter` | `F_.statsStore` — OTel 메트릭 스토어 (확인) |
| `v5("query_*")` | 턴 내부 perf marker |
| `VY6` | profiler span (`api_call`/`tool_exec`) |
| `telemetryEnabled` | `OTEL_LOG_TOOL_DETAILS` 플래그 |
| `TC1`/`$C1` | sync/async 이벤트 fan-out (Datadog + Statsig) |
| `apiProvider` | provider 식별 (`firstParty` 등) |

---

## 1. 수집 항목 (무엇을 측정하는가)

### 1.1 distinct `tengu_*` 이벤트: 1,122개 (확인)

`grep -aoE '"tengu_[a-z_0-9]+"' | sort -u | wc -l` → **1122**. 이 중 Datadog 화이트리스트(`tS1` Set)에 든 것은 약 130개뿐 — 나머지는 Statsig 등 1st-party 분석 sink로만 간다 (§2.3).

카테고리 개관 (대표 prefix):

| 카테고리 | 대표 이벤트 | 비고 |
|---|---|---|
| API/네트워크 | `tengu_api_query`, `tengu_api_error`, `tengu_api_success`, `tengu_api_retry`, `tengu_api_slow_first_byte`, `tengu_api_529_background_dropped`, `tengu_api_before_normalize`, `tengu_api_after_normalize`, `tengu_api_cache_breakpoints` | 정규화 전/후 양쪽 측정 |
| 도구 실행 | `tengu_tool_use_success`, `tengu_tool_use_error`, `tengu_tool_use_cancelled`, `tengu_tool_use_diff_computed`, `tengu_tool_input_json_parse_fail`, `tengu_tool_result_persisted` | per-tool 메모리 델타 포함 (§4) |
| auto-mode (v2 권한 분류기) | `tengu_auto_mode_decision`, `tengu_auto_mode_outcome`, `tengu_auto_mode_denial_limit_exceeded`, `tengu_auto_mode_malformed_tool_input`, opt-in 다이얼로그 6종 | LLM classifier 판단 추적 |
| bg daemon (백그라운드 에이전트) | `tengu_bg_*` ~80종 (`tengu_bg_daemon_zombie_restart`, `tengu_bg_dispatch_sigkill_escalate`, `tengu_bg_orphan_reap`, `tengu_bg_respawn_unconfirmed_bail` …) | 가장 큰 단일 카테고리 — 좀비/고아 프로세스, 메모리 압박, sigkill 에스컬레이션까지 |
| OAuth/토큰 | `tengu_oauth_*` ~50종 (lock acquiring/acquired/releasing/released 단계별, race recovered/resolved) | 토큰 갱신 lock 라이프사이클 전 단계 |
| SDK | `tengu_sdk_ttft`, `tengu_sdk_stall`, `tengu_sdk_session_crash`, `tengu_sdk_schema_violation`, `tengu_sdk_control_roundtrip`, `tengu_sdk_memory_summary` | TTFT·stall·크래시 |
| compact | `tengu_reactive_compact_*`, `tengu_precomputed_compact_*`, `tengu_auto_compact_rapid_refill_breaker`, `tengu_time_based_microcompact`, `tengu_partial_compact` | 3-tier compaction 전부 계측 |
| config/세션 | `tengu_config_stale_write`, `tengu_config_lock_contention`, `tengu_session_persistence_failed`, `tengu_conversation_rewind`, `tengu_resume_consistency_delta` | |
| codename 실험 | `tengu_copper_lantern`, `tengu_amber_*`, `tengu_slate_*`, `tengu_velvet_*`, `tengu_cobalt_*` 등 수백 개 | Statsig 게이트 키 (광물·동물·식물 코드네임) — 사실상 전부 feature flag |

놀라운 점: bg daemon 약 80종, oauth 약 50종은 각각 어지간한 앱 전체보다 많은 텔레메트리 표면을 가진다. `tengu_*`의 절반 이상이 codename 실험 게이트(`Z_()`로 평가)라서 이벤트라기보다 A/B 키.

### 1.2 공통 메타 (`vi_`, 확인)

모든 Datadog 이벤트에 부착되는 베이스 (`OpH`가 `vi_()`를 머지):

```
model, sessionId, userType:"external",
betas, envContext (= JS1()),
entrypoint (CLAUDE_CODE_ENTRYPOINT), sessionKind, hasAttacher,
agentSdkVer (CLAUDE_AGENT_SDK_VERSION),
userBucket (= KC1())
```

`envContext`엔 `parentSessionId`, `agentId`, `agentType`, `teamName`도 조건부 포함.

`eS1` 화이트리스트(ddtags로 승격되는 차원): `arch, classifierModel, classifierStage, clientType, decision, entrypoint, errorKind, errorType, failureKind, fastPath, sessionKind, http_status_range, http_status, kairosActive, model, op, outcome, platform, provider, reason, skillMode, coachMode, source, subscriptionType, toolName, userBucket, userType, version, versionBase`.

---

## 2. 전송 경로 (어디로 보내는가)

### 2.1 Datadog (하드코딩, 확인)

```
DATADOG_LOGS_ENDPOINT = "https://http-intake.logs.us5.datadoghq.com/api/v2/logs"
DATADOG_CLIENT_TOKEN  = "pubea5604404508cdd34afb69e6f42a05bc"   (Z98)
```

라인 5735, 바이트 ~4453920. POST 시 헤더 `DD-API-KEY: pubea5604404508cdd34afb69e6f42a05bc`, `Content-Type: application/json`, timeout 5000ms (`sS1`).

전송 게이트 (`OpH` 첫 줄, 확인):

```js
async function OpH(H,_){ if(Jq()!=="firstParty") return; ... if(!tS1.has(H)) return; ... }
```

- **`Jq()==="firstParty"` 일 때만 전송** — Bedrock/Vertex/Mantle/AWS 사용자는 Datadog로 일절 안 감 (확인).
- 이벤트 이름이 화이트리스트 Set `tS1`(약 130개)에 있어야 함.
- `initializeDatadog`(`R98`)는 `Bu()`(텔레메트리 비활성) 또는 `zR9()`(BYOC 환경에서 `CLAUDE_CODE_BYOC_ENABLE_DATADOG` 미설정) 시 비활성.

배치/플러시:

- 배치 크기 `aS1 = 100` — 큐가 100 차면 즉시 flush (`G98`).
- 플러시 간격 `oS1 = 15000ms` 기본, `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` 로 override (`OC1`).
- 타이머는 `.unref()` (프로세스 종료 막지 않음). `RF`(shutdownDatadog)가 종료 시 잔여 강제 flush.

로그 레코드 형태 (`OpH`, 확인):

```js
{ ddsource:"nodejs", ddtags:"event:<H>,<eS1 화이트리스트 차원들>",
  message:<event>, service:"claude-code", hostname:"claude-code", env:"external",
  ... snake_case 변환된 전체 메타 }
```

전송 전 정규화/리댁션 (`OpH` 본문, 확인):

- `toolName`이 `mcp__`로 시작하면 → `"mcp"` 로 일괄 치환 (MCP 서버명 노출 차단).
- `model`이 `"claude"` 미포함이면 **이벤트 전체 drop**; 포함이면 알려진 모델 테이블 매핑, 아니면 `"other"`.
- `version`의 dev 접미사(`...t<ts>.sha<hex>`) 잘라냄.
- `status` → `http_status` + `http_status_range`(`Nxx`)로 변환 후 `status` 삭제.
- camelCase → snake_case (`ML9`).

`null`/`undefined` 필드는 제외. 자유 텍스트(프롬프트 내용·파일 경로 원문)는 베이스 메타에 없음 — 길이·확장자·해시만 (§4).

### 2.2 OpenTelemetry (`@opentelemetry`, 확인)

라인 5405~5518 영역에 `@opentelemetry` SDK 번들. `t5H()`(= `F_.statsStore`)가 메트릭 스토어. observe 호출 사이트 (확인):

| 메트릭 | 단위 | 사이트 |
|---|---|---|
| `pre_tool_hook_duration_ms` | ms | `executeToolPipeline` 도구 파이프라인 (라인 13875, 바이트 ~10038400). `PreToolUse` hook defer/완료 시 `t5H()?.observe(...)` |
| `hook_duration_ms` | ms | repl hook 완료 (라인 18860/18862) — `tengu_repl_hook_finished`와 함께 |
| `frame_duration_ms` | ms | UI 렌더 onFrame 콜백 (라인 20843, 바이트 ~14137300) — 프레임마다 |

OTel SDK는 `createHistogram`/`createCounter`/`createObservableGauge` API 사용. `M$()` = `OTEL_LOG_TOOL_DETAILS` env로 도구 상세 로깅 토글. (전용 OTLP exporter 설정은 표준 `OTEL_*` env로 추정 — 별도 하드코딩 엔드포인트 없음, 확인.)

### 2.3 1st-party 분석 sink (Statsig, 확인)

`TC1`(sync) / `$C1`(async): `Ei_(H)` 샘플레이트 적용 후 `PL9()`(= `tengu_log_datadog_events` 게이트)면 `OpH`(Datadog)도 호출, 항상 `cmH`/`xv`(Anthropic 1st-party sink)로 전송. 즉 **Datadog는 부가 채널**이고 1,122개 전부는 1st-party로 흐른다.

---

## 3. 메커니즘 (어떻게 측정하는가)

### 3.1 턴 내부 perf marker `v5("query_*")` (확인)

`grep`로 확인된 query_ 마커 (start/end 페어 다수, 한 턴 13+ 발생):

```
query_fn_entry, query_started, query_query_start, query_recursive_call,
query_setup_start/end, query_client_creation_start/end,
query_context_loading_start/end, query_attachment_loading_start/end,
query_image_processing_start/end, query_pasted_image_processing_start/end,
query_process_user_input_base_start/end, query_process_user_input_start/end,
query_message_normalization_start/end,
query_tool_schema_build_start/end,
query_microcompact_start/end, query_autocompact_start/end,
query_file_history_snapshot_start/end,
query_hooks_start/end,
query_api_loop_start, query_api_request_sent,
query_api_streaming_start/end, query_first_chunk_received,
query_response_headers_received,
query_tool_execution_start/end,
query_user_input_received, query_profile_end, query_end
```

→ 한 턴의 모든 sub-step 레이턴시(컨텍스트 로딩, 첨부 처리, 메시지 정규화, 도구 스키마 빌드, microcompact, hook, API 스트리밍, 첫 청크 수신, 응답 헤더 수신, 도구 실행)가 시간축에 찍힘. `VY6("api_call")` / `VY6("tool_exec")` profiler span 별도.

### 3.2 per-call 메모리·CPU 스냅샷 (`DS1`, 확인)

```js
function DS1(){ let H=process.memoryUsage();
  z0H.rss/heapUsed/external = max(...)        // 세션 피크 추적
  let _=process.cpuUsage(), q=Date.now();
  cpuPercent = (Δuser+Δsystem)/(Δt*1000)*100;
  return {uptime, rss, heapTotal, heapUsed, external, arrayBuffers,
          constrainedMemory: process.constrainedMemory(), cpuUsage, cpuPercent}; }
```

`vi_`가 매 메타 빌드 시 `DS1()` 호출 → 모든 firstParty 이벤트가 호출 시점 RSS/heap/external/cpu% 스냅샷을 동반 (추정: ddtags엔 없고 본문 메타로).

### 3.3 세션 종료 메모리 요약 (`oE1`/`sE1` → `tengu_sdk_memory_summary`, 확인)

```
{ uptime_s, final_rss_bytes, final_heap_used_bytes, final_external_bytes,
  final_array_buffers_bytes,
  peak_rss_bytes, peak_heap_used_bytes, peak_external_bytes,
  constrained_memory_bytes,
  attr_<sub>_entries / attr_<sub>_bytes,         // 서브시스템별 보유량
  child_count, child_rss_bytes_total,
  child_<bash_shell|mcp_stdio|lsp|other>_rss_bytes }   // 자식 프로세스별 RSS
```

자식 프로세스 RSS를 종류별(`bash_shell`/`mcp_stdio`/`lsp`/`other`)로 집계 (`QmH`/`hq8`, `RR9`는 `/proc/self/statm` 기반). 리눅스에선 페이지 크기를 `rE1`로 실측.

### 3.4 `userBucket` — 결정론적 A/B 코호트 (`KC1`, 확인)

```js
KC1 = X6(()=>{ let H=pu();                              // 영구 userID
  let _=sha256(H).digest("hex");
  return parseInt(_.slice(0,8),16) % qC1; });            // qC1 = 30
```

- userID는 `pu()`: 설정에 있으면 재사용, 없으면 `crypto.randomBytes(32).hex` 생성 후 영구 저장.
- sha256(userID) 앞 8 hex(32bit)를 30으로 나눈 나머지 → 0~29 버킷. 메모이즈(`X6`)되어 세션 내 안정.
- `userBucket`은 ddtags 화이트리스트(`eS1`)에 포함 → 모든 Datadog 이벤트에 차원으로 붙음 → 서버측 코호트 슬라이싱.

### 3.5 식별 데이터 (확인)

전송되는 user-identifying:

- `userID` 자체는 raw로 안 보냄 — `userBucket`(sha256%30)으로만 노출 (해싱 확인).
- `sessionId`(`k_()`), `parentSessionId`, `agentId`, `teamName`, `model`, `version`, `platform`, `arch`, `entrypoint`, `subscriptionType`, `userType:"external"`는 그대로.

---

## 4. 흥미로운 발견 + opt-out

### 4.1 per-tool 메모리 프로파일링 (`tengu_tool_use_success`, 확인)

라인 13875, 바이트 ~10044900. **도구 한 번 호출할 때마다** 다음을 측정:

```js
d("tengu_tool_use_success",{
  messageID, toolName, isMcp, durationMs,
  rssDeltaBytes:      HH.rss - l.rss,          // 도구 실행 전후 RSS 델타
  heapUsedDeltaBytes: HH.heapUsed - l.heapUsed,
  externalDeltaBytes: HH.external - l.external,
  preToolHookDurationMs, permissionDurationMs,
  toolResultSizeBytes, toolInputSizeBytes,
  fileExtension,            // 파일 확장자만 (경로 원문 X)
  filePathLen,              // 경로 길이만
  bashCommandLen,           // bash 명령 길이만
  readHasLimit, readHasOffset,
  queryChainId, queryDepth, messageClientPlatform })
```

→ 도구 입력 내용은 안 보내지만 **확장자·경로 길이·명령 길이·RSS/heap/external 바이트 델타·권한 결정 소요·pre-hook 소요**를 도구별로 다 잰다. 도구 단위 메모리 델타 측정은 일반 텔레메트리에선 보기 드문 granularity.

### 4.2 가장 놀라운 측정들

- **`tengu_model_response_keyword_detected` { is_suggests_break:true }** (바이트 10136545, 확인): 모델 응답 텍스트에서 "쉬는 게 좋겠다"류 키워드를 감지해 별도 이벤트. 모델이 사용자에게 휴식을 권하는 빈도를 측정.
- **`tengu_flicker`** `{desiredHeight, actualHeight, reason}` — 터미널 UI 깜빡임(원하는 높이 vs 실제 가용 높이 불일치)을 텔레메트리로 보고.
- **`tengu_api_slow_first_byte`** `{model, provider, attempt, elapsed_ms}` — 첫 바이트 지연 임계 초과.
- **`tengu_event_loop_stall`** `{stall_duration_ms, expected_interval_ms, actual_interval_ms, total_stalls, cumulative_stall_ms, likely_sleep}` — Node 이벤트 루프 stall을 누적 측정, 절전 추정(`likely_sleep`)까지.
- **`tengu_heap_dump`** `{triggerManual, triggerAuto15GB, dumpNumber}` — heap 1.5GB 초과 시 자동 힙 덤프.
- **`tengu_startup_telemetry`** — `is_git, worktree_count, gh_auth_status, sandbox_enabled, prefers_reduced_motion` 등 환경 핑거프린트.
- **`tengu_verified_vs_assumed`** — Statsig 게이트지만, on이면 시스템 프롬프트에 "확인한 것과 가정한 것을 구분하라" 지시를 주입(프롬프트 A/B를 텔레메트리 키로 관리).
- **`tengu_copper_lantern`** / `tengu_amber_*` / `tengu_slate_*` — 광물·동물 코드네임 실험 게이트 수백 개. `tengu_*` 전체 1,122개의 과반.
- **`tengu_spinner_stalled_ui`**, **`tengu_streaming_idle_timeout`**, **`tengu_byte_watchdog_fired_late`** — 체감 응답성 워치독.

### 4.3 opt-out 동작 (확인)

검출된 env: `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL`, `OTEL_LOG_TOOL_DETAILS`.

- 텔레메트리 비활성 게이트는 `Bu()`(= `SE1() || AY()!==null || Gq_()` 등 복합). `Bu()` true면 `R98`(initializeDatadog)가 `i3_=false` 반환 → **Datadog 경로 전면 차단**.
- `Jq()!=="firstParty"`(Bedrock/Vertex/Mantle/AWS)면 `OpH` 첫 줄에서 즉시 return → Datadog 안 감 (텔레메트리 설정 무관).
- BYOC 환경(`CLAUDE_CODE_ENVIRONMENT_KIND==="byoc"`)은 `CLAUDE_CODE_BYOC_ENABLE_DATADOG` 미설정 시 `zR9()` true → Datadog 차단.
- **비활성 시에도 남는 것 (추정)**: opt-out 게이트는 주로 Datadog/분석 sink를 끄지만, OAuth 토큰 갱신·자동 업데이트·API 요청 자체(빌링 헤더 `x-anthropic-billing-header` 포함: `cc_version`, `cc_entrypoint`, `cc_workload`)는 기능 동작에 필요해 계속 전송됨. `crash`/`uncaught_exception` 류는 `DISABLE_ERROR_REPORTING`로 별도 제어. `userID` 생성·영구화(`pu`)는 텔레메트리 설정과 무관하게 일어남(`userBucket` 산출 근거).

확인/추정 표기:
- 확인: Datadog 토큰·엔드포인트·게이트·배치 상수, `tengu_*` 1122개, per-tool 메모리 델타 필드, `userBucket` sha256%30, perf marker 목록, OTel observe 3개 사이트.
- 추정: OTLP exporter 설정 경로(표준 `OTEL_*`), `DS1` 스냅샷의 ddtags 미포함 여부, opt-out 후 잔존 전송의 정확한 범위.
