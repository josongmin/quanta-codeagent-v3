# Sep-08 SE audit — agent-1 (lane G session dump)

> **Role:** Sep-07 SOLID/SE campaign **lane G** worker (this Cursor session).
> **Historical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-G.md`](../../plans/sep-7-solid-se-audit/receipts/W1-G.md) — 분류는 `0b14f5cf` 기준. 891-row 매니페스트는 그쪽 appendix.
> **Live dump:** 이 파일. `9b05cd33` hole-check 반영. W3-I 티켓 아님. 구현 권한 없음.
> **Dispatch:** [`docs/plans/sep-7-solid-se-audit/prompts/README.md`](../../plans/sep-7-solid-se-audit/prompts/README.md).

## 1. 세션이 한 일

Sep-07 dispatch pack의 **레인 G**만 수행함. 프로덕션 미수정.

- Exclusive production: `src/apps`, `src/host`, `src/sdk`, `src/ui`, `src/workflow`, `src/scheduler`, `src/reactor`, `src/observability`, `src/radar`
- 1차: W0 없음 → **tracked HEAD-only** (`0b14f5cf`). 영수증 W1-G.
- 2차 hole-check (이 턴): 형제 레인 dump(C/A/E/F/H) 교차 + 병렬 3워커. 코디가 **현재 HEAD `9b05cd33`**에서 owner+consumer 재읽음. grep-only 완료 청구 없음.
  - [CLI composition](755a60b8-89b1-41c3-b01d-4197a00f3274)
  - [Web+host boot](ebc5e6de-b4e6-4d83-8572-de729e630e35)
  - [Bench/eval/scheduler/obs](794c7fb3-7823-4168-8d7f-cd5489b88595)

## 2. 스냅샷

| Field | 1차 W1-G | 2차 hole-check (live) |
|---|---|---|
| HEAD = origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | `9b05cd33b008b52bf54c9f2391070afcbfbaa8fe` |
| ahead/behind | `0 0` | `0 0` |
| G production dirty | 3 files (SEP6 overlay) | **empty** (overlay가 `9b05cd33`에 커밋됨) |
| W0 | 없음 | 없음 |

`9b05cd33` message=`done`. SEP6 closeout + W1-A..H + 이 dump 초안이 한 커밋에 들어감. **W1-G 본문은 옛 HEAD 기준이라 G-F2/G-F7 상태가 이 파일과 어긋남. live 처분은 여기.**

G production porcelain (2차): 없음. `docs/ARCHITECTURE.md` / `slice-boundary-configs.ts`는 그 커밋에서 HEAD=WT로 맞춰짐.

## 3. 커버리지 (1차 그대로, 파일 수 불변)

| Universe | Count |
|---|---:|
| G production `*.ts` (HEAD-tracked, tests 제외) | **891** 전부 분류 |
| colocated tests | 113 |
| 총 라인 | 176959 (1차 `0b14f5cf`) / 176973 (2차 `9b05cd33`) |
| god-MODULE >1000 | 0 |
| god-FUNCTION >150 | 0 |
| cohort 900–999 | **9** (인벤토리) |

2차에서 추가로 owner+consumer를 연 구멍: CLI remote/skill/slash, web WS userInput, pool abort settle, eval cost rollup, host assembler metrics→registry, C-F5 serve-stdio, H-SA-01 host 선택 분기.

## 4. Finding 인덱스 (live HEAD `9b05cd33`)

구현하지 않음.

| ID | Sev | Status | 한 줄 |
|---|---|---|---|
| G-F5 | P1 | **open** | ProMax `boxGrade` early-return이 family setup까지 skip. `isBootstrapped`는 여전히 `~/swebench-python` 요구 |
| G-F9 | P1 | **open** | CLI `selectRemoteRunner(env, {})` — docker/lima seam 미주입 (C-F6 G half) |
| G-F10 | P1 | **open** | CLI HELP가 `headless`를 제품 peer로 광고. empty seams로 합성 성공 (C-F7 G half) |
| G-F16 | P3 | **latent (dead branch)** | assembler metrics 분기는 production producer 0 — `AgentConfig.metrics`가 legacy `Metrics`(=`increment` 없음)라 `looksLikeMetricsRegistry` 항상 false |
| G-F1 | P3 | **inventory** | catch 유무 비대칭만 존재. 공유 producer가 양쪽 fail-soft라 도달 트리거 없음 |
| G-F3 | P3 | **inventory (C 소유)** | `MCP_USE_ISOLATED_SPAWN`은 repo 전체 production reader 0. G 고유 배선 갭 아님 |
| G-F4 | P2 | **open** | `tickScheduler`가 `claim(now)`만. `TickOpts`에 `reclaimBefore` 없음 |
| G-F6 | P2 | **open** | eval dotenv 순서가 CLI/bench와 **반대** |
| G-F11 | P2 | **open** | CLI+web skill authority가 `orgConfigDir`를 영구 null. ADR-0134 env 미읽음 |
| G-F12 | P2 | **open** | web `turn.abort`가 `userInput.cancelAll`을 안 탐. 소켓 close만 (Aug-25 #88) |
| G-F14 | P2 | **open** | pool worker abort 시 `lost:true` 합성 전에 throw. 부분 영수증 없음 |
| G-F15 | P2 | **open** | eval coverage-matrix가 unpriced `costUsd`를 `$0`처럼 합산. bench는 `—` |
| G-F8 | P3 | **open** | CLI permission store 로드 침묵 fail-soft vs 웹 `logger.warn` |
| G-F13 | P3 | **open** | `apps/agent` repo-rules silent fail-open vs CLI/web warn |
| G-F2 | P2 | **repaired** | `mentionFirstLine` (`src/shared/mention-text.ts`) 7 consumer 전부 HEAD |
| G-F7 | P1 | **repaired** | `/session-registry cleanup` → `sweepGlobalSessionResourceRegistryNow()` 싱글톤 |

### G-F5 [P1] ProMax boxGrade / isBootstrapped 계약 분열 — open

- `ec2-lifecycle.ts:483-491` `return` → `:520-530` `setupBoxForFamily` / `verifyPyrightGrounding` 미실행.
- `:711-715` `isBootstrapped`는 `test -x ~/swebench-python` 필수. ProMax는 shim을 안 만듦 → 영원히 false.
- **`attachBox` 재실행 경로는 반증됨**: 호출 3곳(`full.ts:543`, `pool/worker.ts:327`, `:334`)이 전부 `findIdleBox` 경유이고 `:792`가 `isBootstrapped` false를 `continue`로 거름 ⇒ ProMax 박스는 애초에 idle로 반환되지 않음. 실효과는 **웜박스 재사용 영구 불가 + 그 박스가 살아있는 동안 신규 launch 거부**(`full.ts:546-550`, `launch-window.ts:59-68`).
- 테스트: hellgate가 verified / no boxGrade라 early-return RED 못 함.
- write: 해당 파일. shim skip은 유지하고 family setup은 호출하거나 probe를 family-aware로.

### G-F9 [P1] remote composition root가 seam을 안 넣음 — open (C-F6 G half)

- **Owner:** `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})`
- **Contract:** `src/remote/runner/registry.ts:47-76` — docker/lima는 seam 없으면 `null`. 주석: composition root가 wiring 공급.
- **Failure:** `QUANTA_REMOTE_RUNNER=docker|lima` → 항상 `remote-not-configured` (exit 64). 어댑터 dead. `apple-vz`는 `{}`여도 non-null → spawn `daemon-unavailable`.
- **C vs G:** C = registry가 이름만 받고 seam 없으면 null. **G = 유일한 production caller가 `{}`를 넣음.**
- write: `apps/cli/index.ts` (+ Docker/Lima factory를 CLI/host leaf에). Forbidden: registry에 암시 default docker; C registry 본문을 G가 “고침”.
- proof: 정적 호출. live docker 미실행.

### G-F10 [P1] CLI가 headless를 제품 runner로 광고 — open (C-F7 G half)

- **Owner:** `remote-cmd.ts:63` HELP `docker|lima|apple-vz|headless|none`; route는 G-F9와 동일 `{}`.
- **Failure:** `QUANTA_REMOTE_RUNNER=headless`는 seam 없이 선택됨 → stub가 `succeeded`/exit 0 (`headless-stub.ts:93-103`). docker/lima는 죽는데 headless만 성공.
- **C vs G:** 합성 성공 본체 = C. env를 제품 HELP/route에 노출 = G.
- write: HELP를 test-only로 표시하거나 `routeRemote`에서 headless 차단. Forbidden: stub만 고치고 CLI 광고 방치.

### G-F16 [P3] assembler metrics 분기는 production-unreachable — latent (P1-A-01 G half)

- **Owner G:** `host/runtime/agent-config-assembler.ts:665-672` — `metricsEmitter` 있으면 `buildCallerOwnedRegistryWithTelemetry`, 없으면 `getGlobalSessionResourceRegistry`.
- **Owner A:** singleton+sweep vs caller-owned (sweep 없음, `runtimeConfig()` 재읽기).
- **Consumer 분열 (2차 HEAD에서 더 선명):** slash inspect/cleanup은 **singleton만** (`session-registry-cmd.ts:338-365`). live 세션 Map은 caller-owned일 수 있음.
- **Failure: 없음 (도달 불가).** `metrics-adapter.ts:137` duck-test가 `increment`+`gauge`를 요구하는데 `AgentConfig.metrics`의 타입 `observability/metrics.ts:87 class Metrics`에는 `increment`가 **0건**(있는 건 `inc`/`value`/`set`/`start`/`record`/`stats`). 그 docblock 자체가 "legacy `Metrics` … does NOT have `increment`, so the duck test returns false"라고 명시. 유일 producer는 `cli/internal.ts:605 new Metrics()` ⇒ caller-owned 분기 미발화. **split-brain은 발생할 수 없음.**
- write: assembler가 metrics여도 singleton+sweep을 쓰거나, caller-owned에 sweep을 붙이는 건 A. G는 분기만. Forbidden: A `global.ts`를 G가 재작성.
- proof: producer census 완료 — `defaultMetricsRegistry()` 3곳 전부 sink용이고 `cfg.metrics`에 도달하지 않음.

### G-F1 [P2] MCP 로드 실패 정책 CLI vs web — open

- CLI `internal.ts#loadMcpFeatures` catch 없음 → `prepare-runtime` rethrow → 부트 실패.
- 웹 `daemon-mcp.ts:94-97` catch → warn → `{ tools:[], clients:[], mcpAccessor: undefined }`.
- **도달성 없음:** `readMcpConfig`(`mcp-composition.ts:433-437`)는 malformed JSON도 `catch → return []`, `loadSingle`(`mcp-bridge.ts:427-432`)은 서버별 `catch → return null` → `loadMcpTools` continue. 깨진 `.mcp.json`도, 죽은 서버도 throw하지 않음 ⇒ CLI rethrow 경로에 도달하는 트리거가 없음.
- **D21 아님.** 남는 건 정책 shape 비대칭뿐 → inventory.

