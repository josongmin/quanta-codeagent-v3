# Sep-08 SE audit — agent-1 (lane G session dump)

> **Role:** Sep-07 SOLID/SE campaign **lane G** worker (this Cursor session).
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-G.md`](../../plans/sep-7-solid-se-audit/receipts/W1-G.md) (status **DONE**). 891-row 파일 매니페스트는 그쪽 appendix.
> **This file:** 세션에서 확인한 사실·finding·비재오픈·인벤토리·구멍. W3-I 티켓이 아님. 구현 권한 없음.
> **Dispatch:** [`docs/plans/sep-7-solid-se-audit/prompts/README.md`](../../plans/sep-7-solid-se-audit/prompts/README.md). W0 없음. W2-X 전에 이 dump를 진실로 쓰지 말고 W1-G + HEAD 해시를 맞춰라.

## 1. 세션이 한 일

Sep-07 dispatch pack의 **레인 G**만 수행함.

- Exclusive production: `src/apps`, `src/host`, `src/sdk`, `src/ui`, `src/workflow`, `src/scheduler`, `src/reactor`, `src/observability`, `src/radar`
- W0 영수증 없음 → 코디네이터가 **tracked HEAD-only**로 고정. 언커밋 바이트는 완료 청구에 넣지 않음.
- 코디네이터 심층 점검 + 병렬 3워커:
  - [Apps surfaces](83658574-51d7-401d-9de3-f4ce5374c2a5) — cli/web-daemon/headless/agent/terminal/probe
  - [Bench eval](69728f06-fc85-4aa2-b186-be1372037dcf) — apps/bench, apps/eval
  - [Host library](fc704a9d-14f0-45c2-af2b-e8d30188c57e) — host/sdk/ui/workflow/scheduler/reactor/observability/radar
- 워커 제보는 **HEAD 코드를 다시 읽고** 난 뒤에만 영수증에 넣음. grep-only 완료 청구 없음.

## 2. 스냅샷 (진실)

| Field | Value |
|---|---|
| HEAD = origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` (ahead/behind `0 0`) |
| staged diff SHA-256 | `e3b0c442…` (empty) |
| unstaged tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked manifest SHA-256 (pre) | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` (7 files) |
| untracked manifest SHA-256 (post W1-G write) | `1e646eb124287a5ab50343ee753bf25ce576b16db137cbac913a0019e062acf9` (8 files, +W1-C) |
| W0 | **없음** (campaign receipts dir만 존재) |

Authority (HEAD=WT unless noted):

| Path | SHA-256 |
|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md (WT) | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` |
| docs/ARCHITECTURE.md (HEAD) | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| tests/unit/_arch/slice-boundary-configs.ts (WT) | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` |
| tests/unit/_arch/slice-boundary-configs.ts (HEAD) | `315560288012f4e6f2cc149f0605a539faac9676149e2e606fb3580a89115697` |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` |

**HEAD≠WT인 G production 3개** (SEP6 오버레이. 분류는 `git show HEAD:path`):

- `src/apps/cli/at-autocomplete/provider.ts`
- `src/apps/cli/session-registry-cmd.ts`
- `src/host/runtime/internal/mention-source-deps.ts`

언트래킹 중 완료 청구에 **넣지 않은** 것: `src/shared/mention-text.ts`, `tests/unit/mention-first-line-parity-hellgate.test.ts` (SEP6 S8 클로즈아웃이 HEAD에 없음).

형제 레인 영수증(`W1-A`…`W1-H`)이 untracked 해시를 바꿈. 그건 프로덕션 STALE이 아님. W2-X는 **HEAD + tracked diff**로만 묶어야 함.

`docs/ARCHITECTURE.md` / `slice-boundary-configs.ts`는 HEAD≠WT. W2/W3 reserved. G는 dirty ARCHITECTURE를 소유 증명으로 쓰지 않음.

## 3. 커버리지

| Universe | Count |
|---|---:|
| G production `*.ts` (HEAD-tracked, tests 제외) | **891** 전부 분류 |
| colocated tests | 113 |
| 총 라인 | 176973 |
| god-MODULE >1000 | 0 |
| god-FUNCTION >150 (공식 detector) | 0 |
| cohort 900–999 | **9** (인벤토리, finding 아님) |

