# Sep-08 structural remediation — 39 findings / 16 work packages

상태: **W1·W2 implemented on local `main` (`29d7e4ff1`). W3+ 미착수. W7 `verified` 39/39는 아님.**

실행 체크리스트: [ACTIONS — 39건의 근거·수정·제거·실패 rail](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/ACTIONS.md). 이 README는 구조/소유권을, ACTIONS는 finding별 실행과 완료 증거를 관리한다.

실행 배정: [WAVES — W0–W7 disjoint 분할](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/WAVES.md). 정확한 wave/group/write-set 원본은 같은 디렉터리의 `waves.json`이다.

## 1. 기준과 목표

- Plan baseline HEAD: `f5f4875799141068af73e604129c8b9a09f76007`.
- Integrated source (W1+W2): `29d7e4ff1` on local `main`.
- 입력: `docs/bugbash/sep-8-se-audit/agent-1.md`부터 `agent-7.md`까지 현재 재검증본. **39건 = P1 7 / P2 27 / P3 5**.
- 입력 digest: `769530ddf9d76b68bdfdf740771155bd2b255a79c9319516956283469bbedba8`. SHA-256, 번호순으로 각 repo-relative path + NUL + 원문 bytes + NUL을 누적.
- 작성 시 dirty: 위 audit 문서 7개. 제품 소스 변경 없음. 향후 worktree에 HEAD만 전달하면 이 입력 문서들은 누락된다. 착수 시 정확한 문서 snapshot도 전달한다.
- 근거의 상세 `path:line`은 입력 문서에 유지한다. 아래 소스 경로는 현재 owner이며, 새 타입·모듈명은 **제안**이다.
- 목표는 패치 개수 최소화가 아니라 **하나의 불변식에 하나의 결정권자, 모든 production consumer의 동일 계약 사용, 실패 시 사실에 맞는 결과**다.
- **구현 상태 (2026-09-08):** W1(R01/R04/R09)과 W2(R05/R13/R11)는 local `main` `29d7e4ff1`에 통합됨. G-F5.4는 열린 갭. W3+·W0.3–W0.4·W0.6 R10 half는 미착수. W7 `verified` 39/39는 아님. audit `agent-*.md`는 이 HEAD의 closeout이 아니다.
- 철회·미입증·inventory 항목은 재도입하지 않는다. 특히 C-F5 EOF wiring은 작업 대상이 아니다. 아래 구현 전제 검토는 새로운 확정 finding 추가가 아니다.

## 2. 설계 원칙과 금지선

1. 기존 authority를 먼저 확장한다. `priceUsage`, `McpTransport`, scheduler `claimToken`, dataset profile, env loader, LSP availability를 두 번째 구현으로 대체하지 않는다.
2. 공통화는 순수 계약/알고리즘 또는 좁은 I/O adapter까지만 한다. auth CAS, permission merge, migration best-effort, session resume 정책을 하나의 universal store/service로 합치지 않는다.
3. 라이브러리 간 금지 import는 composition root의 local port 주입으로 푼다. fence의 판정 원본은 `tests/unit/_arch/slice-boundary-configs.ts`와 Biome 설정이다. `shared`에 filesystem/env/정책을 몰아넣거나 app 모듈을 library에서 import하지 않는다.
4. 오류를 `null`, `[]`, `$0`, `ready`, `unchanged`로 바꾸지 않는다. 정상적인 missing/no-hit/no-finding과 failed/corrupt/unknown을 분리하고, 호출자가 실제로 분기하게 한다.
5. DTO만 추가하고 예전 경로를 남기지 않는다. 작업마다 **지울 구현**을 명시한다. 필요한 public compatibility wrapper는 새 owner에만 위임하고 자체 판단·캐시·프로토콜 state를 갖지 않는다.
6. touched god-module/function은 같은 작업에서 cohesive하게 분리한다. 1,000-line module / 150-line function / 900–999 cohort / lint debt ceiling을 올리지 않는다. 분리 목적은 행수 이동이 아니라 책임 경계다.
7. 기존 기능을 끄거나 feature-catalog claim만 낮춰 P1을 닫지 않는다. 구현 불가면 `blocked`와 제한을 기록한다. 지원 범위 변경은 별도 제품 결정이다.

## 3. 전체 coverage / 단일 owner

각 finding은 아래 한 작업에서만 닫는다. 번호는 실행 순서가 아니다.

