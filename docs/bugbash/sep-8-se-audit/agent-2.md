# Sep-08 SE audit — agent-2 session dump (Lane F)

> **Role:** Sep-07 SOLID/SE campaign W1-F worker in this session.
> **Scope:** `src/auth`, `src/security`, `src/permission`, `src/config`, `src/capability`, `src/migration`
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-F.md`](../../plans/sep-7-solid-se-audit/receipts/W1-F.md)
> **Status:** classified, **not fixed**. Production code was not edited.
> **Date:** 2026-09-07 → 2026-09-08

이 파일은 세션에서 확인한 사실의 덤프임. 구현 백로그가 아님. 161파일 TSV·핑거프린트 전문은 W1-F 영수증이 SSOT.

---

## 1. 스냅샷

W0 영수증은 세션 내내 없음. dirty shared checkout. 검사는 **커밋된 HEAD만**.

| 항목 | 값 |
|---|---|
| HEAD = origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| ahead/behind | 0 / 0 |
| staged | empty (`e3b0c442…`) |
| tracked diff (`git diff HEAD`) | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` |
| docs/ARCHITECTURE.md **HEAD** | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| docs/ARCHITECTURE.md working tree | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` (dirty, 미사용) |

**핵심 프로세스 사실:** SEP6 closeout 문서는 이 HEAD SHA에서 S9가 고쳐졌다고 함. **커밋된 트리에는 S9가 없음.** 수리는 working-tree overlay.

### HEAD에서 제외한 F dirty overlay

| path | 비고 |
|---|---|
| `src/permission/json-state-file/engine.ts` | S9 fail-closed return + dirty restore |
| `src/permission/json-state-file/locking.ts` | 주석: timeout → typed failure |
| `src/security/sensitivity-classifier.ts` | unwrap depth 8, overflow secret, `classifyCodeShape` |
| `src/security/index.ts` | `classifyCodeShape` re-export |
| `src/config/knob-inventory/{const-keyed,extra,host}.ts` | knob overlay |
| `src/config/knob-schema/schemas/{bench-a,bench-gap-3,bench-loop}.ts` | bench schema overlay |
| `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts` | overlay는 `durable:false` / `"cross-process lock unavailable"` |
| `tests/unit/security/sensitivity-classifier.test.ts` | overlay는 nested bash / interpreter-eval secret |

완료 클레임에 overlay를 넣지 말 것.

---

## 2. 커버리지

| 항목 | 수 |
|---|---:|
| F-tree HEAD `*.ts` | 168 |
| colocated tests | 6 |
| `wasm-assets.d.ts` | 1 |
| **production 분류** | **161 / 161** |

슬라이스: auth 22, security 25, permission 63, config 28, capability 5, migration 18.

god-module `>1000` 없음. 900–999: `knob-inventory/extra.ts` **960**, `external-config/persist.ts` **914**. brace 스캔 기준 함수 body `>150` 없음.

병렬 샤드 (read-only, 영수증 미작성; 코디가 HEAD에서 재검증 후 W1-F에 병합):

- [Audit auth+security](ae085dfa-ce11-4c5b-a2de-0f063b05e4a1) → F-04 채택
- [Audit config+migration](6206b79b-4930-420e-b567-b060c90f00b1) → F-05 채택
- [Audit permission+capability](93f231ef-0c5d-493b-ab2b-4f7114584647) → F-01 확인, F-06 채택

---

## 3. 유지 파인딩 (HEAD, open)

규칙: 실패 모드 없는 SOLID smell은 inventory. duplicate는 두 live owner + PCC + 측정 드리프트 또는 dual-write race. SEP5/SEP6 재오픈은 문서화된 트리거가 이 HEAD에서 재현될 때만.

### F-01 [P1] Permission merge flush가 advisory lock 없이 write (SEP6 S9 트리거 재현)

- **owner (HEAD):** `src/permission/json-state-file/engine.ts` `writeToDisk`  
  `if (useLock) locked = await acquireLock(...)` 이후 snapshot / `rereadForMerge` / tmp write / `rename`이 **무조건** 진행.
- **enqueueWrite (HEAD):** write 전에 `dirty=false`. `{durable:false}`여도 dirty 복구 없음 → 실패 세대 재시도 불가.
- **locking.ts HEAD 주석:** timeout이면 caller가 best-effort write.
- **consumers:** `permission-store.ts` `mergeWithDisk` (`~/.quanta/permission-state.json`). `trust-scope-store.ts` 동일 엔진 (`grants.json`).
- **실패 모드:** 두 OS 프로세스가 lock timeout 후 같은 디스크 스냅샷에서 merge → 두 번째 rename last-write-WINS로 grant/denial 유실.
- **테스트 정직성:** HEAD `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts`가 fail-open을 **핀**함 (`flush proceeds lock-free`, `durable === true`). 구멍이 남아도 RED 안 됨. S9를 HEAD에 넣으면 이 테스트가 RED.
- **write set:** `engine.ts`, `locking.ts`(주석), lock-clock hellgate. overlay를 HEAD로 우기지 말 것.
- **금지:** `src/shared/**`. store 소비자는 엔진만 고치면 됨.

### F-02 [P1] Nested shell wrapper가 `public` (Layer-1 적색 실패)

- **owner (HEAD):** `src/security/sensitivity-classifier.ts` `MAX_SHELL_UNWRAP_DEPTH = 1`. depth 0에서 한 번만 unwrap. `bash -c "bash -c printenv"` → `"public"`. overflow fail-closed 없음.
- **consumer:** `src/tool/bash/index.ts` L701 `classifySource` → `classifyCommandShape`. container-exec도 동일 (lane B, 증거만).
- **실패 모드:** nested credential printer stdout이 `[REDACTED:source_class_secret]` 대신 모델/JSONL/distill로 들어감.
- **테스트:** HEAD는 1단 unwrap만 (`bash -c 'printenv'` → secret). nested 케이스 없음.
- **overlay:** depth 8 + overflow secret + `classifyCodeShape`. 스냅샷 밖.
- **write set:** `sensitivity-classifier.ts` + unit test. `src/tool/bash/**` 금지.

### F-03 [P2] `@/migration` 안 wx-lock 두 개, stale-reclaim 드리프트

| owner | 동작 |
|---|---|
| `persistence.ts` `appendImportLog` | wx + `DEFAULT_LOCK_STALE_MS` + dead pid reclaim. busy → `ImportLogBusyError`. hellgate 있음 |
| `external-config/ledger.ts` `recordDisposition` | wx, `EEXIST` → `false`. **age/pid reclaim 없음**. crash 후 lock 파일 영구 |

- **consumer:** `persistConvertedItems`가 ledger 실패를 `catch (() => false)`로 삼킴.
- **드리프트:** import-log는 stale+dead 후 회복. config throttle lock은 회복 없음. skip된 `imported` 마커 → 다음 런이 사용자 편집 settings에 다시 merge 가능 (corrupt는 refuse).
- **write set:** `ledger.ts` + persistence와 같은 reclaim hellgate. permission/auth lock 타입 공유 금지. `@/shared` generic lock dump 금지.

### F-04 [P2] 고아 `{key}.cas`가 ChatGPT refresh를 막음

- **owner:** `src/auth/node-lock-file-store.ts` `acquireCasClaim`: `EEXIST` → `null`. `compareAndSwap`는 null을 `"changed"`로 맵. unlink는 `finally`만. reclaim 없음.
- **mapping:** `FileBasedLock.tryReplaceExisting`: `"changed"` → `"would-wait"`.
- **consumer:** `createChatgptRefreshLock` → llm `chatgpt-oauth.ts` `refreshTokenTransaction` (8 backoff 후 `lock-timeout`).
- **실패 모드:** `.cas` wx 이후 crash → 이후 CAS 전부 `"changed"`. lock JSON TTL로 못 고침 (takeover도 CAS 필요). 운영자가 `~/.quanta/locks/*.cas` 지울 때까지 refresh 불가.
- **테스트:** happy-path에 `.cas` 안 남음만 단언. planted-orphan RED 없음.
- **write set:** `node-lock-file-store.ts` + unit test. `writeToken` 약화 금지.
- **W2-X:** persist-fail swallow은 `src/llm/adapters/chatgpt-oauth.ts` (lane E). F `writeToken`은 이미 throw.

### F-05 [P2] Claude permission/hook 문자열 trim 드리프트

세 parser:

1. `config/loader.ts` `asStringArray` / `parseCommandHooks` — whitespace-only drop (`trim().length > 0`)
2. `migration/external-config/convert.ts` `asStringList` — 아무 string이나 유지 (`"  "` 포함)
3. `migration/claude-config-decode.ts` `commandsOf` — string command trim 없음

- **경로:** convert → persist → `settings.json` union. 이후 `parseSettingsLayer`가 같은 토큰을 drop. 또는 matcher가 나중에 trim하면 whitespace 규칙이 load-bearing이 됨 (loader 주석 L58–65가 그 위험을 말함).
- **SEP5 D5 재오픈 아님.** D5는 MCP/hooks **decode SSOT**. trim 정책은 아직 갈라짐.
- **테스트:** entrypoint-parity는 valid fixture + error policy만. whitespace fixture 없음.
- **write set:** decode를 canonical trim으로, convert `asStringList`는 위임/삭제. `@/config`를 migration에서 import 금지. loader trim을 풀지 말 것.

### F-06 [P2] `explainResolution`이 `custom` host에서 live PEP와 거짓말

- **inspector:** `explainHost`가 `hostAllowsMutation` 사용. `custom` → `undefined` → null → `{outcome:"ask", source:"global-default"}`.
- **PEP:** `evaluateStack`는 `hostMutationVerdict`. `custom` → `"defer"` → **soft-deny fail-closed**. 주석이 boolean adapter를 쓰면 implicit allow 된다고 명시.
- **계약:** inspector 헤더가 `evaluateStack`과 observationally identical이라고 주장.
- **소비자:** barrel `getPermissionInspector`. 라이브 CLI `/permission explain`은 **`inspect.ts` `inspectPermission`**. `explainResolution`의 `src/apps`/`src/host` caller 없음. 현재 caller는 테스트.
- **테스트:** “every axis”가 `read-only` host만 핀. `custom` 0건. PEP `defer` 분기를 지워도 이 테스트 RED 안 됨.
- **write set:** inspector를 `hostMutationVerdict`로. PEP를 inspector에 맞추지 말 것.

---

## 4. 채택하지 않은 샤드 주장

| 주장 | 처분 | 이유 |
|---|---|---|
| knob dual declaration = 새 P2 | inventory / X-knob-read | SEP5 D27/D28 governed split. disjoint ratchet live. same-key runtime double-apply 없음 |
| `knob-read-authority-parity` orphan-runtime vacuous | 기각 | 해당 분기 없음. 테스트는 authority tag + duplicate만 |
| ChatGPT persist swallow | W2-X lane E | F `writeToken`은 throw. 고칠 곳은 adapter catch |
| RedisLockStub / FallbackLock fail-open | inventory | ChatGPT live path가 Redis를 안 씀 |
| JWKS/attest headless fail-open | 기각 | deny / cache-miss. composition consumer 테스트 밖 없음 |
| two-layer `canAccess`가 두 번째 PEP | inventory / X-pep | `profile-to-context.ts`가 FS pillar non-dispatch를 문서화. `getEffectiveAccess`가 admissibility에 없음 |
| git-write-guard가 shell `command`를 안 봄 | X-git-shell | F owner는 path helper. 적용 공백은 dispatch-guard (A) / bash (B) |
| extra.ts / persist.ts 900대 = finding | inventory | 크기만으로는 실패 모드 없음 |
| knob-schema “not wired” 주석 | P3 honesty inventory | `bench.ts`는 `ALL_BENCH_SCHEMAS`에서 derive. leaf ratchet은 유지 |
| D1 redaction vs trajectory vs scanner | 닫힘 유지 | fence-split + parity hellgate. 새 HEAD 재현 없음 |
| D2/D30 ChatGPT lock 미사용 | 닫힘 유지 | live adapter가 `refreshTokenTransaction` + `FileBasedLock` 호출 |
| D5 decode 이중 | 닫힘 유지 | `claude-config-decode.ts` SSOT. F-05는 trim만 |
| D10 thread decode | 닫힘 유지 | `thread-permission-decode.ts` |
| capability observe-only dual gate | inventory | master-OFF면 probe `[]`. writable owner는 env 하나 |
| TrustStore vs TrustScopeStore merge | 금지 | path trust vs tool TTL grant. 다른 계약 |

---

## 5. 확인한 소비자 (PCC)

| owner | 실제 consumer |
|---|---|
| json-state-file engine + lock | permission-store, trust-scope-store |
| classifyCommandShape | `tool/bash/index.ts` classifySource; container-exec |
| runCapabilityProbe | `host/bootstrap/.../capability-probe.ts` (warn only) |
| refreshTokenTransaction | `llm/adapters/chatgpt-oauth.ts`; `apps/bench/remote/fresh-auth.ts` |
| filterMcpServersByPolicy | `host/mcp-composition.ts` |
| TrustStore | CLI configured-endpoint-wire; host mcp-composition |
| ledger recordDisposition | persistConvertedItems |
| appendImportLog | `apps/cli/session-import-handler.ts` |
| node-lock-file-store CAS | chatgpt refresh-lock |
| convert/decode trim | persist → settings.json → 이후 loader parseSettingsLayer |
| getPermissionInspector | tests + barrel. CLI는 inspect.ts |
| inspectPermission | `apps/cli/permission-explain.ts` |

---

## 6. W2-X로 넘긴 지문

| ID | 요지 | F | 외국 |
|---|---|---|---|
| X-lock-wx | wx sidecar / stale reclaim 유무 | F-03 ledger vs persistence; F-04 `.cas`; permission acquireLock; auth FileBasedLock | storage atomic-write (D) |
| X-claude-trim | whitespace token keep vs drop | F-05 | agent command-hooks loader (A) |
| X-atomic-bytes | fsync+rename 클론 | private-file-atomic, persist writeJsonAtomic, permission engine | `@/storage` |
| X-secret-regex | redact vs detect vs PII vs trajectory | security 테이블들 | shared/trajectory (D1 closed) |
| X-path-canon | path alias collapse | TrustStore vs circumvention vs special-path-resolver | git (H) |
| X-trust | project path vs tool TTL | TrustStore vs TrustScopeStore | host/cli (G) |
| X-knob-read | inventory vs runtime-config vs raw env | knob-inventory + derive | shared/runtime-config |
| X-mcp-policy | launch allow/deny | mcp-governance | host mcp-composition |
| X-token-persist | refresh 후 disk 실패 swallow | writeToken throws | llm chatgpt-oauth catch (E) |
| X-pep | live PEP vs unused two-layer / inspector | evaluateStack | agent gate (A) |
| X-git-shell | git-write path fields only | git-write-guard | dispatch-guard + bash |

`@/shared`에 정책 덤프하지 말 것. shared owner는 pure, fence-legal, 소비자 ≥2.

---

## 7. 닫힌/의도적 경계 (이 레인)

- Auth PKCE / JWT decode / revoke / callback / browser-flow-error: 두 번째 owner 없음.
- fail-closed-base hellgate (branch-only, `..` jail, empty writableRoots, custom host **PEP**)는 production helper와 맞음. inspector만 어긋남 (F-06).
- `managed-path.ts` vs `special-path-resolver`: OS managed-settings path vs profile special-path. 다른 invariant.
- `detector.ts` vs `external-config/detect.ts`: provider install vs config artifact.
- `runImport` vs `importExternalConfig`: session vs config. 다른 게이트.
- permission-store 파일과 trust-scope 파일은 경로가 다름. 같은 엔진, dual-write 같은 파일 아님.
- `rereadForMerge` corrupt → null → 우리 state write: peer-crash 의도.
- Circumvention: 문서화된 advisory FN.
- Headless attest/JWKS: fail-closed stub.
- Capability 4-cap seed: 데이터. master-OFF면 surface env가 권한.

---

## 8. 미검증

- 두 프로세스 permission lock race 실실행 (HEAD fail-open은 static+테스트 텍스트).
- nested `bash -c` → 실제 bash tool → 모델 envelope E2E.
- ledger crash lock 심기 후 persist 재실행.
- `.cas` orphan crash injection.
- `"  "` allow-rule convert → persist → loader 런.
- `explainResolution`을 쓰는 실제 UI (없음).
- `shell/assess` vs bash permission vehicle 전부.
- JWKS/attest가 tests 밖 composition에 붙는지 (grep 부재만).
- lint-debt / cognitive complexity 수치.
- overlay 동작 (범위 밖).

---

## 9. 제안 write set (구현 시)

| ID | files | 메모 |
|---|---|---|
| F-01 | `src/permission/json-state-file/engine.ts`, `locking.ts`, `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts` | lock 실패 시 write 금지. newest failed generation dirty 복구 |
| F-02 | `src/security/sensitivity-classifier.ts`, `tests/unit/security/sensitivity-classifier.test.ts` | nested unwrap + overflow secret. RED: `` bash -c "bash -c printenv" `` → secret |
| F-03 | `src/migration/external-config/ledger.ts` + hellgate | `persistence.ts` reclaim 정책. permission lock 공유 금지 |
| F-04 | `src/auth/node-lock-file-store.ts`, `tests/unit/auth/node-lock-file-store.test.ts` | stale `.cas` reclaim. planted-orphan RED |
| F-05 | `src/migration/claude-config-decode.ts`, `convert.ts` `asStringList`, entrypoint-parity whitespace | loader trim과 맞출 것. `@/config` import 금지 |
| F-06 | `src/permission/inspector.ts`, `tests/unit/permission-inspector.test.ts` | `hostMutationVerdict`. custom host === evaluateStack |

W1/이 세션은 production을 고치지 않음.

---

## 10. 캠페인 맥락 (세션에서 본 것)

- Lane A–H W1 영수증이 모두 `docs/plans/sep-7-solid-se-audit/receipts/`에 생김. W0 / W2-X / W2-M / W2-P / W3-I는 이 세션에서 작성하지 않음.
- 다른 레인도 같은 패턴: SEP6 closeout이 이 HEAD SHA를 고친 것으로 적었지만 **수리는 dirty overlay**. 예: lane B DAP N12, lane E HITL N7, lane G mention S8 / session-registry sweep.
- W1-A는 dirty A 파일을 working tree로 본다고 적음. F는 **HEAD-only**. W3-I가 스냅샷 정책을 통일해야 함.
- W1-F write-set 표에서 F-05 행이 영수증 후반에 빠짐. 이 덤프 §9가 정본.

---

## 11. 세션이 하지 않은 것

- production / test / catalog / git commit 수정 없음 (영수증 `W1-F.md`와 이 파일만 작성).
- `bun test` / typecheck / test:ci 미실행. 증거는 static owner+consumer.
- W2-X 병합·티켓 미작성.
