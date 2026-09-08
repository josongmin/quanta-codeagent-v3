# Sep-08 SE audit — agent-2 session dump (Lane F)

> **Role:** Sep-07 SOLID/SE campaign W1-F worker in this session.
> **Scope:** `src/auth`, `src/security`, `src/permission`, `src/config`, `src/capability`, `src/migration`
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-F.md`](../../plans/sep-7-solid-se-audit/receipts/W1-F.md)
> **Status:** classified, **not fixed**. Production code was not edited.
> **Date:** 2026-09-07 → 2026-09-08 (re-audit after HEAD advanced)

이 파일은 세션에서 확인한 사실의 덤프임. 구현 백로그가 아님. 161파일 TSV·핑거프린트 전문은 W1-F 영수증이 SSOT.

---

## 1. 스냅샷

W0 영수증은 세션 내내 없음.

### 1a. 최초 분류 (커밋 `0b14f5cf`, 지금은 ancestor)

검사는 **커밋된 HEAD만**. 당시 F production overlay가 dirty였음. S9 수리는 `0b14f5cf`의 **커밋된 트리에 없었음**(`engine.ts` L112가 여전히 lock-miss를 통과시킴). 다만 "SEP6 closeout이 그 SHA에서 S9를 고쳤다고 했다"는 서술은 커밋 이력으로 확인 불가 — `SEP6-P2-active-register.md`는 `0b14f5cf`에 **존재하지 않았고**(`9b05cd33`에서 추가), `sep-06-solid-se-audit.md`는 그 시점에 S9를 `still / fail-open`으로 적고 있었음. 그런 closeout은 언커밋 오버레이에만 있었음.

### 1b. 재검증 스냅샷 (이 덤프의 진실)

`9b05cd33` (`done`, 2026-09-08 01:05 +0900)이 origin/main. **같은 커밋이 최초 W1-F 영수증과 S9/classifier 수리를 같이 넣음.** 영수증 본문이 가리키던 `0b14f5cf`는 그 커밋 시점에 이미 거짓이 됨. 아래는 **재검증 HEAD**.

| 항목 | 값 |
|---|---|
| HEAD = origin/main | `9b05cd33b008b52bf54c9f2391070afcbfbaa8fe` |
| ahead/behind | 0 / 0 |
| staged | empty (`e3b0c442…`) |
| F production dirty | **없음** (overlay 흡수됨) |
| tracked diff (`git diff HEAD`) | 형제 문서만 dirty (팩트체크 시점엔 `agent-1/2/3/5.md` + `W1-A/B/D/F/H.md` 9개, 이 파일과 자기 영수증 `W1-F.md` 포함). **`src/`·`tests/`는 clean** |
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` |
| docs/ARCHITECTURE.md | git blob `b401ec63be34bf4ed69682374e4e648cc204edfc` (HEAD = WT). ※ 이 표의 다른 행은 파일 SHA-256 — 단위가 다름. 같은 파일의 SHA-256은 `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` |

**닫힘/부분닫힘 (이 HEAD 기준):** F-01 (S9 lock fail-closed + dirty restore) = 닫힘. F-02 = **부분** — nested `bash`/`sh -c` unwrap(depth 8, 실도달 ≤4)과 `process.env` interpreter-eval만 닫혔고, payload rule이 `t.length===1`이라 trailing 토큰 하나로 우회됨 (§F-02 참조).

병렬 재검증 샤드 (read-only; 코디가 HEAD에서 재검증 후 병합):