### G-F3 [P2] Isolated spawn 게이트 미배선 — open (C-F1 소비자)

`mcp-composition.ts:121-135` factory 항상 `new McpClient`. 단 `MCP_USE_ISOLATED_SPAWN`은 `src/` 전체에서 정의부 2줄뿐이고 `isolatedMcpEnabledFromEnv` 호출 **0** — 게이트 자체가 inert. 반대로 plugin/skill 경로는 `agent/skill-mcp-wire.ts:92` / `agent/plugin-activation-handler/auto-wire.ts:167`에서 env와 무관하게 **무조건** `IsolatedMcpClient`를 씀.

⇒ G-vs-C 두 끝 불변식이 아니라 **C가 끝까지 소유한 dead gate**. G에서 factory를 게이트에 배선하면 아무도 읽지 않는 knob을 존중하게 됨.

### G-F4 [P2] live tick이 stale claim reclaim을 안 함 — open

- `TickOpts` (`ticker.ts:77-91`)에 `reclaimBefore` 없음. `tickScheduler`는 `engine.claim(now)`만 (`:119`).
- 포트·sqlite·in-memory는 reclaim 구현. A `automation-ticker.ts`는 TickOpts가 막아서 못 넣음.
- default-OFF 엔진. 켜진 뒤 crash-during-tick → row가 `running`에 박힘.