| Finding | Sev | Package | 고정할 계약 |
|---|---|---|---|
| F-07 | P1 | R01 | command-shape 변형에도 source sensitivity 유지 |
| SEP7-D-11 | P2 | R01 | stdout free text가 redaction 경계를 우회하지 않음 |
| F-03 | P2 | R02 | migration crash 후 lock 복구 |
| F-04 | P2 | R02 | auth CAS crash 후 복구 및 single winner |
| F-09 | P2 | R02 | live lock 비탈취 및 ABA-free release |
| F-10 | P2 | R02 | settings/hooks RMW 원자성 |
| F-12 | P2 | R02 | 동시 explicit trust grant 보존 |
| F-13 | P2 | R02 | rewrite 실패 시 기존 문서 bytes 보존 |
| F-11 | P3 | R02 | malformed ledger entry로 startup 중단 금지 |
| SEP7-D-05 | P2 | R03 | delete 완료 후 stale save 부활 금지 |
| SEP7-D-06 | P2 | R03 | index 손상이 snapshot 발견 가능성을 파괴하지 않음 |
| SEP7-D-07 | P2 | R03 | corrupt/unreadable snapshot을 fresh resume로 취급 금지 |
| SEP7-D-10 | P2 | R03 | unrelated memory update가 raw embedding을 변경하지 않음 |
| H-PATCH-01 | P1 | R04 | unified rename의 경로/내용 의미 보존 |
| H-PATCH-02 | P2 | R04 | rollback 완료 여부를 실제 disk 결과와 일치시킴 |
| H-SA-02 | P1 | R05 | backer에 무관한 cadence/lifetime/wake 계약 |
| H-SA-01 | P2 | R05 | no-finding/error를 finding으로 게시 금지 |
| G-F4 | P2 | R06 | durable claim의 안전한 restart recovery |
| G-F12 | P2 | R07 | turn abort가 해당 input request를 즉시 settle |
| F-08 | P2 | R07 | OAuth 종료의 모든 경로에서 callback listener 해제 |
| P2-A-02 | P2 | R08 | transient negative probe 재시도 가능 |
| P2-A-05 | P2 | R08 | transient null/rejected open 재시도 가능 |
| C-F12 | P3 | R08 | timeout waiter 개별 제거 |
| P1-A-02 | P1 | R09 | 같은 usage의 pricing/enforcement 정책 단일화 |
| G-F15 | P2 | R09 | 미측정 비용을 무료로 표시 금지 |
| E-SEARCH-01 | P2 | R10 | explicit backend 실패를 실제 consumer에 전달 |
| E-EMBED-01 | P2 | R10 | index/query embedding space 동일성 |
| C-F1 | P1 | R11 | production MCP isolation flag 실제 선택 |
| C-F9 | P2 | R11 | HTTP auth 교체 후 새 MCP session handshake |
| C-F2 | P2 | R12 | 공개 command surface의 명시적 완전성 |
| C-F11 | P2 | R12 | 모든 session event payload 검증 |
| G-F5 | P1 | R13 | bootstrap/readiness의 동일 family profile |
| G-F9 | P1 | R14 | CLI remote backend 선택이 실제 adapter에 연결 |
| E-PROV-01 | P2 | R15 | effective transport와 diagnostics 일치 |
| G-F6 | P2 | R15 | entrypoint env precedence 일치 |
| E-KNOB-01 | P3 | R15 | runtime/bench boolean 의미 일치 |
| G-F11 | P2 | R16 | CLI/web org skill authority 입력 배선 |
| G-F8 | P3 | R16 | permission fail-soft 전환 관측 |
| G-F13 | P3 | R16 | repo-rules fail-open 전환 관측 |

## 4. 작업별 구조와 실패 rail

### R01 — Security classification과 출력 경계

- **Owner/write set:** `src/security/sensitivity-classifier.ts`, `src/stream/adapters/stdout.ts`, 해당 classifier/stdout 및 실제 tool-output tests. 각각 source 판정과 presentation redaction을 소유하며 두 slice를 합치지 않는다.
- **설계:** executable basename, shell option, compound/redirect/prefix 구조를 정규화한 뒤 공통 code-shape 판정으로 연결한다. 지원 shell grammar를 명시한다. 파싱 불가의 의심스러운 env/interpreter 구조를 public으로 단정하지 않고 기존 sensitivity 계약에 맞춰 보수적으로 처리한다. shell 전체를 regex 목록으로 재구현하지 않는다.
- **출력:** stdout free-text 경계에서 `redactStr` → `oneLine` 순서를 통일한다. 이미 분류된 tool source metadata는 모델/JSONL 전달까지 보존한다. format scrubber만으로 임의 env secret 보호를 주장하지 않는다.
- **제거:** raw first-token 기준의 별도 shell/interpreter 규칙, 두 progress field의 unsanitized renderer.
- **RED → GREEN:** `/bin/bash`, `zsh`, `-xc`, redirect, pipeline, bracket env 접근의 audit 재현 + benign controls. 형식상 secret처럼 보이지 않는 synthetic env value가 실제 bash/PTY/tool output → 모델·JSONL에 남지 않는 경로 테스트. stdout progress 두 종류에는 인식 가능한 synthetic token을 주입한다. 실제 credential은 사용하지 않는다.

### R02 — Crash-safe 파일 transaction, 정책은 domain-local

