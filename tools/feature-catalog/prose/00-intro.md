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