- [Audit auth+security](ae085dfa-ce11-4c5b-a2de-0f063b05e4a1) → F-04
- [Audit config+migration](6206b79b-4930-420e-b567-b060c90f00b1) → F-05
- [Audit permission+capability](93f231ef-0c5d-493b-ab2b-4f7114584647) → F-06 (F-01은 당시 HEAD에서 맞았으나 지금 닫힘)
- [Gap-hunt permission](6c4319ad-985e-4a51-964b-ef40d34d5d26) (HEAD `9b05cd33`)
- [Gap-hunt permission inspect (old SHA)](335b1bbf-b7dd-4ff8-87da-4e2c887c8995) — freeze `0b14f5cf`; 신규 P0–P2 없음. `inspect.ts`는 F-06 형제 아님. F-01은 그 freeze에서만 열림
- [Gap-hunt auth security](47acb6d4-8004-430d-ba9c-1c62b673e856) (HEAD `9b05cd33`)
- [Gap-hunt config migration](75f59e9f-30be-401c-a0f4-7c9266c9e6c6) (HEAD `9b05cd33`)
- [Gap-hunt auth security (old SHA)](6fcd0332-f7d4-4048-86d2-ebe9badc5498) — freeze `0b14f5cf`; F-02 형제는 F-07로 흡수. F-02 재오픈 안 함
- [Gap-hunt config migration (old SHA)](4adbb5d0-388e-44b5-a4fc-7a940db71e4a) — freeze `0b14f5cf`; MCP noop는 inventory. markdown 비원자는 F-13

---

## 2. 커버리지

| 항목 | 수 |
|---|---:|
| F-tree HEAD `*.ts` | 168 |
| colocated tests | 6 |
| `wasm-assets.d.ts` | 1 |
| **production 분류** | **161 / 161** |

슬라이스: auth 22, security 25, permission 63, config 28, capability 5, migration 18.

god-module `>1000` 없음. 900–999: `knob-inventory/extra.ts` **951** (구 960), `external-config/persist.ts` **914**. 함수 body `>150` 없음 — brace 스캔뿐 아니라 repo 정본 AST 검출기(`tools/god-code/detect.ts`)로도 확인(빈 allowlist, ratchet green).

---

## 3. 파인딩 (HEAD `9b05cd33`) — F-03…F-13 open, F-01 CLOSED / F-02 PARTIAL

규칙: 실패 모드 없는 SOLID smell은 inventory. duplicate는 두 live owner + PCC + 측정 드리프트 또는 dual-write race. SEP5/SEP6 재오픈은 문서화된 트리거가 이 HEAD에서 재현될 때만.

### F-01 [P1] CLOSED

`writeToDisk`는 lock miss 시 `{durable:false, reason:"cross-process lock unavailable"}` (`engine.ts:114-119`). 프로덕션 전 write 경로에서 도달 가능 — `@/permission` 안에 engine.ts 밖 `node:fs` writer가 없고 두 merge store 모두 `mergeWithDisk`를 넘김.

**단 hellgate 크레딧은 절반만:** `json-state-file-lock-clock-hellgate.test.ts`는 lock-miss `durable:false` + disk 불변만 핀함. `enqueueWrite`의 `dirty=true` 복구(`engine.ts:183`)는 **미핀** — 그 줄을 제거한 뮤턴트가 hellgate 4개 단언을 전부 통과함(baseline이 `null`이라 first-persist barrier가 가림). 복구 자체는 load-bearing으로 실측됨(제거 시 generation 유실 + `flushDurable`이 거짓 `durable:true` 반환).

### F-02 [P1] **PARTIAL** — nested unwrap만 닫힘 (잔여는 F-07, write-set 확장 필요)

닫힌 것 (bun 재현): `bash -c "bash -c printenv"` → `secret`. `node -e 'process.env'` → `secret`.

**닫히지 않은 것 (직접 실행 확인):** payload rule이 `["printenv", (t) => t.length === 1]`(`sensitivity-classifier.ts:182`)이라 **trailing 토큰 하나면 뚫림**.

| input | class |
|---|---|
| `bash -c 'printenv'` | secret |
| `sh -c 'printenv;'` | **public** |
| `bash -c 'printenv 2>&1'` | **public** |
| `bash -c 'printenv \| cat'` | **public** |
| `printenv \| grep KEY` | **public** |
| `true && printenv` | **public** |
| `sudo printenv` | **public** |

**overflow arm은 도달 불가:** `MAX_SHELL_UNWRAP_DEPTH = 8`(`:374`)인데 exported 진입점에서 실제로 도달하는 최대 `unwrapDepth`는 **4** (exhaustive 그래머 236k + hill-climb 1.6M + beam ~10⁶ 탐색). `9b05cd33`이 depth 1→8로 올리며 신설한 `:432` 분기는 dead guard이고 테스트 핀도 없음. 1차의 "overflow → secret"은 **철회**.

### F-03 [P2] `@/migration` 안 wx-lock 두 개, stale-reclaim 드리프트