| Slice | Files | Lines |
|---|---:|---:|
| apps | 656 | 133855 |
| host | 80 | 17145 |
| observability | 91 | 15706 |
| scheduler | 18 | 4164 |
| sdk | 23 | 2969 |
| reactor | 6 | 1108 |
| workflow | 8 | 999 |
| radar | 7 | 756 |
| ui | 2 | 271 |

Apps: cli 298 / bench 213 / eval 63 / web-daemon 51 / agent 15 / terminal 5 / probe 5 / headless 6.

심층(owner+consumer)은 핫클러스터 ~28파일. 나머지 863은 path-role 분류. **파일마다 컨슈머를 연 것은 아님** (아래 §8).

Role-heuristic census (basename uniqueness 아님):

| Role | Count |
|---|---:|
| impl | 645 |
| barrel | 53 |
| surface-command | 47 |
| composition-wire | 41 |
| types-or-port | 40 |
| adapter | 24 |
| bootstrap | 13 |
| slash-surface | 12 |
| composition-root | 7 |
| port | 5 |
| parser | 2 |
| schema | 2 |

### 심층 연 소비자 경로

| Owner (G) | Consumer | 비고 |
|---|---|---|
| `host/bootstrap/bootstrap-session.ts` | CLI `session-setup.ts:399`, headless `session-bridge.ts:111`, brain `brain-mode.ts:796` | 웹은 안 탐 (D21) |
| `prepare-runtime.ts:192` | CLI `internal.ts#loadMcpFeatures` | catch 없음 → G-F1 |
| `loadMcpToolsOrEmpty` | CLI no catch; web `daemon-mcp.ts:71` outer catch | G-F1 |
| `mcp-composition.ts:121-135` factory | 항상 `new McpClient` | G-F3 / C-F1 |
| `live-posture-runtime.ts` | CLI `repl.ts:288`; web `resolveWebLivePosture` | G-F8 |
| `usage-accounting-wire.ts` | host assembler `:121`. CLI mint는 **이 helper가 아님** | X-G5 copies, override-safe |
| `tooling-bundle.ts:186` | CLI `session-setup.ts:773` | |
| `runtime-factory.ts:178` | `createRuntimeFromAgentConfigBase`; `server.ts:453` | 웹 ≠ bootstrapSession |
| HEAD `mention-source-deps.ts:117` `firstLineOf` | subagent autocomplete descriptions | G-F2; WT는 `@/shared` |
| HEAD `at-autocomplete/provider.ts:79` | autocomplete `detail` | G-F2 |
| `pricing.ts#costUsd` | unknown model → `null` | X-G6 documented split |
| `prompt-cache/default.ts:181` | unknown → sonnet fallback + warn-once | ADR-0138 |
| `scheduler/next-fire.ts` | automation-engine tick | UTC-pure |
| `sqlite.ts#markRun` | 3-table transaction | |
| `reactor/trigger-source-pr-comment.ts` | watermark-hole hellgate | residual 없음 |
| `radar/jsonl-file-store.ts` | CLI `buildRadarStore`; A `radar-producer-hook` | barrel 주석 거짓 |
| `sdk/index.ts` | runtime + protocol re-export | surfaceIsolationOnly |
| HEAD `session-registry-cmd.ts` | A inspector/GC | G-F7 |
| `session-transcript-retention.ts` | `/session-registry cleanup` | D+stream 위 합법 seam |
| `stream-json-sink.ts` | unmapped `AgentEvent` silent drop | D26 비재오픈 |
| `pool/types.ts#sleepReal` vs `lease-fs.ts#sleepReal` | worker / lease poll | D22 비재오픈 |

## 4. Finding 인덱스 (HEAD, 전부 open / pre-existing)

구현하지 않음. 권한 있는 write set은 W1-G §Exact proposed write sets.