- **Owner/write set:** `src/auth/node-lock-file-store.ts`, `src/permission/json-state-file/locking.ts`, `src/migration/external-config/{ledger,persist}.ts`, `src/config/trust-store.ts`; trust persistence root `src/apps/agent/index.ts`는 integrator가 배선한다.
- **선행 결정 R02a:** 지원 OS/local filesystem에서 stable lock inode의 **OS descriptor lock**을 사용하는 작은 adapter가 구현 가능한지 먼저 검증한다. holder 종료 시 OS가 해제하고 정상 release에서 lock pathname을 unlink하지 않는 방식을 우선한다. 현재 설치 의존성만으로 사용 가능한 cross-platform primitive는 확인되지 않았으므로 이 선택은 feasibility gate다. native 의존성/지원 OS 변화는 명시적 설계 승인을 거친다. 검증되지 않으면 lock-dependent 변경을 막고 대체 primitive를 결정한다. F-11 entry validation과 독립 atomic-byte-preservation rail은 먼저 진행할 수 있다. 시간 초과만으로 lock을 훔치는 fallback은 금지한다.
- **기존 구현을 그대로 재사용하지 않는 이유:** session-resource-registry의 file lock도 `wx`/mtime 기반이므로 이름이나 기존 테스트만으로 OS lock/ABA 안전성을 입증하지 않는다. token을 읽고 동일하면 `unlink`하는 것도 check→unlink 경쟁을 닫지 못한다. heartbeat만 추가하는 방식도 충분하지 않다.
- **계약:** `withExclusiveFileTransaction(path, signal, fn)`에 해당하는 좁은 port를 domain-local로 주입한다. resource identity/path normalization, bounded wait, reentrancy 금지 또는 명시적 정책, error outcome을 정한다. auth generation CAS / permission delta merge / migration throttle 판단은 각 owner에 남긴다.
- **R02b persistence:** lock 안에서 re-read → validate → explicit delta merge → same-directory temp → file sync → atomic rename. filesystem failure/dir-sync 지원 여부를 결과에 보존한다. `EXDEV`를 copy로 숨겨 atomic 성공 처리하지 않는다. file mode, auth 0600, symlink/path 정책을 보존한다. 기존 `src/auth/private-file-atomic.ts`는 auth-local이고 library fence를 넘어 직접 공용화하지 않는다. 설치된 `write-file-atomic`도 cross-process RMW lock을 대신하지 않는다.
- **R02c domain 적용:** auth CAS single-winner; settings와 hooks는 같은 settings resource lock; trust는 stale 전체 Map 대신 해당 instance의 dirty mutations만 재적용; raw memory append-RMW도 같은 대상 lock 안에서 atomic replace. ledger entry는 element별 validate하고 valid subset/fail-soft diagnostic을 반환한다. malformed 원문을 진단 불가능하게 덮어쓰지 않도록 보존 정책을 정한다.
- **호환:** 기존 `.cas`/`.lock` 포맷과 새 lock이 서로 다른 임계구역을 만들 수 있다. 첫 전환은 관련 writer 종료를 요구하거나 양 버전이 공유하는 검증된 migration 절차를 사용한다. live legacy holder를 age로 제거하지 않는다. 기존 orphan은 old writer 부재가 확인된 전환에서만 정리한다.
- **제거:** 이 finding 경로의 세 독립 wx/stale-release 구현, unlocked settings/hooks RMW, trust whole-map overwrite, live markdown in-place rewrite. 다른 lock들을 무증거로 전부 교체하지 않는다.
- **RED → GREEN:** **서로 다른 OS process** barrier로 live holder >5초 비탈취, kill 후 재획득, old release가 successor에 무영향, CAS 한 winner, distinct grant/settings union. 각 write/sync/rename failure injection에서 old bytes 또는 완전한 new bytes만 남음. memory 누적 block 보존, temp 정리, null/scalar ledger fixture 포함. process-local Promise 테스트로 대체 불가.

### R03 — Session 원본/인덱스 분리와 field-local memory update

- **Owner/write set:** session 하위 작업은 `src/session/{store,index-store}.ts`와 `src/sdk/runtime/session/rehydrate.ts`; memory 하위 작업은 `src/memory/adapters/sqlite.ts`. 두 작업의 정책/저장 abstraction은 합치지 않는다.
- **Session mutation:** save/delete를 같은 per-session queue로 통과시키고 terminal delete 이후 old autosave를 generation fence로 거부한다. 단순히 현재 queue 뒤에 delete를 넣는 것만으로 늦게 도착한 stale producer까지 막았다고 하지 않는다. 정당한 재생성은 새 generation/명시적 create에 한정한다. queue 안에서 그 queue를 기다리는 flush를 await하지 않는다.
- **읽기:** `found | missing | corrupt | unreadable` 결과를 snapshot boundary에서 만들고 durable resume는 missing만 기존 empty 정책으로 처리한다. corrupt/unreadable은 `ResumeRehydrateRefusedError`와 복구 대상 경로를 전달한다. valid empty transcript는 계속 허용한다.
- **인덱스:** snapshot을 원본, index를 재구축 가능한 projection으로 정한다. invalid row 발견 시 원문 보존/진단 후 valid snapshot에서 복구하고 atomic replace한다. snapshot commit와 index update 사이 crash도 다음 read/reconcile에서 복구한다. 공유 index의 cross-session RMW도 직렬화한다. multi-process 지원 여부를 별도로 명시하고, 필요 시 R02 primitive를 사용한다.
- **Memory:** SQL partial update에서 patch에 명시된 column만 바꾼다. `embedding` 미지정이면 raw BLOB 그대로, 명시 clear/set은 기존 API 계약으로 구분한다. decode 실패를 값 없음으로 재직렬화하지 않는다.
- **제거:** queue 밖 delete, 모든 read 오류의 undefined collapse, corrupt index row를 읽고 조용히 소거하는 rewrite, decode→whole-row save update.
- **RED → GREEN:** save 진입 barrier→delete→late stale save; corrupt row+unrelated upsert→기존 snapshot 재발견; malformed/unreadable snapshot+durable tip→resume 거절; snapshot/index 사이 crash→재발견; corrupt BLOB `00`+text-only update→raw bytes/진단 유지. explicit embedding clear/set 정상 대조군 포함.