| owner | 동작 |
|---|---|
| `persistence.ts` `appendImportLog` | wx + `DEFAULT_LOCK_STALE_MS` + dead pid reclaim. busy → `ImportLogBusyError`. hellgate 있음 |
| `external-config/ledger.ts` `recordDisposition` | wx, `EEXIST` → `false`. **age/pid reclaim 없음**. crash 후 lock 파일 영구 |

- **consumer:** `persistConvertedItems`가 ledger 실패를 `catch (() => false)`로 삼킴.
- **write set:** `ledger.ts` + persistence와 같은 reclaim hellgate. permission/auth lock 타입 공유 금지.

### F-04 [P2] 고아 `{key}.cas`가 ChatGPT refresh를 막음

- **owner:** `src/auth/node-lock-file-store.ts` `acquireCasClaim`: `EEXIST` → `null`. `compareAndSwap`는 null을 `"changed"`로 맵. unlink는 `finally`만.
- **consumer:** `createChatgptRefreshLock` → llm `chatgpt-oauth.ts` `refreshTokenTransaction`.
- **실패 모드:** `.cas` wx 이후 crash → 이후 CAS 전부 `"changed"`. lock JSON TTL로 못 고침.
- **write set:** `node-lock-file-store.ts` + planted-orphan RED. `writeToken` 약화 금지.

### F-05 [P2] Claude permission/hook 문자열 trim 드리프트

1. `config/loader.ts` `asStringArray` / `parseCommandHooks` — whitespace-only drop
2. `migration/external-config/convert.ts` `asStringList` — 아무 string이나 유지 (`"  "` 포함)
3. `migration/claude-config-decode.ts` `commandsOf` — string command trim 없음

- **경로 (1차 서술 정정):** convert → persist → `<cwd>/settings.json`에 공백 토큰이 **바이트 그대로** 기록됨. 단 `parseSettingsLayer`는 이 파일을 **안 읽음** — `discoverPaths`(`config/index.ts:70-73`)는 `<cwd>/.quanta/settings.json`과 user dir만 봄. 유일한 live reader는 `loadCommandHookBindings`(`apps/agent/index.ts:343`)이고 **거기 이미 동일 trim이 있음**(`agent/command-hooks/settings-loader.ts:48`). persist된 `permissions` 블록은 live reader **0**. ⇒ 소비자 영향 없음, 잔여는 쓰레기 바이트 + dead hook group.
- **SEP5 D5 재오픈 아님.** trim만 갈라짐.
- **write set:** decode canonical trim; convert 위임. `@/config` import 금지.

### F-06 [P3 / inventory] `explainResolution`이 `custom` host에서 live PEP와 갈림 — **live consumer 0**

- **inspector:** `explainHost`가 `hostAllowsMutation`. `custom` → fall-through `{outcome:"ask", source:"global-default"}`.
- **PEP:** `evaluateStack`는 `hostMutationVerdict` → `"defer"` → soft-deny.
- **라이브 CLI:** `/permission explain`은 `inspect.ts` (store-free **SHAPE**. 호스트 축을 평가하지 않음). F-06 형제가 아님 — 잘못된 어댑터가 아니라 다른 질문. `permission-explain.ts` “final verdict” 라벨 + `host X → custom` 표시만은 G honesty / X-pep. F write 아님.
- **도달성:** `getPermissionInspector`는 배럴(`permission/index.ts:132`) + `tests/unit/permission-inspector.test.ts`뿐이고 `src/sdk`에 미노출 — 프로덕션 소비자 **0**. §1의 규칙("실패 모드 없는 SOLID smell은 inventory")과 §4의 secretlint 처분(같은 사유로 inventory)에 맞추면 이건 **inventory**여야 함. P2 유지는 자기 규칙 위반.
- **테스트 정직성:** `permission-inspector.test.ts:193` `describe("inspector — agreement with evaluateStack")`가 바로 이 parity를 주장하지만 `read-only`/결정된 모드만 돌고 `custom`을 **한 번도 세팅하지 않음** — vacuous guard.
- **write set:** inspector를 `hostMutationVerdict`로. PEP를 inspector에 맞추지 말 것. CLI 라벨은 W2-X/G.

