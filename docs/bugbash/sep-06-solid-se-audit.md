# Sep-06 — SOLID / SE / 중복 / 꼬인 로직 어딧

> 2026-09-06 라이브 재검증. **목적:** 8/25 god-code·SOLID 어딧과 9/05 중복 어딧을 라이브 `src/`에 다시 대고, **이미 끝난 것 / 아직 산 것 / 새로 드러난 것**을 가름.
> **truth snapshot:** `536689912` (`HEAD`). 범위: `src/**/*.ts` (테스트 god-file은 별도).
> **관련:** [aug-25-wave1.md](./aug-25-wave1.md) (god/lint/arch), [sep-05-duplicate-development.md](./sep-05-duplicate-development.md) (역할 중복).

## Snapshot

| 항목 | 8/25 | 9/06 live |
|------|------|-----------|
| god-module allowlist (>1000) | 0 | **0** |
| god-function allowlist (>150) | 0 | **0** |
| 900–999 cohort | **24/24 full** | **21/24** (3칸 여유) |
| `noExcessiveCognitiveComplexity` | prod 143 / tests 97 / worst 59 | **0 / 0 / worst 0** |
| `runTurn` body | 150줄 cliff | **~70줄** (helpers 분리) |
| `assembleAgentConfig` 파일 | 988줄 | **895줄** (900 직전) |
| `compaction.ts` | 983 | **983** (그대로) |
| D0/D2/D3/D5/D6/D10/D11 | execute | **closed** (라이브 인용) |
| god-fn body == 150 | (없음) | **4함수** — 한 줄이면 CI RED |

## 분류

- `closed` — 라이브가 이전 어딧의 조질지를 이미 흡수.
- `still` — 이전 항목이 라이브에 그대로 있음.
- `new` — 9/05 인덱스에 없거나, 그때보다 범위가 커진 것.
- `widened` — 이전 항목이 사이트가 늘었거나 드리프트가 실측됨.

---

## 이미 끝난 것 (손대지 말 것)

### C1. D6 `sanitizeServerKey` 3벌 → `@/mcp` SSOT

`src/mcp/naming.ts` L16–20이 `sanitizeMcpNameSegment` / `mcpToolName` 본체. host/cli/adapter는 thin wrap.

```ts
export const sanitizeMcpNameSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]+/g, "_")
```

### C2. D10 `ThreadPermission` validator 복제 → decode leaf

`src/permission/thread-permission-decode.ts` L87–119 `decodeThreadPermission`. store는 L71 import 후 L224–228 wrap.

### C3. D5 convert↔translate 복붙 → `claude-config-decode`

`src/migration/external-config/convert.ts` L26이 `decodeClaudeMcpServers` import. `classifyClaudeTransport`는 decode 한 곳 (L27–35).

### C4. D2 ChatGPT refresh lock

`src/llm/adapters/chatgpt-oauth.ts` L295–297이 `refreshTokenTransaction(..., { lock: this.refreshLock })`. in-proc `RefreshCoordinator`는 트랜잭션 안 single-flight.

### C5. D3 from-pr `gh` scrub 없음

`createBunGhCliPort`가 `defaultGhExec`를 탐 (`from-pr-cmd-adapters.ts` L59–61). `defaultGhExec`는 `scrubEnv(CI_ENV_ALLOWLIST)` (`tool/gh/runner.ts` L80, L105).

### C6. D0 spinner-stall 주석 거짓말

inventory describe가 “CLI-seeded default-ON” (`knob-inventory/host.ts` L28–29). live-wire 주석도 시딩을 인정 (`spinner-stall-live-wire.ts` L16–22).

### C7. D4 ci-bot PR comment raw write

`ci-bot.ts` L386–393이 `createPrOutputSink` + idempotency key. **에이전트 툴 `ghPrCommentTool`은 아직 별 경로** (S4).

### C8. `runTurn` god-function / complexity 부채

`same-turn-engine.ts` `runTurn` L209–281. abort/prep/steer가 함수로 빠짐. biome complexity ceiling **0**.

### C9. apps/agent `assembleAgentConfig` 이중 본체

`apps/agent/assemble.ts`는 host assembler env shim (L17–21). 본체는 `host/runtime/agent-config-assembler.ts` 한 곳. CLI `buildAgentConfigFromBase`는 per-turn fold — R8 유지.

### C10. D11 token file atomic 0600