### R04 — Patch operation 의미와 rollback 결과

- **Owner/write set:** `src/patch/unified-to-v4a.ts`, `src/patch/applier.ts`, `src/patch/message-for-model.ts`, patch tests. 필요 시 apply-patch tool의 typed error projection만 integrator가 연결한다.
- **설계:** unified metadata를 file-section IR에서 보존하고 canonical V4A parser로 내린다. rename+edit, rename-only, quoted path 및 상충 metadata를 명시적으로 다룬다. 지원 불가 입력은 update로 낮추지 않고 거절한다. 기존 path/symlink safety를 유지한다.
- **타입 주의:** 현재 public `PatchOp`의 move는 `kind: "update"` + `moveTo`다. 존재하지 않는 `kind: "move"` variant를 새로 강요하지 않는다. audit의 move 요구는 의미 요구로 해석한다.
- **결과:** commit failure와 rollback outcome을 분리한다. `rolledBack`일 때만 unchanged를 말하고 `rollbackIncomplete`에는 original error, failed undo paths, 상태 불확실 범위를 전달한다. mutate-then-throw도 복구 대상이며 inverse journal은 변경 전에 준비한다. 독립 파일 patch 전체가 crash-atomic이라는 주장은 하지 않는다.
- **제거:** rename header discard, rollback exception swallow, 무조건 unchanged 문구.
- **RED → GREEN:** 기존 S-OP-5의 잘못된 기대를 `update.moveTo`로 수정하고 실제 old 부재/new 내용 및 moved 결과 검증. commit 실패/undo 실패 조합, mutate-then-throw, 정상 rollback, invalid rename destination을 tool 결과까지 확인한다.

### R05 — Side-agent control plane 하나, execution backer 둘

- **Owner/write set:** `src/side-agent/{registry,process-registry,process,types}.ts`, `src/side-agent/worker-entry.mjs`, 관련 tests.
- **설계:** spec validation, trigger admission, interval/event cadence, maxWakes, idle reap, stop을 parent-owned 공통 control state machine으로 추출한다. in-process와 process backer는 `runPass(wakeId, signal)` 실행만 다르게 한다. IPC는 version/wakeId와 terminal `finding | no_finding | failed | cancelled`을 구분하고 한 pass에서 여러 finding도 표현한다.
- **불변식:** completed wake는 terminal당 정확히 1회 계수; overlapping pass는 불허; event 폭주는 bounded coalescing; stop/child death는 timer, listener, active budget을 해제; duplicate/stale terminal은 무시. failure는 status로 노출하며 finding으로 승격하지 않는다.
- **제거:** 두 registry의 별도 cadence/lifetime 판단, finding 수를 wake 수로 세는 코드, null→synthetic finding fallback.
- **RED → GREEN:** 같은 contract suite를 양 backer에 적용한다. fake clock interval/event/maxWakes/idle reap/invalid spec; OS-child rail로 no-finding/throw/multiple findings/late terminal/kill 포함. stub만으로 child protocol 완료를 주장하지 않는다.

### R06 — Scheduler claim 복구는 기존 fencing 위에

- **Owner/write set:** `src/scheduler/automation-engine/{port,ticker}.ts`, 해당 durable engine adapter/tests; ticker composition 배선은 integrator.
- **설계:** 기존 `claimToken`과 finalize fence를 재사용한다. ticker가 reclaim window를 전달하고 live execution은 claim renewal 또는 검증된 bounded execution timeout을 갖는다. wall-clock age만으로 장시간 live 작업을 탈취하지 않는다. renewal 실패 시 취소/ownership-lost를 명시한다.
- **한계:** finalize fencing은 외부 부작용 exactly-once를 보장하지 않는다. recovery 실행에 attempt identity를 유지하고 지원되는 외부 동작은 idempotency key를 사용한다. 결과 불명인 비멱등 동작은 무조건 재실행하지 않고 recovery-required로 분류한다.
- **제거:** production ticker의 reclaim 미전달. 별도의 독립 lease/token system은 만들지 않는다.
- **RED → GREEN:** durable DB에서 child claim→kill→새 process ticker 복구; live renewed claim 비탈취; old token finalize 거절; renewal failure/cancel 및 ambiguous side-effect 처리. 단순 `engine.claim` 직접 호출만으로 배선 완료 판정 금지.

### R07 — Operation-owned cancellation

- **Owner/write set:** `src/apps/web-daemon/web-user-input-port.ts`, 관련 turn wiring; `src/auth/chatgpt-oauth/{callback-port,cli-callback,browser-flow}.ts`.
- **Web:** pending input을 sessionId/turnId/promptId와 originating abort signal에 묶는다. abort에서 해당 request만 settle/remove하고 terminal event를 추가 cleanup으로 사용한다. terminal이 blocked tool 반환을 기다릴 수 있으므로 terminal event만 기다리면 취소 deadlock이 남는다. socket close는 전체 연결 cleanup, 다른 turn은 보존한다.
- **OAuth:** callback handle에 idempotent close/cancel과 settle 계약을 추가한다. opener 실행 전부터 flow가 handle을 소유하고 성공/timeout/opener throw/caller abort를 `finally`로 닫는다. timer/listener도 정리한다. 두 domain에 universal lifecycle manager를 도입하지 않는다.
- **제거:** socket-close-only cleanup, cancel할 수 없는 callback handle.
- **RED → GREEN:** socket 유지+abort→pending 0/promise settled, late answer 무영향/다른 turn 생존; timeout/open throw/abort/success 후 실제 loopback port 재bind 가능, timer 및 unhandled rejection 없음.

