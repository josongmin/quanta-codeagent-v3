# Sep-05 — 중복 개발 어딧 (근거 원본)

> 2026-08-29 ~ 2026-09-05 병렬 어딧. **목적:** 같은 역할의 모듈/로직이 여러 곳에 복제·드리프트되는 지점을 코드 위치·인용·헬게이트 공백·조질 방법과 함께 남김.
> **재현 기준:** 라이브 `src/` (`.zz-audit-*` 스냅샷 제외). 2026-09-06 closeout이 착지 후 인덱스 상태를 코드에 맞춤.
> **관련:** [aug-25-wave1.md](./aug-25-wave1.md)는 god-code/lint/arch-debt. 이 문서는 **역할 중복**만.

## Snapshot

| 항목 | 값 |
|------|-----|
| `src/` 슬라이스 | **49 library slices + `apps` composition root** (50 top-level dirs). Owner: `tests/unit/_arch/slice-boundary-configs.ts` (open-by-default denylist). `@/agent` is not the only cross-slice-capable module; `host`/`sdk`/`kernel` are surface-isolation-only. |
| 어딧 범위 | `src/**/*.ts` 전 슬라이스 + 해당 hellgate |
| 원칙 | SSOT + thin adapter + hellgate. slice fence 깨고 합치지 않음 |
| fence SSOT | `tests/unit/_arch/slice-boundary-configs.ts` |
| audit truth snapshot | `59ad4f9b3850b89c0417ef3d12d0c27d64917ba1` |
| delivered closeout | `9139626f93763ce3b52f2b05a2224e30ebde0dd6` (historical exact clean CI 21/21 receipt; branch refs may advance) |
| KNOB_INVENTORY | 353 |
| RUNTIME_CONFIG_KNOBS | 194 |
| env-key intersection | 0 |
| inventory `home:"runtime-config"` | **228** (`home` is a target typed owner, not proof a typed field exists) |
| raw `process.env.QUANTA_*` | **43 / ceiling 43** |

## 분류 범례

Every index row is exactly one of: `execute` | `conditional` | `intentional` | `closed`.
Closed duplicate-removal proposals must not return as unscoped cleanup (see SEP5-11).

**Closeout scorecard:** `execute=0`, `closed=19`, `conditional=11`,
`intentional=1`. `conditional`은 미구현 빚이 아니라 SEP5-11에 구체 trigger와
owner-local RED rail이 등록된 보류 판단이다. 현재 즉시 실행 가능한 미해결 항목은 0개다.

## 방법

1. 병렬 glob/grep + 서브에이전트 (compose, auth, git/media, knobs, subagent, stream/LSP, retrieval, prompt/plugin, SDK/session, permission/security).
2. “같은 basename”은 제외. **같은 계약·같은 알고리즘이 두 곳 이상 유지**되는지만 잡음.
3. 2026-09-06 closeout이 라이브 경로를 다시 열어 인덱스 status를 코드에 맞춤. 추측으로 적힌 항목은 삭제하거나 RESOLVED로 표기.

## 조질 때 공통 규칙

- `@/shared`는 leaf. `@/security`를 import 못 함. 공유 테이블은 shared에 두거나 제3 leaf.
- `@/agent`만 cross-import. peer library끼리 value import 금지.
- App fences are surface-specific. `terminal -> headless` is forbidden; CLI currently imports `@/apps/headless` in `serve-stdio-cmd.ts`. See Biome `noRestrictedImports` in the repo config, not a global “apps cannot import apps” slogan.
- 통합 PR은 **함수 호출 패턴**을 가드하는 hellgate를 같이 넣음 (bare identifier 매칭 금지 — `AGENTS.md` non-vacuity).

---

## 이미 끝난 것 (손대지 말 것) — 근거

### R1. `.zz-audit-before` / `.zz-audit-after` / `.zz-attrib`

2026-08-29 어딧 시점엔 ~1.1GB 미추적 `src/` 스냅샷이 있었음. **2026-09-05 워크스페이스에는 디렉터리 없음.** 추가 삭제 불필요.

### R2. prompt-cache 가격표 — DERIVED

`src/observability/prompt-cache/default-pricing.ts` L1–10:

> Default prompt-cache pricing (ADR-0182) — **DERIVED, no longer a copy.**
> The canonical card lives in `@/observability/pricing` — the SAME slice — so the duplication bought no isolation, only drift risk.

`MODEL_RATE_CARD`에서 `derive()`. 이중 테이블 아님.

### R3. bench corpus cache-pathspecs / loader

`src/apps/bench/corpus/cache-pathspecs.ts` 전체가 `@/runner/batch/corpus/cache-pathspecs` **re-export**. SSOT는 runner. shim 유지 OK.

### R4. gh `CI_ENV_ALLOWLIST`

삼중 복사는 `src/shared/env-scrub.ts`로 이미 합쳐짐. spawn 본체는 `src/tool/gh/runner.ts` `defaultGhExec` (SEP5-01). `createBunGhCliPort` / ci-bot 기본값이 그걸 쓴다.

### R5. trajectory ↔ `redactSecrets` parity

`tests/unit/redaction-parity-hellgate.test.ts` L1–16이 **왜 두 스크러버가 합쳐질 수 없는지**를 박아 둠:

> They cannot be merged into one module (`@/shared` is a leaf and may not import `@/security`), so this test is the anti-drift device.

커버: `redactValue` ↔ `redactSecrets` corpus (stripe/openai/anthropic/gh/slack/gitlab/google/aws/bearer).
`tests/unit/secret-sink-parity-hellgate.test.ts`가 `patternScanner().scanText`까지 같은 corpus를 강제 (SEP5-03). 세 모듈 병합은 펜스 때문에 하지 않음.

### R6. 3종 batch orchestrator 본체

`tool/subagent-batch/run-batch.ts` (인세션 템플릿) / `agent/batch-jobs/runner.ts` (ADR-0463 SQLite job) / `workflow/executor.ts` (AST). 계약이 다름. peer fence로 공유 코어 불가. Semaphore만 `@/shared` 가능.

### R7. `agent-tool` ↔ `handlers-6` 본체

ADR-0041 COEXIST. handlers가 이미 `deriveToolFilter` / `ownersForRegistry` 등을 `agent-tool`에서 import. spawn/wait/stop 본체 합치면 이중 surface가 깨짐.