| ID | Sev | 한 줄 | 재오픈 |
|---|---|---|---|
| G-F5 | P1 | ProMax `boxGrade` early-return이 family setup까지 skip. `isBootstrapped`는 여전히 `~/swebench-python` 요구 | 신규 |
| G-F7 | P1 | HEAD `/session-registry cleanup`이 두 번째 `startAutoSweep` 민트. 싱글톤 타이머와 겹침 | 신규 |
| G-F1 | P2 | MCP 로드 실패: CLI throw / 웹 catch→빈 툴 | 신규 (D21 아님) |
| G-F2 | P2 | HEAD 로컬 `firstLineOf` 잔존. G↔A trim/CRLF 드리프트 | **S8/D8 트리거 재현** |
| G-F3 | P2 | host MCP factory 항상 `new McpClient`. `MCP_USE_ISOLATED_SPAWN` 무시 | W1-C C-F1의 G 소비자 |
| G-F4 | P2 | `tickScheduler`가 `claim(now)`만. `TickOpts`에 `reclaimBefore` 없음 | 신규 |
| G-F6 | P2 | eval dotenv 순서가 CLI/bench와 **반대** | 신규 |
| G-F8 | P3 | CLI permission store 로드 침묵 fail-soft vs 웹 `logger.warn` | 신규 |

### G-F5 [P1] ProMax boxGrade / isBootstrapped 계약 분열

- **파일:** `src/apps/bench/remote/box-session/ec2-lifecycle.ts:483-491` `return` → `:520-530` `setupBoxForFamily` / `verifyPyrightGrounding` 미실행. 주석은 shim+uvx만 skip이라고 함.
- **`:711-715` `isBootstrapped`:** `test -x ~/swebench-python` 필수. ProMax는 shim을 안 만듦 → 영원히 false.
- **소비자:** `attachBox:890-902`이 매번 `bootstrapBox` 재실행. `findIdleBox`는 non-bootstrapped skip.
- **실패:** 웜풀 재사용이 풀 rsync/`bun install`. family setup·LSP prove가 provision 경로에서 빠짐.
- **테스트:** hellgate가 **verified / no boxGrade**라서 이 early-return을 RED 못 함.
- **proof:** 정적 CFG. 라이브 EC2 없음. AMI가 밖에서 shim을 심는지는 미검증.
- **write:** 해당 파일만. shim skip은 유지하고 family setup은 호출하거나, probe를 family-aware로.

### G-F7 [P1] HEAD cleanup dual `startAutoSweep`

- **HEAD:** `session-registry-cmd.ts` `renderCleanup` → `startAutoSweep(autoSweepConfigFromRuntime(runtimeConfig()))` + `sweepNow()` + `finally stop()` (ephemeral만). dry-run은 `sessionRegistryCleanupPathsFrom(runtimeConfig())` — **두 번째** 스냅샷.
- **A 싱글톤:** `global.ts` first-get이 이미 `startAutoSweep`. `auto-sweep.ts`는 두 번 start = 두 타이머. `global.ts`만 호출하라고 문서화됨.
- **실패:** 같은 disk/sqlite에 동시 GC/WAL. dry-run 경로 ≠ mounted backend (`/config set` 후).
- **WT는 이미 싱글톤 `sweepNow`로 고침. HEAD 청구 밖.**
- **테스트:** HEAD slash 테스트는 `"Sweep complete."`만. 두 번째 타이머 RED 없음.
- **write:** HEAD `session-registry-cmd.ts`만. `global.ts`/`auto-sweep.ts`는 A.

### G-F1 [P2] MCP 로드 실패 정책 CLI vs web

- CLI `internal.ts#loadMcpFeatures` — catch 없음 → `prepare-runtime.ts:192-198` rethrow → `bootstrapSession` 실패.
- 웹 `daemon-mcp.ts:53-97` — 같은 host helper를 catch, warn, `{ tools:[], clients:[], mcpAccessor: undefined }`.
- producer: `host/mcp-composition.ts#loadMcpToolsOrEmpty` (0 configs만 empty, throw는 통과).
- **D21 재오픈 아님.** 부트 병합 제안 아님. 실패 정책 하나, writer 둘.
- 테스트 없음 (웹 catch 삭제해도 기존 레일 GREEN).

### G-F2 [P2] S8 트리거가 HEAD에서 재현