### F-07 [P1] command-shape 래퍼 argv0 정체성 — F-02 잔여 fail-open

`SHELL_WRAPPER_HEADS` / `SECRET_COMMAND_RULES` / `INTERPRETER_EVAL_HEADS`는 **exact first token**. `basename()`은 path 분류에만 있음 (`sensitivity-classifier.ts` L41–44 vs L184–188 / L429).

bun 재현 (`9b05cd33`):

| input | class |
|---|---|
| `bash -c "bash -c printenv"` | secret (F-02 닫힘) |
| `/bin/bash -c printenv` | **public** |
| `zsh -c printenv` / `dash` / `ksh` | **public** |
| `bash -xc printenv` | **public** (`-c`/`-lc` exact token만 unwrap. `-xc` 미매칭) |
| `bash --norc -c printenv` / `bash -lc printenv` | secret |
| `node -e 'console.log(process.env)'` | secret |
| `node -e 'console.log(process["env"])'` | **public** |
| `classifyCodeShape('console.log(process["env"])')` | secret |

- **consumer (5곳):** `tool/bash/index.ts:701` `classifySource`, `tool/bash/await.ts:90,157`, `tool/pty/tools.ts:82,84`, `tool/test-runner/index.ts:148`, `tool/container-exec/tool.ts:190` (전부 B, 증거만).
- **실패 모드:** 경로 붙은 bash / 대체 셸 / bracket env 접근 / **trailing 토큰이 붙은 payload**(`printenv;`, `printenv 2>&1`, `printenv | grep`, `sudo printenv`)가 Layer-1 `public`. 단 **Layer-2 format regex는 계속 동작** — `redactSecrets`는 `sourceClass === "secret"`일 때만 short-circuit이라(`redaction.ts:299-318`) `ghp_`/`AKIA` 같은 형식 인식 토큰은 잡히고, 형식 미인식 env 값만 모델/JSONL로 나감.
- **테스트:** nested bash + `process.env`만 핀. `/bin/bash`, zsh, `bash -xc`, `process["env"]` command 경로 RED 없음. `bash script.sh` → public은 **의도적 argv-shape 계약** (파일 IO 없음) — F-07 아님.
- **write set:** `sensitivity-classifier.ts` + unit test. head를 basename으로, 셸 집합 확장, interpreter-eval을 `classifyCodeShape`와 공유, **그리고 payload rule의 `t.length===1` 완화** — pipeline/compound/redirect/prefix(`printenv | grep`, `printenv 2>&1`, `true; printenv`, `sudo printenv`)가 전부 public이라 위 셋만으로는 안 닫힘. RED 필수. `src/tool/bash/**` 금지.

### F-08 [P2] OAuth callback timeout이 listener를 안 닫음

- **owner:** `cli-callback.ts` teardown은 `received.then`만. `browser-flow.ts` `Promise.race` timeout은 `received`를 settle/cancel하지 않음. 주석 L134–139는 timeout이 tear-down한다고 하지만 race 패는 `handle.received`를 reject하지 않음.
- **consumer:** `apps/cli/login-cmd.ts`.
- **실패 모드:** timeout 후 포트 `EADDRINUSE`. 첫 비-callback 요청은 `handled=true`로 promise를 미결로 둠.
- **write set:** `cli-callback.ts` / `browser-flow.ts` / `callback-port.ts` + lifecycle hellgate. `apps/cli` 금지 (G).

### F-09 [P2] permission lock steal ABA (S9 잔여)

- **owner:** `locking.ts` `LOCK_STALE_MS = 5000`. holder가 lock JSON `ts`를 refresh하지 않음. `releaseLock`은 누구 락이든 unlink.
- **실패 모드:** live write가 5s 넘으면 peer가 steal → 원 holder가 새 holder lock을 지움 → merge rename 경쟁으로 grant 유실. S9는 timeout fail-closed만 고침.
- **테스트:** hellgate가 live holder를 **외부 lock-body `ts` re-stamp**로 모델링 (`classifyHeldLock`은 body ts 우선, mtime은 unreadable 폴백). production holder는 그걸 안 함. 별도로 `tests/unit/permission/permission-store-concurrent-write-e2e-hellgate.test.ts`가 **실제 2-프로세스**(`Bun.spawn`)를 핀하지만 `LOCK_STALE_MS` 초과 steal은 미커버 — ABA RED의 기성 vehicle.
- **write set:** lease/token + heartbeat 또는 steal 시 owner 확인. engine + ABA hellgate.