### G-F6 [P2] eval dotenv 순서 역전 — open

first-wins SSOT: `.env.dev → .env.local → .env`

- CLI `index.ts:30` / agent `index.ts:31` / bench `run-main.ts:833`: 그 순서.
- eval `index.ts:174`: **`.env → .env.local → .env.dev`**

### G-F11 [P2] skill org policy 미배선 — open (E-SKILL-01 G half)

- CLI `repl/session-setup.ts:343-363` — 주석이 `orgConfigDir`를 고의 null. `snapshotInputs`에 `userDir`만.
- web `authority-readouts.ts:90-105` 동일.
- `build-skills.ts:73-76` orgConfigDir 결정 → `:77-80` `loadAdminPolicy({ orgConfigDir })`; null ⇒ policy 없음.
- ADR-0134 / catalog: `$QUANTA_ORG_CONFIG_DIR` 또는 `~/.config/quanta/org/`. **G composition은 env를 안 읽음.** `org-policy.json` banned/required·admin-skills discovery가 primary CLI/web에서 inert.
- write: `session-setup.ts` + `authority-readouts.ts`에 org dir resolve. Forbidden: E가 CLI 수정; `src/shared/**`.

### G-F12 [P2] turn abort ≠ userInput cancel — open (Aug-25 #88)