### R08 — LSP 성공 캐시와 waiter lifetime

- **Owner/write set:** `src/agent/shadow-verify-adapters/check-lsp-test.ts`, `src/agent/lsp-diagnostics-hook.ts`, `src/agent/lsp-bridge/availability.ts`, `src/lsp/adapters/base/diagnostics-hub.ts`.
- **설계:** shadow probe는 기존 `lspBinaryAvailable`의 success-only cache를 사용한다. diagnostics open은 in-flight dedup + successful client reuse를 유지하되 null/reject를 제거한다. promise identity/generation 비교로 old failure가 newer entry를 제거하지 못하게 한다. dispose와 open 완료가 경합하면 늦게 열린 client도 닫는다.
- **Waiter:** publish/timeout/dispose가 같은 idempotent cleanup을 사용하고 timeout은 해당 callback만 제거한다. 같은 URI의 아직 유효한 waiter는 남긴다.
- **제거:** shadow 전용 negative cache, null/rejected promise 영구 cache, timeout 후 retained callback.
- **RED → GREEN:** false→true 재probe; null/reject→live 재open; 동시 open dedup; old reject/new success race; dispose-during-open; 반복 timeout 후 callback/key 0; 같은 URI의 surviving waiter publish 성공.

### R09 — Usage 한 번 가격 결정, sinks는 같은 provenance 사용

- **Owner/write set:** `src/observability/usage-accounting`의 기존 normalize/price 계약, `src/agent/loop/emit-helpers.ts`, `src/agent/budget-ledger.ts`, `src/agent/loop/stop-conditions.ts`, `src/apps/eval/report`.
- **설계:** 이미 계산된 `UsageSinkCtx.eventCost`를 token counts + pricing provenance와 함께 ledger adapter로 전달한다. ledger가 raw usage를 자체 fallback 단가로 재가격화하지 않는다. `known | unknown | estimated` 의미를 구분하고 현재 정책대로 unknown은 USD breach에서 제외한다. token/time limit은 유지한다. estimated를 enforce할지는 별도 명시 정책 없이는 활성화하지 않는다.
- **집계:** known subtotal, unpriced/estimated record count, completeness를 보존한다. all-unknown은 unavailable, mixed는 known subtotal + partial 표기, 실제 known zero만 `$0` 단독 표기를 허용한다. ledger 저장/rehydration에서도 provenance를 보존하며 legacy provenance 부재를 known으로 간주하지 않는다.
- **제거:** ledger의 implicit Sonnet fallback enforcement, eval count>0이면 cost measured로 취급하는 projection.
- **RED → GREEN:** 실제 emitUsage→meter+ledger+stop 경로에 unknown model/작은 hard limit을 주입해 USD stop 없음; known over-budget는 stop; mixed/zero/unknown eval markdown; persisted unknown hydration 이후 동일 정책. 가격 계산 helper 단독 테스트로 완료 불가.

### R10 — Search readiness와 embedding space 계약

- **Owner/write set:** `src/runner/assemble/search-index-backend.ts`, `src/runner/assemble/search-pipeline.ts`, `src/host/runtime/internal/mention-symbol-deps.ts`, 관련 retrieval/embedder contracts/tests.
- **설계:** backend initialization은 single-flight readiness result를 제공하고 실제 port operation이 이를 await한다. explicit selection 실패는 typed unavailable로 consumer에 전달한다. runtime 장애도 ready/no-hit로 숨기지 않는다. 정상 no-hit은 계속 `[]`이고 명시 store를 다른 store로 자동 대체하지 않는다.
- **Embedding:** `EmbeddingSpace { model, revision, dimensions, normalization }`에 해당하는 identity를 index와 query 양쪽에 고정한다. 같은 dimension의 hash도 provider embedding과 의미 공간이 다르므로 per-item fallback 금지. provider 실패/입력 초과는 typed failure 또는 같은 model의 명시 chunking 정책으로 처리한다. 의도적 headless hash mode는 별도 전체 index namespace로만 허용한다.
- **호환:** persisted index에 space/version을 기록한다. 기존 identity 불명 index는 검증 또는 별도 rebuild가 필요하다. old/new namespace를 섞지 않고 성공한 rebuild 후 전환한다. 원본 index 자동 삭제 금지.
- **제거:** null runtime→empty/noop, static ready, provider failure→hash chain, mismatched cosine의 `Math.min` truncation 허용.
- **RED → GREEN:** 유효한 explicit store의 create/capability/operation 실패를 search 및 mention consumer가 관측; no-hit control; 32,769-byte 입력+1536d provider 실패; 같은 dimension/다른 model 거절; query/index identity mismatch; 실패 중 partial upsert의 재시도/중복 정책 검증.

### R11 — MCP protocol core 하나, transport lifecycle 교체

