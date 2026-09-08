# Sep-08 SE audit — agent-5 (lane C session dump)

> **Role:** Sep-07 SOLID/SE campaign **lane C** worker (this Cursor session).
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-C.md`](../../plans/sep-7-solid-se-audit/receipts/W1-C.md) (status **DONE** = classified, not fixed).
> **Dispatch:** [`docs/plans/sep-7-solid-se-audit/prompts/README.md`](../../plans/sep-7-solid-se-audit/prompts/README.md).
> **This file:** 세션에서 확인한 사실의 **원장**. W3-I 티켓이 아님. 구현 권한 없음.
> W2-X 전에 이 dump만 진실로 쓰지 말고 **W1-C + HEAD 해시**를 맞춰라.

```text
AUDIT_ASSIGNMENT|lane=C|scope=mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-C.md
```

**날짜:** 2026-09-07 ~ 2026-09-08 (KST)

**상태:** 분류 완료. 프로덕션 소스/테스트/티켓/카탈로그/git/GitHub는 안 고침. 이 세션이 쓴 파일은 `W1-C.md`와 이 dump뿐.

---

## 0. 캠페인 규칙 (이 세션이 따른 것)

- Exclusive C production만 분류. `src/shared/**`와 캠페인 docs는 W2/W3. 교차 레인 import는 **증거**, write 소유가 아님.
- 모든 exclusive production 파일을 분류. owner + reachable consumer를 연다. `rg`는 탐색만.
- Finding = 두 live owner + producer→contract→consumer + 측정 drift 또는 dual-write race.
- SOLID smell without failure = inventory. grep-only / 냄새만 = finding 아님.
- SEP5/SEP6 retired ID는 **문서화된 트리거가 이 HEAD에서 재현될 때만** 재오픈.
- DONE = classified, not fixed. STALE = HEAD 또는 tracked/untracked hash가 나중에 나온 W0과 불일치.
- BLOCKED / INCOMPLETE는 이 레인에서 쓰지 않음 (212/212 분류 완료).

---

## 1. 세션이 한 일

1. AGENTS.md / AGENT_CORE.md / AGENT_PLAYBOOK.md / docs/ARCHITECTURE.md / tests/README.md / `.ai/guide-development.md` / SEP5-11 closed register / SEP6 closeout을 읽음.
2. W0 영수증 **부재**. dirty shared checkout에서 레인 C를 받음. C production은 HEAD와 동일해서 WT=HEAD로 검사. 언커밋 바이트는 완료 청구에 넣지 않음.
3. Exclusive production 212파일을 열거·역할 분류. god-MODULE/cohort/god-FUNCTION 스캔.
4. 코디네이터 심층 점검 + 병렬 4워커. 워커 제보는 **owner 소스를 다시 읽고** 난 뒤에만 영수증에 넣음.

| 샤드 | id | 범위 |
|---|---|---|
| MCP | `07474b71-57a1-4550-8cf0-abed80132a96` | `src/mcp/**` |
| LSP | `1300a6f5-ac53-4900-8303-8da36d54824e` | `src/lsp/**` |
| protocol+ipc | `401fd7bd-7f37-485a-a2f9-966920e521b4` | `src/protocol/**`, `src/ipc/**` |
| connectors+ | `94a3e86e-0971-4103-b551-af4317b61c8d` | `src/connectors`, `integrations`, `remote`, `realtime` |

(위 id는 세션 식별자이며 repo 내 경로가 아님 — 링크로 렌더하지 말 것.)

5. **1차 영수증:** C-F1…C-F5. 상태 DONE.
6. **Overlay:** 샤드 재검증 후 C-F6…C-F12 병합. C-F3에 FileWriteStrategy 미배선 반영. HEAD/tracked-diff 불변. untracked는 영수증 파일 추가로 변함.
7. 2026-09-08 01:03 스냅샷 재검증 (아래 §2.1). C production 여전히 clean.
8. 이 dump를 `docs/bugbash/sep-8-se-audit/agent-5.md`에 씀.

---

## 2. 스냅샷 (W1-C freeze)

> **STALE 고지:** 아래 표는 프리즈 시점 `0b14f5cf` 기준. 현재 HEAD는 `9b05cd33`이다. **단 lane-C production diff `0b14f5cf..9b05cd33`는 비어 있어** 아래 finding의 코드/라인 인용은 전부 현 HEAD에서도 그대로 성립한다. 스테일한 것은 스냅샷 메타데이터뿐.

W0 없음. C production porcelain **empty**. 분류 바이트 = HEAD.

| Field | Value |
|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| ahead/behind | `0 0` |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged/tracked diff SHA-256 (W1-C freeze) | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked manifest SHA-256 (최초 freeze) | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` |
| C production porcelain | empty (pre and post W1-C write) |

Authority-document hashes (working tree; W1-C pre/post 불변):

| Path | SHA-256 |
|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md (WT) | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` |
| docs/ARCHITECTURE.md (HEAD) | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |
| package.json | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` |
| biome.json | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` |
| tsconfig.json | `622ad399076687a1e3cdc01ce3b0b46edd344e2bb3da963bf0ea30223a77564b` |
| tsconfig.base.json | `c4ca874cd213452f545c273569a8d220566d763188bb26b64f77433ef51aa22f` |
| tsconfig.typecheck.src.json | `da1da7a381f8ec7b172c78985569df66f1e13e88d7ab0066b1137eaa90eb3320` |
| tsconfig.typecheck.tests.json | `3449f97ec6694b101f4784ab1116c284906d25e10ddc30805de471ee487f0fd0` |
| tests/unit/_arch/slice-boundary-configs.ts (WT) | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` |
| tests/unit/_arch/slice-boundary-scanner.ts (WT) | `2742c83e4b13c5714f4fae96dcd1f6d3572f982ed17d2cb7066727b4c71aa25c` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

`docs/ARCHITECTURE.md`와 `slice-boundary-configs.ts`는 **프리즈 시점** HEAD≠WT였고, 그 WT 바이트가 `9b05cd33`에 커밋되어 **현재는 HEAD==WT**. W2/W3 reserved. C는 dirty ARCHITECTURE를 소유 증명으로 쓰지 않음. 오너는 live TypeScript under `src/{mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime}`.

형제 레인 영수증(`W1-A`…`W1-H`)이 untracked 해시를 바꿈. 그건 **프로덕션 STALE이 아님**. W2-X는 **HEAD + tracked diff**로만 묶어야 함.

나중에 나온 W0이 다른 HEAD 또는 다른 tracked/untracked hash를 이름하면 **이 영수증/dump는 STALE**.

### 2.1 재검증 (2026-09-08 01:03 KST)

| Field | Value |
|---|---|
| HEAD = origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` (불변) |
| C production porcelain | empty |
| tracked diff SHA-256 | `c37c50a18b811eebec2a563ede78b06e9bcdc75c17f5988d6071906f21eb0840` |
| untracked manifest SHA-256 | `0dc6bbfd50b65c6359a60e60f56b1b8cc08944eaa0b91c4f40412c4063e48fd6` |
| AGENTS.md | `79de5da2…` (불변) |
| AGENT_CORE.md | `d1f585c7…` (불변) |
| AGENT_PLAYBOOK.md | `288bb7e2…` (불변) |
| docs/ARCHITECTURE.md (WT) | `16626624…` (불변) |
| tests/README.md | `ba80760a…` (불변) |

tracked/untracked 드리프트는 sibling dump·영수증·이 파일 누적. **C production STALE 아님.** HEAD가 바뀌면 STALE.

G 세션 dump (`agent-1.md`) **G-F3** = C-F1의 host 소비자. 한 레인만 고치면 안 됨.

---

## 3. 커버리지

| Universe | Count |
|---|---:|
| Exclusive production `src/**/*.ts` (tests 제외) | **212** |
| Classified | 212 |
| Unclassified | 0 |
| Colocated 테스트 | 14 (`__tests__/` 아래 13 + `src/protocol/subagent-frame/index.test.ts` 1) |
| Heuristic root/unit tests whose path names a C SUT | 291 (navigation set; not all SUT-owned) |
| God-MODULE >1000 | 0 |
| Cohort 900–999 | **0** |
| God-FUNCTION >150 | 0 confirmed (공식 detector allowlist에 C 엔트리 없음. crude span detector는 class body를 과대계산함) |

| Slice | Files | Lines |
|---|---:|---:|
| mcp | 62 | 8841 |
| lsp | 34 | 3997 |
| protocol | 26 | 3981 |
| ipc | 26 | 5814 |
| connectors | 21 | 2598 |
| integrations | 14 | 3111 |
| remote | 10 | 1403 |
| realtime | 19 | 2193 |

Approaching-cohort (finding 아님, failure mode 없음):

- `src/mcp/client.ts` 888
- `src/ipc/session/handle.ts` 880
- `src/ipc/session/bridge.ts` 879
- `src/lsp/adapters/base.ts` 850

212파일은 path+role 분류. 핫클러스터는 owner+consumer를 염. **파일마다 컨슈머를 연 것은 아님** (§10).

212 path union이 exclusive C universe. A/B/D/E/F/G/H production prefix와 교집합 공집합. `src/shared/**` 미작성.

---

## 4. Inspected consumer paths

Owner + reachable consumer를 아래 클러스터마다 읽음.

| Owner (C) | Consumer inspected | Lane of consumer |
|---|---|---|
| `mcp/isolated-client.ts` `isolatedMcpEnabledFromEnv` | **no production caller**; tests only; host factory always `new McpClient` | G (`src/host/mcp-composition.ts:135`) |
| `mcp/isolated-client.ts` class | `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:93` | A |
| `mcp/client.ts` + `client/negotiate.ts` | `src/host/mcp-composition.ts` factory; `src/agent/mcp-bridge.ts:409` | G / A |
| `mcp/capabilities/{default,full}-negotiator.ts` | `src/host/runtime/agent-arg-builder.ts` `pickMcpNegotiator` | G |
| `mcp/transports/http-sse.ts` `classifyStandaloneGetResponse` | in-process `McpClient.start` via default HTTP factory | C / A |
| `mcp/transports/stdio.ts` `buildEnv` | `McpClient` default stdio carrier | C |
| `mcp/reconnect/supervisor.ts` | `mcpSupervisorDepsFor` always wraps `McpClient` | G |
| `mcp/jsonrpc.ts` | stdio transport `LineReader` | C |
| `lsp/adapters/base/atomic-edit.ts` | `LspClient.applyWorkspaceEdit` (decl `base.ts:507`, atomic call `:512`); `tests/unit/lsp-applyworkspaceedit-atomicity-hellgate.test.ts` | C / tests |
| `lsp/adapters/file-write-atomic.ts` | **no `src/` production caller**; tests only (`lsp-atomic-write-hellgate`) | C / tests |
| `mcp/client.ts` `doReauthorize` | HTTP 401 path; `tests/unit/mcp-cluster-hardening-r2-hellgate.test.ts` (synthetic transport) | C / tests |
| `mcp/client/inbound-router.ts` + `sampling/inbound-router.ts` | `McpClient.dispatch` | C |
| `remote/runner/registry.ts` | `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})` | G |
| `integrations/github/idempotency.ts` | `webhook-server.ts` `createDurableDeliveryStore` | C |
| `protocol/session/codec.ts` `decodeSessionEvent` | `ipc/session/codec.ts` + `bridge.ts` fan-out | C |
| `lsp/adapters/base/diagnostics-hub.ts` | `LspClient.diagnostics()` | C |
| `lsp/adapters/base/transport.ts` spawn env | `resolveLspMemBudgetMb(process.env)` at spawn | C |
| `protocol/session/{commands,builders,codec,verb-surface}.ts` | `src/ipc/session/handle.ts` `buildWireVerbSurface`; `src/kernel/session/scheduler.ts` cases | C / D |
| `protocol/session/codec.ts` | `src/ipc/session/codec.ts` re-exports `decodeSessionCommand` | C |
| `ipc/session/handle.ts` | `src/sdk/runtime/handle-adapter.ts` compile pins | G |
| `ipc/session/transports/stdio.ts` | `createSessionStdioServer`; `tests/unit/ipc/session-transport-liveness.test.ts` | C / tests |
| `ipc/transports/stdio.ts` | event-bridge CLI↔daemon framing | C |
| `ipc/session-export.ts` / `session-import.ts` | `tests/unit/ipc/session-export-import.test.ts`; CLI `/session import` uses **session** envelope not portable | C / G |
| `connectors/token-rotation.ts` | `token-refresh-scheduler.ts` calls `TokenRotator.rotate` (no second mutex) | C |
| `connectors/custom-3p/{in-memory-registry,jsonl-store}.ts` | jsonl wraps in-memory; duplicated `validateEndpoint` | C |
| `integrations/github/{signature-verify,webhook-server,webhook-secret-resolver}.ts` | webhook POST pipeline HMAC → 401 | C |
| `integrations/github/outbound-body-policy.ts` | `pr-output-sink.ts`; twin `src/tool/gh/outbound-body-policy.ts` | C / B |
| `remote/runner/{lima,docker,apple-vz}-adapter.ts` | `selectRemoteRunner` in `src/apps/cli/index.ts` | G |
| `mcp/skybridge/lima-microvm.ts` | `detectLima` uses binary name `lima` vs remote `limactl` | C |
| `realtime/default-adapter.ts` | `src/realtime/index.ts` barrel; web-daemon `@/realtime` import count not re-run (catalog #74 retired unless new consumer) | C |
| `protocol/subagent/projection.ts` | `redactSecrets` from `@/security` (allowed); daemon sink type | F type/value |

---

## 5. Finding 인덱스 (HEAD, 전부 open / pre-existing)

구현하지 않음. retired SEP5/SEP6는 재오픈하지 않음: D9, D19, D24, D25, D29, D30, D6, D11, D20. Aug-25 항목은 그 ID가 아님. 이 HEAD에서 live면 **새** campaign finding.

| ID | Sev | 한 줄 | 채택 시점 | 재오픈 |
|---|---|---|---|---|
| C-F1 | P1 | `MCP_USE_ISOLATED_SPAWN` 파서만 있음. host factory는 항상 `new McpClient` | 1차 | 신규 (G-F3 짝) |
| C-F2 | P2 | `SessionVerbSurface`에 posture/skill/objective 없음. 커널·코덱은 받음 | 1차 | Aug-25 #73; **D9 아님** |
| C-F3 | P2 | live `atomic-edit`는 EXDEV throw. `FileWriteStrategy`는 프로덕션 미배선 | 1차, overlay가 dead sibling 보강 | Aug-25 #79; **D29 아님** |
| C-F4 | P2 | Isolated initialize: `capabilities:{}` + 다운그레이드 없음 | 1차 | Aug-25 #67/#84 live |
| ~~C-F5~~ | — | **RETRACTED** — `serve-stdio-cmd.ts:153-163`이 컴포지션 루트에서 EOF 배선. inventory로 강등 | 1차 | 반증됨 |
| C-F6 | P1 | CLI `selectRemoteRunner(env, {})` — docker/lima seam 미주입 | overlay | 신규 (#90의 미배선 실체) |
| C-F7 | P1 | `QUANTA_REMOTE_RUNNER=headless`는 seam 없이 `succeeded`/exit 0 | overlay | 신규 |
| C-F8 | P2 | inbound sampling 캡이 상수·카운터 둘 (**scope 비대칭**: module-global vs per-client) | overlay | 신규 |
| C-F9 | P2 | HTTP OAuth reauth가 carrier만 재건, MCP `initialize` 없음 | overlay | 신규 |
| C-F10 | **inventory** | webhook dedup 1024-FIFO — cap이 문서화·설정가능·테스트 핀되어 있고 durable store 소비자는 레인 G | overlay | 강등 |
| C-F11 | P2 | `decodeSessionEvent`는 envelope+공통메타는 검사하나 **페이로드 필드는** 미검사 후 캐스트. command는 fail-closed | overlay | 신규 |
| C-F12 | P3 | diagnostics waiter timeout 후 map prune 없음 | overlay | 신규 |

### C-F1 [P1] `MCP_USE_ISOLATED_SPAWN` gate has no production ingress

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/mcp/isolated-client.ts:56-64` (`isolatedMcpEnabledFromEnv`)
- **second owner / claimed swap:** `src/host/mcp-composition.ts:121-135` always `return new McpClient(c, clientOpts)`
- **invariant:** documented default-OFF swap of spawn implementation when env is `1`/`true`/`yes`
- **failure:** operator sets the env; host MCP still uses `McpClient` + `Bun.spawn`. Promised 5s spawn timeout and SIGTERM→SIGKILL grace do not apply. Feature catalog `162-mcp-isolated-spawn.yaml` and the module docstring still describe the swap.
- **producer → contract → consumer:** env parser (C) produces a boolean; no composition root consumes it. `rg` of `isolatedMcpEnabledFromEnv` / `IsolatedMcpClient` in `src/apps`, `src/host`, `src/agent/mcp-bridge.ts` is empty. Sole live constructor is `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:93`, which **always** uses isolated and ignores the env. ADR-0338 default-OFF.
- **test honesty:** `tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts`는 describe A(env 파서)만 파서 전용이고 B(construction guard)/C(lifecycle)/D(real spawn)도 있음 — "asserts the parser only"는 파일 전체로는 틀림. 다만 **핵심은 유지**: 어떤 테스트도 composition root가 env로 분기하는 것을 핀하지 않으므로, 없는 factory 분기를 지워도 RED가 안 남.
- **not D24 / not SEP5 closed twins:** this is a dead enablement gate, not lima-vs-lima lifecycle comparison.
- **proposed write set (C):** `src/mcp/isolated-client.ts` (stop advertising a swap the slice cannot perform, or export a factory the composition root must call). **Forbidden C writes:** catalog YAML, host composition (lane G), agent launcher (lane A). W2-X must assign the wire vs delete-docs split.
- **ADR 인용 정정:** ADR-0338은 "default-OFF"라고 쓰지 않는다 — 슬라이스는 landed이고 *activation trigger*만 deferred라고 적혀 있다. 게다가 그 트리거는 이제 배선되어 있음(`host/runtime/agent-config-assembler.ts:864`가 `autoWirePluginActivation`을 무조건 호출). 반대로 카탈로그 `162-mcp-isolated-spawn.yaml`은 `maturity: L4 / status: stable / cli: full / method: audited` — 이 finding을 **강화**한다. (참고: `docs/decisions/`에 `0338-*.md`가 2개 있는 번호 충돌 상태.)
- **proof limit:** static owner+consumer universe (`src/**` call sites of `isolatedMcpEnabledFromEnv`). Runtime with the env set was not executed.
- **cross-lane:** G-F3 is the same invariant at the host factory.

### C-F2 [P2] `SessionVerbSurface` is a second, narrower owner of public session.v1 verbs

- **status:** open
- **attribution:** pre-existing (Aug-25 #73 shape; **not** SEP5 D9, which closed factory-merge of existing verbs)
- **owners:** `src/protocol/session/verb-surface.ts:55-101` vs `SESSION_COMMAND_TYPES` in `src/protocol/session/commands.ts:221-234` plus builders in `builders.ts` (`buildPostureSet`, `buildSkillSetEnabled`, `buildObjectiveMutate`) and kernel cases in `src/kernel/session/scheduler.ts`
- **measured drift:** three commands have fail-closed codec arms (`codec.ts:193-227`) and kernel dispatch, but `buildWireVerbSurface` (`src/ipc/session/handle.ts:675-728`) has no `posture` / `skill` / `objective` methods. `SessionHandle` therefore cannot mint them. `SessionTransportClient.sendCommand` remains a raw escape hatch.
- **`turn.submit`:** host-only 의도 (SDK capability). posture/skill/objective는 RFC 프론트도어인데 Handle에 없음.
- **consumer:** `src/sdk/runtime/handle-adapter.ts` compile-pins `RuntimeSession` to `SessionVerbSurface` — in-process SDK inherits the same hole. CLI `/posture` and host projections bypass the wire surface.
- **failure:** a wire `SessionHandle` peer cannot issue RFC-03/05/06 commands the server already accepts. Surfaces invent local slash/OOB paths instead of one verb table.
- **proposed write set (C):** `src/protocol/session/verb-surface.ts`, `src/ipc/session/handle.ts` `buildWireVerbSurface`. **Forbidden:** kernel scheduler (D), sdk adapter (G) except type pins after protocol adds methods.
- **proof limit:** static API/codec/kernel comparison. No live SDK client was driven to prove a user-visible hang; the typed surface simply cannot express the commands.

### C-F3 [P2 → **contested design**] LSP workspace-edit commit has no EXDEV fallback; file-write-atomic does

> **선행 ADR이 이 동작을 규정함.** `docs/decisions/0152-lsp-atomic-workspace-edit.md` (**Accepted**)가 "Phase 2가 K/N 번째에서 실패: 1..K-1 originals는 commit 완료; K-N tmps는 disk에 남음"을 **설계로 명시**하고, hellgate 행 ATOM-B3이 에러 메시지에 `EXDEV` 포함을 요구한다. Phase-2 rollback은 §대안에서 "복잡도 vs ROI"로 **기각**됐다. 오너 코드도 `base.ts:534`에서 "cross-FS surfaces as `EXDEV` which we re-throw"라고 의도를 밝힌다. 또 dead sibling 유지도 기록된 KEEP이다 — `docs/decisions/0195-dead-sibling-cleanup.md`가 5개 어댑터를 지우면서 `file-write-atomic.ts`는 "sole atomic-write strategy behind the `FileWriteStrategy` port"로 **명시 보존**.
> ⇒ 감사 누락이 아니라 **논쟁 가능한 설계 선택**. 바꾸려면 ADR-0152를 supersede해야 함.

- **status:** open
- **attribution:** pre-existing
- **owners:** `src/lsp/adapters/base/atomic-edit.ts:113-131` (any rename failure throws; partial commit of files `1..K-1`) vs `src/lsp/adapters/file-write-atomic.ts:190-198` (`isExdev` → `commitViaCopyFallback`)
- **not D29:** D29 is storage vs lsp atomic-write ports. This is **intra-`@/lsp`** two commit strategies for the same POSIX rename.
- **measured drift (범위 축소):** `lsp-atomic-write-hellgate.test.ts` ATOMW-C11은 진짜 `err.code = "EXDEV"`로 copy+warn을 요구함. 반면 `lsp-applyworkspaceedit-atomicity-hellgate.test.ts:250`은 `new Error("rename EXDEV")` — **code 없이 메시지만** 주입하므로 `isExdev`(`file-write-atomic.ts:42-46`, `e.code === "EXDEV"` 요구)에 걸리지 않는다. 즉 그 테스트가 핀하는 건 "EXDEV 의미"가 아니라 "Phase-2 rename 실패는 무조건 throw". 주장된 드리프트는 서술보다 약함.
- **consumer:** `LspClient.applyWorkspaceEdit` (decl `base.ts:507`, atomic call `:512`) is the live production path. `atomicFileWriteStrategy` has **zero** `src/` callers outside its defining files. Hellgate headers that claim “strategy DI” do not reach `LspClient` (`grep FileWrite src/lsp/adapters/base.ts` → 0). ※ 소스가 이 포트를 "ADR-0155"라 부르지만 `docs/decisions/0155-*`는 **mcp-skybridge**와 **otlp-helper** 둘뿐 — FileWriteStrategy ADR 파일이 없는 **번호 충돌**이다(관련 논의는 `0185-file-write-atomic-lib-swap.md`, `0195-dead-sibling-cleanup.md`).
- **failure:** cross-filesystem workspace apply aborts with partial files on disk. The EXDEV copy fallback exists only on the unwired sibling, so production cannot take it.
- **overlay note:** FileWriteStrategy “dead”는 별 ID가 아님. C-F3에 흡수.
- **proposed write set (C):** wire `LspClient` to `FileWriteStrategy` **or** lift EXDEV into `atomic-edit.ts` and retire the dead sibling. Update the applyWorkspaceEdit hellgate so the live ingress has RED. **Forbidden:** `src/storage/atomic-write.ts` (D29).
- **proof limit:** tests encode both behaviors; live EXDEV on a two-mount fixture was not reproduced in this audit.

### C-F4 [P2] Isolated initialize is a weaker copy of `McpClient` initialize

- **status:** open
- **attribution:** pre-existing (Aug-25 #67/#84 live on this HEAD)
- **owners:** `src/mcp/client.ts` `initializeWithDowngrade` + injected `CapabilityNegotiator` vs `src/mcp/isolated-client.ts:219-223` (`capabilities: {}`, single `host.call("initialize")`) and private `pinNegotiatedVersion` at `:361-376` (copy of `client/negotiate.ts:76-95` without header pin / without downgrade)
- **consumer:** `createIsolatedMcpLauncherPort` always constructs isolated; host `QUANTA_MCP_CAPS=full` never reaches this path.
- **failure:** plugin-isolated MCP cannot advertise elicitation/tasks/sampling/roots even when the host knob is full. Isolated HTTP `url`+empty command도 throw (stdio-only, C-F4 인접, 별 ID 아님).
- **정정 — "영구 실패"는 거짓:** `isolated-client.ts:213-217`이 바로 그 완화를 문서화함 — "The isolated spawner has no JSON-RPC error/retry surface to drive the §4.c bounded re-offer, so it offers the resolved version directly; **operators who know a peer chokes on the bump pin it back via `QUANTA_MCP_PROTOCOL_MAX`**". "without header pin"도 갭 아님 — `:357-359` "The isolated path stamps no header, so there is nothing to re-pin." 살아남는 건 `QUANTA_MCP_CAPS=full`에서의 `capabilities: {}` 드리프트뿐.
- **#69:** SSE !ok silent는 HEAD에서 **수정됨** (`classifyStandaloneGetResponse` → `fireExit`). #67/#84는 isolated에만 남음.
- **proposed write set (C):** `src/mcp/isolated-client.ts` initialize to call `initializeWithDowngrade` / `pinNegotiatedVersion` / optional negotiator. **Forbidden:** rewriting plugin-isolation JSON-RPC (lane B) as a substitute for offering the same initialize contract.
- **proof limit:** static initialize payloads. Dual-flag runtime (`QUANTA_MCP_CAPS=full` + plugin launcher) not executed. ~~Default-OFF plugin launcher means the failure is latent~~ — **이 문장 철회**: 런처는 이미 마운트되어 있음 (`host/runtime/agent-config-assembler.ts:864` `autoWirePluginActivation(cfg, {}, {mode: req.mode})` 무조건 호출 → `agent/plugin-activation-handler/auto-wire.ts:167`에서 `createIsolatedMcpLauncherPort()`). env feature flag가 아니라 `.quanta/plugins/**` 매니페스트 유무 + trust-mode로 게이팅됨. ⇒ latent가 아니라 **live**.

### C-F5 — **RETRACTED** (finding 아님, inventory)

1차/overlay는 "session stdio가 reader EOF를 안 봐서 peer가 clean exit하면 waiter가 hang한다"고 적었으나 **프로덕션 소비자에서 반증됨**.

- `src/ipc/session/transports/stdio.ts:20-27` 은 data-only가 **의도**라고 명시하고 EOF 의미를 ticket 02로 넘김 (`docs/plans/jul-16-transport-unified-sdk/02-serve-stdio-entrypoint.md` §1 L26, 수용조건 L53).
- 유일한 실 stdin/stdout 소비자 `src/apps/cli/serve-stdio-cmd.ts`의 `onShutdown`이 **컴포지션 루트에서** EOF를 배선함: `process.stdin.on("end")` / `.on("close")` / `process.stdin.resume()` / `SIGTERM` / `SIGINT` (L153-163). 주석이 "a paused stdin never emits EOF"까지 설명.
- 반대쪽 half는 dead: `createSessionStdioClient`(`src/ipc/session/stdio-client.ts:22`)는 프로덕션 호출자 **0** (배럴 재export만).
- `tests/unit/ipc/session-transport-liveness.test.ts:421`이 현재 seam을 의도적으로 green-pin ("EOF semantics = ticket 02 scope … so ticket 02 flips it consciously, not by drift").

⇒ 실패 모드 없음. 세 슬라이스에 걸친 계약 분업이지 결함이 아님.

### C-F6 [P1] `selectRemoteRunner` docker/lima seams are never injected at the only consumer

- **status:** open
- **attribution:** pre-existing (Aug-25 #90 CLI-only; this is the missing composition, not a second reader)
- **owner:** `src/remote/runner/registry.ts:62-76` — docker/lima return `null` when `dockerProcess` / (`limaProcess`+`limaVm`) absent
- **consumer:** `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})`
- **failure:** `QUANTA_REMOTE_RUNNER=docker|lima` cannot select a live adapter (`remote-not-configured`). Registry is honest (`null` = missing seam); the only production caller never supplies seams, so adapters are dead. apple-vz still constructs and then `daemon-unavailable` (fail-closed-ish).
- **proposed write set (C):** `src/remote/runner/registry.ts` only if the contract should refuse names whose seams the composition root cannot supply. **Forbidden C writes:** `src/apps/cli/index.ts` (lane G) — W2-X assigns the seam factory.
- **proof limit:** static registry+CLI. `quanta remote` was not executed.

### C-F7 [P1] `QUANTA_REMOTE_RUNNER=headless` is a production synthetic-success runner

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/remote/runner/registry.ts:69-70` (headless needs no seam) + `src/remote/runner/headless-stub.ts:93-103` (`timeoutMs !== 0` → `succeeded` / exit 0 without exec)
- **consumer:** same CLI `routeRemote`
- **failure:** unlike docker/lima, headless is selectable with `{}` and reports remote success. Weaker than `RemoteRunner` (no job, no VM). Operator can believe a remote run happened.
- **not D7:** realtime `createHeadlessStub`는 **다른 파일**. STT 쌍이 아님.
- **proposed write set (C):** `headless-stub.ts` / registry — refuse headless unless an explicit test seam, or mark status `headless` so CLI cannot print success as remote. **Forbidden:** treating skybridge lima as this runner (D24).
- **proof limit:** static spawn record. CLI binary not run.

### C-F8 [P2] Two inbound sampling in-flight caps

- **status:** open
- **attribution:** pre-existing
- **owners:** `src/mcp/client/inbound-router.ts:30,199-210` `MAX_INBOUND_SAMPLING_IN_FLIGHT` vs `src/mcp/sampling/inbound-router.ts:37,169-183` `SAMPLING_MAX_IN_FLIGHT` (both 8 today; separate counters; outer `-32000` vs inner decline message)
- **consumer:** `McpClient.dispatch` → `handleInboundSampling` then `routeSampling`
- **failure:** two writable constants for one DoS bound, **and the two counters have different scopes**: `client/inbound-router.ts:199` gates on `ctx.inboundSamplingInFlight` (per-`McpClient`, initialised at `client.ts:275`) while `sampling/inbound-router.ts:42` `let samplingInFlight` is **module-global** (its own comment says "Module-level count"). With ≥2 connected MCP servers the inner global cap binds across clients that never trip their own outer gate — 8 in-flight on client A declines client B's first request. No test pins single authority. (1차의 "min=8이라 동작은 같음"은 오판 — 단일 클라이언트에서만 참.)
- **proposed write set (C):** one exported constant; one counter. Prefer keeping the client-router DoS gate **or** delegating entirely to `routeSampling`.
- **proof limit:** static dual increment. Concurrent sampling storm not executed.

### C-F9 [P2] HTTP OAuth reauthorize rebuilds the carrier without MCP `initialize`

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/mcp/client.ts:822-845` `doReauthorize` — invalidate → tokenFor → `next.start()` only → 옛 close. `sendInitialize` 없음.
- **second owner:** `src/mcp/transports/http-sse.ts` session id assigned on initialize POST
- **failure:** mid-session 401 on Streamable-HTTP: new transport has `sessionId=null`; subsequent POSTs can be rejected or attach to a different session while pending RPC ids are reused on the rebuilt carrier.
- **proposed write set (C):** `client.ts` re-run initialize (or a transport session-rebind) after rebuild. Stdio OAuth path unchanged.
- **proof limit:** static control flow. Existing oauth hellgates use synthetic transports that do not model session headers.

### C-F10 [P2] Webhook delivery dedup is a 1024-FIFO, not a durable forever-set

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/integrations/github/idempotency.ts:46-54,190-192` — `makeBoundedSet` evicts oldest; durable `add` persists the **post-eviction** snapshot on new insert
- **consumer:** `webhook-server.ts` durable store
- **failure:** after 1024 distinct `X-GitHub-Delivery` ids, an evicted id `has()` false. GitHub redelivery re-enqueues the trigger. Persist-on-new-add **does** run on eviction inserts; the defect is bounded forgetfulness, not a skipped save.
- **정정 2건:** ① "cap window를 안 밝힌다"는 **거짓** — `idempotency.ts:4-6` 첫 불릿이 "bounded (**default 1024 entries, FIFO eviction**)"이라고 명시하고 `maxEntries`는 공개 옵션. ② consumer 귀속도 틀림 — `webhook-server.ts:124`는 **ephemeral** `createDeliveryStore()`가 기본값이고, durable store는 `apps/cli/webhook-server-setup.ts`(**레인 G**)에서 주입됨.
- ⇒ 문서화 + 설정가능 + 테스트 핀(`idempotency-cap-hellgate-r2.test.ts:33`) + 외부 레인 소비자 ⇒ 이 레인 규칙상 **inventory**.
- **proposed write set (C):** `idempotency.ts` — persist+document the cap as the replay window, or fail-closed/503 when cap would evict still-retryable ids.
- **proof limit:** `idempotency-cap-hellgate` already shows `has("d-0")` false after overflow. Live GitHub retry after 1024 others not reproduced.

### C-F11 [P2] `decodeSessionEvent`는 **페이로드 필드만** 미검증 (envelope/공통 메타는 검증함)

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/protocol/session/codec.ts:238-244` vs `:160-228`
- **consumer:** `ipc/session/codec.ts:287`, **`kernel/session/event-log-jsonl.ts:216`**(영속 이벤트 로그 전 줄을 디코드 — 영향 최대), `sdk/index.ts:53`. (`bridge.ts`는 `decodeSessionEvent`를 호출하지 않음.)
- **failure:** unknown event `type` throws; **envelope + 6개 공통 메타데이터는 `assertCommonMetadata`(`codec.ts:136-151`)가 검증하고 `protocol-validate-typesafe-hellgate.test.ts:76-99`가 핀함** — 미검증인 건 **타입별 페이로드 필드**. 실제 오염 대상 키는 `prompt`가 아니라 `event.approval.approvalId`로, `handle.ts` `handleApprovalRequested`가 검증 없이 `state.byApprovalId.set(...)`에 넣음.
- **proposed write set (C):** `codec.ts` event payload guards for high-fan-out types used by `createTurnEndCorrelator`.
- **proof limit:** `session-codec.test.ts` covers envelope metadata, not mistyped event fields. Runtime poison not reproduced.

### C-F12 [P3] Diagnostics waiter entries leak after timeout

- **status:** open
- **attribution:** pre-existing
- **owner:** `src/lsp/adapters/base/diagnostics-hub.ts:31-38` — timeout `settle` does not `delete(uri)` from `diagnosticsWaiters`
- **consumer:** `LspClient.diagnostics()`
- **failure:** hang is prevented (`settled` guard). Late `publishDiagnostics` still walks leftover callbacks. Long sessions accumulate waiter arrays per URI that timed out.
- **proposed write set (C):** `diagnostics-hub.ts` prune on timeout (same as publish path).
- **proof limit:** static; leak volume not measured.

---

## 6. 재오픈하지 않은 것 / 워커 기각

| ID | 이유 |
|---|---|
| D6 sanitizeMcpNameSegment | `mcp/naming.ts` SSOT. thin alias는 host/CLI |
| D9 SessionVerbSurface factory 병합 | 있는 verb의 shape pin은 살아 있음. 구멍은 C-F2로 **새** ID |
| D11 chatgpt vs MCP token store | 레지스터의 종결 사유는 `writePrivateFileAtomic` SSOT 통일(`sep-05-duplicate-development.md:113`) — "의도적 분리"가 아님. 이 HEAD에서 mutex 드리프트 미측정 |
| D19 mcp vs lsp jsonrpc | 프레이밍 다름 (newline 10MB vs Content-Length 32MiB). `isJsonRpcEnvelope` shared |
| D20 JSONL durability | custom-3p는 snapshot rewrite. 다른 JSONL과 같은 append 계약 아님 |
| D24 skybridge vs remote/runner | `lima` vs `limactl`. lifecycle/policy 다름 |
| D25 pump-death | mcp stdio + lsp transport + plugin-isolation 상수. 같은 픽스처에서 judge 드리프트 재현 없음 |
| D29 storage vs lsp atomic | 포트 다름. intra-lsp EXDEV는 C-F3 |
| D30 token rotator vs MCP oauth mutex | rotator coalesce + MCP outer `inFlightToken` / `reauthInFlight` — documented layer |
| D7 voice→media STT | realtime voice-session ≠ media/stt. 양쪽 live 소비자 없음 |
| S8 mention first-line | C 범위 아님. HEAD 재현은 G-F2 |
| Aug-25 #69 SSE !ok silent | **수정됨** (`classifyStandaloneGetResponse` → `fireExit`, 405 POST-only except) |
| Aug-25 #74 realtime web:full | default-OFF. CLI `/voice-live`만. web-daemon import 0은 재카운트 안 함 |
| Aug-25 #87 OOB WS | 소비자 `web-daemon` = G. fingerprint X-C22만. C write 금지 |
| Aug-25 #104 portable vs envelope import | 스키마가 다름 (`quanta.session.portable` vs SessionExportEnvelope). mix 소비자 없음 |

워커가 P1로 올렸지만 **기각/강등:**

- FileWriteStrategy “dead” → C-F3에 흡수 (별 ID 아님).
- marketplace / jsonl custom-3p / token-refresh-scheduler 프로덕션 미연결 = documented default-OFF → 인벤토리. host `schedule()` / `enforceMarketplacePolicy` / `createJsonlCustom3pRegistry` caller 0.
- REST outage host fallback = `mcp-connector-wire` (A/G). C `rest-registry`는 typed throw 유지. foreign.
- `REPO_SLUG_RE` integrations vs reactor = **오늘 바이트 동일**. 복사만으로는 finding 아님 (X-C21).
- token-refresh-scheduler가 rotator를 호출하는 것은 두 번째 mutex가 아님 (D30 트리거 아님).

---

## 7. Inventory (SOLID smell, no finding)

- SRP: `McpClient`, `LspClient`, `HttpSseMcpTransport`, `createSessionHandle`/`bridge`/`attach-flow`는 크지만 메서드/헬퍼로 150-line function gate 아래.
- OCP: skybridge `registry.ts`와 remote `registry.ts`는 closed env-name switch. 백엔드 추가는 테이블 편집 — 예상된 어댑터 레지스트리.
- ISP: `SupervisableMcpClient` optional methods (`requestRaw`, resources, tasks)는 Isolated 정직한 생략. documented, default-OFF tools.
- DIP: protocol `subagent/projection.ts` value-imports `@/security` `redactSecrets` (fence-allowed). `ipc/session-import.ts` persists via `@/session#saveSessionById` — LAYER2 ipc에 composition-legal. portable v1 vs session envelope v1/v2는 **다른 스키마** (Aug-25 #104는 mix 소비자 없으면 inventory).
- Default MCP negotiator emits `{}` unless `QUANTA_MCP_CAPS=full` — explicit opt-in, in-process client에 hidden fallback 아님.
- Webhook secret resolver: empty secret / unknown map key fail closed; empty map does not silently fall back to the single secret.
- Token refresh scheduler delegates to one rotator mutex. `createTokenRefreshScheduler` / `enforceMarketplacePolicy` / `createJsonlCustom3pRegistry` have no host caller — documented default-OFF, not dual-write.
- Realtime adapter outbound queue is documented NOOP (WS buffer). Speculative slowness → W2-P only with a fixture.
- `QUANTA_LSP_MEM_BUDGET_MB` is spawn-time `process.env` (`server-mem-budget.ts` + `transport.ts`); not in knob inventory. Dual-read vs `runtimeConfig()` is a lane F question; lsp `envAllowFiles` already lists these files.
- `REPO_SLUG_RE` in integrations vs reactor is currently the same regex; fence-local copies without measured drift.
- Isolated HTTP-empty-command throw is documented stdio-only; plugin `url` configs fail `ready: false` (adjacent to C-F4, not a second initialize invariant).
- protocol/integrations slice barrel 없음 (`requireSliceBarrel` omitted) — X-C13 inventory.
- jsonl vs in-memory `validateEndpoint` 복사. `ProviderKind`는 지금 `"mcp" | "llm"`뿐 — X-C12 copy risk.
- 3× stdio 스택 (event-bridge / session / mcp JSON-RPC)은 **프레이밍이 같음** — 셋 다 newline-delimited JSON이고 `Content-Length`를 쓰지 않음. 다른 것은 **cap**(mcp 10MB `MAX_LINE_BYTES` vs lsp 32MiB)과 invalid-line 정책. (프레이밍이 실제로 갈리는 쌍은 mcp-vs-**LSP**이고 그건 D19.)

### No-finding bounded areas

Bounded by inspected owner + consumer on this snapshot:

- MCP HTTP-SSE standalone GET non-2xx: `classifyStandaloneGetResponse` calls `reportStandaloneGetFailure` → `fireExit` except 405 POST-only (Aug-25 #69 **not** reproduced).
- MCP JSON-RPC line cap 10MB; LSP frame cap 32MiB — different carriers, D19.
- GitHub `verifyHubSignature256`: empty secret returns false; server refuses boot on empty secret.
- Protocol `decodeSessionCommand`: unknown type throws `bad_command_type`.
- Connectors `ProviderKind` is only `"mcp" | "llm"`; jsonl/in-memory endpoint rules currently match.
- Realtime `createHeadlessStub` is a test/swap adapter; no extra production STT consumer found in C (D7 not triggered). `QUANTA_REMOTE_RUNNER=headless` is a **different** stub (`remote/runner/headless-stub.ts`) — see C-F7.
- `mcp/naming.ts` `sanitizeMcpNameSegment` remains the C-side SSOT (D6).

---

## 8. W2-X fingerprints (전부)

Format: `authority/invariant/input/output/state/effect/failure-policy/lifecycle`

| ID | Fingerprint | C owner | Foreign owner | Notes |
|---|---|---|---|---|
| X-C1 | mcp-client-select / spawn-isolation-enablement / env MCP_USE_ISOLATED_SPAWN / SupervisableMcpClient / process / spawn+kill / fail-open (env ignored) / start-stop | `isolated-client.ts` | `host/mcp-composition.ts` (G), catalog YAML (reserved) | C-F1 / G-F3 |
| X-C2 | session.v1-public-verbs / command-union completeness / SessionCommand / CommandReceipt / none / submit / typed-omit vs kernel-accept / handle-lifetime | `verb-surface.ts`, `handle.ts` | `kernel/session/scheduler.ts` (D), `sdk/runtime/handle-adapter.ts` (G) | C-F2; do not reopen D9 factory merge |
| X-C3 | posix-rename-commit / EXDEV / temp path / original path / tmp leftovers / copy-or-throw / partial-commit / apply-batch | `atomic-edit.ts` vs `file-write-atomic.ts` | `storage/atomic-write.ts` (D) is D29 — keep separate | C-F3 |
| X-C4 | mcp-initialize / protocolVersion+capabilities / initialize params / pinned version / negotiatedVersion / JSON-RPC / fail-closed unsupported / session-start | `client/negotiate.ts` vs `isolated-client.ts` | plugin launcher (A) | C-F4 |
| X-C5 | stdio-framing-liveness / peer-death / byte stream / onClose / buffer / teardown / fail-open EOF / transport-lifetime | session stdio vs ipc event-bridge stdio | `serve --stdio` (G) | **C-F5 RETRACTED** — EOF는 `serve-stdio-cmd.ts:153-163`이 컴포지션 루트에서 배선. inventory |
| X-C6 | jsonrpc-framing / max-bytes / newline vs Content-Length / decoded msg / reader buffer / drop-or-kill / pump | `mcp/jsonrpc.ts` vs `lsp/adapters/jsonrpc.ts` | D19 closed unless new drift | inventory |
| X-C7 | sandbox-cli / lima-or-docker-or-vz / spec / handle / vm process / exec / injection / spawn-cancel | `mcp/skybridge/*` vs `remote/runner/*` | D24 closed; binaries `lima` vs `limactl` | inventory |
| X-C8 | pump-death / stdout-end-while-alive / grace ms / fireExit / pumps / kill / fail-closed / child-lifetime | mcp stdio, lsp transport | `plugin-isolation` (B) D25 | inventory unless new fixture divergence |
| X-C9 | session-export-format / portable-v1 vs envelope-v1v2 / SavedSession / wire JSON / none / persist / validation / round-trip | `ipc/session-export.ts` | `session/import-export.ts` (D) | different schemas; not a duplicate unless a consumer mixes them |
| X-C10 | pr-comment-body / utf8-cap-65000+redact / body string / prepared body / none / gh post / fail-closed prepare / one-shot | `integrations/github/outbound-body-policy.ts` | `tool/gh/outbound-body-policy.ts` (B) | SEP5 twin; reopen only with measured truncate/redact drift |
| X-C11 | token-coalesce / in-flight-refresh / connectorId / TokenRecord / inFlight map / store.write / mutex / rotate | `connectors/token-rotation.ts` | chatgpt refresh + mcp oauth (F) D30 | scheduler is caller, not second mutex |
| X-C12 | endpoint-scheme / mcp-vs-llm URL / spec / throw Custom3pError / none / reject-register / fail-closed / seed-vs-live | jsonl-store `validateEndpoint` copy vs in-memory | none | copy risk; kinds currently only mcp\|llm |
| X-C13 | protocol-barrel / slice-public-API / @/protocol / exports / none / import / missing index / load | no `src/protocol/index.ts`, no `src/integrations/index.ts` | arch SSOT `requireSliceBarrel` omitted | inventory |
| X-C14 | mention-first-line / trim / text / first line / none / lookup / S8 shared | none in C | `src/shared/mention-text.ts` SEP6 S8 | do not reopen from C; G-F2 is HEAD trigger |
| X-C15 | webhook-hmac / sha256= / raw body / bool / none / 401 / fail-closed empty secret / request | `signature-verify.ts` + `webhook-server.ts` | none second writer | no-finding bounded |
| X-C16 | remote-runner-select / env+seams / QUANTA_REMOTE_RUNNER / RemoteRunner\|null / none / spawn / missing-seam-null vs headless-success / cmd-lifetime | `remote/runner/registry.ts` | `apps/cli/index.ts` (G) | C-F6, C-F7 |
| X-C17 | inbound-sampling-cap / in-flight count / sampling/createMessage / busy\|decline / two counters / send error / fail-closed / request | inbound-router vs sampling/inbound-router | none | C-F8 |
| X-C18 | mcp-http-session / oauth-reauth / 401 / new bearer+carrier / sessionId / POST / fail-open stale session / mid-session | `client.ts` `doReauthorize` | http-sse session header | C-F9 |
| X-C19 | webhook-delivery-dedup / X-GitHub-Delivery / id / bool has / FIFO Map 1024 / enqueue / bounded-forget / process+disk | `idempotency.ts` | none | C-F10 |
| X-C20 | session-event-decode / typed payload / wire JSON / SessionEvent / none / fan-out / shallow-cast / attach | `protocol/session/codec.ts` | `ipc/session/bridge.ts` | C-F11 |
| X-C21 | repo-slug-gate / owner/repo / string / bool / none / gh api path / fail-closed / request | `pr-output-sink.ts` `REPO_SLUG_RE` | `reactor/trigger-source-pr-comment.ts` (G) | **byte-identical today** — inventory, not a finding |
| X-C22 | web-daemon-oob-ws / control frames / text frame / handler / none / mutate / unversioned / socket | none in protocol | `src/apps/web-daemon/server/ws-handlers.ts` (G) Aug-25 #87 | foreign; do not write from C |

G dump의 X-G3 = X-C1. G dump의 X-G11 = X-C2 (G는 sdk consumer만).

---

## 9. Exact proposed write sets (C only)

Lane C will not implement these in this campaign.

| Finding | C files | Forbidden |
|---|---|---|
| C-F1 | `src/mcp/isolated-client.ts` (gate honesty or factory) | `src/host/**`, catalog YAML, `src/agent/plugin-mcp-launcher/**` unless W2-X assigns them |
| C-F2 | `src/protocol/session/verb-surface.ts`, `src/ipc/session/handle.ts` | `src/kernel/**`, `src/sdk/**` except type pins |
| C-F3 | `src/lsp/adapters/base/atomic-edit.ts`, optional `file-write-*.ts` wire-or-delete, owner-local hellgate | `src/storage/atomic-write.ts` |
| C-F4 | `src/mcp/isolated-client.ts` initialize/negotiator | `src/plugin-isolation/**` as a fake initialize owner |
| ~~C-F5~~ | — (RETRACTED) | 이 finding 근거로 `src/ipc/session/transports/stdio.ts`를 고치지 말 것 — 현재 data-only는 ticket 02가 규정한 계약이고 `session-transport-liveness.test.ts:421`이 green-pin |
| C-F6 | `src/remote/runner/registry.ts` (contract only) | `src/apps/cli/index.ts` unless W2-X assigns G |
| C-F7 | `src/remote/runner/headless-stub.ts`, `registry.ts` | mcp skybridge lima (D24) |
| C-F8 | `src/mcp/client/inbound-router.ts`, `src/mcp/sampling/inbound-router.ts` | host sampling handler (G) |
| C-F9 | `src/mcp/client.ts` `doReauthorize` | oauth provider impl (G) |
| C-F10 | `src/integrations/github/idempotency.ts` | none |
| C-F11 | `src/protocol/session/codec.ts` `decodeSessionEvent` | kernel event producers (D) |
| C-F12 | `src/lsp/adapters/base/diagnostics-hub.ts` | none |

---

## 10. Uninspected conditions / 검증 한계

정적 전제. 아래는 **안 함**:

- Runtime with `MCP_USE_ISOLATED_SPAWN=1` against a live MCP server (static call-site universe was used instead).
- Live EXDEV across two mounts for workspace edit vs file write.
- ~~Live `serve --stdio` peer EOF hang~~ — 정적 확인 완료: `serve-stdio-cmd.ts:153-163`이 `end`/`close`/`resume`/SIGTERM/SIGINT를 배선하므로 hang 전제가 성립하지 않음 (C-F5 철회 근거).
- ~~Plugin-mcp-launcher composition actually mounted in CLI/web~~ — **확인 완료: 마운트되어 있음** (`host/runtime/agent-config-assembler.ts:864` → `agent/plugin-activation-handler/auto-wire.ts:167`). C-F4의 latent 단서는 철회.
- Cognitive-complexity scores per C function. (사유 정정: `tools/dev/lint-debt-ceiling.ts`는 `--tighten` 없이는 write하지 않으므로 read-only 제약 때문은 아님 — 단순 미실행.)
- ~~Official god-function AST pass~~ — **실행 완료**: `detectGodModules`/`detectGodFunctions`를 212파일에 돌려 **0/0**. "assumed green"이 아니라 measured green.
- Full execution of the 291 heuristic C tests (not required for classification).
- Web-daemon OOB WS frames vs session.v1 (Aug-25 #87) — consumer is lane G; fingerprint X-C22 (receipt text once said X-C2; that was a slip — OOB WS is X-C22).
- Whether `QUANTA_REMOTE_RUNNER` is read outside CLI (lane G) besides `selectRemoteRunner`.
- HTTP OAuth 401 against a real Streamable-HTTP session header.
- Sampling storm hitting both in-flight counters.
- Durable webhook store after 1024 GitHub deliveries.
- 212파일 각각 컨슈머 추적.
- Apple VZ / Lima 실기기.
- web-daemon `@/realtime` import 0 재카운트 (#74).
- `quanta remote` 실실행.

---

## 11. 다른 에이전트에게

1. 구현하려면 W3-I 티켓. 이 파일/W1-C는 분류 영수증.
2. C production은 HEAD. 공유 checkout dirty는 C 밖.
3. `src/shared/**` 쓰지 말 것 (C write 금지).
4. D9/D19/D24/D29/D30으로 C-F*를 닫지 말 것.
5. C-F1과 G-F3는 한 불변식의 두 끝. host factory만 또는 isolated 주석만 고치면 안 됨.
6. C-F6 seam은 G CLI. C registry만 만지지 말 것.
7. FileWriteStrategy를 “프로덕션 파일 write 툴 경로”로 쓰지 말 것 — live ingress는 `applyWorkspaceEditAtomic`.
8. portable ipc import vs session envelope는 **다른 스키마**. mix 소비자 없이 #104 재오픈 금지.
9. `REPO_SLUG_RE`는 오늘 바이트 동일. 복사만으로 finding 만들지 말 것.
10. 다음 작업이 W0이면 freeze 해시(`b693d469…` tracked, HEAD `0b14f5cf…`)와 맞춰라. HEAD가 바뀌면 STALE. 01:03 재검증의 tracked `c37c50a1…`는 sibling WT 누적.

---

## 12. Complete file manifest (212)

Role은 분류 태그이지 두 번째 authority가 아님.

```text
slice	lines	role	path
mcp	13	capability-policy	src/mcp/capabilities/default-negotiator.ts
mcp	62	capability-policy	src/mcp/capabilities/full-negotiator.ts
mcp	5	barrel	src/mcp/capabilities/index.ts
mcp	40	port	src/mcp/capabilities/port.ts
mcp	59	capability-policy	src/mcp/client/capabilities-gate.ts
mcp	96	client	src/mcp/client/errors.ts
mcp	235	client	src/mcp/client/inbound-router.ts
mcp	95	capability-policy	src/mcp/client/negotiate.ts
mcp	165	client	src/mcp/client/result-folding.ts
mcp	40	transport	src/mcp/client/transport-factory.ts
mcp	888	client	src/mcp/client.ts
mcp	249	impl	src/mcp/elicitation/default-cli-prompter.ts
mcp	24	impl	src/mcp/elicitation/headless-rejecter.ts
mcp	241	impl	src/mcp/elicitation/inbound-router.ts
mcp	31	barrel	src/mcp/elicitation/index.ts
mcp	130	impl	src/mcp/elicitation/lease.ts
mcp	51	port	src/mcp/elicitation/port.ts
mcp	192	impl	src/mcp/elicitation/schemas.ts
mcp	164	barrel	src/mcp/index.ts
mcp	382	client	src/mcp/isolated-client.ts
mcp	153	codec	src/mcp/jsonrpc.ts
mcp	20	impl	src/mcp/naming.ts
mcp	14	impl	src/mcp/oauth/headless-rejecter.ts
mcp	7	barrel	src/mcp/oauth/index.ts
mcp	37	port	src/mcp/oauth/port.ts
mcp	67	impl	src/mcp/progress.ts
mcp	70	impl	src/mcp/protocol-version.ts
mcp	18	barrel	src/mcp/reconnect/index.ts
mcp	75	lifecycle	src/mcp/reconnect/policy.ts
mcp	74	port	src/mcp/reconnect/port.ts
mcp	491	lifecycle	src/mcp/reconnect/supervisor.ts
mcp	262	codec	src/mcp/resources/codec.ts
mcp	60	impl	src/mcp/resources/inbound-router.ts
mcp	47	barrel	src/mcp/resources/index.ts
mcp	97	impl	src/mcp/resources/notifications.ts
mcp	157	port	src/mcp/resources/port.ts
mcp	18	impl	src/mcp/sampling/headless-rejecter.ts
mcp	186	impl	src/mcp/sampling/inbound-router.ts
mcp	21	barrel	src/mcp/sampling/index.ts
mcp	80	port	src/mcp/sampling/port.ts
mcp	110	server	src/mcp/server-builder.ts
mcp	311	server	src/mcp/server.ts
mcp	159	impl	src/mcp/skybridge/applevz-microvm.ts
mcp	355	impl	src/mcp/skybridge/applevz-native.ts
mcp	39	impl	src/mcp/skybridge/container.ts
mcp	49	barrel	src/mcp/skybridge/index.ts
mcp	340	impl	src/mcp/skybridge/lima-microvm.ts
mcp	39	impl	src/mcp/skybridge/microvm.ts
mcp	185	impl	src/mcp/skybridge/passthrough.ts
mcp	124	registry	src/mcp/skybridge/registry.ts
mcp	206	types	src/mcp/skybridge/types.ts
mcp	181	impl	src/mcp/tasks/client-port.ts
mcp	102	impl	src/mcp/tasks/default-store.ts
mcp	17	barrel	src/mcp/tasks/index.ts
mcp	79	impl	src/mcp/tasks/poller.ts
mcp	29	port	src/mcp/tasks/port.ts
mcp	15	impl	src/mcp/tasks/rpc.ts
mcp	70	types	src/mcp/tasks/types.ts
mcp	789	transport	src/mcp/transports/http-sse.ts
mcp	74	port	src/mcp/transports/port.ts
mcp	333	transport	src/mcp/transports/stdio.ts
mcp	119	types	src/mcp/types.ts
lsp	133	adapter	src/lsp/adapters/base/atomic-edit.ts
lsp	52	adapter	src/lsp/adapters/base/config.ts
lsp	68	adapter	src/lsp/adapters/base/diagnostics-hub.ts
lsp	80	adapter	src/lsp/adapters/base/document-tracker.ts
lsp	24	adapter	src/lsp/adapters/base/errors.ts
lsp	413	adapter	src/lsp/adapters/base/mappers.ts
lsp	169	types	src/lsp/adapters/base/raw-types.ts
lsp	113	adapter	src/lsp/adapters/base/request-correlator.ts
lsp	283	transport	src/lsp/adapters/base/transport.ts
lsp	27	adapter	src/lsp/adapters/base/workspace.ts
lsp	850	adapter	src/lsp/adapters/base.ts
lsp	28	adapter	src/lsp/adapters/clangd.ts
lsp	79	adapter	src/lsp/adapters/default-code-action.ts
lsp	34	adapter	src/lsp/adapters/default-format.ts
lsp	54	adapter	src/lsp/adapters/default-rename-apply.ts
lsp	30	adapter	src/lsp/adapters/default-signature-help.ts
lsp	266	adapter	src/lsp/adapters/file-write-atomic.ts
lsp	89	adapter	src/lsp/adapters/file-write-sequential.ts
lsp	85	adapter	src/lsp/adapters/file-write-strategy.ts
lsp	17	adapter	src/lsp/adapters/gopls.ts
lsp	158	codec	src/lsp/adapters/jsonrpc.ts
lsp	87	adapter	src/lsp/adapters/pyright.ts
lsp	16	adapter	src/lsp/adapters/rust-analyzer.ts
lsp	32	adapter	src/lsp/adapters/typescript.ts
lsp	77	barrel	src/lsp/index.ts
lsp	98	port	src/lsp/ports/code-action-port.ts
lsp	39	port	src/lsp/ports/format-port.ts
lsp	59	port	src/lsp/ports/rename-apply-port.ts
lsp	33	port	src/lsp/ports/signature-help-port.ts
lsp	64	port	src/lsp/ports.ts
lsp	76	server	src/lsp/server-mem-budget.ts
lsp	54	registry	src/lsp/server-registry.ts
lsp	176	server	src/lsp/server-rss-watchdog.ts
lsp	134	types	src/lsp/types.ts
protocol	58	barrel	src/protocol/agent-state/index.ts
protocol	249	impl	src/protocol/agent-state/messages.ts
protocol	415	projection	src/protocol/agent-state/projection.ts
protocol	27	barrel	src/protocol/canvas/index.ts
protocol	249	impl	src/protocol/canvas/messages.ts
protocol	26	barrel	src/protocol/observability/index.ts
protocol	173	impl	src/protocol/observability/messages.ts
protocol	436	projection	src/protocol/readout/goal.ts
protocol	23	barrel	src/protocol/readout/index.ts
protocol	266	protocol-contract	src/protocol/session/builders.ts
protocol	36	capability-policy	src/protocol/session/capabilities.ts
protocol	272	codec	src/protocol/session/codec.ts
protocol	239	protocol-contract	src/protocol/session/commands.ts
protocol	205	impl	src/protocol/session/errors.ts
protocol	379	impl	src/protocol/session/events.ts
protocol	149	barrel	src/protocol/session/index.ts
protocol	26	projection	src/protocol/session/objective-projection.ts
protocol	71	projection	src/protocol/session/posture-projection.ts
protocol	185	projection	src/protocol/session/read-models.ts
protocol	30	projection	src/protocol/session/skill-projection.ts
protocol	122	impl	src/protocol/session/snapshot.ts
protocol	101	protocol-contract	src/protocol/session/verb-surface.ts
protocol	6	impl	src/protocol/session/version.ts
protocol	23	barrel	src/protocol/subagent/index.ts
protocol	121	projection	src/protocol/subagent/projection.ts
protocol	94	barrel	src/protocol/subagent-frame/index.ts
ipc	351	impl	src/ipc/event-bridge.ts
ipc	76	barrel	src/ipc/index.ts
ipc	622	impl	src/ipc/session/attach-flow.ts
ipc	879	impl	src/ipc/session/bridge.ts
ipc	399	client	src/ipc/session/client.ts
ipc	452	codec	src/ipc/session/codec.ts
ipc	86	impl	src/ipc/session/errors.ts
ipc	880	impl	src/ipc/session/handle.ts
ipc	94	impl	src/ipc/session/heartbeat.ts
ipc	110	barrel	src/ipc/session/index.ts
ipc	28	server	src/ipc/session/server.ts
ipc	36	client	src/ipc/session/stdio-client.ts
ipc	25	server	src/ipc/session/stdio-server.ts
ipc	61	transport	src/ipc/session/transports/close-signal.ts
ipc	270	transport	src/ipc/session/transports/stdio-spawn.ts
ipc	153	transport	src/ipc/session/transports/stdio.ts
ipc	169	transport	src/ipc/session/transports/websocket.ts
ipc	199	types	src/ipc/session/types.ts
ipc	32	client	src/ipc/session/websocket-client.ts
ipc	21	server	src/ipc/session/websocket-server.ts
ipc	91	impl	src/ipc/session-export.ts
ipc	275	impl	src/ipc/session-import.ts
ipc	124	transport	src/ipc/transports/in-memory.ts
ipc	214	transport	src/ipc/transports/stdio.ts
ipc	59	transport	src/ipc/transports/uds.ts
ipc	108	transport	src/ipc/transports/websocket.ts
connectors	129	impl	src/connectors/availability-prober.ts
connectors	12	impl	src/connectors/availability.ts
connectors	211	impl	src/connectors/connector-marketplace.ts
connectors	32	headless-stub	src/connectors/custom-3p/headless-stub.ts
connectors	121	impl	src/connectors/custom-3p/health-probe.ts
connectors	213	registry	src/connectors/custom-3p/in-memory-registry.ts
connectors	31	barrel	src/connectors/custom-3p/index.ts
connectors	214	impl	src/connectors/custom-3p/jsonl-store.ts
connectors	48	port	src/connectors/custom-3p/port.ts
connectors	122	types	src/connectors/custom-3p/types.ts
connectors	26	registry	src/connectors/in-memory-registry.ts
connectors	92	barrel	src/connectors/index.ts
connectors	84	impl	src/connectors/marketplace-policy.ts
connectors	164	impl	src/connectors/mcp-connector-catalog.ts
connectors	114	impl	src/connectors/oauth-discovery.ts
connectors	107	impl	src/connectors/oauth-registration.ts
connectors	119	adapter	src/connectors/rest-catalog-adapter.ts
connectors	212	registry	src/connectors/rest-registry.ts
connectors	262	impl	src/connectors/token-refresh-scheduler.ts
connectors	85	impl	src/connectors/token-rotation.ts
connectors	200	types	src/connectors/types.ts
integrations	37	adapter	src/integrations/github/adapters/delivery-persist-fs.ts
integrations	241	impl	src/integrations/github/event-payload.ts
integrations	225	impl	src/integrations/github/event-source-actions.ts
integrations	217	impl	src/integrations/github/idempotency.ts
integrations	100	barrel	src/integrations/github/index.ts
integrations	188	impl	src/integrations/github/mention-filter.ts
integrations	105	impl	src/integrations/github/outbound-body-policy.ts
integrations	198	impl	src/integrations/github/pr-context-loader.ts
integrations	661	impl	src/integrations/github/pr-output-sink.ts
integrations	59	authn-boundary	src/integrations/github/signature-verify.ts
integrations	165	types	src/integrations/github/types.ts
integrations	253	authn-boundary	src/integrations/github/webhook-secret-resolver.ts
integrations	376	authn-boundary	src/integrations/github/webhook-server.ts
integrations	286	transport	src/integrations/github/webhook-transports.ts
remote	9	barrel	src/remote/index.ts
remote	126	adapter	src/remote/runner/apple-vz-adapter.ts
remote	390	adapter	src/remote/runner/docker-adapter.ts
remote	143	headless-stub	src/remote/runner/headless-stub.ts
remote	57	barrel	src/remote/runner/index.ts
remote	237	adapter	src/remote/runner/lima-adapter.ts
remote	46	port	src/remote/runner/port.ts
remote	85	registry	src/remote/runner/registry.ts
remote	210	types	src/remote/runner/types.ts
remote	100	impl	src/remote/runner/validate.ts
realtime	51	codec	src/realtime/audio-codec.ts
realtime	404	adapter	src/realtime/default-adapter.ts
realtime	212	headless-stub	src/realtime/headless-stub.ts
realtime	51	barrel	src/realtime/index.ts
realtime	102	port	src/realtime/port.ts
realtime	96	capability-policy	src/realtime/sdp-negotiator.ts
realtime	85	types	src/realtime/types.ts
realtime	147	impl	src/realtime/voice-session/default-playback.ts
realtime	68	impl	src/realtime/voice-session/default-session/context.ts
realtime	103	impl	src/realtime/voice-session/default-session/inbound.ts
realtime	98	impl	src/realtime/voice-session/default-session/lifecycle.ts
realtime	205	impl	src/realtime/voice-session/default-session.ts
realtime	71	barrel	src/realtime/voice-session/index.ts
realtime	77	adapter	src/realtime/voice-session/openai-realtime-adapter.ts
realtime	88	impl	src/realtime/voice-session/pcm-bridge.ts
realtime	37	impl	src/realtime/voice-session/playback-port.ts
realtime	134	port	src/realtime/voice-session/port.ts
realtime	86	impl	src/realtime/voice-session/session-config.ts
realtime	78	impl	src/realtime/voice-session/state-machine.ts
```

DONE (classified, not fixed)