### R8. `assembleAgentConfig` ↔ `buildAgentConfigFromBase`

headless/SDK/batch vs CLI per-turn. `capability-wire-path-parity` hellgate가 이미 양쪽 fold를 핀. **강제 병합 금지.** 새 wire는 양쪽 의무.

---

## 인덱스

| # | status | 등급 | 분류 | 코드 위치 | 제목 |
|---|---|---|---|---|---|
| [D0](#d0) | closed | 🟢 p3 | docs | `spinner-stall-live-wire.ts` / `knob-inventory/host.ts` / `cli-feature-gates.ts` | `QUANTA_SPINNER_STALL` CLI-seeded; comment lie fixed |
| [D1](#d1) | closed | 🔴 p0 | security | `redaction.ts` / `trajectory.ts` / `pattern-scanner.ts` | secret regex 3포크 — scanner parity hellgate (tables stay fence-split) |
| [D2](#d2) | closed | 🟠 p1 | auth | `chatgpt-oauth/refresh.ts` vs `github-token-rotation.ts` | ChatGPT refresh is `refreshTokenTransaction` + file lock |
| [D3](#d3) | closed | 🟠 p1 | gh | `tool/gh/runner.ts` / `from-pr-cmd-adapters.ts` / `ci-bot.ts` | `gh` spawn SSOT `defaultGhExec` |
| [D4](#d4) | closed | 🟠 p1 | gh | `pr-output-sink.ts` / `ghPrCommentTool` / `ci-bot.postPrComment` | PR comment redact/cap; automation idempotency |
| [D5](#d5) | closed | 🟠 p1 | migration | `external-config/convert.ts` vs `translators/claude-code-config.ts` | Claude MCP/hooks decoder SSOT |
| [D6](#d6) | closed | 🟠 p1 | mcp | `mcp/naming.ts` / `mcp-health.ts` / `mcp-surface-wire.ts` | `sanitizeMcpNameSegment` SSOT; thin aliases remain |
| [D7](#d7) | conditional | 🟠 p1 | media | `media/stt/*` vs `voice/transcriber/*` | Whisper/Deepgram REST sibling |
| [D8](#d8) | conditional | 🟠 p1 | mention | `mention-runner/skill-resolver.ts` vs `plugin-app-resolver/*` | `firstLineOf`/`safeLookup` 복제 + warn 드리프트 |
| [D9](#d9) | closed | 🟡 p2 | session | `ipc/session/handle.ts` vs `sdk/runtime/handle-adapter.ts` | verb-table 쌍둥이 — `SessionVerbSurface<R>` already enforces shape |
| [D10](#d10) | closed | 🟡 p2 | permission | `permission-store.ts` vs `posture-persistence.ts` | `decodeThreadPermission` SSOT |
| [D11](#d11) | closed | 🟡 p2 | auth | `chatgpt-oauth/token-store.ts` vs `mcp-composition.createFileMcpTokenStore` | `writePrivateFileAtomic` SSOT |
| [D12](#d12) | closed | 🟡 p2 | rg | `tool/grep` / `tool/glob` / `retrieval/lexical/ripgrep-impl` | `rg` spawn 3구현 — different output/fallback/jail contracts |
| [D13](#d13) | conditional | 🟡 p2 | git | `storage/git-runner` vs rewind/consolidate/worktree | git spawn 4+경로 |
| [D14](#d14) | closed | 🟡 p2 | hash | `storage/atomic-write.ts` vs llm hash×2 vs migration persist vs bench digest | `sha256Hex` 선언 다수 — fence-local one-liners |
| [D15](#d15) | conditional | 🟡 p2 | retrieval | `embedders/` vs `engines/embedder/`; `rerank/` vs `reranker/` | assembler retired; barrel public-compat dual stack remains |
| [D16](#d16) | conditional | 🟡 p2 | tools | `gated-tool-ports.buildBaseRegistry` vs `tooling.buildToolingCore` | ToolRegistry 조립 2파이프 |
| [D17](#d17) | conditional | 🟡 p2 | compose | `apps/agent/mode-presets/build*Base` | 5개 preset 공통 조립 |
| [D18](#d18) | closed | 🟡 p2 | test | `_support/bootstrap-fake-deps` / `headless/fake-deps` / `brain-mode-session-scaffold` | SessionBootstrapDeps 3벌 — keep surface fakes local |
| [D19](#d19) | closed | 🟡 p2 | jsonrpc | `mcp/jsonrpc.ts` vs `lsp/adapters/jsonrpc.ts` | shared `isJsonRpcEnvelope`; framing stays local |
| [D20](#d20) | closed | 🟡 p2 | jsonl | replay / subagent-persist / custom-3p / radar / jsonl-recorder | JSONL IO 패턴 5곳 — different durability/corruption contracts |
| [D21](#d21) | conditional | 🟡 p2 | boot | CLI `session-setup` vs web `runtime-factory` | interactive boot 평행 |
| [D22](#d22) | conditional | 🟢 p3 | util | `safeJsonParse` / debug `withTimeout` / `sleepReal` / `edit/eol` | 작은 hoist |
| [D23](#d23) | conditional | 🟡 p2 | cdp | `browser/cdp/cdp-session.ts` vs `tool/debug/cdp-client.ts` | CDP correlator 이중 |
| [D24](#d24) | closed | 🟡 p2 | remote | `mcp/skybridge` vs `remote/runner` | lima/docker/vz CLI 평행 — different lifecycle/policy |
| [D25](#d25) | conditional | 🟡 p2 | spawn | plugin-isolation / mcp stdio / lsp transport | pump-death judge (grace는 공유됨) |
| [D26](#d26) | conditional | 🟡 p2 | stream | stdout / jsonl-recorder / agent-state / item-stream … | `AgentEvent` switch ~10곳 |
| [D27](#d27) | closed | 🟡 p2 | knobs | `runtimeConfig()` vs raw `process.env` / CLI_KNOBS∩GATES | `readAuthority` + raw-env 43/43 |
| [D28](#d28) | closed | 🟢 p3 | knobs | inventory `home:"runtime-config"` **228** | `home` is target owner; `readAuthority` is current read |
| [D29](#d29) | intentional | 🟡 p2 | atomic | `storage/atomic-write.ts` vs `lsp/adapters/file-write-atomic.ts` | 알고리즘 동일, port 다름 (문서화됨) |
| [D30](#d30) | closed | 🟢 p3 | oauth | `chatgpt-oauth/refresh.ts` vs `mcp-oauth-provider.ts` vs `token-rotation.ts` | MCP outer mutex ≠ token rotator; SEP5-04B is ChatGPT only |

---

## D0. `QUANTA_SPINNER_STALL` “NOT seeded” 거짓말

**상태 (2026-09-06):** closed. inventory describe는 `CLI-seeded default-ON`. live-wire / session-setup 주석은 slice `gateOn` default-OFF + CLI seed ON. 가드: `tests/unit/cli/cli-seeded-surface-knob-projections.test.ts`.

**배경:** CLI 기본 ON 시딩과 inventory/composition 주석이 반대였음.

**근거 (pre-fix):** live-wire / host inventory가 “NOT CLI-seeded”라고 썼고 `cli-feature-gates.ts`는 키를 seed함.

**라이브:** `src/config/knob-inventory/host.ts` describe “CLI-seeded default-ON”; `cli-feature-gates.ts` L208 `QUANTA_SPINNER_STALL`.

---

## D1. Secret regex 3포크 — scanner parity 없음

**상태 (2026-09-06):** closed as parity, not merge. `SECRET_PATTERN_CATALOG`에 gitlab-pat/jwt/bearer-token/url-userinfo. `secret-sink-parity-hellgate`가 세 plane corpus를 강제. `@/shared` leaf라 테이블 단일 모듈은 불가 (R5).

**배경:** 같은 secret 모양이 싱크마다 다른 카탈로그를 탐. 한쪽만 고치면 다른 plane으로 샘.

**근거:**

| 카탈로그 | 경로 | 싱크 |
|----------|------|------|
| named-kind mask | `src/security/redaction.ts` `redactSecrets` | tool result, memory distill, spans |
| boolean isSecret | `src/shared/trajectory.ts` `SECRET_VALUE_RES` / `redactValue` | JSONL / Plane B |
| findings | `src/security/secret-detection/pattern-scanner.ts` `PATTERNS` | `check_secrets`, egress |

`tests/unit/redaction-parity-hellgate.test.ts`가 **왜 모듈 병합이 불가한지**와 **무엇을 커버하는지**를 명시. `pattern-scanner` import 없음.

알려진 드리프트 (어딧 당시): `redaction.ts`의 `gitlab_pat` / jwt / `sk-svcacct-` / bearer / url-userinfo가 scanner에 빠질 수 있음. corpus는 trajectory↔security만 강제.

**헬게이트:** trajectory↔security만. scanner 없음.

**조질지:**

1. kind+regex 테이블을 `@/shared` (또는 제3 leaf)에 둠. shared→security import 불가 (`ARCHITECTURE.md` §1).
2. 세 consumer가 그 테이블만 참조. 출력 타입(`RedactionHit` vs `SecretFinding`)은 유지.
3. 기존 CORPUS에 `patternScanner().scan` assert 추가.

**검증:** CORPUS 한 줄 revert 시 scanner assert도 RED (non-vacuity).

---

## D2. ChatGPT refresh에 cross-process lock 없음

**상태 (2026-09-06):** closed. `refreshTokenTransaction` + `FileBasedLock`/`createNodeLockFileStore`. LLM `ensureFreshToken`과 bench `refreshRemoteAuthJson`이 같은 트랜잭션을 씀. MCP outer mutex는 D30 — 손대지 않음.

**근거:**

`src/auth/github-token-rotation.ts` L7–14, L55:

> rotation is lock-protected (same `OAuthRefreshLockPort` from Phase D)
> `readonly lockPort: OAuthRefreshLockPort`

`src/auth/chatgpt-oauth/refresh.ts` L228–274: `RefreshCoordinator` — `(issuer, clientId, refresh_token)` in-flight Map. `OAuthRefreshLockPort` **미사용**.

포트 본체: `src/auth/oauth-refresh-lock.ts` + `lock-file-based.ts` / `lock-in-memory.ts` / `lock-redis-stub.ts`.

`rotateGitHubToken`은 모듈 밖 production caller가 거의 없음 (scaffolding). ChatGPT 경로는 실사용.

**헬게이트:** `oauth-refresh-lock-hellgate`, `github-token-rotation-hellgate`, `auth/t07-refresh-hellgate`(Coordinator만). **ChatGPT×lockPort 연동 없음.**

**조질지:** `refreshToken` 경로에 `lockPort` 주입. Coordinator는 in-proc 유지, file lock은 cross-proc. composition root에서 `FileBasedLock` 연결.

**검증:** 두 holder 동시 refresh → 한쪽 wait/skip.

---

## D3. `gh` spawn 3경로 — from-pr는 scrub 없음

**상태 (2026-09-06):** closed. `src/tool/gh/runner.ts` `defaultGhExec`가 scrub+timeout+tree-kill SSOT. `createBunGhCliPort(binary, exec=defaultGhExec)`, ci-bot `spawnGhRunner`도 동일 기본값. `Bun.spawn(["gh"` 본체는 runner.ts만.

**배경:** 같은 `gh` 바이너리, argv 모양·env 정책이 다름.

**근거:**

| 구현 | 경로 | 특징 |
|------|------|------|
| `defaultGhRunner` | `src/tool/gh/runner.ts` | `Bun.spawn` + `scrubEnv(CI_ENV_ALLOWLIST)` + tree-kill |
| `GhCliPort` | `src/reactor/trigger-source-ci.ts` | 포트 타입. argv에 `gh` prefix **없음** |
| `createBunGhCliPort` | `src/apps/cli/from-pr-cmd-adapters.ts` L59–86 | `bun.spawn([binary, ...args])`. **env 필드 없음 = 부모 env 상속** |
| `spawnGh` | `src/apps/agent/mode-presets/ci-bot.ts` L75+ | `Bun.spawn` + `scrubEnv` |

`from-pr-cmd-adapters.ts` L54–57:

> Production `gh` CLI adapter via Bun.spawn. … Mirrors the pattern in `src/reactor/trigger-source-ci.ts`.

spawnOpts는 `cwd` / stdout / stderr / signal만. scrub 없음.

allowlist 삼중 복사는 R4로 해소. **wrapper는 남음.**

**헬게이트:** `ci-bot-preset.test.ts`(scrub), `spawn-helper-consolidation-hellgate`(tree-kill on defaultGhRunner). **from-pr scrub ratchet 없음.**

**조질지:** `defaultGhRunner`가 spawn+scrub+kill SSOT. `GhCliPort`는 그 위 adapter (`["gh", ...args]` 정규화). `createBunGhCliPort`는 그걸 호출.

**검증:** from-pr 경로가 `scrubEnv`를 탄다는 source ratchet (`scrubEnv\s*\(`).

---

## D4. PR comment write 안전 계약 3개

**상태 (2026-09-06):** closed. ci-bot은 `createPrOutputSink` + `automatedPrCommentKey` (runId 없으면 fail-closed skip). HITL `ghPrCommentTool`은 `defaultGhCommentBodyPolicy.prepare` 후 runner. 펜스 때문에 integrations/github와 tool/gh body policy는 구조적 쌍둥이 (cap 65000; automation만 marker).

**배경:** 사용자에게는 같은 “PR에 댓글”. 재시도·secret 처리가 갈림.

**근거:**

`src/integrations/github/pr-output-sink.ts` L1–14:

> ADR-0313 — PR output sink with redaction + idempotency.
> Every outgoing body passes through `RedactPort.redact` BEFORE the gh API call
> Idempotency: `<!-- quanta:idempotency=<key> -->` … find-existing → PATCH

구현: `gh api --method POST …/issues/…/comments`.

`src/tool/gh/index.ts` L159–178: `ghPrCommentTool` — `gh pr comment --body`. permission gate만. marker 없음.

`src/apps/agent/mode-presets/ci-bot.ts` L336+: `postPrComment` — `gh(["pr","comment",pr,"--body",body])`. redact/idempotency 없음.

**헬게이트:** sink 쪽 reconcile/pagination은 다수. **삼자 write 통일 ratchet 없음.**

**조질지:** write SSOT = `pr-output-sink.postComment`. ci-bot은 sink 호출. agent tool은 HITL UX 유지하되 body는 sink(또는 동일 marker+redact) 경유.

**검증:** ci-bot이 raw `pr comment`만 치면 RED.

---

## D5. Migration MCP/hooks — 주석은 REUSES, 코드는 복붙

**상태 (2026-09-06):** closed. `src/migration/claude-config-decode.ts` ← convert.ts / translators/claude-code-config.ts.

**근거:**

`src/migration/external-config/convert.ts` L10–11:

> `mcp` / `hooks` → **REUSES** the parent slice's `translateMcpServers` / `translateHooks` **shapes**

`translateMcpServers` / `translateHooks` **import 없음.** 로컬 재구현.

양쪽 `classifyTransport`가 바이트 수준으로 같음:

`translators/claude-code-config.ts` L51–59:

```ts
const classifyTransport = (entry: Record<string, unknown>): TranslatedMcpServer["transport"] => {
  const type = entry.type
  if (type === "http" || type === "sse" || type === "stdio") return type
  if (typeof entry.url === "string") return "http"
  if (typeof entry.command === "string") return "stdio"
  return "unknown"
}
```

`external-config/convert.ts` L184–192: 동일 분기. 반환 타입 이름만 `ConvertedMcpServer`.

추가로 양쪽 `asObject`, `commandsOf`, `translateHookGroup`/`translateHookMap`.

소비자:

- `migration/importer.ts` → `translateMcpServers` / `translateHooks`
- `migration/external-config/run.ts` → `convertMcp` / `convertHooks`

**헬게이트:** `external-config-migration-hellgate`는 convert 쪽. **translate↔convert 동치 없음.**

**조질지:** `claude-code-config.ts`의 순수 map을 SSOT. convert는 path 읽고 그 함수 호출 후 `Converted*`로 래핑. `asObject`는 한 곳.

**검증:** 동일 `.mcp.json` / `settings.json#hooks` fixture → convert.value ≡ translate 결과.

---

## D6. `sanitizeServerKey` 3벌

**상태 (2026-09-06):** closed. regex SSOT `sanitizeMcpNameSegment` (`mcp/naming.ts`). health/CLI `sanitizeServerKey`는 thin alias.

**근거:**

`src/host/mcp-health.ts` L20:

```ts
export const sanitizeServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_")
```

`src/apps/cli/repl/mcp-surface-wire.ts` L39–42:

> Sanitize a config server name the same way `mcpToolName` does (private helper in `@/agent/mcp-bridge`). **Kept in lockstep** here

```ts
const sanitizeServerKey = (name: string): string => name.replace(/[^A-Za-z0-9_]+/g, "_")
```

(주석의 `mcp-bridge`는 구경로. 실제는 `mcp-tool-adapter.ts`.)

`src/agent/mcp-tool-adapter.ts` L42–45:

```ts
export const mcpToolName = (server: string, tool: string): string => {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]+/g, "_")
  return `mcp__${clean(server)}__${clean(tool)}`
}
```

관련: `agent/subagent-tool-namespace.ts`도 같은 sanitize 계열.

**헬게이트:** `tests/unit/mcp/tool-name-collision-hellgate.test.ts`는 `mcpToolName` 충돌만. **삼중복 parity 없음.**

**조질지:** host `sanitizeServerKey`가 SSOT. `mcpToolName`이 그걸 호출. wire는 로컬 삭제 후 host import (`@/agent`·apps는 host import 가능).

**검증:** `sanitizeServerKey\s*\(` source ratchet + 세 곳이 같은 함수를 쓰는지. lockstep 주석 삭제.

---

## D7. STT Whisper/Deepgram REST sibling

**배경:** ADR-0202 `SpeechToTextPort` (`@/media`)와 ADR-0208 `TranscriberPort` (`@/voice`)가 공존. HTTP는 거의 같음.

**근거 — 코드가 sibling이라고 씀:**

`src/voice/transcriber/openai-whisper-transcriber.ts` L9–11:

> Sibling to `@/media/stt/openai-whisper-adapter` — this one binds to the richer `TranscriberPort`

`src/voice/transcriber/deepgram-transcriber.ts` L13–15:

> Sibling to `@/media/stt/deepgram-adapter`

`src/voice/transcriber/port.ts` L4:

> Sibling to `@/media/stt/port`'s `SpeechToTextPort` (ADR-0202)

엔드포인트:

- Whisper: `api.openai.com/v1/audio/transcriptions`, model `whisper-1`
- Deepgram: `api.deepgram.com/v1/listen`, nova-3 + smart_format

포트 합치면 `/voice`의 segments/language/abort가 깨짐. **HTTP core만** 빼는 게 맞음.

**헬게이트:** `media/stt-hellgate`, `voice-cmd-hellgate` 등 각각. **교차 transcript 동치 없음.**

**조질지:** `media/stt/rest-core.ts` (FormData, fetch, error, retry). voice는 thin wrap. 포트 유지.

**검증:** mock fetch 동일 audio → text 동치 + endpoint/model 상수 parity.

---

## D8. mention `firstLineOf` / `safeLookup`

**배경:** ADR-0330이 mention-runner 슬라이스 mutate를 금지해서 composite resolver가 복제함.

**근거:**

`src/agent/mention-runner/skill-resolver.ts` L1–30, L47, L63: ADR-0330 skill-only port. `firstLineOf` + `safeLookup`. miss/throw → `null`. logger.warn 경로 있음.

`src/agent/plugin-app-resolver/skill-resolver.ts` L11–24:

> Behaviour parity with ADR-0330's skill resolver is intentional
> **Why duplicate instead of importing from `@/agent/mention-runner`:**
> ADR-0330's exported helper is the full-port builder. … spec forbids ("ADR-0330 mention-runner 슬라이스 mutate X"). **Code duplication is intentional**

같은 `firstLineOf`/`safeLookup`이 추가로:

- `plugin-app-resolver/plugin-resolver.ts`
- `plugin-app-resolver/mcp-resolver.ts` (`firstLineOf`)
- `plugin-app-resolver/subagent-resolver.ts`
- `apps/cli/at-autocomplete/provider.ts` (`.trim()` 변형)
- `host/runtime/internal/mention-source-deps.ts` (`.trim()` 변형)

plugin 쪽은 silent catch (warn 없음) → 드리프트.

**헬게이트:** 없음.

**조질지:** `firstLineOf`+`safeLookup`을 `@/agent/mention-injection` (또는 `mention-text.ts`) leaf로. ADR-0330 슬라이스는 mutate하지 않음. 양쪽 import. warn 정책 통일.

**검증:** CRLF/`\r`/empty fixture 동치 + warn 복구 hellgate.

---

## D9. Session verb-table 쌍둥이

**배경:** in-process oracle과 wire door가 같은 `SessionVerbSurface`. correlator는 이미 공유. verb 테이블만 복붙.

**근거:**

`src/ipc/session/handle.ts` L1–26, L675 `buildWireVerbSurface` — `submit(build*)` → receipt.

`src/sdk/runtime/handle-adapter.ts` L1–22, L135 `buildAdapterVerbSurface` — `receiptOf(session.*)`.

공유됨: `createTurnEndCorrelator` (`ipc/session/handle.ts`), `protocol/session/builders.ts`, `verb-surface.ts`.

세 번째 배선: `sdk/runtime/session.ts` — `SessionDispatchResult` 등급 (더 강함). `SessionVerbSurface` 밖.

**헬게이트:** WS e2e / hang-wire. **verb 키 집합 이중구현 hellgate 없음.**

**조질지:** `ipc/session/verb-surface-impl.ts`에 `buildVerbSurfaceFromSubmit`. wire/adapter는 submit만. 레이어 병합 금지.

**검증:** 기존 e2e + verb 키 집합 동일 assert.

---

## D10. `ThreadPermission` validator 복제

**상태 (2026-09-06):** closed. `permission/thread-permission-decode.ts` ← store + posture.

**근거:**

`src/permission/posture-persistence.ts` L79–86:

> Fail-closed shape guards (small, local — **no value import from the store, to avoid a runtime cycle**; the store's own `validateThreadPermission` stays private there).
> `isApprovalPolicy` = never | on-request | on-failure | always

`src/permission/permission-store.ts` L226–230: **동일** `isApprovalPolicy` / `isApprovalsReviewer` / `isStringArray`.

스키마 한 곳만 고치면 posture load가 다른 값을 통과/거절함.

**헬게이트:** store concurrent-write, web-posture resume, fail-closed-base. **양쪽 validator 동치 없음.**

**조질지:** `permission/thread-permission-validate.ts` (value cycle 없는 leaf). 양쪽 import.

**검증:** corrupt sandbox/approval fixture가 양쪽 fail-closed.

---

## D11. Token file atomic-write 패턴

**상태 (2026-09-06):** closed. `writePrivateFileAtomic` ← ChatGPT `writeToken` + MCP `createFileMcpTokenStore.write`. 스키마는 분리.

**근거:** `src/auth/chatgpt-oauth/token-store.ts` — `access_token`, `expires_at` ISO, 0600 assert.
`src/host/mcp-composition.ts` `createFileMcpTokenStore` — `TokenRecord` camel, tmp+chmod+rename.

**헬게이트:** chatgpt t07-refresh, token-revoke. MCP file store 전용 hellgate 약함.

**조질지:** atomic 0600 write leaf (`@/storage` 또는 shared). 스키마 adapter 유지.

---

## D12. `rg` spawn 3구현

**근거:**

- `src/tool/grep/index.ts` — `buildGrepArgv` → `runShell("rg …")` 문자열
- `src/tool/glob/index.ts` — `rg --files` via `runShell`
- `src/retrieval/lexical/ripgrep-impl.ts` — `Bun.spawn` + injectable spawner, `--json`, grep fallback

**헬게이트:** grep-flags, grep-jail, glob-gitignore, lexical-hellgate. **spawn 단일화 없음.**

**조질지:** argv-array `RgSpawner`. grep/glob은 argv만. lexical은 json/fallback 유지.

---

## D13. git spawn 4+경로

**근거:**

| 경로 | 메커니즘 |
|------|----------|
| `src/storage/git-runner/runner.ts` | `Bun.spawn(["git",…])` + scrubbed env — **SSOT 후보** |
| `src/tool/git/runner.ts` | 위 re-export |
| `src/apps/cli/rewind-git.ts` | `node:child_process` / exec, **full process.env** |
| `src/memory/consolidate/git.ts` | 자체 `Bun.spawn` |
| `src/runtime/worktree.ts` | `` runShell(`git ${args}`) `` **셸 문자열** |

**조질지:** 전부 `GitRunner` 주입. worktree 셸 경로 제거.

**검증:** argv가 `["git", …]`만인지 ratchet.

---

## D14. `sha256Hex` 선언 다수

**배경:** slice fence 때문에 1줄 wrapper를 복사. storage 주석이 인정함.

**근거:**

`src/storage/atomic-write.ts` L31–34:

> The `sha256Hex` helper is the convention every other slice already uses (see `@/llm/system-prompt-cache/hash.ts`). **Re-declared here ONLY so `@/storage` does not reach into `@/llm`** for a 1-line wrapper.

동일 1-liner:

- `src/llm/system-prompt-cache/hash.ts` L23–24 — ADR-0326. “Same shape as ADR-0322 `cache-control-audit/hash.ts`”
- `src/llm/cache-control-audit/hash.ts` L28–29
- `src/migration/external-config/persist.ts` L722 (local const)
- `src/apps/bench/promax/provenance/digest.ts` L22 — bytes 입력 확장

이미 `@/storage`를 쓰는 곳: edit/write, hunk-mutation-journal, review-anchor, skill promote 등.

**헬게이트:** hash 단일성 ratchet 없음. empty digest `e3b0c4…`는 각 모듈 테스트에 흩어짐.

**조질지:** `@/storage#sha256Hex` 또는 `@/shared` crypto leaf. llm은 storage import 가능하면 import, 아니면 shared. bench digest는 bytes overload만 래핑. persist 로컬 삭제.

**검증:** `""` → 동일 hex를 storage/llm/bench/persist가 공유.

---

## D15. Retrieval 이중 스택

**상태 (2026-09-06):** conditional. `runner/assemble/retrieval.ts` / `buildRetrievalStackCore` 삭제. live 조립은 `createEmbedderFromEnv` / `createRerankerFromEnv`. `embedders/**` + `embedding-port`는 barrel public-compat로 분류됨 (`retrieval-authority-manifest.test.ts`). 스택 병합은 외부 소비자 증거 전까지 하지 않음.

**근거:**

- Legacy ADR-0159: `src/retrieval/embedders/*` — `EmbeddingPort`, throw
- New ADR-0261: `src/retrieval/engines/embedder/*` — `Embedder`, `Result<>`
- Live wire: `runner/assemble/search-index-backend.ts` → `@/retrieval/engines`
- `rerank/` (`RerankPort`, fusion/BM25) vs `reranker/` (`Reranker<T>`, vendor HTTP)
- **같은 심볼** `identityReranker` 두 계약

placeholder embed도 3개: `hashEmbed` (FNV dim 64), semantic headless (L2), engines headless (dim 1536, no L2).

BM25: `lexical/bm25-impl.ts` Unicode tokenizer vs `rerank/bm25-secondary.ts` ASCII. 공식 k1=1.5 b=0.75 동일.

**헬게이트:** 이중 트리 통합 없음.

**조질지:** engines/reranker SSOT. legacy barrel `@deprecated` re-export. `identityRerankPort` rename. fusion만 `rerank/`에.

**검증:** production import가 `createEmbedderFromEnv`만이라는 source ratchet.

---

## D16. ToolRegistry 조립 2파이프

**근거:**

- `src/host/runtime/agent-arg-builder/gated-tool-ports.ts` `buildBaseRegistry` (~L459) — headless/host
- `src/runner/assemble/tooling.ts` `buildToolingCore` (~L308) — CLI `buildTooling`

둘 다 `buildDefaultTools` + `instrumentToolsForExport`. ports/extras만 다름.

**헬게이트:** async-tools-deferred, tool-origin-substrate, memory-mode-knob. **단일 builder ratchet 없음.**

**조질지:** `buildToolingCore`가 레지스트리 SSOT. host는 gated ports만.

---

## D17. Mode preset `build*Base` 5개

**근거 (6이 아님):**

- `interactive.ts` `buildInteractiveBase`
- `ide.ts` `buildIdeBase`
- `daemon.ts` `buildDaemonBase`
- `headless.ts` `buildHeadlessBase`
- `ci-bot.ts` `buildCiBotBase`
- `batch.ts` / `system.ts`에는 `build*Base` **없음**. `system.ts`는 shared resolvers만.

공통: system prompt, repo-rules, `assembleAgentConfig`, ToolRegistry.

**조질지:** `buildModePresetBase(req, overrides)`.

**헬게이트:** mode-preset-repo-rules-wire. 유지.

---

## D18. SessionBootstrapDeps fake 3벌

**근거:** ~70줄 stub이 세 곳.

| 파일 | 함수 |
|------|------|
| `tests/_support/bootstrap-fake-deps.ts` | `makeFakeBootstrapDeps` |
| `src/apps/headless/fake-deps.ts` | `buildFakeBootstrapDeps` |
| `src/apps/terminal/brain-mode-session-scaffold.ts` | `buildTerminalBootstrapDeps` — 주석: headless shape **REPLICATES**, apps fence 때문에 import 불가 |

공통 stub: `buildLifecycleBundle`, `deriveMcpPillServers`, `buildCostPanelOrUndefined`, `buildLlm`, `buildIdleGuards`, …

activityStore 드리프트: terminal/stdio=`buildSessionAuthorities`, headless=`createActivityStore()`.

**조질지:** `host/bootstrap`에 `buildMinimalSessionBootstrapDeps`. apps는 delta만.

---

## D19. MCP vs LSP jsonrpc 타입

**상태 (2026-09-06):** closed. `shared/jsonrpc-envelope.ts` `isJsonRpcEnvelope`. MCP/LSP framing과 로컬 `JsonRpcMessage` 별칭은 유지.

**근거:**

`src/mcp/jsonrpc.ts` — newline `LineReader`, `MAX_LINE_BYTES` 10MB. 주석이 plugin-isolation `MAX_MESSAGE_BYTES`를 거울로 명시.

`src/lsp/adapters/jsonrpc.ts` — Content-Length `MessageReader`, `MAX_FRAME_BYTES` 32MiB.

`JsonRpcMessage` / `JsonRpcResponse` / `JsonRpcError` / `isValidEnvelope`(jsonrpc==="2.0") 거의 동일.

**조질지:** `@/shared/jsonrpc` 타입+validator. framing은 slice 유지.

---

## D20. JSONL IO 패턴 5곳

**근거:**

| 파일 | 패턴 |
|------|------|
| `src/llm/replay/jsonl-store.ts` | append + hash match |
| `src/agent/subagent-persistence-store/jsonl-store.ts` | resume |
| `src/connectors/custom-3p/jsonl-store.ts` | snapshot rewrite, 0600/0700 |
| `src/radar/jsonl-file-store.ts` | append-only replay, corrupt skip |
| `src/stream/adapters/jsonl-recorder.ts` | trajectory events |

공통: mkdir, `\n`, chmod, corrupt-line skip, in-memory hydrate.

**조질지:** `storage/jsonl-io.ts` leaf. 스키마는 slice.

---

## D21. CLI vs web interactive boot

**근거:**

CLI: `host/bootstrap/bootstrap-session.ts` ← `apps/cli/repl/session-setup.ts` (~823 LOC) + `runtime-context-compose.ts`.

Web: `apps/web-daemon/runtime-factory.ts` — `bootstrapSession` **없음**. `buildAgentConfigBase` + `mintSessionCollaborators`. 주석이 interactive preset / CLI bootstrap shape을 거울로 언급.

공유 SSOT: `assembleAgentConfig`, `buildInteractiveTurnAssembler`.

**조질지:** `mintSessionCollaborators`를 `@/host/runtime`으로. CLI=TTY, web=WS. `apps/agent/mode-presets/interactive.ts`는 thin 또는 deprecate.

**헬게이트:** session-setup-hellgate, web-posture-wire, composition-slot-registry-byte-identical.

---

## D22. 작은 유틸

| 대상 | 경로 | 근거 | 조질지 |
|------|------|------|--------|
| `safeJsonParse` | `agent/subagent-background.ts` (export, `undefined`) / `agent/budget-ledger.ts` (private) / `llm/streaming-events.ts` (`null`) | 동일 try/catch, sentinel만 다름. `@/llm`↛`@/agent` | `@/shared` |
| `withTimeout` | `tool/debug/inspect-driver.ts` ↔ `cdp-inspect.ts` | 바이트 동일 Promise.race | `tool/debug/_timeout.ts` |
| `sleepReal` | `apps/bench/remote/lease-fs.ts` ↔ `pool/types.ts` | 동일 setTimeout one-liner | types 하나로 |
| `detectEol` | `shared/eol.ts` SSOT vs `tool/edit/eol.ts` 복제 | ratchet이 byte-identical 유지 | `export { detectEol } from "@/shared/eol"` |
| `parseBoolKnob` | `agent/brief.ts` | “mirrors parseBool” | `runtime-config/parsers.parseBool` |
| `abortableSleep` vs `loop/sleep` | reject vs resolve on abort | **합치지 말 것** | poller early-abort만 |

---

## D23. CDP correlator 이중

**근거:** `src/browser/cdp/cdp-session.ts` — Page/Runtime, allowlist, multi-tab `sessionId`, `Result`.
`src/tool/debug/cdp-client.ts` — Node `--inspect-brk`, Debugger domain. `event-fanout.ts`는 DAP와만 공유, browser와는 아님.

둘 다: monotonic id, pending map, event waiters, JSON parse loop.

**조질지:** id↔reply correlator leaf만. transport/policy 유지.

---

## D24. skybridge vs remote/runner

**근거:** 같은 백엔드 CLI, 다른 포트.

| Backend | skybridge (`McpSandbox`) | remote (`RemoteRunner`) |
|---------|--------------------------|-------------------------|
| Lima | `mcp/skybridge/lima-microvm.ts` | `remote/runner/lima-adapter.ts` |
| Apple-VZ | `applevz-microvm.ts` / `applevz-native.ts` | `apple-vz-adapter.ts` (주석: skybridge substrate mirror) |
| Docker | `container.ts` (stub) | `docker-adapter.ts` (full) |

**조질지:** detect+argv leaf. 포트 합치지 말 것.

---

## D25. pump-death

**근거:** `src/plugin-isolation/bun-spawner.ts`가 `PUMP_DEATH_EXIT_GRACE_MS = 50`을 **export하고 “sibling stdout pumps must not reinvent the window”**라고 씀.

소비: `mcp/transports/stdio.ts`, `lsp/adapters/base/transport.ts` — **상수 import**. judge/kill 로직은 각자.

**헬게이트:** plugin-isolation-pump-death, mcp/stdio-pump-death, lsp-pump-death — 이미 3개.

**조질지:** judge 함수까지 plugin-isolation에서 export.

---

## D26. `AgentEvent` switch ~10곳

**근거:** 각 파일이 다른 부분집합을 렌더/프로젝션. 신규 이벤트 시 다수 수정, 일부는 silent drop.

- `stream/adapters/stdout.ts` (~50 arms, exhaustiveness)
- `stream/adapters/jsonl-recorder-kind-map.ts` / `-data.ts`
- `apps/agent/mode-presets/stream-json-sink.ts`
- `protocol/agent-state/projection.ts`
- `stream/item-stream-projector.ts` — **item core SSOT**, drift hellgate 있음
- `kernel/session/session-host-turn-event-projection.ts`
- CLI debug-tracer, turn-summary, background-capture-tee

**조질지:** inventory 테이블 + projector는 filter/map. stdout/jsonl부터.

---

## D27. Knob raw env / 이중 선언

**상태 (2026-09-06):** closed. `readAuthority` closed universe. raw `process.env.QUANTA_*` **43 / ceiling 43**. runtime-config knob catalog은 **194**이며 default/kind parity rail이 194개 전부를 열거하고 0 violation을 증명한다. CLI 7 overlap은 `CLI_SEEDED_SURFACE_KNOBS`. dual-channel 4키 유지. `QUANTA_GOAL`은 startup-seed.

**근거 (2026-09-05 재검증):**

typed인데 raw `process.env` (최소):

- `QUANTA_GOAL` — `apps/cli/index.ts` (startup-seed; keep)
- `QUANTA_SESSION_REGISTRY_SQLITE_PATH` / `DISK_DIR` — auto-sweep / inspector still raw; `/session-registry cleanup --dry-run` now injects typed runtime-config paths

전체 raw ceiling: `tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts` **43**.

`CLI_KNOBS ∩ CLI_FEATURE_GATES` **7키:**
`QUANTA_AT_AUTOCOMPLETE`, `BRACKETED_PASTE`, `ENABLE_ENV_PROBE`, `EXTERNAL_EDITOR`, `KEYBINDINGS`, `MODE_CYCLE`, `PREFLIGHT_CHECK`.

runner ∩ runtime-config-knobs **4키** (apply no-op, 문서화 dual-channel):
`QUANTA_MCP_TOOL_ANNOTATIONS`, `RATELIMIT_NOTICE`, `READ_OUTLINE`, `TEST_RUNNER`.

**조질지 (SEP5-10 landed):** typed cleanup inject. 7키는 `CLI_SEEDED_SURFACE_KNOBS` SSOT에서 help/seed/`/knobs` projection. 4키 dual-channel은 runner discovery + runtimeConfig mutation, apply identity. raw ceiling **43/43**.

**검증:** no-raw-env ceiling ↓. disjoint hellgate 확장.

---

## D28. inventory `home:"runtime-config"` 228

**상태 (2026-09-06):** closed. `home` 리네임은 하지 않음. `readAuthority`가 current read를 구분. `types.ts` 주석: home is target typed owner.

**근거:** `KNOB_INVENTORY` ∩ `RUNTIME_CONFIG_KNOBS` by envKey = **0** (의도적 disjoint). 그런데 inventory **228**개가 `home: "runtime-config"`라 운영자가 typed SSOT로 착각. `home` is a **target** typed owner, not proof a typed field currently exists. Executable under `tests/unit/knob-read-authority-parity.test.ts`.

예: `QUANTA_MCP_AUTORESTART` / `HOT_RELOAD` — inventory `host.ts`, 실제 parse는 `host/mcp-composition.ts` `parseEnvFlag(process.env.…)`.

**조질지:** `home` rename `composition-gate` 또는 typed promote. **4레지스트리 1파일 합치기 금지.**

---

## D29. atomic write 알고리즘 이중 (문서화)

**근거:** `storage/atomic-write.ts` L10–11:

> Algorithm — **identical** to `@/lsp/adapters/file-write-atomic.ts` for a single entry … different port shape.

단일 파일 vs N-file LSP batch. **합치지 말 것.** 주석이 SSOT.

---

## D30. OAuth token parse + in-flight mutex

**근거:**

parse (access_token + expires_in):

- `auth/chatgpt-oauth/refresh.ts` `parseTokenResponse` / `parseExchange`
- `auth/github-token-rotation.ts` `parseRefreshResponse`
- `host/runtime/mcp-oauth-provider.ts` `parseTokenResponse` (필드명 camel, ms)

in-flight Map:

- ChatGPT `RefreshCoordinator`
- `connectors/token-rotation.ts` `createTokenRotator` (주석: chatgpt invariant 일반화)
- `mcp-oauth-provider.ts` `inFlightToken` (rotator 위 3번째)

토큰 레코드 두 모델: snake `TokenRecord` (chatgpt) vs camel `connectors/types.ts`.

**조질지:** RFC6749 parse leaf + field adapter. mutex는 `createTokenRotator`로 ChatGPT도 연결 (D2 lock과 별개 — in-proc vs cross-proc).

---

## 의도적 분리 (통합 금지) — 근거

| 대상 | 근거 |
|------|------|
| kernel / protocol / ipc / sdk 레이어 | `ARCHITECTURE.md` §1. builders는 이미 `protocol/session/builders.ts` SSOT |
| LSP `@/lsp` ↔ `tool/lsp_nav` type mirror | RFC §3.1. 주석+hellgate가 byte-compatible 강제 |
| codemode 3층 | slice sandbox / `codemode-tool.ts` / `codemode-wire.ts` — 보안 경계 |
| prompt-body → graph → rules | ADR-0538, `role-drift.ratchet` |
| V1 `agent/state.ts` vs V2 `session/store.ts` | session/index.ts: “NEW rail alongside V1” |
| `mcp/client` vs `isolated-client` | `MCP_USE_ISOLATED_SPAWN=1` |
| auth lock 3 strategy | in-memory / file / redis stub — 같은 포트 |
| `config/loader` vs `runtime-config` | disk layers vs frozen env. 우선순위 env > disk |
| skill frontmatter 3종 | lenient / strict(zod) / playbook(yaml lib) — 각 파일 주석 |
| human vs JSON logger | `shared/logger.ts` vs `observability/logger.ts` |
| `abortableSleep` vs `loop/sleep` | abort 시 reject vs resolve |
| 18× `headless-stub.ts` | 포트당 테스트 어댑터 |

---

## 실행 순서 (SEP5 tickets)

The source-audit PR list is retired. Execute via
[`docs/plans/sep-5-duplicate-development/tickets/README.md`](../plans/sep-5-duplicate-development/tickets/README.md):

1. SEP5-00 audit truth
2. SEP5-01 gh execution authority
3. SEP5-03 secret detector parity
4. SEP5-04A private atomic token write → SEP5-04B ChatGPT refresh transaction
5. SEP5-02 PR comment outbound safety (after 01+03)
6. SEP5-05 Claude decoder
7. SEP5-06 MCP naming
8. SEP5-07 permission decoder
9. SEP5-08 JSON-RPC envelope
10. SEP5-09 retrieval authority
11. SEP5-10 knob read-authority
12. SEP5-11 closed/conditional register (no impl of closed items)
13. SEP5-12 receipts + `bun run test:ci` last

Unresolved scope: HTTPS secret egress remains opaque without MITM. Dual retrieval public-compat barrel (`embedders/**`) stays until a deprecation consumer inventory. SEP5-12 is closed only with an exact-HEAD `bun run test:ci` receipt.

---

## 세션 메타

- 어딧 기간: 2026-08-29 ~ 2026-09-05
- 라이브 재검증: 2026-09-05; closeout 문서 정합: 2026-09-06
- 이 파일이 근거 SSOT. 채팅 요약보다 이 인용을 믿을 것.
- 코드가 이 문서와 달라지면 **코드를 이기고 이 섹션을 고침.**