- **Owner/write set:** `src/mcp/client.ts`, `src/mcp/client/transport-factory.ts`, `src/mcp/transports`, `src/mcp/isolated-client.ts`; `src/plugin-isolation`의 readiness primitive는 별도 소유권 배정 후 변경. host/agent/skill/plugin construction 배선은 integrator.
- **Isolation:** 기존 `McpTransport` 아래 isolated carrier를 넣는다. production normal/supervised/skill MCP가 같은 factory에서 flag를 소비한다. manifest plugin의 isolation 정책은 유지한다. 별도 IsolatedMcpClient를 켜서 client feature set을 교체하는 방식 대신 compatibility facade도 같은 protocol core에 위임한다.
- **구현 전제:** 현재 plugin spawner는 첫 stdout line을 DXT ready로 소비한다. 일반 MCP stdio server는 client의 initialize를 기다릴 수 있으므로 그대로 연결하면 ready timeout 또는 첫 응답 유실이다. process-spawn readiness와 DXT ready-line mode를 명시적으로 분리하고 DXT 기본 계약은 보존한다. MCP initialize는 core가 소유한다. dead/oversize send를 silently drop하지 않고 carrier의 `send` 실패 계약으로 전달한다.
- **HTTP reauth:** connection generation을 두고 replace를 `create → start → initialize → initialized notification → negotiated state publish` transaction으로 만든다. replacement handshake가 자기 자신을 기다리는 auth-refresh recursion을 만들지 않는다. 실패/stop 시 candidate를 닫고 stale response가 새 state를 덮지 못하게 한다. old pending requests의 fail/retry outcome을 명시한다.
- **재시도:** 새 credential에 old session id를 무조건 이식하지 않는다. 명백한 auth rejection 또는 안전성이 입증된 요청만 replay한다. 완료 여부 불명 `tools/call`을 자동 재실행하지 않는다. old close/DELETE가 adopted session을 지우지 않게 session ownership을 분리한다.
- **제거:** 두 client의 handshake/RPC pending/lifecycle 중복, reauth의 start-only swap. catalog는 실제 factory 경로에 맞게 YAML을 수정하고 build한다.
- **RED → GREEN:** flag OFF/ON을 production factory까지 검증; unsolicited ready line 없는 실제 stdio MCP fixture; DXT ready control; timeout/exit/oversize-send. stateful HTTP server에서 401→new initialize→새 session id/protocol pin→허용된 retry; handshake 401/failure, simultaneous 401 single-flight, stop-during-refresh, late old response, side-effect replay 금지.

### R12 — Session protocol의 closed-world 표면

- **Owner/write set:** `src/protocol/session/{commands,verb-surface,codec}.ts` 및 event schemas, `src/ipc/session/handle.ts`, `src/sdk/runtime/handle-adapter.ts`; kernel replay의 error projection만 필요한 범위에서 연결한다.
- **Command:** command discriminant를 기준으로 visibility/executor/verb mapping을 exhaustively 선언한다. objective/posture/skill typed verbs를 wire와 in-process surface 양쪽에 제공한다. `turn.submit` 등 host-only command는 명시적 exception이며 exhaustive라는 이유로 외부에 노출하지 않는다. wire submitted receipt와 in-process completion semantics를 혼동하지 않는다.
- **Event:** `SessionEvent["type"]` 전체에 required payload validator를 배정한다. common envelope 검증 뒤 payload를 검증하고 cast한다. schema/domain policy owner는 분리하고 protocol에서 kernel로 역import하지 않는다. 기존 version/optional field 호환 범위를 fixtures로 고정한다.
- **제거:** 수동 surface 목록의 silent omission, payload 무검증 cast. 기존 공개 API는 delegating wrapper로 유지할 수 있지만 별도 command encoder를 만들지 않는다.
- **RED → GREEN:** 세 verb의 wire→kernel 및 in-process conformance; 새 command에 mapping 없으면 compile failure; 모든 event variant의 valid/malformed required field table; `approval:null` wire/replay 거절; corrupt log는 typed 진단하고 원문을 덮어쓰지 않음. event 수 floor와 validator exhaustiveness를 함께 검증한다.

### R13 — Benchmark bootstrap와 readiness의 동일 profile

- **Owner/write set:** `src/apps/bench/remote/box-session/ec2-lifecycle.ts`, `src/apps/bench/profiles/registry.ts`, family setup/readiness consumers와 tests.
- **설계:** 기존 dataset-family profile에서 common prerequisites, optional grader shim, family setup, readiness requirements를 파생한다. bootstrap phase는 공통 → 필요한 shim → **항상 family setup** → readiness 순서. boxGrade가 전체 bootstrap을 반환시키지 않는다. warm-box selection도 같은 profile의 readiness를 사용한다.
- **제거:** boxGrade early return, 모든 family에 대한 swebench-python hardcoded probe. lifecycle god-module은 phase executor/profile readiness로 분리한다.
- **RED → GREEN:** ProMax bootstrap command sequence+setup 1회, warm reuse 성공, SWE-bench shim control, phase failure로 false-ready 금지. fake SSH는 local contract proof다. 실제 EC2 provision/reuse는 별도 승인·비용이 있는 runtime proof이며 이 계획 작성/로컬 test로 수행했다고 하지 않는다.

### R14 — Product CLI remote composition 완결