`src/auth/private-file-atomic.ts` `writePrivateFileAtomic`. ChatGPT token-store L239 + MCP file store (`mcp-composition.ts` L190)가 공유.

### C11. D1 scanner hellgate (부분)

`tests/unit/secret-sink-parity-hellgate.test.ts`가 3-plane CORPUS를 핀함. **테이블 병합은 미완** (S1). `redaction-parity-hellgate`만 보면 scanner가 없는 것처럼 보임 — 잘못된 부재 증명.

---

## 인덱스 (아직 산 것 + 신규)

| # | status | 등급 | 분류 | 위치 | 제목 |
|---|---|---|---|---|---|
| [N9](#n9) | new | 🔴 p0 | ratchet | bootstrap-session / resume-fsm / runtime-config / codemode | god-function body **정확히 150** ×4 |
| [S1](#s1) | still | 🟠 p1 | security | `redaction.ts` / `trajectory.ts` / `pattern-scanner.ts` | secret regex 3테이블 — hellgate는 있음, SSOT 없음 |
| [N3](#n3) | still | 🟠 p1 | loop | `same-turn-engine.ts:251` | mid-stream abort → `/resume` partial 누락 |
| [N4](#n4) | still | 🟠 p1 | loop | `turn-outcome.ts:86` | `interrupted` park — capture 없음 |
| [N5](#n5) | still | 🟠 p1 | mcp | `isolated-client.ts:213` | isolated MCP protocol downgrade 없음 |
| [N6](#n6) | still | 🟠 p1 | mcp | `http-sse.ts:545` | SSE GET `!ok` silent return |
| [N7](#n7) | still | 🟠 p1 | llm | `decorator-policy.ts:93` | HITL kinds → `consult_markers` retry |
| [N8](#n8) | still | 🟠 p1 | security | `container-exec/tool.ts:186` | `classifySource` 없음 — Layer-1 skip |
| [N10](#n10) | still | 🟠 p1 | security | `sensitivity-classifier.ts:183` | `bash -c printenv` wrapper bypass |
| [S2](#s2) | still | 🟠 p1 | srp | `agent/types.ts` + `types/wire-slots-*` | `AgentConfig` god-interface (~206–224 slots) |
| [S3](#s3) | still | 🟠 p1 | retrieval | `embedders/` vs `engines/embedder/` vs `memory-embedder` | OpenAI embed **3스택** + 동명 `createOpenAIEmbedder` |
| [S4](#s4) | still | 🟠 p1 | gh | `tool/gh/index.ts` `ghPrCommentTool` | HITL PR comment는 sink 미경유 |
| [S5](#s5) | still | 🟠 p1 | di | `admissibility-gate/gates.ts:311` | `getDefaultPermissionStore()` service locator |
| [S6](#s6) | still | 🟠 p1 | config | `auto-sweep.ts` / `apps/cli/internal.ts` | typed config 우회 `process.env` |
| [N1](#n1) | new | 🟠 p1 | jsonrpc | `shared/jsonrpc*` + mcp + lsp | JSON-RPC 타입/코덱 **4표면** |
| [S7](#s7) | still | 🟡 p2 | god-code | 900-band 21파일 | cohort cliff — compaction/store/tool barrel |
| [S8](#s8) | widened | 🟡 p2 | dup | `firstLineOf` ×6 | CRLF 정책 **실측 드리프트** (trim vs no-trim) |
| [S9](#s9) | still | 🟡 p2 | fail-open | `permission/json-state-file/locking.ts:104-140` | lock timeout → unprotected write |
| [S10](#s10) | still | 🟡 p2 | determinism | `loop/turn-iteration.ts:82` | `Date.now()` turn provenance |
| [S11](#s11) | still | 🟡 p2 | singleton | `tool/index.ts:925` | `defaultTools` eager singleton |
| [S12](#s12) | still | 🟡 p2 | isolation | `slice-boundary-configs.ts:513-523` | `side-agent` `@/llm` `@/tool` whole-slice allow |
| [S13](#s13) | still | 🟡 p2 | media | `media/stt` vs `voice/transcriber` | Whisper REST sibling (포트 합치기 금지, HTTP core만) |
| [S14](#s14) | still | 🟡 p2 | junk | `src/agent/*-wire.ts` ×16 | agent composition drawer |
| [S15](#s15) | still | 🟡 p2 | jsonrpc | mcp vs lsp 로컬 `JsonRpcMessage` | framing은 다름, **로컬 타입 복제**는 남음 |
| [N11](#n11-p2) | new | 🟡 p2 | dup | `storage/atomic-write` vs `lsp/file-write-atomic` | D29 “identical”인데 **fsync 드리프트** |
| [N12](#n11-p2) | new | 🟡 p2 | dup | `lsp/jsonrpc` vs `tool/debug/dap-codec` | Content-Length framing 복제, DAP 한도 없음 |
| [N13](#n11-p2) | still | 🟡 p2 | boot | `web-daemon/runtime-factory` | CLI `memoryAuto` vs web **미배선** |
| [N14](#n11-p2) | still | 🟡 p2 | knobs | inventory `home:"runtime-config"` | **228** home, typed field **0** (D28) |
| [N15](#n11-p2) | still | 🟡 p2 | loop | `compaction-wire.ts:319` | `/summarize-now` `recordSendCount` 생략 |
| [N16](#n11-p2) | still | 🟡 p2 | dead | `primary-rail/index.ts:75` | finish gate prod caller 0 + runner 이중 SSOT |

---

## N9. god-function body 정확히 150 ×4

**status:** new. ratchet은 `>150`이라 **한 줄 추가 = CI RED**.

| 파일 | 심볼 |
|------|------|
| `src/host/bootstrap/bootstrap-session.ts:192` | `assembleBootstrapResult` |
| `src/runner/orchestrate/resume-fsm.ts:137` | `resolveResume` |
| `src/shared/runtime-config.ts:328` | `parseToolSurfaceSlice` |
| `src/codemode/runtime.ts:620` | `toolsBindingState` |

**조질지:** 각 body 120 이하로 helper 추출. 이미 burndown 주석이 있는 파일도 있음.

---

## S1. Secret regex 3테이블 — hellgate는 있음, SSOT 없음

**status:** still (D1). **정정:** `secret-sink-parity-hellgate.test.ts`가 3-plane CORPUS를 핀함. `redaction-parity-hellgate`만 보면 scanner 부재로 오인됨.

테이블은 여전히 3벌. JWT quantifier drift: trajectory `+` vs redaction/scanner `{10,}`.

**조질지:** kind+regex leaf 하나. consumer는 출력 타입만. hellgate는 유지.

---

## N3. Mid-stream abort → `/resume` partial 누락

**status:** still (aug-25 #30).

`streamConsume`이 `{ aborted: true }`만 반환 (`stream-consume.ts:553-555`). `runTurn` L251이 `applyAction`/`wm.append` 전에 `settleTurnAbort`. capture는 이미 wm에 있는 assistant만 읽음 (`interrupted-turn.ts:145-151`). UI에 보인 스트리밍 텍스트는 resume buffer에 없음.

**조질지:** abort 전에 부분 assistant를 wm에 넣거나 capture가 in-flight buffer를 읽게.

---

## N4. `interrupted` park — capture 없음

**status:** still (aug-25 #44).

`classifyTurnAbort`가 gate interrupt면 `{ kind: "interrupted" }` (`turn-gate.ts:34-40`). `turn-outcome.ts:86-88`은 park만. aborted 팔의 `captureAbortedTurn` 없음 → cross-session `/resume` 공백.

---

## N5. Isolated MCP protocol downgrade 없음

**status:** still (aug-25 #67).

`isolated-client.ts:213-223`: in-process는 `initializeWithDowngrade`, isolated는 1회 offer. 주석이 JSON-RPC retry 부재를 인정. `capabilities: {}` vs in-process negotiator compile.

---

## N6. SSE GET `!ok` silent return

**status:** still (aug-25 #69).

`http-sse.ts:545-568`: 405가 아닌 `!ok`와 wrong content-type이 `return`만. `fireExit` 없음 → half-dead transport. resume cursor 거절 시 1회 retry는 있음.

---

## N7. HITL kinds → `consult_markers` retry

**status:** still (aug-25 #68).

`decorator-policy.ts:93-98`: `auth`만 `no_retry`. `cyber_policy` / sandbox HITL은 marker scan → 429 문자열이 있으면 재시도 가능.

---

## N8. `container_exec` Layer-1 skip

**status:** still (aug-25 #70).

`container-exec/tool.ts:186-188`: `extractShellCommand`만. `classifySource` 없음 → dispatch가 Layer-1 redact skip.

**조질지:** bash와 같이 `classifySource: (i) => classifyCommandShape(i.command)`.

---

## N10. `bash -c printenv` wrapper bypass

**status:** still (aug-25 #71).

`sensitivity-classifier.ts`: `firstToken`만 head → `bash`/`sh`는 SECRET_COMMAND_RULES miss → `"public"`. bare `printenv`만 secret.

**조질지:** `-c`/`-lc` payload unwrap 후 재분류.

---

## S2. `AgentConfig` god-interface

**status:** still (aug-25 #5). 주석이 SRP 회귀를 인정함.

`src/agent/types.ts` L89–103:

> Subsystem consumers SHOULD take a narrow `Pick<AgentConfig, ...>`
> Adding a new field here without an associated narrow Pick is an SRP regression.

실제는 `SafetyConfig | PermissionExtras | Steering | WireSlotsCore | Runtime | Session | Compose`를 한 인터페이스에 펼침. 실측 **~206–224** 고유 필드 (wire ~143 + body ~63). `types.ts:695` “53-field god-config” 주석은 stale.

**impact:** 새 슬롯이 assembler·CLI·headless·bench 전 표면에 전파. OCP 위반 (확장마다 거대 타입 수정).

**조질지:** 새 필드는 해당 `*Config`에만. 루프는 `Pick`. 조립은 섹션 객체. 플랫 병합은 composition root 한 점.

---

## S3. OpenAI embed 3스택 + 동명 export

**status:** still/widened (D15). 라이브 search는 engines. legacy `embedders/`와 memory 스택이 남음.

| 스택 | 심볼 | 포트 | 라이브 소비자 |
|------|------|------|----------------|
| memory | `agent/memory-embedder.ts` `OpenAIEmbedder` | `@/memory` `EmbedderPort` | `runner/assemble/store.ts` |
| retrieval Axis D | `retrieval/embedders/openai.ts` `createOpenAIEmbedder` | `EmbeddingPort` | barrel + commit-embedder / tests |
| ADR-0261 | `retrieval/engines/embedder/openai-embedder.ts` `createOpenAIEmbedder` | `Embedder` + `Result<>` | `createEmbedderFromEnv` → search |

`@/retrieval` barrel과 `@/retrieval/engines`가 **같은 이름**을 다른 타입으로 export. `createHeadlessEmbedder`도 이중: semantic dim **64**+L2 vs engines dim **1536** no L2.

같은 엔드포인트 `POST /v1/embeddings`, 같은 default model `text-embedding-3-small`, 같은 batch 96.

**조질지:** engines HTTP core SSOT. memory/commit는 thin adapter. legacy `embedders/` `@deprecated` re-export 후 삭제. 동명 export 금지.

**검증:** production value-import가 `engines` + `memory-embedder` adapter만.

---

## S4. `ghPrCommentTool`은 sink 미경유

**status:** still (D4 잔여). ci-bot은 C7로 sink. 에이전트 툴은 raw `gh pr comment`.

`src/tool/gh/index.ts` L180–220: `policy.prepare` 후 `["gh","pr","comment",ref,"--body",prepared.body]`. idempotency marker / `RedactPort` 없음. HITL confirm은 있음.

**조질지:** body redact+marker는 sink. 툴은 HITL UX만.

**검증:** 툴 execute가 `pr comment` raw argv만 치면 RED (ci-bot 패턴과 동일 ratchet).

---

## S5. `getDefaultPermissionStore()` DIP 위반

**status:** still (aug-25 #10).

`src/agent/admissibility-gate/gates.ts` L307–311:

```ts
{ store: opts.store ?? getDefaultPermissionStore() },
```

주석이 “legacy callers” fallback을 허용. 게이트가 전역 싱글톤을 숨겨 물어옴 → 테스트/벤치가 다른 store를 주입해도 누락 시 프로덕션 파일로 폴백.

**조질지:** store 필수. 누락은 타입/런타임 fail-closed. 싱글톤은 apps composition root만.

---

## S6. typed config 우회 `process.env`

**status:** still (D27 / aug-25 #12, #22).

- `session-resource-registry/auto-sweep.ts` L200–233: `QUANTA_SESSION_REGISTRY_*`를 `process.env[CONST]`로 직접. **no-raw ceiling(43) 회피** (리터럴 `process.env.QUANTA_*`만 카운트).
- inventory `home:"runtime-config"` **228**, typed field **0** (D28). inv ∩ `RUNTIME_CONFIG_KNOBS` envKey = **0**.
- `apps/cli/internal.ts`: `process.env.QUANTA_*` 다수.

**조질지:** 키는 inventory + `runtimeConfig()` 한 길. auto-sweep은 typed `sessionRegistry*` 주입. `process.env[CONST]`도 ratchet에 넣음.

---

## N1. JSON-RPC 4표면 (신규 강조)

**status:** new (D19의 상위집합). ADR-0033이 mcp/lsp 이관을 **의도적으로 미룸**.

| 표면 | 경로 | 계약 |
|------|------|------|
| loose envelope | `shared/jsonrpc-envelope.ts` | result+error 공존 허용. MCP/LSP `isJsonRpcEnvelope` |
| strict zod | `shared/jsonrpc/envelope.ts` + `codec.ts` | result XOR error, id null 허용. **src 프로덕션 import 0** (테스트만) |
| MCP framing | `mcp/jsonrpc.ts` | newline + 로컬 `JsonRpcMessage` 복제 |
| LSP framing | `lsp/adapters/jsonrpc.ts` | Content-Length + **동일 로컬 타입** |

`shared/jsonrpc/index.ts` L4–7: mcp/lsp 통합 “INTENTIONALLY deferred”. 그 사이 로컬 타입이 또 생김.

**조질지:** 로컬 `JsonRpcMessage`/`JsonRpcError` 삭제 → `jsonrpc-envelope`. framing만 슬라이스에. strict codec은 소비자 없으면 접거나, 이관 ADR을 닫음.

---

## S7. 900-band cliff (21/24)

god-module 0. **900대로 몰린 파일**이 다음 기능 한 방에 1000 초과.

| 줄 | 파일 | SE |
|----|------|-----|
| 985 | `apps/bench/promax/campaign/gates.ts` | bench 게이트 모놀리스 |
| 983 | `agent/compaction.ts` | 루프 핵심 + `Date.now` (aug-25 #6) |
| 981 | `session/store.ts` | rewind/lock/save 한 파일 (aug-25 #49–51) |
| 973 | `tool/index.ts` | barrel + registry 혼재 |
| 972 | `runner/session-ops/index.ts` | |
| 964 | `tool/surface/gated-tools.ts` | |
| 913 | `agent/admissibility-gate/gates.ts` | 게이트 + locator |

추가로 `permission/shell/assess.ts` **763** (aug-25 ~547, 악화). `apps/terminal/brain-mode.test.ts` **1270** — ratchet이 `.test.ts` 제외.

**조질지:** compaction / session store / tool barrel을 900 아래로. cohort max를 낮춤. N9 150줄 함수도 같이.

---

## S8. `firstLineOf` ×6 + trim 드리프트

**status:** widened (D8). ADR-0330 복제는 문서화됨. **동작이 이미 갈림.**

| 파일 | 정책 |
|------|------|
| `mention-runner/skill-resolver.ts:47-54` | `\n` cut, trailing `\r` strip, **no trim**, miss → `logger.warn` |
| `plugin-app-resolver/skill-resolver.ts:29-48` | 같은 cut, **silent catch** (warn 없음) |
| `plugin-app-resolver/{plugin,mcp,subagent}-resolver.ts` | 로컬 복제 |
| `apps/cli/at-autocomplete/provider.ts:79-81` | `search(/\r?\n/)` + **`.trim()`** |
| `host/runtime/internal/mention-source-deps.ts:117-120` | 동일 **trim** |

mention inject와 autocomplete 첫 줄이 공백/CRLF에서 불일치.

**조질지:** `mention-text.ts` leaf (`firstLineOf` + `safeLookup`). ADR-0330 슬라이스 mutate 금지, 양쪽 import. warn 정책 통일. trim은 한 곳으로.

**검증:** `"  hello\\r\\nworld"` fixture가 전 소비자 동치.

---

## S9. permission lock timeout fail-open

**status:** still (aug-25 #45).

`locking.ts` L104–107: timeout이면 `false`, caller는 best-effort write. 주석: “non-durability never blocks the in-memory authority”.

교차 프로세스에서 두 writer가 락 실패 후 둘 다 persist → last-write-wins. in-memory는 맞을 수 있어도 디스크 드리프트.

**조질지:** timeout은 에러. steal은 stale만. 호출부가 미기록 persist를 성공으로 포장 금지.

---

## S10. `Date.now()` turn provenance

**status:** still (aug-25 #11).

`turn-iteration.ts` L76–84 `makeTurnHeader({ startedAt: Date.now() })`. replay/cassette에서 헤더 시각이 비결정.

**조질지:** `now: () => number`를 config에서. 기본 `Date.now`. 테스트/replay는 고정 시계.

---

## S11. `defaultTools` eager singleton

**status:** still (aug-25 #25).

`tool/index.ts` L920–925 `export const defaultTools: Tool[] = buildDefaultTools()`. import 만으로 레지스트리 구축. 신규 import 금지에 가깝지만 export가 살아 있음.

**조질지:** builder만 public. `defaultTools`는 deprecated alias 또는 삭제.

---

## S12. `side-agent` whole-slice allow

**status:** still (aug-25 #14).

`slice-boundary-configs.ts` L513–523: `@/llm`, `@/llm/replay`, `@/tool`을 슬라이스 전체 allow. 주석은 `worker-charter-runner.ts` composition root만. 스캐너는 파일 단위로 안 좁힘.

**조질지:** `allowImportFiles` (이미 다른 슬라이스가 쓰는 패턴)로 runner 파일만.

---

## S13. STT Whisper REST sibling

**status:** still (D7). 포트는 다름 (`SpeechToTextPort` vs `TranscriberPort`). HTTP는 같은 endpoint/model.

`voice/transcriber/openai-whisper-transcriber.ts` L9–11이 sibling을 명시.

**조질지:** FormData/fetch/error core만 `media/stt/rest-core`. 포트 유지.

---

## S14. agent `*-wire.ts` / `*-bridge.ts` ×16

**status:** still (aug-25 #17). composition이 라이브러리 슬라이스에 쌓임. `ARCHITECTURE.md`는 조립을 `apps/`에 두라고 함. agent가 크로스슬라이스 브리지인 건 맞지만 wire 파일이 루프 옆에 계속 증가.

**조질지:** 새 wire는 host/apps. 기존은 옮기지 말고 증가를 hellgate.

---

## S15. MCP/LSP 로컬 JSON-RPC 타입 복제

N1의 부분집합. `mcp/jsonrpc.ts` L16–32와 `lsp/adapters/jsonrpc.ts` L10–26이 `JsonRpcMessage`/`JsonRpcResponse`/`JsonRpcError` 동일. framing (`LineReader` vs `MessageReader`)은 의도적으로 다름.

로컬 타입만 `jsonrpc-envelope`로.

---

## N11–N16. 추가 P2 (병렬 재검증)

- **N11 D29 fsync:** `storage/atomic-write.ts`는 temp/dir fsync. LSP `file-write-atomic.ts` Phase A는 write→rename만. 주석은 “identical algorithm”.
- **N12 Content-Length:** LSP jsonrpc vs `tool/debug/dap-codec.ts`. DAP는 32MiB cap이 약함.
- **N13 web memoryAuto 0:** CLI `extendBaseWithMemoryAuto`. web-daemon import 0.
- **N14 D28:** inventory home `"runtime-config"` 228, typed 0. `QUANTA_MCP_AUTORESTART`는 `parseEnvFlag(process.env...)`.
- **N15 #31:** `/summarize-now`는 `invalidateOnShrink`만. proactive는 `recordSendCount`.
- **N16 #34/#57:** `decidePrimaryRailFinishGate` prod caller 0. live는 runner `repairCandidateClears`.
- D16 ToolRegistry 2파이프 (`buildBaseRegistry` vs `buildToolingCore`) — R8류, 강제 병합 금지·parity만.
- D17 `build*Base` ×5, #75 `bootstrapSession` 우회, D25 pump-death judge 삼중, D23 CDP correlator, D26 AgentEvent switch, #38 ADR-0061 pending TODO, #46 denial `flushDebounced`, #76–77 session import/export sidecar.

---

## 조질 순서 (ROI)

1. **N9** 150줄 함수 4개를 120 이하 — ratchet cliff.
2. **N3/N4** abort/interrupt capture — `/resume` 공백.
3. **N8/N10** container_exec classify + bash `-c` unwrap.
4. **N6** SSE `!ok` → `fireExit`.
5. **S1** 테이블 SSOT (hellgate는 이미 있음).
6. **S8** `firstLineOf` leaf — UI 드리프트.
7. **S3** embed HTTP core + headless dim.
8. **N1/S15** JSON-RPC 로컬 타입 삭제.
9. **S5** store 필수화.
10. **S7** compaction / session store 900 아래.

강제 병합 금지 (이전 R-항목): batch orchestrator 3종, `assemble` vs per-turn fold, atomic-write 포트 분리, rg/jsonl 계약 다른 spawn.