- `ws-handlers.ts:500-513` — `cancelAll`은 WS `close`만. 주석 residual 명시.
- `goal-wake-compose.ts:38`은 이미 `turn.aborted|failed|completed`를 봄.
- **Failure:** 소켓이 열린 채 turn cancel → `request_user_input` / `ask_user` resolver hang.
- 웹 userInput 포트의 `cancelAll` 유일 production caller = `ws-handlers.ts:510` (close 경로). 단 bare `cancelAll` 토큰 자체는 playbook debouncer·headless-stub·fs-watch·user-question broker에도 있음 — 다른 포트.
- 게이트: 포트 존재는 `QUANTA_WEB_AGENT_STATE`, in-band interrupt는 `QUANTA_THIN_CLIENT_DISPATCH`. 둘 다 default-OFF.
- write: `ws-handlers.ts`가 shared-session turn terminal에서 `userInputPorts.handle.cancelAll()`. Forbidden: protocol/kernel.

### G-F14 [P2] pool abort가 `lost:true` 합성 전에 throw — open

- `pool/worker.ts:957-961` catch → `queue.abort()` → `finalizeWorkerRun`이 `primaryErr`를 **재throw** (`:622`).
- `pool.ts:186-188` `workerErrors` 있으면 `lost:true` map (`:192-200`) **전에** throw.
- consumer `commands/pool.ts`는 성공 시에만 `summarizePoolRun`.
- **Failure:** 이미 `out`에 쌓인 청크·abort된 잔여가 LOST/PARTIAL 영수증 없이 전체 throw. 주석의 “no recorded result → lost”는 worker 실패 시 도달 불가.
- write: `pool.ts` settle 순서 + worker abort 정책. Forbidden: auth/EC2 TTL 소유권.

### G-F15 [P2] eval cost rollup이 unpriced를 `$0`처럼 표시 — open

- `eval/report/coverage-matrix.ts:128-135` — `tokens` 있으면 `records++`, `costUsd`는 number일 때만 가산.
- `eval/report/markdown.ts:49` — `Estimated cost: $…` 무조건 `toFixed`.
- bench `analyze/cost.ts:260-268`은 unpriced면 `— (no pricing for model)`.
- **Failure:** unknown model → 헤드라인 `$` 과소. 토큰/`Runs with usage`는 증가.
- write: matrix+markdown에 `pricingKnown`/`unpricedRecords` 또는 bench식 `—`. Forbidden: `@/observability/pricing` SSOT, prompt-cache fallback (X-G6).

### G-F8 [P3] permission store 로드 관측 드리프트 — open