SEP6는 S8을 `src/shared/mention-text.ts`로 닫았다고 함. **그 파일은 HEAD에 없음.**

HEAD `firstLineOf` 7곳:

| 위치 | 레인 | 알고리즘 |
|---|---|---|
| `host/.../mention-source-deps.ts` | G | `/\r?\n/` + **trim** |
| `apps/cli/at-autocomplete/provider.ts` | G | 동일 trim (string only) |
| `plugin-app-resolver/mcp-resolver.ts` | A | `\n`+CR strip + **trim** |
| `plugin-app-resolver/subagent-resolver.ts` | A | 동일 + trim |
| `plugin-app-resolver/plugin-resolver.ts` | A | CR strip, **trim 없음** |
| `plugin-app-resolver/skill-resolver.ts` | A | trim 없음 |
| `mention-runner/skill-resolver.ts` | A | trim 없음 |

측정: `"  hello  \\nworld"` → G `"hello"`, A plugin/skill `"  hello  "`. CR-only 첫 줄도 `search(/\r?\n/)` vs `indexOf("\\n")`로 갈림.

**G 내부(host↔CLI)는 trim 드리프트 없음.** S8은 A 드리프트 + HEAD 로컬 owner 잔존으로 연다. `src/shared/**`는 G write 금지.

### G-F3 [P2] Isolated spawn 게이트 미배선 (C-F1 소비자)

`host/mcp-composition.ts:121-135` factory 항상 `new McpClient`. `src/host`에 `IsolatedMcpClient` / `isolatedMcpEnabledFromEnv` 없음. CLI·웹 MCP가 이 factory를 씀. env=1이어도 isolate timeout 미적용.

write: G는 factory만. `isolated-client.ts`는 C.

### G-F4 [P2] stale claim reclaim이 라이브 tick에 없음

- `TickOpts`에 `reclaimBefore` 필드 없음. `tickScheduler`는 `engine.claim(now)`만.
- 포트·sqlite·in-memory는 reclaim 구현됨. hellgate는 **opt-in일 때만** 증명.
- A `automation-ticker.ts`는 `tickScheduler({ engine, now, handler })`만 — TickOpts가 막아서 A가 넣고 싶어도 못 넣음.
- default-OFF 엔진. 켜진 뒤 crash-during-tick이면 그 row는 `running`에 박힘.
- write: G `ticker.ts`. A ticker wire는 W2-X.

### G-F6 [P2] eval dotenv 순서 역전

first-wins SSOT: `.env.dev → .env.local → .env`

- CLI/agent: `loadEnvFiles([...])` from `@/shared/env-files`
- bench `run-main.ts:833`: **같은 순서**, 로컬 파서 복사 (`run-args.ts`)
- eval `index.ts:174`: **`.env → .env.local → .env.dev`**

같은 cwd에서 `.env`와 `.env.dev`가 충돌하면 bench/CLI vs eval의 `QUANTA_*`가 갈림.

write: `apps/eval/index.ts`. shared 정책 변경은 reserved.

### G-F8 [P3] permission store 로드 관측 드리프트

둘 다 fail-soft → `undefined`. CLI `repl.ts:288-295` empty catch (침묵). 웹 `runtime-factory.ts:272-283` `logger.warn`. durable posture 유실을 CLI는 모름. grant dual-write는 아님.

## 5. 재오픈하지 않은 것

| ID | 이유 |
|---|---|
| D21 CLI/web boot 병합 | 공통 session-bootstrap I/O 계약 + parity RED 없음. CLI/headless/brain = `bootstrapSession`. 웹 = `mintSessionCollaborators`+`buildAgentConfigBase`. interactive preset = 세 번째 경로. 비교 증거만 W2-X |
| D22 `sleepReal` | `pool/types.ts` vs `lease-fs.ts` 의미 동일 one-liner. G dirty set 아님. 측정 드리프트 없음 |
| D26 AgentEvent 메가테이블 | `stream-json-sink`는 문서화된 non-exhaustive drop. **새로 빠져야 하는 이벤트**를 특정하지 않음 |
| SEP6 S8 “이미 닫힘” | **거절.** 공유 오너가 HEAD에 없음. 트리거는 재현됨 → G-F2 |