- **Owner/write set:** `src/remote/runner/registry.ts`의 기존 계약, CLI-local remote dependency builder/tests; `src/apps/cli/index.ts` wiring은 integrator.
- **설계:** 기존 Docker process/Lima process+VM ports의 concrete adapter를 CLI composition에서 생성해 selector에 주입한다. env 없는 기본 실행은 기존 동작을 유지하고 side effect 없이 selection만 한다. 실제 child 실행은 argv 기반이며 shell interpolation 금지. disabled/misconfigured/unavailable/ready를 구분해 CLI outcome에 연결한다.
- **제거:** production `selectRemoteRunner(process.env, {})` empty seam. tests 전용 adapter wiring을 제품 배선의 증거로 삼지 않는다.
- **RED → GREEN:** 실제 CLI route를 fake process/VM adapter로 실행해 docker/lima selection과 command dispatch를 검증; missing binary/VM/invalid config/error mapping; flag unset에서 adapter 실행 없음. 실제 Docker/Lima integration은 설치 가능한 환경의 별도 rail로 남기고 fake 성공과 구분한다.

### R15 — Boot selection과 configuration projection

- **Owner/write set:** `src/runner/assemble/llm.ts`의 selector 계약, CLI status/doctor/internal, `src/apps/eval/index.ts`, `src/runner/knobs/knobs/{read-outline,test-runner}.ts`; shared helper 변경은 integrator만.
- **설계:** 기존 transport selector 결과를 requested provider/effective transport/reason DTO로 반환한다. live status는 session boot snapshot, preflight doctor는 동일 resolver의 현재 설정 결과로 구분한다. credential 값은 DTO/log에 넣지 않는다. `pickProvider`를 cloud transport의 대체 authority로 사용하지 않는다.
- **Env/knob:** eval을 기존 shared env loader의 `.env.dev → .env.local → .env` first-wins와 연결한다. shell env 우선권을 보존한다. knob는 기존 `isTruthyToken`을 사용한다. value/provenance helper만 공유하고 각 app boot 정책을 거대한 config service로 옮기지 않는다.
- **제거:** eval 전용 역순 dotenv 루프, 두 local ENABLING set, status/doctor의 독립 transport 추론.
- **RED → GREEN:** cloud selector별 booted adapter↔status/doctor effective transport; no-cloud control; 실제 temp env 충돌+shell override; canonical true/false/unknown token의 runtime/bench parity. env/global singleton tests는 독립 process로 격리한다.

### R16 — Skill authority 입력과 fail-soft 관측

- **Owner/write set:** `src/runner/assemble/session-authorities/build-skills.ts` 계약, `src/apps/cli/repl/session-setup.ts`, `src/apps/web-daemon/authority-readouts.ts`, `src/apps/cli/repl.ts`, `src/apps/agent/mode-presets/system.ts`.
- **설계:** 기존 org-directory resolver를 composition에서 한 번 호출해 snapshot에 넣는다. `undefined` default resolution과 explicit `null` opt-out을 구분한다. admin skills/banned/required 정책은 기존 skill authority만 해석한다. malformed org policy를 wiring catch로 조용히 무시하지 않고 기존 authority의 오류 정책을 지킨다.
- **관측:** permission/repo-rules loader의 기존 fail-soft/fail-open 정책은 유지하되 path, scrubbed cause, effective degraded mode를 warning sink로 정확히 1회 전달한다. 로그 추가 때문에 원래 fallback이 throw하지 않게 한다. 무관한 모든 startup catch를 한꺼번에 재설계하지 않는다.
- **제거:** org 입력 누락, 두 silent catch. CLI와 web에 별도 org policy parser를 추가하지 않는다.
- **RED → GREEN:** temp org policy/admin skills가 실제 CLI/web active/policy projection에 반영; banned/required/explicit opt-out/default/env 경로; load rejection→fallback+warning 1회; success→warning 없음; diagnostic에 credential 원문 없음.

## 5. 실행 순서 / 병렬 소유권

이 절은 wave 절차다. W1·W2는 이미 수행됐다. 아래 규칙은 W3+에 그대로 적용한다.

### W0 — Integrator가 먼저 고정할 것

- HEAD와 dirty source/doc digest, 지원 OS/filesystem, 테스트 runner, 기존 공개 API/schema/feature catalog의 영향 목록.
- 각 package의 exact write set과 기존 test path를 선언한다. 새 filename은 기존 책임과 충돌하는지 inventory 후 정한다.
- R02a lock feasibility와 legacy-writer 전환 정책을 가장 먼저 결정한다. 이 결과가 나오기 전 lock-dependent 구현 또는 cross-process session 안전성 claim을 시작하지 않는다. 독립 작업의 선행조건은 ACTIONS의 dependency 표를 따른다.
- R11의 MCP-vs-DXT readiness contract, R09 pricing provenance/hydration, R10 embedding-space migration을 interface barrier로 확정한다.
- owner-local reproduction을 기존 tree에서 RED로 확보한다. 실패 이유가 syntax/type error 또는 test 미선택이면 RED receipt로 인정하지 않는다.

### 확정 wave 배정: worker 최대 3 + serial integrator

기존 B1–B6 초안은 [WAVES](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/WAVES.md)의 W0–W7로 대체한다. 모든 39 finding/172 action이 한 그룹에만 배정된다.