CLI `repl.ts:288-295` empty catch. 웹 `runtime-factory.ts` `logger.warn`. 둘 다 fail-soft → `undefined`.

### G-F13 [P3] apps/agent repo-rules 침묵 fail-open — open

- `apps/agent/mode-presets/system.ts:49` `loadRepoRules(cwd).catch(() => undefined)`
- CLI host: `session-state-ports.ts:253-257` warn. 웹: `agent-config-base.ts:232-237` warn.
- 같은 fail-open, 관측만 없음. write: `system.ts` warn 미러. fail-open 뒤집지 말 것.

### G-F2 [P2] **repaired** on `9b05cd33`

`src/shared/mention-text.ts` `mentionFirstLine`가 HEAD. G: `mention-source-deps.ts:285`, `at-autocomplete/provider.ts:116`. A resolvers도 동일 import. 로컬 `firstLineOf` 없음. S8 트리거 이 HEAD에서 재현 안 됨.

### G-F7 [P1] **repaired** on `9b05cd33`

`session-registry-cmd.ts:338-365` — dry-run은 `getGlobalSessionResourceRegistryState().sweepConfig`, live는 `sweepGlobalSessionResourceRegistryNow()`. 두 번째 `startAutoSweep` / `runtimeConfig()` 재스냅샷 없음. (G-F16 split-brain은 **다른** 불변식.)

## 5. 재오픈하지 않은 것 / 2차에서도 안 연 것

