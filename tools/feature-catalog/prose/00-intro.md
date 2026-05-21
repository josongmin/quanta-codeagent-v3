quanta-codeagent-v3에 **구현·배선된** 기능 전수 목록. **대**(주요 시스템) → **중**(하위 능력) → **소**(구체 기능/노브) 3단.

근거: RFC `rfc/0001-architecture.md`, ADR `docs/decisions/0001~0027`. cross-import는 `@/agent`만(슬라이스 격리). 운영 reference: [docs/runbooks/agent-loop-reference.md](docs/runbooks/agent-loop-reference.md).

## 성숙도 5단계 척도

있다/없다 이분이 아니라 **구현 폐쇄도(closure)** 를 5단계로:

| 등급 | 의미 |
|---|---|
| **L5 ●●●●●** | 완성·검증 — 구현·배선·단위+통합테스트, **실 LLM 스모크 또는 e2e 폐쇄** 확인됨 |
| **L4 ●●●●○** | 견고 — 구현·배선·단위+통합테스트(실 runAgent, mock LLM). 실 LLM 스모크는 미실시 |
| **L3 ●●●○○** | 동작 — 구현·배선됨, **단위테스트 위주**(통합 미검증) |
| **L2 ●●○○○** | 부분/한계 — 동작하나 **의도적 제약·advisory·옵셔널 미도달** |
| **L1 ●○○○○** | 골격/보류 — **타입/API만 노출**, 루프 미배선, 의식적 후속 |

`⚙️` = env/config 노브(기본 OFF·behavior-preserving).

