# Aug-25 Wave 1 — 아키텍처·코드퀄리티 개선 후보

> 2026-08-25 병렬 어딧 — **Wave 1** (god-code / slice-boundary / lint / arch-debt) + **Wave 2** (agent-loop / permission-memory-session / bench-host / test-catalog) + **Wave 3** (llm-mcp-lsp-stream / sdk-web-ipc / tool-security-retrieval / config-migration-session).
> **목적:** correctness·구조·품질·기술부채 개선 후보를 코드 위치·목적·근거와 함께 남김.
> **재현 기준:** `main` worktree, `bun run lint:debt` 통과, god-code ratchet 7/7 통과.

## Snapshot

| 항목 | 값 |
|------|-----|
| `src/` 슬라이스 | 50 |
| TypeScript LOC (`src/**/*.ts`) | ~627k |
| 테스트 파일 (`*.test.ts`) | ~3,312 |
| 900–999줄 cohort | **24 / 24** (ceiling full) |
| god-module (>1000줄) allowlist | **0** |
| god-function (>150줄 body) allowlist | **0** |
| `noNonNullAssertion` (prod/tests) | **0 / 0** (2026-08-25 소진 완료) |
| `noExcessiveCognitiveComplexity` ceiling | prod **143**, tests **97**, worst **59** |

## 요약

| 등급 | W1 | W2 | W3 | 합계 | 의미 |
|------|----|----|-----|------|------|
| 🔴 P0 | 4 | 0 | 0 | 4 | CI ratchet 직전 |
| 🟠 P1 | 10 | 12 | 14 | 36 | correctness / security / wiring |
| 🟡 P2 | 9 | 18 | 24 | 51 | parity / silent-fail / catalog |
| 🟢 P3 | 6 | 7 | 7 | 20 | docs / low ROI |
| **합계** | **29** | **37** | **45** | **111** | |

## 인덱스