| ID | 이유 |
|---|---|
| D21 CLI/web boot 병합 | 공통 I/O 계약 + parity RED 없음. 세 루트 inventory |
| D22 `sleepReal` | 의미 동일, **바이트는 다름** — `pool/types.ts:119` 한 줄 `(r)` vs `lease-fs.ts:5-8` 블록 `(resolve)` |
| D26 AgentEvent | dropped `usage` 등 존재. **그걸 필요로 하는 소비자** 못 짚음 |
| SEP6 S8 | **이 HEAD에서 닫힘** (G-F2 repaired) |
| C-F5 stdio EOF | G `serve-stdio-cmd.ts`가 stdin `end`/`close` 구독. transport data-only는 C. G hang 아님 |
| H-SA-01 charter fail-open | assembler는 `QUANTA_SIDE_AGENT_PROCESS`일 때 process registry 정직 선택. finding IPC는 H |
| permission grant dual-write | 한 gate 경로. 웹에 trustScope writer 없음 (missing writer ≠ dual-write) |
| usage-accounting ×3 mint | override-safe. 세션당 한 instance |
| web OOB WS vs session.v1 (#87) | goalWork/goalVerify는 refuse. 새 misroute 없음. X-C22 inventory |
| C-F2 SessionVerbSurface | SDK `handle-adapter`가 구멍 핀. write는 protocol (C). G-Fx 아님 |
| `/config set` 유령 | 7파일 8개 **주석**에 `/config set` (knob-catalog·runtime-config/types·global.ts·caller-owned-builder·cli-knobs-accessor×2·registry-surface·persistence-sqlite). live 슬래시는 `/knobs`뿐. comment rot → **inventory** |
| CLI `dotenv.ts` | `export { loadEnvFiles } from "@/shared/env-files"` re-export. dual-owner 아님 |
| cohort 900–999 size | size≠failure. 실실패는 G-F3/F5/F6/F14뿐 |

## 6. 인벤토리 (failure mode 없음)

- cohort 9파일: gates 985, worker 962, box 960, brain-mode 959, eval/index 956, rewind 938, ec2-lifecycle 934, run-main 929, mcp-composition 923.
- `SessionBootstrapDeps` fat bag = 펜스 비용.
- host/sdk `surfaceIsolationOnly`. `@/apps` value import 없음.
- `parseEnvFlag` from `@/runner/assemble` = `@/shared` re-export.
- usage mint 3곳 전부 `resolveUsageAccounting`.
- `costUsd` null vs prompt-cache sonnet — ADR-0138. UI join 없으면 X-G6 inventory.
- radar JSONL skip-corrupt + no fsync, default-OFF.
- `NamedEntry` host 재선언 = fence.
- `loadNamedAgents(...).catch(() => undefined)` (`apps/agent/index.ts:458`) — intentional fail-open. 대칭 warn 사이트는 `apps/cli/repl/session-loop-options.ts:129`. `apps/agent`엔 skill 로더가 없음. P3 smell, 승격 안 함 (G-F13과 구조 동일한데 여기만 미승격 — 트리아지 비일관).
- apps/agent는 `.mcp.json` bootstrap 안 함 (#75 inventory).
- CLI `rule-indicator.ts` `loadRepoRules.catch(() => undefined)` — chrome, boot capability 아님.
- `getOrCreateRegistry` (`agent/session-resource-registry/unified-api.ts:118`, ADR-0383 "unified mint API") — production caller **0**. assembler는 builder를 직접 호출. dead API.

## 7. W2-X fingerprint (live)

| ID | Fingerprint | G 끝 | 상대 | 처분 |
|---|---|---|---|---|
| X-G1 | mcp-load-fault / throw-vs-empty | `loadMcpFeatures` vs `daemon-mcp.ts` | A `loadMcpTools` | **G-F1** |
| X-G2 | mention-first-line / shared owner | `mentionFirstLine` 7 call | shared + A | **repaired** |
| X-G3 | MCP_USE_ISOLATED_SPAWN ignored | `mcp-composition.ts:135` | C isolated-client | **G-F3 / C-F1** |
| X-G4 | session-boot three roots | bootstrap vs web vs interactive | D21 | inventory |
| X-G5 | usage-accounting mint copies | tooling-bundle / wire / web factory | obs | override-safe |
| X-G6 | null vs sonnet fallback | `costUsd` vs prompt-cache | none | inventory; **G-F15**는 eval 표시층 |
| X-G7 | sleepReal | pool vs lease-fs | D22 | 의미 동일, 표기 다름 |
| X-G8 | AgentEvent subset-map | stream-json-sink | D | D26 closed |
| X-G9 | radar jsonl skip-corrupt | jsonl-file-store | A producer-hook | gated |
| X-G11 | SessionVerbSurface hole | sdk handle-adapter | C-F2 | G consumer only |
| X-G15 | claim reclaim absent | `ticker.ts` | A automation-ticker | **G-F4** |
| X-G16 | boxGrade vs isBootstrapped | ec2-lifecycle | profile | **G-F5** |
| X-G17 | dotenv first-wins order | eval vs CLI/bench | shared | **G-F6** |
| X-G18 | dual startAutoSweep | session-registry-cmd | A global | **repaired**; see X-G20 |
| X-G19 | permission load silent-vs-warn | repl vs runtime-factory | F store | **G-F8** |
| X-G20 | registry mint split-brain | assembler metrics branch | P1-A-01 | **G-F16 — latent, producer 없음** |
| X-G21 | remote-runner empty seams | `cli/index.ts:100` | C-F6 registry | **G-F9** |
| X-G22 | headless advertised | remote-cmd HELP | C-F7 stub | **G-F10** |
| X-G23 | orgConfigDir null | session-setup + web authority | E-SKILL-01 | **G-F11** |
| X-G24 | userInput cancel vs turn abort | ws-handlers close-only | #88 | **G-F12** |
| X-G25 | pool lost:true unreachable | pool.ts throw-before-map | commands/pool | **G-F14** |
| X-G26 | eval unpriced as $0 | coverage-matrix + markdown | bench analyze/cost | **G-F15** |
| X-G27 | repo-rules warn drift | agent system.ts vs host/web | — | **G-F13** |

W1-G가 정의한 **X-G10 / X-G12 / X-G13 / X-G14는 이 표에서 빠짐** (X-G10=NamedEntry·X-G12=parseEnvFlag는 §6 인벤토리로 흡수, **X-G13 transcript-retention·X-G14 next-fire `_clock`은 이번 hole-check에서 재확인 안 함**). 이 표를 라이브 전수로 쓰지 말 것.

## 8. 검증 한계 (2차 후에도 안 한 것)

- 891파일 각각 컨슈머
- 깨진 `.mcp.json` 실기동, `MCP_USE_ISOLATED_SPAWN=1` 라이브 부트
- live docker/lima/`quanta remote`, EC2 ProMax 웜풀
- MetricsRegistry 켠 채 slash cleanup vs live Map
- process-kill armed ticker, dual-process dotenv
- 손상 permission store, `QUANTA_RADAR_FILE` mid-append
- 웹 turn-abort + pending `request_user_input` 실소켓
- eval null-cost fixture 테스트 (정적만)
- D26 전수 AgentEvent, biome complexity 재귀속
- CLI slash/keymap 전수 line-walk (remote/skill/config/mcp만 심층)

## 9. 다른 에이전트에게

1. 구현은 W3-I. 이 파일은 분류 dump.
2. **W1-G를 그대로 실행하지 말 것.** G-F2/G-F7은 `9b05cd33`에서 repaired.
3. G-F9/G-F10은 C-F6/C-F7과 한 불변식의 두 끝. G만 또는 C만 고치면 안 됨. G-F3도 C-F1과 동일.
4. G-F16은 P1-A-01과 한 불변식. assembler(G) vs registry(A).
5. G-F11은 E-SKILL-01과 한 불변식. `src/shared/**` / skill 본체는 E.
6. D21로 CLI/web 부트 합치지 말 것.
7. HEAD가 `9b05cd33`이 아니면 이 dump는 STALE.

## 10. Write set (G only, live open)

| ID | 허용 | 금지 |
|---|---|---|
| G-F1 | `apps/cli/internal.ts#loadMcpFeatures` **및** `daemon-mcp.ts` (수렴 방향 택1) | D21 부트 병합; A `loadMcpTools` 본문 |
| G-F3 | `mcp-composition.ts` factory | C `isolated-client.ts`; A plugin launcher |
| G-F4 | `scheduler/automation-engine/ticker.ts` | A `automation-ticker.ts` (W2-X 전) |
| G-F5 | `ec2-lifecycle.ts` + boxGrade 테스트 | observability 가격표; AMI 추측 |
| G-F6 | `apps/eval/index.ts` | shared env-files 정책을 G cleanup으로 |
| G-F8 | `repl.ts` warn | CLI만 fail-closed |
| G-F9 | `apps/cli/index.ts` seam factory | C registry를 G가 재작성 |
| G-F10 | `remote-cmd.ts` HELP 및/또는 `routeRemote` 차단 | stub 본체만 고치고 광고 방치 |
| G-F11 | `session-setup.ts`, `authority-readouts.ts` | E skill 본체; `src/shared/**` |
| G-F12 | `ws-handlers.ts` (+ optional `web-user-input-port.ts`) | protocol/kernel |
| G-F13 | `apps/agent/mode-presets/system.ts` warn | fail-open → fail-closed |
| G-F14 | `apps/bench/remote/pool.ts` + `pool/worker.ts` | auth/EC2 TTL |
| G-F15 | `eval/report/coverage-matrix.ts` + `markdown.ts` | `@/observability/pricing` |
| G-F16 | `agent-config-assembler.ts` 분기 | A `global.ts` / caller-owned-builder 재작성 as G |

### Test-owner map (coarse)

- `src/apps/cli/**` → `src/apps/cli/__tests__/**`, `tests/unit/apps/cli/**`, `tests/unit/cli/**`
- `src/apps/web-daemon/**` → `tests/unit/apps/web-daemon/**`, `*-web-daemon-e2e*`
- `src/apps/bench/**` → `tests/unit/apps/bench/**`, `tests/unit/bench*`
- `src/apps/eval/**` → `tests/unit/eval-*`
- `src/apps/agent/**` → `tests/unit/apps/agent/**`
- `src/host/**` → `tests/unit/host/**`
- `src/scheduler/**` → `tests/unit/scheduler-*.test.ts`
- 나머지 slice-boundary + `tests/unit/<slice>*`

### 레인 소유권

W1 G write 금지: `src/shared/**`, root-level tests, architecture configs, generated catalog MD, 다른 레인 production. 교차 import는 증거이지 write ownership이 아님.