> **R-Phase1-4 closure (2026-05-21)** — 2-round 코드 audit(8 parallel agents) 후 correctness + observability + 정직성 일괄 폐쇄. **P0** (HIGH): streaming-dispatch 3개소 rejection 경로(`Promise.all` → `Promise.allSettled`, drainDeferredSlots try/catch, collectResultBlocks 합성 `dispatchFailedBlock`) — ordering invariant 회복; `maybeCompact()` try-catch + `error` 이벤트 + graceful degrade; `resolveMemoryContext()` 동등 처리. **P1** (MED): proactive compaction 성공 시 `recovery:{reason:"compact",detail:"proactive"}` 방출(reactive 대칭); `stream_reset` tombstone orphan promise `.catch(()=>{})` 가드(Bun unhandledRejection 방지); jsonl-recorder degraded-line 실패에 `logger.warn` 진단; streamingTurn `AbortSignal` 계약 docstring. **P3** (defensive): CLI 진입점 `process.on("unhandledRejection")` defense-in-depth; `HookBus.on` 제너릭 cast → closure-erasure(런타임 안전 + 타입 표면 개선); `WorkingMemory.snapshot` shallow-copy 명시(`WorkingState.snapshot`의 deep-copy와 구분). **P2** 회귀 테스트 6개 파일(40 신규 테스트): `streaming-dispatch-rejection-e2e`(4), `observability-error-event-e2e`(4 — P0-2/P0-3/P1-1 검증 + default-OFF 회귀 가드), `skill-discover-errors`(11), `lsp-bridge-probe`(3 — Promise.race 5s 타임아웃 + 캐시 + extension fast-path), `mcp-client-errors`(8 — empty command + not-running), `env-knob-branches`(35 — `pickProvider`/`buildStore`/`buildMemoryConfig`/`parseRecallTiers`/`buildSubagentConfig`/`buildVerifyGuardConfig`/`buildSkillsConfig` 전 분기). 모든 변경 default-OFF byte-identical 불변식 무손상.
>
> **R-Phase5 closure (2026-05-21)** — 또 2-round 코드 audit(8 parallel agents) 추가 진행 후 7건 fix + 7 regression test. **P0** (HIGH): (A) `features.cleanup` hook이 `loop.ts finish()` 어디에도 invoke되지 않아 background subagent 자식이 부모 abort 시 orphan — 5 finish 사이트 모두 cleanup invoke + try-catch(`error` 이벤트로 surface, default-OFF 시 optional chain 무동작). (B) `cacheConversationPrefix`가 마지막 블록이 `tool_use`/`tool_result`/`thinking`일 때 `cache_control`을 비-text 블록에 부착 (Anthropic API 무시 + 일부 버전에서 reject) — backward walk으로 last text 블록을 찾아 부착, text 블록 부재 시 graceful no-op. (C) `onConfirm` 콜백이 throw할 때 admissibility-gate가 propagate(2개소: HITL always-confirm 114, mode-policy ask 149) — try-catch로 wrap, `preview:"error"` 태그된 deny로 surface. **P1** (MED): (D) `HARD_DENY rm-recursive-force-system-root` 정규식 3개 `[\s\S]*?` lookahead unbounded ReDoS 위험 → `{0,500}?` 명시 bound(real bash command well under, adversarial 10KB+ input 100ms 미만 완료). (F) anthropic adapter `thinking_delta` explicit drain(Phase-1 intent 문서화). (G) FallbackLLM이 fallback provider가 zero event yield + prior partial 존재 시 stream_reset tombstone 누락 → for-await 외부에서 명시 emit. (H) `SqliteStore.save()` INSERT 동기 throw가 `Promise<void>` boundary를 우회 → try-catch + `Promise.reject(new Error("SqliteStore.save(<id>) failed: ..."))`. **회귀 테스트 7 파일(43 tests)**: `subagent-cleanup-invocation-e2e`(3), `anthropic-cache-control-blocks`(5), `onconfirm-throw`(5 — 3개 throw path + 2개 control), `hard-deny-redos-bound`(11 — positive/negative + 10KB adversarial timing < 100ms), `anthropic-thinking-delta`(4), `fallback-empty-tombstone`(4), `sqlite-save-error`(5). 모든 변경 default-OFF byte-identical 불변식 무손상(`features.cleanup?.()` optional chain, fallback의 prior-partial gate, etc.).
>
> **R-Phase6 catalog-truth pass (2026-05-21)** — 4-agent 병렬 audit 후 카탈로그 정직성 갱신. 코드 무수정, 카탈로그 갱신만:
>
> **(1) Hell-case 확장 인벤토리** (외부 enrich, 카탈로그 미반영):
> - `tests/integration/mcp-e2e.test.ts` (16 tests) — original 3 happy-path + **13 adversarial hell-cases**: garbage frames, `id:null` ghost responses, notification-with-id 위반, 10MB single-line, `process.exit(1)` mid-call crash, `setTimeout(1<<30)` sigkillable hang, 5s slow response, NUL/control bytes in result, 20-parallel concurrent calls, multi-server registry collision. JSON-RPC/stdio 경계의 untrusted-server CVE surface 폐쇄.
> - `tests/integration/fs-jail-e2e.test.ts` (21 tests) — original 3 + **18 hell-cases**: path-traversal-vectors(5 — `../etc/passwd`, URL-encoded `%2f`, collapsed `./..//`, absolute paths, 50× repeated `../`), symlink-escapes(5 POSIX — inside-to-outside, parent-chain, a→b→a loops, dangling), TOCTOU-races(2 — file→symlink swap, atomic rename), unicode-normalization(3 — NFC vs NFD, U+202E RTL override detect, U+202E spoof no-traversal), edge-values(2 — empty string + `..`alone), opt-out hatch(2). 모든 escape vector detected + 루프 continue(no throw-out-of-dispatch) + 디스크 파일 미생성.
> - `tests/integration/agent-recovery-e2e.test.ts` (22 tests), `subagent-fork-e2e.test.ts` (16), `subagent-cancellation-e2e.test.ts` (14), `resume-e2e.test.ts` (21) — 각각 hell-case 배터리 (예산 회계 / fork 라이프사이클 / cancellation FSM / corrupt state file·orphan tool_use·concurrency race) 포함.
>
> **(2) 신규 통합 테스트 파일**:
> - `tests/integration/session-chaos-and-attack.test.ts` (19 tests) — 세션 상태 chaos/attack/replay/corruption (resume-e2e 보강 layer).
> - `tests/integration/mode-block-matrix-e2e.test.ts` (4 tests) — mode×tool admissibility matrix(`mode-block-e2e`의 결합 cases 확장).
> - `tests/integration/bench-python-harness-e2e.test.ts` (7 tests) — bench Python harness 통합 e2e(REQUIRE_CONTRACT-gated 가능).
> - `tests/integration/mcp-client.test.ts` (5)+`mcp-bridge.test.ts` (2) — `mcp-e2e`의 foundation layer(JSON-RPC client + Tool adapter).
>
> **(3) `src/shared/runtime-config.ts` 신규 frozen-config 모듈** (R-Phase4-5 between 추가, 카탈로그 미언급):
> - `runtimeConfig()` — process.env 1회 snapshot 후 frozen singleton 반환(per-run immutable).
> - `__resetRuntimeConfig()` — **test seam**: fs-jail-e2e 같은 env-toggle 테스트가 mid-run env 변경을 관찰하려면 frozen cache를 reset해야 함(`tests/integration/fs-jail-e2e.test.ts:72,77` 사용).
> - `LOG_LEVELS` / `LogLevel` / `RuntimeConfig` interface 노출.
> - 추가 운영 env knobs: ⚙️`QUANTA_GIT_SHA`(trajectory commit hash), ⚙️`QUANTA_PRICING_VERSION`(pricing lock), ⚙️`QUANTA_SESSIONS_DIR`(sessions root override), ⚙️`QUANTA_TOOL_OUTPUT_SPILL_KEEP`(spill GC retention count). 모두 default-OFF / 안전 default.
>
> **(4) catalog 베이스라인 갱신** — 검증: tsc 0 · biome clean · `bun test` 2562 pass / 0 fail / 6 skip / 8965 expect across 205 files (150 unit + 52 integration + 3 contract). 이전 R-Phase5 베이스라인 2236/181 대비 **+326 tests / +24 files** (hell-case 확장 + 신규 e2e 파일 + R-Phase5 regression tests 누적).
