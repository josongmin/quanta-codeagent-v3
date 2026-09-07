# Sep-08 SE audit — agent-5 (lane C session dump)

> **Role:** Sep-07 SOLID/SE campaign **lane C** worker (this Cursor session).
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-C.md`](../../plans/sep-7-solid-se-audit/receipts/W1-C.md) (status **DONE**).
> **This file:** 세션에서 확인한 사실·finding·비재오픈·인벤토리·구멍. W3-I 티켓이 아님. 구현 권한 없음.

```text
AUDIT_ASSIGNMENT|lane=C|scope=mcp,lsp,protocol,ipc,connectors,integrations,remote,realtime
```

## 1. 세션이 한 일

Sep-07 dispatch pack의 **레인 C**만 수행함. 프로덕션 코드는 안 고침. 영수증만 씀.

- Exclusive production: `src/mcp`, `src/lsp`, `src/protocol`, `src/ipc`, `src/connectors`, `src/integrations`, `src/remote`, `src/realtime`
- W0 영수증 없음 → 코디네이터가 dirty shared checkout에 C를 던짐. C production은 HEAD와 동일. 언커밋 바이트는 완료 청구에 넣지 않음.
- 코디네이터 심층 점검 + 병렬 4워커. 워커 제보는 **HEAD 코드를 다시 읽고** 난 뒤에만 영수증에 넣음.
  - [MCP](07474b71-57a1-4550-8cf0-abed80132a96)
  - [LSP](1300a6f5-ac53-4900-8303-8da36d54824e)
  - [protocol+ipc](401fd7bd-7f37-485a-a2f9-966920e521b4)
  - [connectors+](94a3e86e-0971-4103-b551-af4317b61c8d)
- 1차 영수증 후 샤드 결과를 overlay로 합침 (C-F6…C-F12). 합친 뒤에도 grep-only 완료 청구 없음.

## 2. 스냅샷 (진실)

| Field | Value |
|---|---|
| HEAD = origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` (ahead/behind `0 0`) |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| 최초 untracked manifest SHA-256 | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` |
| W0 | **없음** |
| C production porcelain | **empty** (HEAD와 같음) |

C exclusive production 파일은 공유 checkout dirty 목록에 **없음**. 분류 바이트 = HEAD.

`docs/ARCHITECTURE.md` / `slice-boundary-configs.ts`는 HEAD≠WT. W2/W3 reserved. C는 dirty ARCHITECTURE를 소유 증명으로 쓰지 않음.

형제 레인 영수증(`W1-A`…`W1-H`)이 untracked 해시를 바꿈. 그건 프로덕션 STALE이 아님. W2-X는 **HEAD + tracked diff**로만 묶어야 함.

G 세션 dump (`agent-1.md`)의 **G-F3**는 이 세션 C-F1의 host 소비자와 같은 불변식임. 한 레인만 고치면 안 됨.

## 3. 커버리지

| Universe | Count |
|---|---:|
| C production `*.ts` (tests 제외) | **212** 전부 분류 |
| colocated `src/**/__tests__` | 14 |
| 휴리스틱 C 이름 테스트 | 291 (navigation set) |
| god-MODULE >1000 | 0 |
| cohort 900–999 | **0** |
| god-FUNCTION >150 (allowlist C 엔트리 0) | 0 confirmed |

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

Approaching-cohort (finding 아님): `mcp/client.ts` 888, `ipc/session/handle.ts` 880, `ipc/session/bridge.ts` 879, `lsp/adapters/base.ts` 850.

클러스터별 owner+consumer는 읽음. 212파일 전부 라인/역할 분류. **파일마다 컨슈머를 연 것은 아님** (아래 §8).

## 4. Finding 인덱스 (HEAD, 전부 open / pre-existing)

구현하지 않음. 권한 있는 write set은 W1-C §Exact proposed write sets.

| ID | Sev | 한 줄 | 재오픈 |
|---|---|---|---|
| C-F1 | P1 | `MCP_USE_ISOLATED_SPAWN` 파서만 있음. host factory는 항상 `new McpClient` | 신규 (G-F3 짝) |
| C-F6 | P1 | CLI `selectRemoteRunner(env, {})` — docker/lima seam 미주입 → 어댑터 죽음 | 신규 (#90의 미배선 실체) |
| C-F7 | P1 | `QUANTA_REMOTE_RUNNER=headless`는 seam 없이 `succeeded`/exit 0 | 신규 |
| C-F2 | P2 | `SessionVerbSurface`에 posture/skill/objective 없음. 커널·코덱은 받음 | Aug-25 #73; **D9 아님** |
| C-F3 | P2 | live `atomic-edit`는 EXDEV throw. `FileWriteStrategy`는 프로덕션 미배선 | Aug-25 #79; **D29 아님** |
| C-F4 | P2 | Isolated initialize: `capabilities:{}` + 다운그레이드 없음 | Aug-25 #67/#84 live |
| C-F5 | P2 | session stdio는 reader EOF 미구독. event-bridge stdio는 구독 | 신규 |
| C-F8 | P2 | inbound sampling 캡이 상수·카운터 둘 | 신규 |
| C-F9 | P2 | HTTP OAuth reauth가 carrier만 재건, MCP `initialize` 없음 | 신규 |
| C-F10 | P2 | webhook dedup은 1024-FIFO. eviction 후 재전달은 재발화 | 신규 |
| C-F11 | P2 | `decodeSessionEvent`는 type만 검사 후 캐스트. command는 fail-closed | 신규 |
| C-F12 | P3 | diagnostics waiter timeout 후 map prune 없음 | 신규 |

### C-F1 [P1] Isolated spawn 게이트 무효

- **파일:** `src/mcp/isolated-client.ts:56-64` `isolatedMcpEnabledFromEnv`. 모듈 주석·catalog `162-mcp-isolated-spawn.yaml`은 env=`1`/`true`/`yes`가 spawn을 바꾼다고 함.
- **소비자:** `src/host/**`, `src/apps/**`, `src/agent/mcp-bridge.ts`에 호출 **0**. `src/host/mcp-composition.ts:135` 항상 `new McpClient`.
- **유일한 Isolated 생성자:** `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:93` — 항상 isolated, env 무시. ADR-0338 default-OFF.
- **실패:** 연산자가 `MCP_USE_ISOLATED_SPAWN=1`을 켜도 5s spawn timeout / SIGTERM→SIGKILL가 host MCP에 안 붙음.
- **테스트:** `plugin-isolation-mcp-integration-hellgate`는 파서만. composition 브랜치를 지워도 GREEN.
- **write:** C는 `isolated-client.ts` 광고/팩토리. host factory는 G (G-F3). 한 불변식.

### C-F6 [P1] remote docker/lima seam 미주입

- **파일:** `src/remote/runner/registry.ts:62-76` — docker는 `dockerProcess` 없으면 `null`. lima는 process+vm 필요.
- **소비자:** `src/apps/cli/index.ts:100` `selectRemoteRunner(process.env, {})`.
- **실패:** `QUANTA_REMOTE_RUNNER=docker|lima` → `remote-not-configured`. 어댑터 코드는 있으나 유일한 소비자가 seam을 안 줌. apple-vz는 생성 후 `daemon-unavailable` (fail-closed-ish).
- **#90과의 관계:** CLI-only reader는 맞음. 이번 이슈는 **그 CLI가 seam을 안 넣는다**.
- **write:** seam factory는 G (`apps/cli`). C는 registry 계약만.

### C-F7 [P1] headless remote가 프로덕션 가짜 성공

- **파일:** `registry.ts:69-70` headless는 seam 불필요. `headless-stub.ts:93-103` `timeoutMs !== 0`이면 즉시 `succeeded`/exit 0, exec 없음.
- **소비자:** 같은 `routeRemote`.
- **실패:** docker/lima와 달리 `{}`로 선택 가능하고 “원격 성공”으로 보임. `RemoteRunner`보다 약한 구현.
- **realtime `createHeadlessStub`와 다른 파일.** D7 STT 쌍이 아님.
- **write:** `headless-stub.ts` / registry. skybridge lima와 합치지 말 것 (D24).

### C-F2 [P2] session.v1 verb surface 구멍

- **명령 12종** (`SESSION_COMMAND_TYPES`): posture.set / skill.set_enabled / objective.mutate / turn.submit 포함.
- **Verb surface 8그룹만** (`verb-surface.ts:55-101`). `buildWireVerbSurface` (`handle.ts:675-728`) 동일 subset. builders는 있음. kernel scheduler는 case 있음. codec은 그 셋 fail-closed.
- **`turn.submit`은 host-only 의도** (SDK capability). posture/skill/objective는 RFC 프론트도어인데 Handle에 없음.
- **D9 재오픈 아님.** D9는 있는 verb의 shape pin. 이 구멍은 pin이 못 잡음.
- **소비자:** `sdk/runtime/handle-adapter.ts`가 RuntimeSession을 VerbSurface에 핀 → in-process도 동일 구멍. CLI `/posture`·host projection이 우회.
- **write:** `verb-surface.ts` + `handle.ts`. kernel(D)·sdk(G)는 타입핀만.

### C-F3 [P2] LSP workspace commit 이중 authority + EXDEV

- **live:** `applyWorkspaceEditAtomic` (`atomic-edit.ts:113-131`) — rename 실패면 throw, 1..K-1 부분 커밋, tmp 잔류. `LspClient.applyWorkspaceEdit` (`base.ts:512`)만 탐.
- **dead:** `atomicFileWriteStrategy` — `src/` 호출 0 (정의 파일·테스트만). EXDEV copy+unlink는 **여기만**.
- **hellgate가 둘 다 고정:** applyWorkspaceEdit는 EXDEV throw를 **요구**. ATOMW-C11은 copy fallback을 **요구**. “strategy DI” 헤더는 `LspClient`에 strategy 주입이 없어서 거짓말.
- **D29 아님.** D29는 storage vs lsp 포트. 이건 intra-`@/lsp`.
- **write:** atomic-edit에 EXDEV 올리거나 LspClient를 FileWriteStrategy에 배선하고 dead sibling 제거. storage/atomic-write 금지.

### C-F4 [P2] Isolated initialize가 in-process보다 약함

- Isolated `initialize`: `capabilities: {}`, `host.call` 1회, 로컬 `pinNegotiatedVersion` 복사 (`isolated-client.ts:219-223,361-376`).
- In-process: `initializeWithDowngrade` + 주입 `CapabilityNegotiator` (`QUANTA_MCP_CAPS=full`이면 elicitation/tasks/sampling/roots).
- **실패:** plugin isolated 경로에서 strict 서버 버전 거절 = 영구 fail. full caps도 광고 안 됨. Isolated는 HTTP `url`+empty command도 throw (stdio-only, C-F4 인접).
- **#69 SSE !ok silent는 HEAD에서 수정됨** (`classifyStandaloneGetResponse` → `fireExit`). #67/#84는 isolated에만 남음.

### C-F5 [P2] session stdio EOF 미관측

- `ipc/session/transports/stdio.ts`는 `data`만. teardown = owner close / writer throw / frame cap. 주석이 ticket 02로 EOF를 미룸.
- 형제 `ipc/transports/stdio.ts`는 `end`/`close`/`error` 구독.
- spawn 자식은 `stdio-spawn.ts`가 exit를 봄. `serve --stdio` 직접 stdin은 안 봄.
- **실패:** 피어가 깨끗이 EOF 하면 waiter/`onClose`가 안 닫힘.

### C-F8 [P2] sampling in-flight 캡 둘

- `MAX_INBOUND_SAMPLING_IN_FLIGHT = 8` (`client/inbound-router.ts`) 후 `SAMPLING_MAX_IN_FLIGHT = 8` (`sampling/inbound-router.ts`). 카운터도 둘. 에러 문구 다름 (`-32000` vs decline).
- 오늘은 min=8이라 동작은 같음. 한쪽만 바꾸면 드리프트. 단일 authority 테스트 없음.

### C-F9 [P2] HTTP OAuth reauth가 initialize를 안 함

- `doReauthorize` (`client.ts:822-845`): invalidate → tokenFor → 새 carrier `start()` → 옛 close. `sendInitialize` 없음.
- HTTP-SSE session id는 initialize POST 응답에서 붙음. 새 transport는 `sessionId=null`.
- 기존 oauth hellgate는 합성 transport라 세션 헤더를 안 모델링함. stdio OAuth는 해당 없음.

### C-F10 [P2] webhook dedup 1024-FIFO 망각

- `makeBoundedSet` (`idempotency.ts:46-54`) cap 초과 시 oldest delete. durable `add`는 **신규 insert**에만 save — eviction+insert는 save 함. 결함은 persist skip이 아니라 **bounded forget**.
- 모듈 주석은 reboot 후 재전달을 막는다고 하고 cap 창은 안 씀.
- cap hellgate가 overflow 후 `has("d-0")===false`를 이미 보여 줌.

### C-F11 [P2] event codec 얕은 캐스트

- `decodeSessionCommand`은 turn.submit/posture/objective/skill 필드 assert.
- `decodeSessionEvent` (`codec.ts:238-244`)는 type ∈ union이면 `as SessionEvent`. mistyped payload가 correlator 맵을 오염할 수 있음 (command 코덱 주석이 그 클래스의 버그를 이름 붙임).

### C-F12 [P3] diagnostics waiter leak

- `diagnostics-hub.ts:31-38` timeout `settle`이 `diagnosticsWaiters`에서 uri를 안 지움. hang은 `settled`로 막힘. late publish가 leftover callback을 순회. 장세션 메모리.

## 5. 재오픈하지 않은 것

| ID | 이유 |
|---|---|
| D6 sanitizeMcpNameSegment | `mcp/naming.ts` SSOT. thin alias는 host/CLI |
| D9 SessionVerbSurface factory 병합 | 있는 verb의 shape pin은 살아 있음. 구멍은 C-F2로 **새** ID |
| D11 chatgpt vs MCP token store | 의도적 분리. mutex 드리프트 측정 없음 |
| D19 mcp vs lsp jsonrpc | 프레이밍 다름 (newline 10MB vs Content-Length 32MiB). `isJsonRpcEnvelope` shared |
| D20 JSONL durability | custom-3p는 snapshot rewrite. 다른 JSONL과 같은 append 계약 아님 |
| D24 skybridge vs remote/runner | `lima` vs `limactl`. lifecycle/policy 다름 |
| D25 pump-death | mcp stdio + lsp transport + plugin-isolation 상수. 같은 픽스처에서 judge 드리프트 재현 없음 |
| D29 storage vs lsp atomic | 포트 다름. intra-lsp EXDEV는 C-F3 |
| D30 token rotator vs MCP oauth mutex | rotator coalesce + MCP outer `inFlightToken` / `reauthInFlight` — documented layer |
| D7 voice→media STT | realtime voice-session ≠ media/stt. 양쪽 live 소비자 없음 |
| S8 mention first-line | C 범위 아님. HEAD 재현은 G-F2 |
| Aug-25 #69 SSE !ok silent | **수정됨** |
| Aug-25 #74 realtime web:full | default-OFF. CLI `/voice-live`만 |
| Aug-25 #87 OOB WS | 소비자 `web-daemon` = G. fingerprint X-C22만 |
| Aug-25 #104 portable vs envelope import | 스키마가 다름 (`quanta.session.portable` vs SessionExportEnvelope). mix 소비자 없음 |

워커가 P1로 올린 것 중 **기각/강등:**

- FileWriteStrategy “dead”는 C-F3에 흡수 (별 ID 아님).
- marketplace/jsonl/scheduler 프로덕션 미연결 = documented default-OFF → 인벤토리.
- REST outage host fallback = `mcp-connector-wire` (A/G). C rest-registry는 typed throw 유지.
- `REPO_SLUG_RE` integrations vs reactor = **오늘 바이트 동일**. 복사만으로는 finding 아님 (X-C21).

## 6. 인벤토리 (failure mode 없음 → finding 아님)

- SRP: 큰 클래스(`McpClient`, `LspClient`, `HttpSseMcpTransport`, handle/bridge)는 메서드 분할로 god-fn 게이트 아래.
- OCP: skybridge/remote registry 스위치는 어댑터 테이블.
- ISP: `SupervisableMcpClient` optional methods는 Isolated 정직한 생략.
- `ipc/session-import` → `saveSessionById`는 LAYER2 허용. portable ≠ envelope.
- default negotiator `{}` = `QUANTA_MCP_CAPS=full` 옵트인.
- webhook HMAC: empty secret false, 서버 부트 throw, empty map → mode `none` (single secret로 침묵 fallback 없음).
- token-refresh-scheduler는 rotator mutex만 호출. 자체 이중 write 없음. host `schedule()` 호출 0.
- `enforceMarketplacePolicy` / `createJsonlCustom3pRegistry` host caller 0.
- jsonl vs in-memory `validateEndpoint` 복사. `ProviderKind`는 지금 `mcp|llm`뿐.
- realtime outbound queue NOOP (WS 버퍼). 추측 슬로우는 W2-P.
- `QUANTA_LSP_MEM_BUDGET_MB`는 spawn-time `process.env`. knob inventory에 없음. runtimeConfig 이중읽기는 F 질문. lsp `envAllowFiles`에 transport/mem/rss 있음.
- protocol/integrations slice barrel 없음 (`requireSliceBarrel` omitted).
- Isolated HTTP-empty-command throw는 stdio-only 문서화. plugin `url`은 `ready: false`.
- 3× stdio 스택 (event-bridge / session / mcp JSON-RPC)은 프레이밍이 다름.

## 7. W2-X fingerprint (레인 교차)

전체 표는 W1-C `X-C1`…`X-C22`. 핵심만:

| ID | 요지 | 상대 레인 |
|---|---|---|
| X-C1 / C-F1 | isolated env 무시 | G `mcp-composition` (G-F3), catalog reserved |
| X-C2 / C-F2 | verb surface ⊂ command union | D kernel, G sdk handle-adapter |
| X-C3 / C-F3 | EXDEV commit | D storage/atomic-write는 D29로 분리 |
| X-C4 / C-F4 | isolated initialize | A plugin launcher |
| X-C5 / C-F5 | stdio EOF | G `serve --stdio` |
| X-C16 / C-F6·F7 | remote seams / headless | G `apps/cli/index.ts` |
| X-C10 | GH body policy twin | B `tool/gh/outbound-body-policy` |
| X-C21 | REPO_SLUG_RE 복사 | G reactor — 현재 동일 |
| X-C22 | OOB WS | G web-daemon — C write 금지 |
| X-C9 | portable vs envelope | D session/import-export |

## 8. 검증 한계 / 구멍

정적 전제. 아래는 **안 함**:

- 212파일 각각 컨슈머 추적
- `MCP_USE_ISOLATED_SPAWN=1` 라이브 MCP
- `quanta remote` 실실행
- 두 마운트 EXDEV
- `serve --stdio` EOF hang
- plugin-mcp-launcher가 CLI/web에 실제로 마운트됐는지
- HTTP 401 + 진짜 Streamable-HTTP session 헤더
- sampling storm
- GitHub 1024+ 재전달
- `lint:debt` complexity 점수
- 공식 god-fn AST 재실행 (allowlist에 C 없음으로 추정 GREEN)
- 291 heuristic 테스트 전수 실행
- Apple VZ / Lima 실기기
- web-daemon `@/realtime` import 0 재카운트 (#74)

## 9. 다른 에이전트에게

1. 구현하려면 W3-I 티켓. 이 파일/W1-C는 분류 영수증.
2. C production은 HEAD. 공유 checkout dirty는 C 밖.
3. `src/shared/**` 쓰지 말 것 (C write 금지).
4. D9/D19/D24/D29/D30으로 C-F*를 닫지 말 것.
5. C-F1과 G-F3는 한 불변식의 두 끝. host factory만 또는 isolated 주석만 고치면 안 됨.
6. C-F6 seam은 G CLI. C registry만 만지지 말 것.
7. FileWriteStrategy를 “프로덕션 파일 write 툴 경로”로 쓰지 말 것 — live ingress는 `applyWorkspaceEditAtomic`.
8. 다음 작업이 W0이면 이 스냅샷 해시와 맞춰라. HEAD가 바뀌면 이 dump는 STALE.

## 10. Write set 요약 (C only)

| ID | 허용 | 금지 |
|---|---|---|
| C-F1 | `isolated-client.ts` (게이트 정직 또는 팩토리) | `src/host/**`; catalog YAML; A plugin launcher (W2-X 전) |
| C-F2 | `verb-surface.ts`, `handle.ts` `buildWireVerbSurface` | kernel scheduler; sdk 본문 (타입핀 제외) |
| C-F3 | `atomic-edit.ts` ± `file-write-*.ts` wire-or-delete + hellgate | `storage/atomic-write.ts` |
| C-F4 | `isolated-client.ts` initialize/negotiator | plugin-isolation을 initialize 오너로 |
| C-F5 | `ipc/session/transports/stdio.ts` | event-bridge drop-invalid 정책 개조 |
| C-F6 | registry 계약만 | `apps/cli/index.ts` unless W2-X assigns G |
| C-F7 | `headless-stub.ts`, `registry.ts` | skybridge lima (D24) |
| C-F8 | 두 inbound-router, 상수 하나 | host sampling handler |
| C-F9 | `client.ts` `doReauthorize` | oauth provider impl (G) |
| C-F10 | `idempotency.ts` | none |
| C-F11 | `protocol/session/codec.ts` `decodeSessionEvent` | kernel event 생산자 |
| C-F12 | `diagnostics-hub.ts` | none |