### F-10 [P2] `settings.json` persist가 unlocked RMW

- **owner:** `persist.ts` `persistSettings`/`persistHooks`: read JSON → merge → `writeJsonAtomic` rename. 파일 lock 없음.
- **F-03과 별개:** F-03은 ledger sidecar. 이건 실제 설정 파일 last-write-WINS.
- **실패 모드:** 두 migrate 프로세스가 같은 스냅샷에서 permissions와 hooks를 각각 쓰면 한쪽 union이 사라짐.
- **write set:** `persist.ts` + concurrent persist hellgate. `@/permission` lock 공유 금지 (migration-local).

### F-11 [P2] malformed ledger entry가 `isThrottled`에서 throw

- **owner:** `ledger.ts` `loadMigrationLedger` L71–77: `version===1` + `entries`가 array이면 **엔트리 shape 없이** 통과. `isThrottled` L88 `e.sourceKey`.
- **실패 모드:** `{"version":1,"entries":[null]}` → TypeError. 문법 오류는 빈 ledger (fail-soft)인데 구조 손상은 크래시. **단 원소가 `null`일 때만** — `1`/`"x"`/`{}`/`{"disposition":"offered"}`는 무해. `recordDisposition`은 항상 정형 엔트리를 쓰고 tmp+rename이라 torn write도 불가 ⇒ **외부 손상/수작업 편집 경로 한정**.
- **write set:** `ledger.ts` + malformed-entry fixture.

### F-12 [P2] TrustStore 전체-map save 동시 갱신

- **owner:** `trust-store.ts` `flush`가 전체 map `persistence.save`. lock/merge 없음.
- **실패 모드:** `setUntrusted(X)` 뒤 다른 프로세스의 stale snapshot save가 X를 `trusted:true`로 부활 (fail-open resurrection). grant 유실도 가능.
- **write set:** `trust-store.ts` + cross-process hellgate. TrustScopeStore와 합치지 말 것.

### F-13 [P2] markdown/memory persist는 in-place `writeFile` — JSON만 atomic

- **owner:** `persist.ts` `writeNoClobber` L458–463 (`AGENTS.md` / rules); `persistMemory` L793 (`raw_memories.md`를 existing+block로 통째 rewrite).
- **JSON 경로:** `writeJsonAtomic` tmp+fsync+rename. crash면 original 유지, 다음 런 corrupt-refuse.
- **실패 모드 (범위 정정):** `AGENTS.md`는 **약한 절** — `writeNoClobber`는 파일이 이미 있으면 `AGENTS.imported.md`에 쓰고 `loadRepoRules`는 그 sibling을 안 읽음. 반면 `.quanta/rules/*.imported.md`는 `loadGlobRules`(`agent/glob-rules.ts:166-170`)가 **실제로 읽으므로** rules 절은 그대로 성립. 강한 절은 `persistMemory`: `writeFile(rawPath, existing + block)`은 append가 아니라 **truncate-rewrite**라 크래시 시 누적 evidence 전체가 날아감 — `:792` 주석의 "Append-only"는 오기.
- **F-10과 별개:** F-10은 두 프로세스 last-write-WINS. 이건 단일 프로세스 crash-torn bytes.
- **write set:** `writeNoClobber` / `persistMemory`를 JSON과 같은 tmp+fsync+rename. `@/storage` import 금지.

---

## 4. 채택하지 않은 샤드 주장