- W0 preflight → W1(R01/R04/R09) → W2(R05/R13/R11) → W3(R14/R02/R12) → W4(R03/R06/R10) → W5(R07/R08/R15) → W6(R16) → W7 final closeout.
- 각 구현 wave는 **P: disjoint owner writes → I: serial root integration** 순서다. P 중 integrator는 제품 read-only, I 중 workers는 제품 read-only다.
- shared/barrel/entrypoint/공통 fixture/catalog/root 배선은 worker 집합에서 제외한다. source뿐 아니라 test/artifact write set도 `waves.json`에서 검사한다.
- 미배정 잔여 작업/임의 조기 착수는 없다. scope/순서 변경은 manifest와 dependency/disjoint 검사 갱신을 먼저 수행한다.
- wave마다 dependency test를 재실행하고 새 source snapshot을 publish한다. 다음 wave는 갱신된 source와 정확한 audit 문서를 함께 받는다.
- 서로 다른 process/temp root의 독립 tests는 병렬 가능하다. 공통 env/DB/port 또는 receipt freshness가 겹치는 rail만 직렬화한다.

## 6. 완료 gate와 증거 형식

### Package gate

1. 실제 producer → owner → consumer의 RED reproduction.
2. 구조 변경 + 기존 중복/우회 경로 제거 + public compatibility 확인.
3. 같은 rail GREEN, 정상 대조군, 실패/취소/재시도 경계 테스트.
4. cheap하고 authoritative한 mutation/revert에서 해당 invariant가 다시 RED. static guard는 live call/AST pattern + anti-vacuum floor + 잘못된 항목을 지목하는 red-on-injection self-test가 필수다.
5. touched source/types/tests의 typecheck, lint, slice fence, god-code/cohort, lint-debt gate. allowlist/ceiling 증가는 실패다.

### Serial integration gate

- `git diff --check`.
- `bun run typecheck:all`, `bun run lint`, `bun run lint:debt`.
- `bun test tests/unit/god-code-ratchet.test.ts`와 변경 slice의 boundary entrypoints, config↔entrypoint parity test.
- repository의 `bun run prepush` campaign 및 필요한 cold verification. 재사용 receipt는 정확한 source/dependency/env snapshot과 일치할 때만 인정한다. runner 내부 scheduling을 존중한다.
- feature 변경은 해당 YAML 수정 후 `bun fc validate`, `bun fc build`, `bun fc diff`, 필요한 evidence 검사. generated `docs/10.feature-catalog.md` 직접 편집 금지.
- cross-cutting smoke: boot/status/doctor; wire+in-process session commands/replay; search readiness; OAuth/MCP lifecycle; persistent resume; side-agent backers. package 단독 GREEN 이후 통합 source에서도 다시 실행한다.

### Receipt 최소 필드

`package / finding IDs / source HEAD+dirty digest / owner diff / removed path / command / environment / RED cause / GREEN result / mutation result / compatibility result / remaining proof gap`.

- finding 상태는 `planned → red-confirmed → implemented → verified`; 제품 불변식이 검증되지 않으면 verified가 아니다.
- local fake SSH/process test, 실제 OS child test, 실제 Docker/Lima/EC2 실행을 서로 다른 evidence class로 기록한다.
- CI 성공·merge·배포·runtime 성공을 서로 대체하지 않는다. 이 계획에는 자동 commit/push/유료 cloud 실행 권한이 포함되지 않는다.
- 최종 closeout은 39개 각각의 receipt 링크와 open gap을 기재한다. 일부 환경 검증이 없으면 그 항목을 남기며 **계획 완성도를 제품 해결률로 표현하지 않는다**.

## 7. 우선순위 판단

- 즉시: R01 secret 노출, R04 잘못된 파일 변경/복구 오보고, R09 부당한 budget 중단. 독립 owner라 첫 batch에서 병렬 처리한다.
- 다음: W2의 R05/R11/R13과 W3-I 첫 순서의 R14로 나머지 P1을 닫는다. R02a feasibility는 W0의 선행 조사이지 P2라서 뒤로 미루는 작업이 아니다.
- 이후: R02/R03의 데이터 보존·동시성, R10/R12의 typed boundary, lifecycle/cache/boot authority를 통합한다.
- 가장 큰 불확실성은 R02의 portable lock 구현/혼재 버전 전환, R11의 client 통합 호환성, R10의 기존 index 전환이다. 달력 기간은 이 세 spike 결과와 실제 runtime 환경 확보 전에는 확정하지 않는다.

## 8. 계획 문서 검증

계획 **작성 턴** 기록 (baseline HEAD `f5f48757`, 제품 변경 없음):

- 입력 digest 일치, finding 39개 각각 정확히 한 package 배정, severity 일치, package 16개 확인.
- 위에 명시한 source/test/tool/doc 경로 67개 참조 존재 확인. 새 API 이름은 구현된 것으로 세지 않았다.
- 문서 whitespace 검사 통과. 그 턴의 제품 source/test/tool/package 변경 없음.
- 그 턴에서는 제품 test suite를 실행하지 않았다. 앞선 audit baseline PASS를 이 계획의 회귀 rail PASS로 전용하지 않는다.
- 후속 ACTIONS 보강은 당시 source HEAD 유지 상태에서 수행했다. finding별 4개 액션과 W0/통합 체크리스트를 추가했으며 source evidence 위치·기존 test path·coverage를 별도 검사한다.

현재 local `main` `29d7e4ff1`은 W1·W2 제품 변경을 포함한다. 구현 증거는 `work/W1-I.md` / `work/W2-I.md`와 각 `work/Rxx/receipt.md`다.