## 6. 인벤토리 (failure mode 없음 → finding 아님)

- cohort 9파일: gates 985, worker 962, box 960, brain-mode 959, eval/index 956, rewind 938, ec2-lifecycle 934, run-main 929, mcp-composition 923. ratchet max=24가 이미 인구 캡.
- `mcp-composition.ts` SRP 허브. failure는 G-F3뿐.
- `SessionBootstrapDeps` fat bag = 펜스 비용.
- host/sdk `surfaceIsolationOnly`. `src/host`/`src/sdk`에서 `@/apps` value import 없음.
- `parseEnvFlag` from `@/runner/assemble` = `@/shared` re-export.
- usage-accounting 민트 3곳 (`tooling-bundle` / `usage-accounting-wire` / web factory) 전부 `resolveUsageAccounting`, override-safe. CLI hellgate 있음.
- `costUsd` 미지 모델 `null` vs prompt-cache sonnet fallback — 문서화된 분기 (ADR-0138). UI가 두 USD를 한 숫자로 합치면 그때 재검토.
- metrics in-memory: histogram/series cap, sink no-throw counted.
- scheduler `markRun` 트랜잭션. `computeNextFire` UTC-pure, 10년 캡. `_clock` unused.
- reactor watermark hole = hellgate + 코드 hole-cap. 잔여 없음.
- radar JSONL skip-corrupt + no fsync, default-OFF. barrel 주석 “nobody imports radar”는 거짓 (CLI `buildRadarStore`, A `radar-producer-hook`).
- host `NamedEntry` vs CLI — host↛apps 펜스.
- probe/headless/rewind/brain: 추가 failure mode 못 잡음 (워커+코디네이터).

## 7. W2-X fingerprint (레인 교차 — 전체)

형식: authority / invariant / input / output / state / effect / failure-policy / lifecycle.