| 주장 | 처분 | 이유 |
|---|---|---|
| F-01 재오픈 | 기각 | `9b05cd33`에서 트리거 재현 안 됨 |
| F-02 재오픈 | **부분 기각** | nested/interpreter-eval은 닫혔으나 trailing-token 우회는 열려 있음 (F-07로 흡수) |
| inspect.ts가 F-06 형제 (호스트 custom 거짓말) | 기각 | store-free SHAPE. 호스트 미평가. [old SHA permission hunt](335b1bbf-b7dd-4ff8-87da-4e2c887c8995) |
| two-layer PEP dead (샤드 F-07) | inventory / X-pep | sdk `permissionProfileManager`는 publish되나 **read** consumer 없음. `profile-to-context`의 `permissionModeFromProfile`은 **live**(`host/runtime/agent-arg-builder/permission-profile.ts:168,179`) — barrel-only는 `approvalModeToContextMode`뿐. 미배선은 READ 측만 |
| trust deny가 positive를 veto 안 함 | inventory | hellgate가 deny+once_only 첫 hit `true`를 **핀**. deny는 ask-skip inert. 헤더 문구만 과함. persistent first-match는 X-trust |
| rereadForMerge corrupt→우리 state write | inventory | engine 주석이 의도적 peer-crash posture |
| bash git-write 우회 | X-git-shell | F helper 소유. 적용은 dispatch/bash (A/B) |
| `bash script.sh` public | 계약 | argv-shape only. 테스트가 public을 핀 |
| D28 readAuthority 공백 | inventory | live double-apply 없음. ratchet honesty는 W2-P |
| knob dual declaration | inventory / X-knob-read | SEP5 D27/D28 |
| ChatGPT persist swallow | W2-X lane E | F `writeToken`은 throw |
| RedisLockStub / JWKS/attest | inventory | live **Redis chain** 없음 (ChatGPT refresh는 `chatgpt-oauth.ts:293` → FileBasedLock으로 **live** — F-04의 소비자 사슬). stubs fail-closed |
| empty-key lock LSP | 기각 | live refresh key가 SHA-256 |
| D1 gitlab_pat vs gitlab-pat | 닫힘 | 타입명. catalog에 `gitlab-pat` 있음 |
| secretlint fail-soft | inventory | live consumer 없음 |
| EXDEV fallback | inventory | temp가 sibling이라 도달 불가 |
| extra.ts 951 = finding | inventory | 크기만으로는 실패 모드 없음 |
| MCP empty-allowlist no-op / untrusted `.mcp.json` spawn | inventory / X-mcp-policy | `mcp-governance.ts`·`resolveMcpLaunchPolicy`가 identity를 **문서화·핀**. `types.ts` “Trust-gated”는 settings `enabledServers` loosening drop (merge가 함). `.mcp.json` spawn은 별 경로. host가 G. permission에 2nd MCP filter 넣지 말 것. `enabledServers:[" "]` → trim drop → empty noop는 F-05 형제 |
| persist JSON RMW는 typical path가 단일 CLI | F-10 유지 | 두 `QUANTA_MIGRATE_CONFIG_IMPORT` 동시 LWW는 실패 모드. typical-path caveat는 proof_limit |
| D1 / empty-key / JWT-as-authz / revoke never-throw | 기각 | [old SHA auth hunt](6fcd0332-f7d4-4048-86d2-ebe9badc5498)와 동일. 새 실패 모드 없음 |
| `runImport` vs `importExternalConfig` | 다른 게이트 | session vs config |
| TrustStore vs TrustScopeStore merge | 금지 | path trust vs tool TTL |

---

## 5. 확인한 소비자 (PCC)

| owner | 실제 consumer |
|---|---|
| json-state-file engine + lock | permission-store, trust-scope-store, **`agent/sticky-model/fs-backed-store.ts:27` (locking만 재사용, 레인 A)** |
| classifyCommandShape | `tool/bash/index.ts:701`, `tool/bash/await.ts:90,157`, `tool/pty/tools.ts:82,84`, `tool/test-runner/index.ts:148`, `tool/container-exec/tool.ts:190` |
| classifyCodeShape | `tool/node-repl` (B) |
| runCapabilityProbe | `host/bootstrap/.../capability-probe.ts` (warn only) |
| refreshTokenTransaction | `llm/adapters/chatgpt-oauth.ts:293`, `apps/bench/remote/fresh-auth.ts:83` |
| createCliOAuthCallback / browser-flow | `apps/cli/login-cmd.ts:213`, `host/mcp-composition.ts:233`(callback)/`:311`(flow), `host/runtime/mcp-oauth-provider.ts:288`, `apps/bench/auth-pool/login.ts:159`, `apps/web-daemon/auth-routes.ts:137` |
| filterMcpServersByPolicy | `host/mcp-composition.ts` |
| TrustStore | CLI `configured-endpoint-wire.ts:88`; `host/mcp-composition.ts:471`; **`apps/agent/index.ts:357`(`~/.quanta/trust.json`)** |
| ledger recordDisposition / isThrottled | persistConvertedItems; `external-config/run.ts` |
| appendImportLog | `apps/cli/session-import-handler.ts` |
| node-lock-file-store CAS | chatgpt refresh-lock |
| convert/decode trim | persist → settings.json → loader parseSettingsLayer |
| getPermissionInspector | tests + barrel. CLI는 inspect.ts |
| inspectPermission | `apps/cli/permission-explain.ts` |