| # | 등급 | 분류 | 코드 위치 | 제목 |
|---|------|------|-----------|------|
| [1](#1) | 🔴 p0 | god-code | `src/apps/bench/run-main.ts:998` | 900-band cohort full — bench entry 1줄 여유 |
| [2](#2) | 🔴 p0 | god-code | `src/host/runtime/agent-config-assembler.ts:988` | `assembleAgentConfig` + 989줄 — 조립 루트 분할 필요 |
| [3](#3) | 🔴 p0 | god-code | `src/agent/loop/same-turn-engine.ts:21` | `runTurn` body **150줄** — god-function cliff |
| [4](#4) | 🔴 p0 | god-code | cohort 전체 | 24/24 approaching-module ceiling — 신규 900대 파일 추가 불가 |
| [5](#5) | 🟠 p1 | srp | `src/agent/types.ts:89-103` | `AgentConfig` flat surface **~220 fields** — SRP 회귀 압력 |
| [6](#6) | 🟠 p1 | god-code | `src/agent/compaction.ts:983` | compaction 모놀리스 + `Date.now()` + complexity |
| [7](#7) | 🟠 p1 | god-code | `src/tool/index.ts:63-918` | barrel ~660줄 re-export + registry 혼재 |
| [8](#8) | 🟠 p1 | complexity | `src/tool/debug/dap-client.ts:99` | `ingest` complexity **38** (threshold 15) |
| [9](#9) | 🟠 p1 | complexity | `src/tool/git/branch-switch.ts:198` | `gitBranchSwitchTool.execute` complexity **38** |
| [10](#10) | 🟠 p1 | di | `src/agent/admissibility-gate/gates.ts:307-311` | `getDefaultPermissionStore()` service-locator fallback |
| [11](#11) | 🟠 p1 | determinism | `src/agent/loop/turn-iteration.ts:81` | `Date.now()` in turn provenance (allowlist burn-down) |
| [12](#12) | 🟠 p1 | config | `src/agent/session-resource-registry/auto-sweep.ts:211+` | raw `process.env` — `/config set` precedence 우회 |
| [13](#13) | 🟠 p1 | arch | `src/llm/types.ts:185-282` | leaky `StreamEvent` — content/telemetry 혼합 |
| [14](#14) | 🟠 p1 | isolation | `tests/unit/_arch/slice-boundary-configs.ts:513-523` | `side-agent` whole-slice `allowImports` (`@/llm`, `@/tool`) |
| [15](#15) | 🟡 p2 | isolation | `tests/unit/_arch/slice-boundary-configs.ts:8-25` | `PEER_LIBRARY_DENY`에 `@/security`, `@/auth` 미포함 |
| [16](#16) | 🟡 p2 | mirrors | `src/tool/types/context-seams.ts` | ~47 mirror types, `AssertEqual`은 4쌍만 |
| [17](#17) | 🟡 p2 | arch | `src/agent/*-wire.ts`, `src/agent/*-bridge.ts` | agent slice composition junk drawer |
| [18](#18) | 🟡 p2 | god-code | `src/llm/factory.ts:857` | provider registry + multicloud + reasoning 한 파일 |
| [19](#19) | 🟡 p2 | feature-catalog | `tools/feature-catalog/baseline.json` | stale/broken gate snapshot (May 2026) |
| [20](#20) | 🟡 p2 | incomplete | `tools/feature-catalog/features/02-tool-system/99-deferred-tool-registry.yaml` | seam-only: producer 있음, consumer 없음 |
| [21](#21) | 🟡 p2 | permission | `src/permission/gate-pattern-wire.ts:196` | ADR-0061 remember-patterns surface TODO |
| [22](#22) | 🟡 p2 | env | `src/apps/cli/internal.ts` | 10× raw `process.env` (S5 migrate TODO) |
| [23](#23) | 🟡 p2 | biome | S4b leaf slices | AST-only fence — IDE-time `noRestrictedImports` 없음 |
| [24](#24) | 🟢 p3 | docs | `src/storage/service.ts:~328` | patch가 `FileSystemPort` 쓴다는 오해 유발 주석 |
| [25](#25) | 🟢 p3 | singleton | `src/tool/index.ts:920-925` | `defaultTools` eager singleton — 신규 import 금지 |
| [26](#26) | 🟢 p3 | agent | `src/agent/session-resources.ts:193` | git numstat 수집 TODO (observability) |
| [27](#27) | 🟢 p3 | agent | `src/agent/types/wire-slots-core.ts:342` | wire-slot hookup TODO |
| [28](#28) | 🟢 p3 | lint | `src/apps/eval/index.ts` | 69/69 `noConsole` ceiling — CLI stdout product |
| [29](#29) | 🟢 p3 | barrel | `src/protocol/`, `src/integrations/` | `requireSliceBarrel` 미적용 |

### Wave 2 인덱스 (#30–66)

| # | 등급 | 분류 | 코드 위치 | 제목 |
|---|------|------|-----------|------|
| [30](#30) | 🟠 p1 | correctness | `src/agent/loop/same-turn-engine.ts:128-130` | mid-stream abort 시 streaming assistant text `/resume`에 누락 |
| [31](#31) | 🟠 p1 | correctness | `src/agent/loop/compaction-wire.ts:319-321` | `/summarize-now`가 `recordSendCount` 생략 — baseline skew |
| [32](#32) | 🟠 p1 | bench | `src/runner/batch/eval/driver/config-build.ts:656+` | bench `buildConfig`에 `admissibility.permissionStore` 미주입 |
| [33](#33) | 🟠 p1 | bench | `src/host/runtime/sandbox-escalation-wire.ts:220-223` | sandbox escalation — store 없으면 silent no-op |
| [34](#34) | 🟠 p1 | dead-code | `src/agent/primary-rail/index.ts:75-86` | `decidePrimaryRailFinishGate` — production caller 0 |
| [35](#35) | 🟠 p1 | catalog | `tools/feature-catalog/features/09-integration/observability-ws-sink.yaml:8,19` | L4 + `ui_surfaces: [cli]` + `cli: missing` 모순 |
| [36](#36) | 🟠 p1 | dead-code | `src/runner/orchestrate/run-once.ts:100` | `runOnce` orchestrate — barrel 미export, production unwired |
| [37](#37) | 🟠 p1 | dead-code | `src/agent/retry-pretry.ts:112`, `src/tool/_shared/glob-write-gate.ts:27` | `withRetryPRetry`, `globWriteGuardEnabled` — prod importer 0 |
| [38](#38) | 🟠 p1 | permission | `src/permission/gate-pattern-wire.ts:195-203` | ADR-0061 pending-permission queue — dispatch 미연결 |
| [39](#39) | 🟠 p1 | test | `tests/unit/lsp-atomic-write-phase-contract.test.ts:6-8` | hellgate GREEN on phase-contract revert |
| [40](#40) | 🟠 p1 | test | `tests/unit/tool/debug/debug-inspect-wire-contract.test.ts:6-10` | debug-inspect wire regressions — parent hellgate 미흡 |
| [41](#41) | 🟠 p1 | test | — | deferred async tools — `tests/integration` gap |
| [42](#42) | 🟡 p2 | ux/debug | `src/apps/cli/session-bootstrap.ts:355-357` | `/state` skill-scope가 live registry/mode filter와 drift |
| [43](#43) | 🟡 p2 | arch | `src/agent/turn-closeout.ts:15-24` | `sealTranscript` 문서화만, 구현 없음 |
| [44](#44) | 🟡 p2 | resume | `src/agent/loop/turn-outcome.ts:86-88` | `interrupted` park — `/resume` buffer 미캡처 |
| [45](#45) | 🟡 p2 | permission | `src/permission/json-state-file/locking.ts:108-144` | lock timeout → unprotected write |
| [46](#46) | 🟡 p2 | permission | `src/permission/permission-store.ts:858` | denial path `flushDebounced` — `flushDurable` 미사용 |
| [47](#47) | 🟡 p2 | memory | `src/apps/web-daemon/runtime-factory/session-collaborators.ts:193-197` | web session — memory consolidator 미연결 |
| [48](#48) | 🟡 p2 | memory | `src/memory/typed-event/in-memory-store.ts` | typed history — durable adapter 없음 |
| [49](#49) | 🟡 p2 | session | `src/session/store.ts:509-512` | session save — cross-process lock 없음 |
| [50](#50) | 🟡 p2 | session | `src/session/store.ts:831-834` | rewind — JSONL envelope 미truncate |
| [51](#51) | 🟡 p2 | session | `src/session/store.ts:847-849` | legacy session message.id 없으면 rewind silent no-op |
| [52](#52) | 🟡 p2 | session | `src/session/crash-resume.ts:39-49,136-139` | crash-resume default-OFF + marker persist 실패 silent |
| [53](#53) | 🟡 p2 | permission | `src/permission/shell/assess.ts` | shell assess ~547줄 monolith — semantic drift risk |
| [54](#54) | 🟡 p2 | permission | `src/permission/shell/parser.ts:106-107` | parser 미ready → `unknown` assessment window |
| [55](#55) | 🟡 p2 | bench | `src/runner/batch/eval/closure-session.ts:123-124` | closure stakes/uncertainty neutral 고정 (jun-20 #8 잔존) |
| [56](#56) | 🟡 p2 | bench | `src/apps/bench/eval/driver/agent-phase.ts:508-534` | tentative-patch — apps-only, runner drift |
| [57](#57) | 🟡 p2 | bench | `src/agent/primary-rail` vs `src/runner/batch/eval/repair/decision.ts:46-51` | primary-rail vs `repairCandidateClears` SSOT 분리 |
| [58](#58) | 🟡 p2 | catalog | `tools/feature-catalog/features/07-resilience/outcome-exit-code-table.yaml` | L4 + cli surface + `cli: missing` |
| [59](#59) | 🟡 p2 | catalog | `tools/feature-catalog/features/01-agent-loop/control-request-surface.yaml` | L3 + web wired / CLI unwired |
| [60](#60) | 🟡 p2 | ratchet | `tests/unit/src-no-sketchy-code.test.ts` | `no-process-env-outside-config` allowlist **181** |
| [61](#61) | 🟡 p2 | test | `tools/feature-catalog/test-audit-baseline.json` | R10 env-isolation **648** rows — injection 미검증 |
| [62](#62) | 🟡 p2 | test | `tests/integration/` | `src/session/` kernel — integration hit 0 |
| [63](#63) | 🟢 p3 | docs | `src/permission/skill-gate.ts:49-50` | `filterSpecsByScope` 주석 stale (v2 gate 설명) |
| [64](#64) | 🟢 p3 | docs | ADR-0046, `docs/ARCHITECTURE.md:313` | lock shipped인데 문서는 "no lock" |
| [65](#65) | 🟢 p3 | bench | `src/runner/batch/eval/knobs-bench.ts:387-397` | `sotaOn` dead telemetry (jun-20 #14) |
| [66](#66) | 🟢 p3 | bench | `src/agent/lsp-bridge/warm-pool.ts:145-196` | import-scan 200-line cap fail-open (jun-20 #21 accepted) |

### Wave 3 인덱스 (#67–111)

| # | 등급 | 분류 | 코드 위치 | 제목 |
|---|------|------|-----------|------|
| [67](#67) | 🟠 p1 | mcp | `src/mcp/isolated-client.ts:219-228` | isolated MCP — protocol downgrade 없음 |
| [68](#68) | 🟠 p1 | llm | `src/llm/retry/decorator-policy.ts:83-98` | HITL kinds → `consult_markers` → message retry 우회 |
| [69](#69) | 🟠 p1 | mcp | `src/mcp/transports/http-sse.ts:501-521` | SSE GET `!ok` silent return — half-dead transport |
| [70](#70) | 🟠 p1 | security | `src/tool/container-exec/tool.ts:99-111` | `classifySource` 없음 — Layer-1 redaction skip |
| [71](#71) | 🟠 p1 | security | `src/security/sensitivity-classifier.ts:271-277` | `bash -c printenv` wrapper bypass |
| [72](#72) | 🟠 p1 | tool | `src/tool/grep/index.ts:99-131` | symlink hit — per-file re-jail 없음 (`glob`는 있음) |
| [73](#73) | 🟠 p1 | sdk | `src/protocol/session/verb-surface.ts:55-100` | SDK verbs — posture/skill/objective 누락 |
| [74](#74) | 🟠 p1 | catalog | `realtime-websocket-codex.yaml:17-22` | realtime `web: full` — web-daemon import 0 |
| [75](#75) | 🟠 p1 | parity | `src/apps/agent/mode-presets/*.ts` | `apps/agent` — `bootstrapSession` 우회 |
| [76](#76) | 🟠 p1 | session | `src/apps/cli/session-cmd.ts:315-324` | `/session import` — sidecar parse만, hydrate 없음 |
| [77](#77) | 🟠 p1 | session | `src/apps/cli/session-cmd.ts:203` | `/session export` — sidecar 미직렬화 |
| [78](#78) | 🟠 p1 | resilience | `src/agent/types/wire-slots-session.ts:537-540` | ADR-0217 error routing — composition 미wire |
| [79](#79) | 🟡 p2 | lsp | `src/lsp/adapters/base/atomic-edit.ts:121-131` | workspace edit — EXDEV copy+delete fallback 없음 |
| [80](#80) | 🟡 p2 | stream | `src/stream/adapters/tee.ts:66-86` | `TeeStream.onFirstDegrade` — CLI REPL만 wire |
| [81](#81) | 🟡 p2 | observability | `src/observability/metrics/instrument-genai.ts:120,143` | GenAI metrics `Date.now()` hardcode |
| [82](#82) | 🟡 p2 | lsp | `src/lsp/adapters/base/transport.ts:86` | LSP spawn raw `process.env` budget knobs |
| [83](#83) | 🟡 p2 | llm | `src/llm/empty-stream-breaker.ts:88-103` | `signature_delta` non-contentful → false breaker trip |
| [84](#84) | 🟡 p2 | mcp | `src/mcp/isolated-client.ts:219-222` | isolated `initialize` — `capabilities: {}` |
| [85](#85) | 🟡 p2 | llm | `src/llm/replay/jsonl-store.ts:201-204` | replay append tail `.catch(() => {})` |
| [86](#86) | 🟡 p2 | parity | `src/apps/cli/serve-stdio-cmd.ts:262-271` | `serve --stdio` — skills hard-disabled |
| [87](#87) | 🟡 p2 | protocol | `src/apps/web-daemon/server/ws-handlers.ts:254-280` | OOB WS frames — session.v1 밖 |
| [88](#88) | 🟡 p2 | web | `src/apps/web-daemon/server/ws-handlers.ts:299-307` | turn abort 시 `request_user_input` hang |
| [89](#89) | 🟡 p2 | parity | `src/apps/agent/index.ts:578-598` | `apps/agent` — CLI gate seeding 없음 |
| [90](#90) | 🟡 p2 | remote | `src/apps/cli/index.ts:205` only | `QUANTA_REMOTE_RUNNER` — CLI만 |
| [91](#91) | 🟡 p2 | security | `src/sdk/connect.ts:119-122` | WS auth token in query string |
| [92](#92) | 🟡 p2 | memory | `src/apps/web-daemon/.../agent-config-base.ts` | web — memory write/recall path omit |
| [93](#93) | 🟡 p2 | search | `src/tool/search-codebase/index.ts:205-227` | scoped search — global top-50 false-empty |
| [94](#94) | 🟡 p2 | retrieval | `src/retrieval/indexer/default-scanner.ts:44` | default index `src/**/*.ts` only |
| [95](#95) | 🟡 p2 | tool | `src/tool/shadow-verify/` vs bench | shadow_verify — bench unwired |
| [96](#96) | 🟡 p2 | skill | `src/skill/playbook/plan-writeback/` | plan-writeback — host consumer 0 |
| [97](#97) | 🟡 p2 | skill | `src/skill/playbook/wire.ts:68-99` | playbook auto-dispatch — CLI opt-in only |
| [98](#98) | 🟡 p2 | skill | `src/skill/tool-search.ts:309-311` | ToolSearch skills — unwired 시 silent empty |
| [99](#99) | 🟡 p2 | assemble | `src/runner/assemble/llm.ts:221` | assemble slice `runtimeConfig()` — no-env invariant 위반 |
| [100](#100) | 🟡 p2 | migration | `src/migration/external-config/persist.ts:908-910` | throttle ledger write fail → re-clobber |
| [101](#101) | 🟡 p2 | migration | `src/migration/external-config/run.ts:164-167` | detect crash → silent empty inventory |
| [102](#102) | 🟡 p2 | migration | `src/migration/external-config/ledger.ts:62-67` | ledger read error → empty throttle |
| [103](#103) | 🟡 p2 | session | `src/session/import-export.ts:542-543` | v2 import — digest optional → tamper 허용 |
| [104](#104) | 🟡 p2 | session | `src/ipc/session-import.ts:261-274` | IPC import — envelope port bypass |
| [105](#105) | 🟡 p2 | reactor | `src/reactor/trigger-source-pr-comment.ts:303-314` | `gh` spawn/parse failure fully silent |
| [106](#106) | 🟡 p2 | workflow | `src/workflow/executor.ts:231-285` | builder throw → silent item drop |
| [107](#107) | 🟡 p2 | search | `src/runner/assemble/search-index-backend.ts:252-254` | embedder fallback — bare catch |
| [108](#108) | 🟡 p2 | plugin | `src/plugin-isolation/bun-spawner.ts:82-88` | DXT manifest `env` — linker key inject 가능 |
| [109](#109) | 🟢 p3 | tool | `src/tool/container-exec/tool.ts:42-50` | stream cap — module-load `process.env` |
| [110](#110) | 🟢 p3 | assemble | `src/runner/assemble/session-state.ts:43-47` | system prompt rebuild fail — silent fallback |
| [111](#111) | 🟢 p3 | observability | `src/observability/metrics/in-memory-registry.ts:424-435` | metric sink throw — count-only signal |

## 재발 패턴 (테마)

- **900-band treadmill**: 파일이 999까지 자라고 split → 다른 파일이 다시 900대 진입. cohort ceiling 24/24로 **새 기능 = 먼저 split**.
- **god-config smell**: `AgentConfig` field-count는 ratchet 없음. wire-slots로 **파일**만 쪼갰고 **표면**은 220 fields.
- **slice fence ≠ IDE feedback**: AST test는 CI에서만; Biome override 없는 leaf는 로컬에서 위반을 못 봄.
- **composition fallback**: `getDefaultPermissionStore()`, `defaultTools`, raw `process.env` — 테스트/서피스마다 다른 진입점.
- **mirror drift**: 격리는 맞지만 `@/tool` ↔ `@/agent` 타입 동기화가 convention + 4쌍 compile check에 의존.
- **wired≠engages**: primary-rail, pending-permission queue, consolidator — producer/타입은 있는데 loop/bench에 안 붙음 (jun-20 테마 재발).
- **surface split-brain**: CLI는 `permissionStore` inject, bench/web는 omit → singleton fallback에 의존.
- **catalog honesty**: L4 + `ui_surfaces: [cli]` + `cli: missing` — maturity가 실제 reachability보다 높음.
- **hellgate teeth gap**: phase-contract / wire-contract 테스트가 parent hellgate와 분리 → revert해도 GREEN.
- **surface parity drift**: `quanta` CLI vs `apps/agent` vs web-daemon vs `serve --stdio` — bootstrap/gate/skills/memory/remote 불일치.
- **import≠hydrate**: envelope parse/report는 하는데 live store에 안 넣음 (session sidecar).
- **security layer gap**: Layer-1 redaction은 `classifySource` 선언에 의존; tool마다 누락 가능.
- **isolated vs in-process parity**: MCP/LSP/retry 경로가 isolated spawn에서 축소·다름.

---

## 상세

### 1

**🔴 P0 — 900-band cohort: `run-main.ts` 1줄 여유**

| | |
|---|---|
| **코드** | `src/apps/bench/run-main.ts` (**998 lines**) |
| **목적** | SWE-bench / bench CLI 메인 오케스트레이션 (dataset load, worker dispatch, grading hook) |
| **근거** | `tools/god-code/allowlist.json` — `approachingModuleCeiling.max: 24`, 현재 cohort **24/24**. 이 파일은 **999가 되면 god-module** (1000 hard gate). bench에 기능 하나 추가하면 CI red. |
| **개선** | `run-main.ts`를 `run-main-dataset.ts` + `run-main-dispatch.ts` + thin `index`로 분할. cohort `max`를 23으로 내림. |

---

### 2

**🔴 P0 — `agent-config-assembler.ts` 조립 루트 비대**

| | |
|---|---|
| **코드** | `src/host/runtime/agent-config-assembler.ts` (**988 lines**), `assembleAgentConfig` body ~**110 lines** |
| **목적** | 모든 surface(CLI/web/headless/bench)가 공유하는 `AgentConfig` 조립 — LLM, tools, memory, permission, stream wire-up |
| **근거** | 900-band + 함수도 150 cliff 접근. host/runtime은 composition root인데 agent loop만큼 churn이 큼. `src/host/runtime/agent-arg-builder.ts` (904줄)와 역할 중복 압력. |
| **개선** | subsystem별 assembler 추출: `assemble-llm-config.ts`, `assemble-tool-ports.ts`, `assemble-memory-config.ts`. `assembleAgentConfig`는 orchestrator만 남김. |

---

### 3

**🔴 P0 — `runTurn` god-function cliff**

| | |
|---|---|
| **코드** | `src/agent/loop/same-turn-engine.ts:21` — `runTurn` body **150 lines**, complexity **32** |
| **목적** | 단일 agent turn의 stream consume → tool dispatch → recovery/compaction arm 실행 |
| **근거** | `godFunctionMaxLines: 150` — **다음 줄 추가 = god-function violation** (allowlist 비어 있음). 이미 complexity 2× threshold. `agent/loop/*` 분할의 다음 타겟. |
| **개선** | `runTurn`에서 stream arm / tool arm / compaction trigger를 각각 private helper로 추출. `turn-loop.ts` (197, complexity 28)와 함께 정리. |

---

### 4

**🔴 P0 — approaching-module cohort saturated**

| | |
|---|---|
| **코드** | `tools/god-code/allowlist.json` + 24 files in 900–999 band (full list below) |
| **목적** | god-module(>1000) 진입 전 조기 경보 — cohort가 full이면 **split 없이는 어떤 파일도 900대로 성장 불가** |
| **근거** | ratchet comment (aug-23 audit): 하루에 30→27 drift, split이 다음 feature에 상쇄됨. 현재 24/24. |
| **개선** | 우선순위 split 후보: `run-main.ts`, `agent-config-assembler.ts`, `compaction.ts`, `tool/index.ts`, `gated-tools.ts` (962줄). |

**900–999 band 전체 (2026-08-25):**

```
998  src/apps/bench/run-main.ts
988  src/host/runtime/agent-config-assembler.ts
983  src/agent/compaction.ts
973  src/tool/index.ts
973  src/runner/session-ops/index.ts
962  src/tool/surface/gated-tools.ts
961  src/config/knob-inventory/extra.ts
961  src/apps/bench/commands/box.ts
960  src/apps/bench/remote/pool/worker.ts
944  src/llm/openai-responses-wire.ts
940  src/apps/terminal/brain-mode.ts
935  src/apps/bench/remote/box-session/ec2-lifecycle.ts
934  src/runner/batch/report-official-grade.ts
934  src/apps/eval/index.ts
928  src/runner/batch/corpus/repo-version-specs.ts
927  src/host/mcp-composition.ts
926  src/permission/permission-store.ts
919  src/apps/cli/internal.ts
915  src/migration/external-config/persist.ts
914  src/agent/admissibility-gate/gates.ts
912  src/agent/mode.ts
909  src/apps/bench/promax/campaign/gates.ts
908  src/agent/budget-ledger.ts
904  src/host/runtime/agent-arg-builder.ts
```

---

### 5

**🟠 P1 — `AgentConfig` 220-field surface (SRP)**

| | |
|---|---|
| **코드** | `src/agent/types.ts:89-103` (SRP warning), wire-slots: `wire-slots-core.ts` (556줄, 42 fields), `wire-slots-session.ts` (615줄, 42), `wire-slots-runtime.ts` (540줄, 35), `wire-slots-compose.ts` (358줄, 20) |
| **목적** | ReAct loop에 필요한 모든 의존성을 하나의 config bag으로 전달 |
| **근거** | 파일은 wire-slots로 쪼갰지만 **flat surface ~220 fields**. 주석은 "53-field"/"71-field" 등 **stale**. `FeaturesConfig` Pick alone이 30+ fields. **field-count ratchet 없음** — line-count만 guard. |
| **개선** | (1) subsystem-owned config 객체로 분리 (`LlmSessionConfig`, `ToolSessionConfig` …) (2) 신규 field = owning `Pick<>` 필수 static scan (3) stale 주석 갱신 (4) optional: field-count ratchet |

---

### 6

**🟠 P1 — `compaction.ts` 모놀리스**

| | |
|---|---|
| **코드** | `src/agent/compaction.ts` (**983 lines**), `compactIfNeeded` ~91 body lines, `compactedAt: Date.now()` at ~823 |
| **목적** | WM compaction trigger / execution / wire-format / telemetry |
| **근거** | 900-band + `Date.now` allowlist (`no-date-now-in-domain`) + multiple complexity hotspots. replay determinism에 compaction timestamp가 들어가면 drift. |
| **개선** | `compaction-trigger.ts`, `compaction-execute.ts`, `compaction-wire.ts` 분할. `now: () => number` inject from composition root. |

---

### 7

**🟠 P1 — `tool/index.ts` barrel bloat**

| | |
|---|---|
| **코드** | `src/tool/index.ts` (**973 lines**): imports 1–62, re-exports **~660 lines** (63–722), `CONDITIONAL_REGISTRATIONS` 733–825, `buildDefaultTools` 835–918 |
| **목적** | built-in tool catalog + port-gated conditional registration (OCP table) |
| **근거** | re-export만 ~500줄 줄일 수 있음. `gated-tools.ts` (962줄)가 sibling risk. `buildBaseDefaultTools` largest fn 75 lines (아직 safe). |
| **개선** | `tool/exports/read-tools.ts`, `mutating-tools.ts`, `default-tool-registrations.ts`, `default-base-tools.ts` 추출 → index는 thin facade (~300줄). |

---

### 8

**🟠 P1 — `dap-client.ingest` complexity 38**

| | |
|---|---|
| **코드** | `src/tool/debug/dap-client.ts:99` |
| **목적** | Debug Adapter Protocol response/event ingest + pending request map resolution |
| **근거** | biome cap 15, pinned worst prod sites. lint-debt prod ceiling **143** — 하나 고치면 count↓ 가능. |
| **개선** | response routing vs event routing 분리; pending-map lookup pure helper. |

---

### 9

**🟠 P1 — `gitBranchSwitchTool.execute` complexity 38**

| | |
|---|---|
| **코드** | `src/tool/git/branch-switch.ts:198` |
| **목적** | dirty tree 처리 + branch create/switch + permission hooks |
| **근거** | 동일 complexity debt. git tool은 permission/admissibility와 교차 — 버그 시 user-visible. |
| **개선** | dirty-tree resolution / branch creation / switch를 pure function + table-driven policy. |

---

### 10

**🟠 P1 — `getDefaultPermissionStore()` fallback**

| | |
|---|---|
| **코드** | `src/agent/admissibility-gate/gates.ts:307-311` |
| **목적** | legacy caller가 `AgentConfig.admissibility.permissionStore`를 omit할 때 singleton fallback |
| **근거** | ratchet `no-getDefaultPermissionStore-outside-composition` — 허용 site는 `permission-store.ts`, `apps/cli/repl.ts`, `apps/web-daemon/runtime-factory.ts` 뿐. gates.ts는 **transitional carve-out**. hidden coupling → multi-process LWW (ADR-0046) 테스트 어려움. |
| **개선** | 모든 surface에서 `permissionStore` inject 확인 (headless, bench, agent modes). fallback 삭제. |

---

### 11

**🟠 P1 — turn provenance `Date.now()`**

| | |
|---|---|
| **코드** | `src/agent/loop/turn-iteration.ts:81` (`startedAt`), `src/agent/loop/compaction-wire.ts:301,609,619,681`, `src/agent/loop/emit-helpers.ts:91,115` |
| **목적** | turn/usage event timestamp for stream + compaction wire |
| **근거** | `no-date-now-in-domain` ratchet on `agent/` + `permission/` with BURN-DOWN allowlist. replay/eval에서 timestamp가 outcome에 스며들 수 있음. clean pattern exists: `inbound-mode.ts`, `side-agent-runner.ts` inject `now` only. |
| **개선** | composition root → `runAgent({ now })` → loop wire. allowlist entry 제거 per site. |

---

### 12

**🟠 P1 — session registry raw env**

| | |
|---|---|
| **코드** | `src/agent/session-resource-registry/auto-sweep.ts:211,217,233,248`, `inspector.ts:358` |
| **목적** | session registry sweep interval / cap knobs |
| **근거** | `process.env[QUANTA_SESSION_REGISTRY_*]` — `runtimeConfig()` / `/config set` precedence 우회. `no-process-env-outside-config` ratchet 위반 후보. |
| **개선** | `runtimeConfig().sessionRegistry.*` 또는 injected `env` bag. pattern: `src/tool/web/providers/from-env.ts:48`. |

---

### 13

**🟠 P1 — leaky `LLMPort.StreamEvent`**

| | |
|---|---|
| **코드** | `src/llm/types.ts:185-282` (12+ event kinds), `src/llm/assemble.ts` (ignores usage/progress/delta), `src/agent/streaming-dispatch.ts`, `src/llm/fallback.ts` (`stream_reset`) |
| **목적** | 단일 stream으로 assistant content + billing + transport + UI telemetry 전달 |
| **근거** | ARCHITECTURE.md "leaky-by-design" — Anthropic-shaped fields. **버그 클래스:** `tool_use_delta`는 dispatch에 contentful, `assembleFromEvents`는 no-op. 새 adapter가 `tool_use_end` 없이 delta만내면 tool call silent drop. `collectText` 중복 구현 (`edit-repair-wire.ts`, `issue-hint/agentless-localize.ts`). |
| **개선** | (1) shared `collectAssistantTurn(events)` in `@/llm` (2) long-term: content vs telemetry port split (3) adapter contract test: `tool_use_start` ⇒ `tool_use_end`. |

---

### 14

**🟠 P1 — `side-agent` broad allowImports**

| | |
|---|---|
| **코드** | `tests/unit/_arch/slice-boundary-configs.ts:513-523`, consumer `src/side-agent/worker-charter-runner.ts:37-46` |
| **목적** | OS-process worker가 자체 LLM+tool surface를 가져 spawn-depth containment 유지 |
| **근거** | `@/llm`, `@/tool` **whole-slice** allow — `side-agent` 아래 **어떤 파일이든** 전체 llm/tool import 가능. 의도는 composition-root이나 SSOT상 가장 넓은 carve-out. |
| **개선** | exact sub-barrels만: `@/llm/replay`, `@/llm/factory` paths, `@/tool/registry` 등 실제 import 목록으로 좁히기. |

---

### 15

**🟡 P2 — `PEER_LIBRARY_DENY` incomplete**

| | |
|---|---|
| **코드** | `tests/unit/_arch/slice-boundary-configs.ts:8-25` |
| **목적** | library slice 간 peer import 금지 |
| **근거** | `@/security`, `@/auth` 및 S4b leaf slices 미포함. **의도적 edge:** `src/protocol/subagent/projection.ts` → `@/security`, `src/codemode/limits.ts` → `@/security` (biome codemode rule이 허용). 문서화 없으면 leaf→leaf edge가 늘어남. |
| **개선** | `PEER_LIBRARY_DENY`에 security/auth 추가 + per-slice `allowImports`로 known edge 명시. |

---

### 16

**🟡 P2 — cross-slice mirror drift risk**

| | |
|---|---|
| **코드** | `src/tool/types/context-seams.ts` (~47 mirrors), guard `tests/unit/cross-slice-mirrors.test.ts` (**4 pairs**: BlockerSurface, WorkingState, ToolRisk) |
| **목적** | RFC §3.1 — `@/tool`이 `@/agent`/`@/permission` import 불가 → structural duplicate |
| **근거** | MIRROR INVARIANT comment: "CONVENTION-ONLY". `ActiveWorktree`, `PlanMutator`, `ReviewerRunner`, `VcsEventMirror` 등은 runtime test만 — **tsc가 drift 못 잡음**. |
| **개선** | (1) closed literal union마다 `AssertEqual` 추가 (2) mirror registry ratchet script (3) long-term: stable shapes → `@/shared` SSOT (`HITLTier` pattern). |

---

### 17

**🟡 P2 — agent slice composition concentration**

| | |
|---|---|
| **코드** | `src/agent/mcp-bridge.ts`, `lsp-bridge.ts`, `codemode-wire.ts`, `deny-reason-wire.ts`, `verify-checkpoint-bridge.ts`, `coordination-broker-wire.ts`, `optional-ports.ts` (874줄), `dispatch.ts` (655줄), `tier1/`, `branch-search/` |
| **목적** | `@/agent` = 유일한 cross-slice bridge — legitimate |
| **근거** | host-facing wire가 agent에 섞임 (`deny-reason-wire`는 `runtimeConfig` gate). `host/runtime/`에 이미 wire cluster (`sandbox-escalation-wire.ts`, `progress-sink-wire.ts`). |
| **개선** | Move: `deny-reason-wire.ts`, `verify-checkpoint-bridge.ts` → `src/host/runtime/`. Extract: `tier1/`, `branch-search/` → feature subpackages. |

---

### 18

**🟡 P2 — `llm/factory.ts` decomposition**

| | |
|---|---|
| **코드** | `src/llm/factory.ts` (**857 lines**): `ADAPTER_REGISTRY` 139–257, reasoning helpers 272–414, `createLLM` 433–516, multicloud 606+ |
| **목적** | provider pick + adapter construct + BYOK + Bedrock/Vertex |
| **근거** | 900-band 진입 1 feature 거리. `ADAPTER_REGISTRY` anthropic arm alone ~54 lines. OCP pattern은 good — file size만 risk. |
| **개선** | `adapter-registry.ts`, `factory-reasoning.ts`, `factory-multicloud.ts`, `createReplayLLM()`. |

---

### 19

**🟡 P2 — feature catalog `baseline.json` stale**

| | |
|---|---|
| **코드** | `tools/feature-catalog/baseline.json` |
| **목적** | catalog footer metrics (tsc/biome/test counts) |
| **근거** | `generated_at: 2026-05-29`, `tsc.exit: 2`, `biome.exit: 1`, tests `pass:2 fail:2` — **placeholder-scale**. `docs/10.feature-catalog.md` footer가 repo health misrepresent. |
| **개선** | CI green 시 `bun tools/feature-catalog/refresh-baseline.ts` + commit. CI drift check: `tsc.exit !== 0` in committed baseline → fail. |

---

### 20

**🟡 P2 — seam-only features (catalog vs wiring)**

| | |
|---|---|
| **코드** | `tools/feature-catalog/features/02-tool-system/99-deferred-tool-registry.yaml`, `03-permission-safety/02-dockersandbox.yaml`, `05-memory/memory-telemetry-port.yaml` |
| **목적** | feature catalog maturity / reachability tracking |
| **근거** | `wireStatus: seam-only` — producer (`DeferredResultRegistry`, `DockerSandbox`, telemetry port) without loop consumer. catalog가 false-green. |
| **개선** | wire scheduler/consumer OR `status: hold` + `deliberate_hold` + reachability exclude. |

---

### 21

**🟡 P2 — ADR-0061 remember-patterns incomplete**

| | |
|---|---|
| **코드** | `src/permission/gate-pattern-wire.ts:196` |
| **목적** | permission learning — remember grant patterns across turns |
| **근거** | comment: "surface is still TODO (ADR-0061)". permission critical path에 feature gap. agent loop TODO는 없음 — 이쪽이 permission 유일 gap. |
| **개선** | finish grant-side surface OR ADR amendment으로 explicit defer. |

---

### 22

**🟡 P2 — CLI `internal.ts` raw env**

| | |
|---|---|
| **코드** | `src/apps/cli/internal.ts` (**919 lines**, 10× `process.env`) |
| **목적** | CLI bootstrap / env seeding |
| **근거** | documented S5 TODO: migrate to `runtimeConfig`. `no-raw-process-env-knob-ratchet` **44/49** slots used. |
| **개선** | knob별 `runtimeConfig()` routing. file split과 함께 진행 (919줄 → 900-band). |

---

### 23

**🟡 P2 — AST-only slice fence (no Biome IDE feedback)**

| | |
|---|---|
| **코드** | S4b leaves: `activity`, `artifact`, `attention`, `capability`, `codemode`, `config`, `connectors`, `integrations`, `media`, `protocol`, `radar`, `realtime`, `remote`, `retrieval`, `runtime`, `ui`, `voice`, `workflow` |
| **목적** | slice boundary via `registerSliceBoundarySuite` in unit tests |
| **근거** | Biome `noRestrictedImports` override는 legacy slices에만. 개발자가 illegal import 해도 **IDE/lint 즉시 안 잡힘** — `bun test`까지 기다림. |
| **개선** | biome.json에 S4b leaf overrides 추가 (ARCHITECTURE.md §1.1 watch-out: `**/src/X/**` prefix 필수). |

---

### 24

**🟢 P3 — `FileSystemPort` vs `PatchFileSystemPort` comment drift**

| | |
|---|---|
| **코드** | `src/patch/types.ts:110-117` (intentional rename), `src/storage/service.ts:~328` (misleading), bridge `src/tool/apply-patch.ts` |
| **목적** | storage general FS vs patch minimal mutation port — **different shapes by design** |
| **근거** | runtime misuse 없음. onboarding confusion only. |
| **개선** | `storage/service.ts` comment fix: patch uses `FsJailFileSystemPort` → `PatchFileSystemPort`. |

---

### 25

**🟢 P3 — `defaultTools` eager singleton**

| | |
|---|---|
| **코드** | `src/tool/index.ts:920-925` |
| **목적** | back-compat for `import { defaultTools }` |
| **근거** | ratchet `no-eager-defaultTools-outside-composition`. production path는 `buildDefaultTools(ports)` (`runner/assemble/tooling.ts`, `host/runtime/agent-arg-builder.ts`) — correct. |
| **개선** | 신규 import 금지. tests는 `buildDefaultTools({})`로 migrate. |

---

### 26–29

**🟢 P3 — 낮은 우선순위**

| # | 코드 | 목적 | 개선 |
|---|------|------|------|
| 26 | `src/agent/session-resources.ts:193` | per-turn git numstat for resources | absorb #6 cont. — observability only |
| 27 | `src/agent/types/wire-slots-core.ts:342` | wire-slot hookup doc | finish hookup or delete stale §Wire |
| 28 | `src/apps/eval/index.ts` | eval CLI stdout | 69 `noConsole` pinned — logger port는 churn |
| 29 | `src/protocol/`, `src/integrations/` | slice barrels | add `index.ts` + `requireSliceBarrel: true` |

---

## Wave 2 상세 (#30–66)

> Jul-2 symptom doc + jun-20 bugbash 대비 **재검증** 포함. Jul-2 6건 중 6건 **fixed** 확인 (interrupted resume, budget/completed ordering, skill scope, summarize baseline invalidation, context provider throw, early-dispatch abort). jun-20 33건 중 **대부분 closed** (`bugbash-fix-*.test.ts` rails); 아래는 **신규** 또는 **still-open**만.

### 30

**🟠 P1 — mid-stream abort loses assistant work for `/resume`**

| | |
|---|---|
| **코드** | `src/agent/loop/same-turn-engine.ts:128-130` → `src/agent/loop/turn-outcome.ts:77` → `src/agent/interrupted-turn.ts:102-128` |
| **목적** | Ctrl+C / signal abort 시 cooperative settle + `/resume` 버퍼 |
| **근거** | assistant text는 stream delta에만 존재; `applyAction` append 전 abort (`recovery-executor.ts:329-349`). `captureInterruptedTurn`은 **이미 wm에 있는** message만 읽음 — streaming 중 partial text / in-flight `tool_use` 누락. UI는 `assistant_text` 봤는데 resume buffer엔 없음. |
| **개선** | abort 시 `streamingTurn` state에서 partial assemble → wm append 또는 `captureInterruptedTurn`에 partial 전달. |

---

### 31

**🟠 P1 — `/summarize-now` baseline `recordSendCount` 누락**

| | |
|---|---|
| **코드** | `src/agent/loop/compaction-wire.ts:319-321` (invalidate only) vs `src/agent/loop/context-assembler.ts:436` (proactive: `recordSendCount`) |
| **목적** | D5 token-baseline — provider `inputTokens`와 send-time wm length 페어링 |
| **근거** | Jul-2 FIX 4는 `invalidateOnShrink` wired + `tests/unit/agent/loop/__tests__/compact-now-baseline-invalidation.test.ts` 통과. 그러나 proactive path는 compact 후 **`baseline.recordSendCount(wm.snapshot().length)`** 도 호출; on-demand path는 **invalidate만** → 다음 full `prepareTurnContext` 전까지 send-count anchor skew. |
| **개선** | `compactNowOnDemand`의 `wm.replace` 후 `TokenBaselineBox.wrap(box).recordSendCount(wm.snapshot().length)` 추가. |

---

### 32–33

**🟠 P1 — bench permission store / sandbox escalation gap**

| | |
|---|---|
| **코드** | `src/runner/batch/eval/driver/config-build.ts` — `admissibility` 필드 없음; `src/agent/admissibility-gate/gates.ts:307-311` fallback; `src/host/runtime/sandbox-escalation-wire.ts:220-223` early return when `permissionStore` undefined |
| **목적** | bench SWE-bench run에서 permission state + sandbox escalation |
| **근거** | CLI는 `src/apps/cli/repl/runtime-context-compose.ts:336-338`에서 `permissionStore` inject. bench `buildConfig` → `runAgent` path는 omit → singleton. `QUANTA_SANDBOX_ESALATION=1` bench에서 **silent no-op**. Wave1 #10과 동일 뿌리, bench surface가 누락된 구체 경로. |
| **개선** | bench composition root에서 `permissionStore` mint → `buildConfig.admissibility` → gates fallback 제거. |

---

### 34

**🟠 P1 — `decidePrimaryRailFinishGate` dead code**

| | |
|---|---|
| **코드** | `src/agent/primary-rail/index.ts:75-86` |
| **목적** | primary rail 미-green 시 finish block — non-primary green 무시 (false-green hole) |
| **근거** | `decidePrimaryRailFinishGate(` — **production import 0** (tests only). bench repair는 `repairCandidateClears` (`src/runner/batch/eval/repair/decision.ts:46-51`) — `isFalseGreen`만, primary rail state 미검사. jun-20 #1 **still open**. |
| **개선** | repair finish path에 wire OR `repairCandidateClears`가 re-export하는 단일 SSOT로 통합 후 dead API 삭제. |

---

### 35–37

**🟠 P1 — catalog honesty + unwired exports**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 35 | `observability-ws-sink.yaml:8,19` | WS observability fan-out | `maturity: L4`, `ui_surfaces: [cli]`, `surface_integration.cli: missing` | `ui_surfaces: [web]` or wire CLI diagnostic |
| 36 | `src/runner/orchestrate/run-once.ts:100` | surface-agnostic one-shot turn | **not** in `orchestrate/index.ts` exports; zero `src/` importers; live path `driveSessionTurn` | export+wire CLI argv OR delete + catalog demote |
| 37 | `retry-pretry.ts:112`, `glob-write-gate.ts:27` | retry primitive / glob→write safety | prod importer 0; knob mirror only in `types-extra.ts:356` | wire at composition OR delete exports |

---

### 38

**🟠 P1 — ADR-0061 pending-permission queue unwired**

| | |
|---|---|
| **코드** | `src/permission/gate-pattern-wire.ts:195-203`, `src/agent/admissibility-gate/shared.ts:753-784`, `src/agent/dispatch.ts:468-482` |
| **목적** | approve once → same-turn queued tools auto-pass (v0 cascade) |
| **근거** | `grantAndCascade` accepts `pending` queue; comment "surface still TODO". `pendingPermissions` / `onPatternCascade` — **integration test only** (`remember-patterns-cascade-hell.test.ts`). `dispatch.ts` passes `config.admissibility` only — **no pending queue**. auto-pass for *future* calls works; **same-turn queue cascade dead**. Wave1 #21 확장. |
| **개선** | agent loop pending tool-call queue + `runAdmissibilityGate`에 `pendingPermissions` / `onPatternCascade` wire. |

---

### 39–41

**🟠 P1 — test quality gaps**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 39 | `lsp-atomic-write-phase-contract.test.ts:6-8` | LSP atomic write phase attribution | parent hellgate GREEN on revert | fold injection into hellgate |
| 40 | `debug-inspect-wire-contract.test.ts:6-10` | debug-inspect wire R1–R6 | 6 regressions pass old e2e suite alone | merge into `debug-inspect-tool-e2e-hellgate` |
| 41 | — | deferred async tools E2E | unit hellgates exist; **no** `tests/integration` through `runAgent` + `poll_deferred` | add integration e2e |

---

### 42–44

**🟡 P2 — agent loop / UX**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 42 | `session-bootstrap.ts:355-357`, `skill-scope-view.ts:52` | `/state` operator panel | frozen `session.specs` vs live `registry.specs()`; mode filter (`filterSpecsByMode`) 미적용 | `resolveVisibleSpecs` 공유 |
| 43 | `turn-closeout.ts:15-24` | transcript sealing authority | `sealTranscript` documented, **not implemented**; orphan pairing ad hoc | implement or trim header |
| 44 | `turn-outcome.ts:86-88` | subagent interrupt park | `interrupted` parks but no `captureAbortedTurn` — cross-session `/resume` gap | capture with reason or document in-session-only |

---

### 45–46

**🟡 P2 — permission durability (jun-20 #2 fixed; residual)**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 45 | `json-state-file/locking.ts:108-144` | multi-process permission merge | lock timeout 10s → **unprotected write**; ADR-0046 "no lock" **stale** vs shipped lock | timeout → `{ durable: false }` not blind write |
| 46 | `permission-store.ts:858` | denial/grant persist | `flushDebounced` void — EACCES/full-disk 시 in-memory only | security mutations → `flushDurable` + surface signal |

**Closed (참고):** jun-20 merge race — `permission-store.ts:830-852` `liveSnapshot()` re-read; `tests/unit/bugbash-fix-permission-race.test.ts`.

---

### 47–48

**🟡 P2 — memory pipeline gaps**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 47 | `web-daemon/.../session-collaborators.ts:193-197` | web session memory | READ-ONLY store mint; **no** `buildSessionMemoryAutoWires` / consolidator (CLI: `host/runtime/internal/context-binding/base.ts:474-491`) | wire session-end consolidator OR catalog `deliberate_hold` |
| 48 | `memory/typed-event/in-memory-store.ts` | typed history events | no sqlite adapter in `@/memory`; cross-session loss unless session-resource-registry path | durable adapter or document layer |

---

### 49–52

**🟡 P2 — session / rewind / crash-resume**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 49 | `session/store.ts:509-512` | atomic session JSON save | in-process lock only; two CLIs same dir → last rename wins | reuse `json-state-file` lock pattern |
| 50 | `session/store.ts:831-834` | message-granularity rewind | snapshot truncated; envelope append-only → ghost events | envelope compact at rewind point |
| 51 | `session/store.ts:847-849` | rewind by message id | legacy sessions without `id` → `{ removed: 0 }` silent | mint ids on first `/rewind` or explicit error |
| 52 | `crash-resume.ts:39-49,136-139` | SIGKILL/OOM resume marker | `QUANTA_CRASH_RESUME` default OFF; persist failure log-only | surface failures; soak 후 default-on 검토 |

**Mitigation in place:** `session/store.ts:47-70` `reconcileMessages` before persist (tool pair orphan guard).

---

### 53–54

**🟡 P2 — shell assessment**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 53 | `permission/shell/assess.ts` (~547줄) + `parser.ts`, `ir.ts`, `rules.ts` | sync shell effect authority for HARD_DENY | ~1619 LOC slice; biome complexity clean but **semantic drift** as rules grow | split `assess-pipelines.ts`, `assess-heads.ts` |
| 54 | `permission/shell/parser.ts:106-107` | tree-sitter bash WASM | pre-init `parseShell` → null → `unknown` assessment | block dispatch until `initShellEffectParser()` resolves |

---

### 55–57

**🟡 P2 — bench / repair SSOT**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 55 | `closure-session.ts:123-124` | anti-under-verify gate | stakes/uncertainty pinned neutral; jun-20 #8 **intentional** partial | document OR wire structure LSP source |
| 56 | `agent-phase.ts:508-534` | P0 tentative-patch retention | apps-only `createTentativeRecorder`; runner driver lacks it | shared helper or deprecate runner comments |
| 57 | `primary-rail/index.ts` vs `repair/decision.ts` | finish gate SSOT | parallel implementations — "keep in sync" comment, no shared fn | #34와 함께 통합 |

**Closed (참고):** jun-20 cost/ec2/LSP/knobs_applied/selection/grading/security box-session — `bugbash-fix-*.test.ts`. `decideEscalation` now widens owners (`localize-prep.ts:247+`).

---

### 58–62

**🟡 P2 — catalog / ratchet / integration**

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 58 | `outcome-exit-code-table.yaml` | POSIX exit mapping | L4 + cli surface + `cli: missing` | fix surface_integration |
| 59 | `control-request-surface.yaml` | live control channel | L3, web wired, CLI unwired per yaml | cap L2 or wire REPL |
| 60 | `src-no-sketchy-code.test.ts` | env discipline | **181** `no-process-env-outside-config` allowlist entries | S5 `runtimeConfig()` migration (overlaps #12, #22) |
| 61 | `test-audit-baseline.json` | env-isolation test quality | **648** R10 rows without mockEnv failure proof | batch tighten shared `mockEnv` helper |
| 62 | `tests/integration/` | session kernel | grep: zero integration hits on `src/session/` | persist+reload cross-process smoke |

---

### 63–66

**🟢 P3 — docs / accepted debt**

| # | 코드 | 목적 | 개선 |
|---|------|------|------|
| 63 | `skill-gate.ts:49-50` | filter when skillScopeV2 | comment stale — `stream-consume` always filters when `skillGate` exists |
| 64 | ADR-0046, ARCHITECTURE §9 | permission LWW docs | update: lock shipped; document timeout gap (#45) |
| 65 | `knobs-bench.ts:387-397` | `sotaOn` telemetry | delete once hellgate stops asserting inert label (jun-20 #14) |
| 66 | `lsp-bridge/warm-pool.ts:145-196` | import readiness cap | 200-line cap fail-open (jun-20 #21 accepted) |

---

## Wave 3 상세 (#67–111)

> 4 클러스터: `llm/mcp/lsp/stream/observability` · `sdk/host/ipc/web-daemon` · `tool/security/retrieval/skill` · `config/migration/session-import`.

### P1 cluster — MCP/LLM/Security (#67–72)

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| **67** | `mcp/isolated-client.ts:219-228` | plugin-isolated MCP `initialize` | in-process는 `initializeWithDowngrade` (`client/negotiate.ts:50-59`); isolated는 1회 offer만 — strict server는 in-process OK / isolated permanent fail | isolated path에 downgrade 재사용 |
| **68** | `llm/retry/decorator-policy.ts:83-98` | retry vs codex-spec table | `cyber_policy` 등 → `consult_markers` → `agent/retry.ts` message에 `"429"` 있으면 retry; table은 `hitl_handoff` | `hitl_handoff` kinds → `no_retry` + hellgate |
| **69** | `mcp/transports/http-sse.ts:501-521` | standalone SSE inbound channel | fresh connect에서 `401`/`500` → `return` (no log, no `fireExit`); pump-death는 수정됐으나 HTTP-status branch 잔존 | non-405 `!ok` on fresh GET → `fireExit()` |
| **70** | `tool/container-exec/tool.ts` | container shell exec | `extractShellCommand` 있으나 **`classifySource` 없음**; dispatch Layer-1 redaction은 `classifySource` 선언 tool만 (`dispatch/execute.ts:87-92`) | `classifySource` 추가 (bash mirror) |
| **71** | `security/sensitivity-classifier.ts:271-277` | command-shape Layer-1 | first token만 검사 — `bash -c printenv` → `public`; bare `printenv` → `secret` | `-c`/`-lc` unwrap + pipe dump intent |
| **72** | `tool/grep/index.ts:99-131` | ripgrep content search | root만 jail; `glob`는 `collectSurvivors`로 hit마다 re-jail (`glob/index.ts:29-51`). workspace symlink → out-of-jail read 가능 | glob survivor pipeline 재사용 |

---

### P1 cluster — SDK / Surfaces / Session (#73–78)

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| **73** | `protocol/session/verb-surface.ts:55-100`, `ipc/session/handle.ts:706-727` | session.v1 public verbs | protocol+kernel에 `posture.set`/`skill.set_enabled`/`objective.mutate` 있으나 `SessionHandle`은 legacy subset | verb surface 확장 + SDK export |
| **74** | `realtime-websocket-codex.yaml:17-22` | catalog reachability | `web: full` evidence cites ws-adapter; `web-daemon/`에 `@/realtime` import **0** | catalog fix; CLI `/voice-live`만 wired |
| **75** | `apps/agent/mode-presets/headless.ts:167+`, `interactive.ts:130+` | `bun run agent:*` launcher | `bootstrapSession` **0 matches** in `apps/agent/`; CLI는 posture/skills/MCP bootstrap (`session-setup.ts:178+`) | apps/agent → CLI composition root 공유 |
| **76** | `apps/cli/session-cmd.ts:315-324` | `/session import` | `importSessionFromJson` → `writeSession(messages)` only; output은 `sidecar=${keys}` **report**하지만 hydrate 없음 | sidecar → checkpoint/budget/plan stores |
| **77** | `apps/cli/session-cmd.ts:203` | `/session export` | `exportSessionToFile(session, { quantaVersion, now })` — sidecar opts 없음 (`import-export.ts:84-91` port는 지원) | live sidecar snapshot + `emitV2`/`withDigest` |
| **78** | `agent/types/wire-slots-session.ts:537-540` | ADR-0217 typed error routing | `errorRouting` slot 존재; `host/`/`apps/` assignment **0**; production `RetryingLLM` = legacy `isRetryable` only | composition root wire + metric |

---

### P2 — Transport / Observability / Parity (#79–92)

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 79 | `lsp/adapters/base/atomic-edit.ts:121-131` | LSP workspace apply | EXDEV 시 partial commit; sibling `file-write-atomic.ts:170-187`는 copy+delete 있음 | EXDEV fallback port |
| 80 | `stream/adapters/tee.ts:66-86` | stream fan-out degrade | `onFirstDegrade` wired CLI REPL factories만; bench/web `strict:false` → leg fail silent | composition root degrade emit |
| 81 | `observability/metrics/instrument-genai.ts:120,143` | OTLP GenAI metrics | `MetricSample.at: Date.now()` — replay drift | injectable `now` |
| 82 | `lsp/adapters/base/transport.ts:86` | LSP mem/RSS budget | `process.env` at spawn — `/config set` 무효 | `runtimeConfig()` at composition |
| 83 | `llm/empty-stream-breaker.ts:88-103` | empty stream trip | `signature_delta` non-contentful → thinking-only stream false trip | contentful로 분류 |
| 84 | `mcp/isolated-client.ts:219-222` | MCP capabilities | `capabilities: {}` vs in-process negotiator | inject negotiator |
| 85 | `llm/replay/jsonl-store.ts:201-204` | replay cassette append | `appendTail.catch(() => {})` — hole in file | broken flag on fail |
| 86 | `apps/cli/serve-stdio-cmd.ts:262-271` | stdio session server | `skillsConfig: undefined` unconditional | mirror web skill authority |
| 87 | `web-daemon/server/ws-handlers.ts:254-280` | web live control | `controlRequest`/`followerVerb` — not in `@/protocol` | promote to session.v1 or document extension |
| 88 | `web-daemon/server/ws-handlers.ts:299-307` | user input prompt | `cancelAll()` only on WS close; turn abort leaves resolver | subscribe turn.aborted/failed |
| 89 | `apps/agent/index.ts:578-598` | agent launcher boot | no `CLI_SEEDED_GATE_NAMES` (CLI `index.ts:47-49` has it) | shared boot-env |
| 90 | `apps/cli/index.ts` only | remote runner | `selectRemoteRunner` CLI-only import | document or wire agent-app |
| 91 | `sdk/connect.ts:119-122` | WS browser auth | `?token=` in URL — log/history leak | `Sec-WebSocket-Protocol` where possible |
| 92 | `web-daemon/.../agent-config-base.ts` | web memory | `base.memory` unset — readout only (#47 consolidator와 별개) | explicit write gate or catalog demote |

---

### P2 — Search / Skill / Migration / Workflow (#93–108)

| # | 코드 | 목적 | 근거 | 개선 |
|---|------|------|------|------|
| 93 | `tool/search-codebase/index.ts:205-227` | scoped codebase search | global top-50 후 filter — in-scope hits at rank 51+ → false empty | scope in pipeline or widen fetch |
| 94 | `retrieval/indexer/default-scanner.ts:44` | semantic index | `DEFAULT_GLOB = "src/**/*.ts"` | broader default + tool description |
| 95 | `tool/shadow-verify/` | pre-apply verify | CLI `QUANTA_SHADOW_VERIFY`; bench **0 refs**; web via observability bundle only | single knob all surfaces |
| 96 | `skill/playbook/plan-writeback/` | findings → plan | `createDefaultWriteback` — host/apps/runner importer 0 | bootstrap wire default-OFF |
| 97 | `skill/playbook/wire.ts:68-99` | inline playbook triggers | CLI `--playbook-trigger` only; no planQueueSink → counted not enqueued | web/bench sink wire |
| 98 | `skill/tool-search.ts:309-311` | skill catalog search | `skillCatalog` absent → `[]` silent | `ok:false` unwired error |
| 99 | `runner/assemble/index.ts:5-8` vs `llm.ts:221` | assemble no-env invariant | header says no `process.env`; 4× `runtimeConfig()` calls | inject from composition root |
| 100 | `migration/.../persist.ts:908-910` | migration throttle | `recordDisposition.catch(() => false)` — persist OK but ledger miss → re-clobber | warn + retry ledger |
| 101 | `migration/.../run.ts:164-167` | external config detect | bare catch → empty inventory | `MigrationWarning` on fault |
| 102 | `migration/.../ledger.ts:62-67` | throttle ledger read | non-ENOENT → `{ entries: [] }` | EACCES ≠ empty |
| 103 | `session/import-export.ts:542-543` | v2 digest | `digest === undefined` → accept | `strictDigest` for CLI |
| 104 | `ipc/session-import.ts:261-274` | IPC session import | portable blob path — no envelope/digest/sidecar | unify on envelope port |
| 105 | `reactor/trigger-source-*.ts:303+` | GH reactor triggers | `safeRun` catch → undefined | `onError`/metrics |
| 106 | `workflow/executor.ts:231-285` | workflow steps | builder throw → silent break/return | `step_fail` emit |
| 107 | `runner/assemble/search-index-backend.ts:252-254` | index embed fallback | bare catch in `fallbackHeadless` | `logger.warn` |
| 108 | `plugin-isolation/bun-spawner.ts:82-88` | DXT plugin spawn | manifest `env` merges over base — `LD_PRELOAD` etc. | env key allowlist |

---

### P3 (#109–111)

| # | 코드 | 목적 | 개선 |
|---|------|------|------|
| 109 | `container-exec/tool.ts:42-50` | stream cap at import | resolve in `execute` from injected env |
| 110 | `runner/assemble/session-state.ts:43-47` | system prompt rebuild | log/notice on fallback |
| 111 | `in-memory-registry.ts:424-435` | metric sink errors | rate-limited warn on first drop |

---

## 권장 실행 순서

### Wave 1 (구조·ratchet)

1. **Week 1 (unblock cohort):** split `run-main.ts` + `same-turn-engine.runTurn` + 하나 더 900-band (`compaction` or `tool/index`)
2. **Week 2 (core loop quality):** `getDefaultPermissionStore` fallback 제거, compaction `now` inject, top-2 complexity (dap-client, branch-switch)
3. **Week 3 (fence & truth):** `baseline.json` refresh, `PEER_LIBRARY_DENY` expand, `cross-slice-mirrors` extend, `side-agent` allowImports tighten

### Wave 2 (correctness·wiring·truth)

4. **P1 correctness:** #30 abort partial capture, #31 `recordSendCount`, #32-33 bench `permissionStore`
5. **P1 wiring:** #34-38 primary-rail SSOT, ADR-0061 pending queue, dead exports (#36-37)
6. **P1 test teeth:** #39-41 hellgate merge + deferred-async integration
7. **P2 session/permission:** #45-46 durability, #49-52 session locks/rewind
8. **P2 catalog honesty:** #35, #58-59 maturity vs `cli: missing`
### Wave 3 (security·parity·session round-trip)

10. **P1 security:** #70-72 container_exec redaction, classifier wrapper, grep symlink re-jail
11. **P1 MCP/LLM:** #67-69 isolated downgrade + SSE half-dead + retry policy (#68)
12. **P1 surfaces:** #73-75 SDK verbs + apps/agent bootstrap + catalog realtime (#74)
13. **P1 session/resilience:** #76-78 import/export sidecar parity + error routing wire
14. **P2 parity:** #86-92 web-daemon (stdio skills, OOB protocol, user-input hang, memory)
15. **P2 migration:** #100-104 throttle/digest/IPC import unification
16. **Backlog:** #93-98 search/skill wiring, #79-85 transport/obs determinism

## 참고 문서

- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — ports/adapters, slice fence
- [rfc/0001-architecture.md](../../rfc/0001-architecture.md) — SOTA++ stance, non-goals
- [AGENTS.md](../../AGENTS.md) — god-code, lint-debt, feature catalog rules
- [tools/god-code/allowlist.json](../../tools/god-code/allowlist.json) — approaching cohort SSOT
- [tests/unit/_arch/slice-boundary-configs.ts](../../tests/unit/_arch/slice-boundary-configs.ts) — slice deny SSOT