| ID | Fingerprint | G 끝 | 상대 | 처분 |
|---|---|---|---|---|
| X-G1 | mcp-load-fault / boot-capability / mcpConfigs+loadMcpTools / tools+clients / fleet / spawn / throw-vs-empty / session-start | `internal.ts#loadMcpFeatures` vs `daemon-mcp.ts` | A `loadMcpTools` | **G-F1**. D21 병합 금지 |
| X-G2 | mention-first-line / trim+CRLF / description / first line / none / lookup+autocomplete / local-vs-shared / call | HEAD `mention-source-deps.ts`, `at-autocomplete/provider.ts` | A resolvers; untracked `shared/mention-text.ts` | **G-F2 / S8 트리거** |
| X-G3 | mcp-client-select / spawn-isolation-enablement / MCP_USE_ISOLATED_SPAWN / SupervisableMcpClient / process / spawn / env-ignored / start-stop | `mcp-composition.ts:135` | C `isolated-client.ts`; A plugin launcher | **G-F3 / C-F1** |
| X-G4 | session-boot / interactive-collaborators / env+deps / AgentConfig / session / mint / surface-local / process | `bootstrapSession` vs `runtime-factory` vs `mode-presets/interactive.ts` | D21 conditional | 인벤토리. parity RED 없음 |
| X-G5 | usage-accounting-mint / QUANTA_USAGE_ACCOUNTING_V2 / env / UsageAccountingPort / one instance / record / fail-safe-on / session | `tooling-bundle.ts` vs `usage-accounting-wire.ts` vs `runtime-factory.ts` | observability factory | copies, override-safe. CLI hellgate 있음 |
| X-G6 | unknown-model-price / rate-card miss / model id / usd / none / display / null-vs-sonnet-fallback / record | `pricing.ts#costUsd` vs `prompt-cache/default.ts#resolvePricing` | none | documented split. UI가 한 숫자로 합치면 재검토 |
| X-G7 | sleep-real / delay-ms / number / Promise\<void\> / none / timer / n-a / call | `pool/types.ts` vs `lease-fs.ts` | D22 | byte-identical. 재오픈 안 함 |
| X-G8 | agent-event-projection / subset-map / AgentEvent / SessionEvent\|undefined / none / stdout-json / silent-drop / turn | `stream-json-sink.ts:218-223` | stream/kernel projectors (D) | D26. 새 dropped event 못 짚음 |
| X-G9 | radar-jsonl-durable / append-replay / file / in-memory map / cards / write / skip-corrupt / process | `radar/jsonl-file-store.ts` | A `radar-producer-hook.ts` | gated; no fsync; best-effort |
| X-G10 | named-entry-shape / autocomplete-row / name+description / NamedEntry / none / list / structural-dup / call | host `mention-source-deps.ts` vs CLI `NamedEntry` | fence: host ↛ apps | 인벤토리 |
| X-G11 | session.v1-public-verbs / command-union / SessionCommand / CommandReceipt / none / submit / typed-omit / handle | sdk `handle-adapter` pins `SessionVerbSurface` | C-F2 protocol/ipc | G는 consumer. protocol 편집 금지 |
| X-G12 | parseEnvFlag / bool-env / raw string / boolean / none / gate / default / call | G files import `@/runner/assemble` re-export | `shared/env-flag.ts` SSOT | duplicate 아님 |
| X-G13 | transcript-retention / max-bytes / jsonl envelopes / trimmed file / none / rewrite / no-throw-continue / sweep | `session-transcript-retention.ts` | stream `applyRetention` + session `sessionsRoot` (D) | 합법 composition seam |
| X-G14 | scheduler-next-fire / rrule UTC / (rule,from,count) / ms\|never / none / none / never-on-horizon / pure | `scheduler/next-fire.ts` | timezone unused `_clock` | TZ 드리프트 미측정 |
| X-G15 | automation-claim-reclaim / stale-running / now+reclaimBefore / ClaimedRun / running row / re-claim / opt-in-absent / tick | `ticker.ts` `claim(now)` | A `automation-ticker.ts` | **G-F4** |
| X-G16 | box-readiness / bootstrapped⇔shim+family+LSP / ssh probe / bool / box disk / skip-setup / fail-open-reuse / attach | `ec2-lifecycle.ts` `bootstrapBox` vs `isBootstrapped` | profile.`boxGrade` | **G-F5** |
| X-G17 | dotenv-first-wins / file-order / KEY=VALUE / process.env / provenance? / set-if-absent / silent-shadow / process-start | `eval/index.ts` vs `bench/run-main.ts` vs `shared/env-files` | CLI/agent `loadEnvFiles` | **G-F6**. shared reserved |
| X-G18 | session-registry-sweep / single-timer+frozen-cfg / slash cleanup / GC / store / dual-startAutoSweep / process | HEAD `session-registry-cmd.ts` | A `global.ts` + `auto-sweep.ts` | **G-F7** |
| X-G19 | permission-store-load / fail-soft / store.load / PermissionStore\|undefined / none / degrade / silent-vs-warn / boot | `repl.ts` vs `runtime-factory.ts` | `@/permission` store (F) | **G-F8** |

## 7b. No-finding으로 닫은 영역 (이 HEAD)

- `bootstrapSession` = CLI / headless / brain 공유 부트. 웹은 안 탐.
- `assembleAgentConfig`는 host. `apps/agent/assemble.ts`는 env-binding shim. 웹 `buildAgentConfigBase`가 그 assembler로 project.
- `loadMcpToolsOrEmpty`는 0 configs일 때만 empty. throw-all catch가 아님.
- reactor watermark: hellgate가 hole-cap. skip-past-hole 소스 재현 없음.
- scheduler sqlite unique `idx_automations_live_heartbeat_thread` = 프로세스 간 one-live-heartbeat.
- SDK public surface는 133-field `AgentConfig`를 re-export 안 함 (`sdk/public-surface.test.ts` 존재, 이번엔 재실행 안 함).
- UI slice = string helpers. `envAllowFiles: ui-helpers.ts`가 display-posture read.
- transcript sweep = session+stream 위 apps composition (라이브러리끼리 import 못 함).

## 8. 검증 한계 / 구멍

정적 전제. 아래는 **안 함**:

- 891파일 각각 컨슈머 추적
- 깨진 `.mcp.json` 실기동 CLI vs web
- `MCP_USE_ISOLATED_SPAWN=1` 라이브 부트
- EC2 ProMax 웜풀
- dual-timer sqlite GC 스트레스
- process-kill armed ticker
- 이중 프로세스 dotenv 실험
- 손상 permission store 프로브
- `QUANTA_RADAR_FILE` mid-append crash
- scheduler TZ/DST
- D26 전수 AgentEvent 매핑
- biome complexity 점수 재귀속
- 공식 god-fn AST를 dirty 3파일의 **HEAD blob**에 (detector는 WT 바이트)

CLI slash 본문·keymap·status chrome 전수 line-walk는 apps 워커도 structure-only로 남김.

## 9. 다른 에이전트에게

1. 구현하려면 W3-I 티켓. 이 파일/W1-G는 분류 영수증.
2. G-F7/G-F2는 **HEAD**. WT에 고친 코드가 있어도 HEAD 재현이 진실.
3. `src/shared/**` 쓰지 말 것 (G write 금지).
4. D21로 CLI/web 부트를 합치지 말 것.
5. C-F1과 G-F3는 한 불변식의 두 끝. 한 레인만 고치면 안 됨.
6. 다음 작업이 W0이면 이 스냅샷 해시와 맞춰라. HEAD가 바뀌면 이 dump는 STALE.

## 10. Write set 요약 (G only)

| ID | 허용 | 금지 |
|---|---|---|
| G-F1 | `daemon-mcp.ts` 및/또는 host load-fault helper | D21 부트 병합; A `loadMcpTools` 본문 |
| G-F2 | HEAD mention-source-deps + at-autocomplete provider | `src/shared/**`; A resolver |
| G-F3 | `mcp-composition.ts` factory | C `isolated-client.ts`; A plugin launcher |
| G-F4 | `scheduler/.../ticker.ts` | A `automation-ticker.ts` (W2-X 할당 전) |
| G-F5 | `ec2-lifecycle.ts` + boxGrade 테스트 | observability 가격표; AMI 추측 |
| G-F6 | `apps/eval/index.ts`; optional `run-args.ts`→shared import | shared env-files 정책 변경을 G cleanup으로 |
| G-F7 | HEAD `session-registry-cmd.ts` | A global/auto-sweep; WT를 HEAD로 취급 |
| G-F8 | `src/apps/cli/repl.ts` warn | CLI만 fail-closed로 뒤집기 |

### Test-owner map (coarse)

- `src/apps/cli/**` → `src/apps/cli/__tests__/**`, `tests/unit/apps/cli/**`, `tests/unit/cli/**`
- `src/apps/web-daemon/**` → `tests/unit/apps/web-daemon/**`, integration `*-web-daemon-e2e*`
- `src/apps/bench/**` → `tests/unit/apps/bench/**`, `tests/unit/bench*`
- `src/apps/eval/**` → `tests/unit/eval-*`
- `src/apps/agent/**` → `tests/unit/apps/agent/**`
- `src/apps/headless/**` → `tests/unit/apps/headless/**`
- `src/host/**` → `tests/unit/host/**`, `tests/unit/host-slice-boundary.test.ts`
- `src/sdk/**` → `tests/unit/sdk/**`
- `src/observability/**` → `tests/unit/observability*.test.ts`
- `src/scheduler/**` → `tests/unit/scheduler-*.test.ts`
- `src/reactor/**` → `tests/unit/reactor-*.test.ts`
- `src/radar/**` → `tests/unit/radar-slice-boundary.test.ts` (thin)
- `src/workflow/**` → `tests/unit/workflow-*.test.ts`
- `src/ui/**` → `tests/unit/ui-slice-boundary.test.ts`

root tests 중 SUT가 G인 것은 디렉터리 heuristic으로만 매핑. ~750 rg hit 전부 열지 않음.

### 레인 소유권 (이 세션이 쓰지 않은 것)

W1 G write 금지: `src/shared/**`, root-level tests, architecture configs, generated catalog MD, 다른 레인 production.

교차 import는 **증거**이지 write ownership이 아님. A/C/F 파일은 소비자로만 읽고 비교는 W2-X로 보냄.