---

## 6. W2-X로 넘긴 지문

| ID | 요지 | F | 외국 |
|---|---|---|---|
| X-lock-wx | wx sidecar / stale reclaim | F-03 ledger; F-04 `.cas`; F-09 ABA; F-10 persist; F-12 TrustStore; permission acquireLock; auth FileBasedLock | storage atomic-write (D) |
| X-claude-trim | whitespace token keep vs drop | F-05 | agent command-hooks loader (A) |
| X-atomic-bytes | **fsync+rename**: private-file-atomic, persist writeJsonAtomic / **rename-only(fsync 없음)**: permission engine(`engine.ts:133-134`, fsync 0건) / markdown in-place (F-13) | 위 셋 | `@/storage` |
| X-secret-regex | redact vs detect vs PII | security 테이블들 | shared/trajectory (D1 closed) |
| X-path-canon | path alias collapse | TrustStore vs circumvention vs special-path-resolver | git (H) |
| X-trust | project path vs tool TTL; deny first-match | TrustStore vs TrustScopeStore | host/cli (G) |
| X-knob-read | inventory vs runtime-config vs raw env | knob-inventory + derive | shared/runtime-config |
| X-mcp-policy | launch allow/deny; empty allowlist identity vs types “Trust-gated” | mcp-governance + merge loosening drop | host `readMcpConfig` / `.mcp.json` spawn (G) |
| X-token-persist | refresh 후 disk 실패 swallow | writeToken throws | llm chatgpt-oauth catch (E) |
| X-pep | live PEP vs unused two-layer / inspector | evaluateStack | agent gate (A); CLI explain (G) |
| X-git-shell | git-write path fields only | git-write-guard | dispatch-guard + bash |
| X-oauth-listen | callback lifecycle vs flow timeout | F-08 | apps/cli login (G) |

`@/shared`에 정책 덤프하지 말 것.

---

## 7. 닫힌/의도적 경계 (이 레인)

- Auth PKCE / revoke / callback-port 타입: 두 번째 owner 없음. **lifecycle은 F-08**. **JWT decode는 예외** — F 레인 안에 2nd owner 있음 (`auth/chatgpt-oauth/jwt.ts:57 decodeJwtClaims`, 자체 base64url+throw vs `security/jwks-identity/default-client.ts:208 decodeJwt`, 자체 `b64urlDecode`+null). 닫힌 근거는 owner 부재가 아니라 jwks-identity의 live consumer 0.
- fail-closed-base hellgate (branch-only, `..` jail, empty writableRoots, custom host **helper 쌍** `hostMutationVerdict`/`hostAllowsMutation`)는 production helper와 맞음. PEP 자체의 핀은 `tests/unit/permission-host-custom-fail-closed-hellgate.test.ts`. inspector만 어긋남 (F-06).
- `managed-path.ts` vs `special-path-resolver`: 다른 invariant.
- `detector.ts` vs `external-config/detect.ts`: provider install vs config artifact.
- `runImport` vs `importExternalConfig`: session vs config.
- permission-store 파일과 trust-scope 파일은 경로가 다름.
- rereadForMerge corrupt → null → 우리 state write: peer-crash 의도.
- Circumvention: 문서화된 advisory FN.
- Headless attest/JWKS: fail-closed stub.
- Capability 4-cap seed: 데이터. master-OFF면 surface env가 권한.
- `bash script.sh` public: command-shape가 파일 내용을 안 읽음.

---

## 8. 미검증

- 두 프로세스 permission lock steal (F-09) 실실행. (단 `permission-store-concurrent-write-e2e-hellgate.test.ts`가 real 2-process 레일을 이미 갖고 있음 — `LOCK_STALE_MS` 초과 steal만 미커버)
- `/bin/bash -c printenv` → 실제 bash tool → 모델 envelope E2E (분류기는 재현함).
- F-10 / F-12 / F-13: 정적 판독만, 미실행.

**이후 라운드에서 실행 완료(해소):** ledger crash lock 재현(F-03, dead-pid lock → `recordDisposition` 영구 false, 형제 `appendImportLog`는 reclaim) · `.cas` orphan 주입(F-04, crash 다음 사이클부터 `lock-timeout` 영구화) · `"  "` allow-rule convert→persist→loader 런(F-05) · OAuth timeout 후 `EADDRINUSE` bind 재현(F-08).
- `explainResolution`을 쓰는 실제 UI (없음).
- JWKS/attest가 tests 밖 composition에 붙는지 (grep 부재만).
- lint-debt / cognitive complexity 수치.

---

## 9. 제안 write set (구현 시)

| ID | files | 메모 |
|---|---|---|
| F-01 | — | CLOSED on `9b05cd33` |
| F-02 | `src/security/sensitivity-classifier.ts` | **부분 닫힘.** nested unwrap/interpreter-eval만. payload `t.length===1` 우회 잔여 → F-07 write-set에서 같이 |
| F-03 | `src/migration/external-config/ledger.ts` + hellgate | `persistence.ts` reclaim 정책 |
| F-04 | `src/auth/node-lock-file-store.ts`, `tests/unit/auth/node-lock-file-store.test.ts` | stale `.cas` reclaim. planted-orphan RED |
| F-05 | `src/migration/claude-config-decode.ts`, `convert.ts` `asStringList`, whitespace fixture | loader trim과 맞출 것. `@/config` import 금지 |
| F-06 | `src/permission/inspector.ts`, `tests/unit/permission-inspector.test.ts` | `hostMutationVerdict`. custom host === evaluateStack |
| F-07 | `src/security/sensitivity-classifier.ts`, `tests/unit/security/sensitivity-classifier.test.ts` | basename head; zsh/dash/ksh; `/bin/bash`; `bash -xc`; `process["env"]` command ≡ code. RED: `/bin/bash -c printenv` 및 `bash -xc printenv` → secret |
| F-08 | `cli-callback.ts`, `browser-flow.ts`, `callback-port.ts`, callback lifecycle test | timeout/abort가 `received`를 settle하고 server.close. (§7이 `callback-port.ts`를 요구하는데 이 표에서 빠져 있었음 — `W1-F.md:300`에도 같은 누락) |
| F-09 | `locking.ts`, `engine.ts`, lock-clock hellgate | lease heartbeat 또는 steal owner check |
| F-10 | `external-config/persist.ts` + concurrent hellgate | settings.json RMW. permission lock 타입 공유 금지 |
| F-11 | `ledger.ts` + malformed-entry fixture | entries shape-filter |
| F-12 | `trust-store.ts` + cross-process hellgate | merge 또는 lock. TrustScope와 합치지 말 것 |
| F-13 | `persist.ts` `writeNoClobber` / `persistMemory` | tmp+fsync+rename. `@/storage` import 금지 |

W1/이 세션은 production을 고치지 않음.

---

## 10. 캠페인 맥락

- Lane A–H W1 영수증이 `docs/plans/sep-7-solid-se-audit/receipts/`에 있음. W0 / W2-X / W2-M / W2-P / W3-I는 이 세션에서 작성하지 않음.
- `9b05cd33`이 형제 레인 overlay(S9, classifier, HITL 등)를 커밋함. 최초 W1-F 본문은 그 커밋 안에서 자기 SHA를 잘못 가리킴 → 이 재검증이 정본.
- 구 W1-F write-set 표에서 F-05가 빠졌음. §9가 복구함.

---

## 11. 세션이 하지 않은 것

- production / test / catalog / git commit 수정 없음 (영수증 `W1-F.md`와 이 파일만 작성).
- `bun test` 스위트 전체 미실행. 분류기 갭만 bun으로 재현.
- W2-X 병합·티켓 미작성.
