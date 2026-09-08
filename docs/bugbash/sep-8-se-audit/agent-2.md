# Sep-08 SE audit — agent-2 재검증 결과

> 기준: `f5f4875799141068af73e604129c8b9a09f76007` (`origin/main`과 동일)
> 범위: lane F (`src/auth`, `src/config`, `src/migration`, `src/permission`, `src/security`)
> 처분 원칙: 현재 소스에서 재현되거나 reachable producer → consumer 실패가 확인되는 미해결 항목만 유지한다.

## 유지 항목

| ID | Sev | 실제 실패 효과 |
|---|---:|---|
| F-07 | P1 | command-shape 우회로 형식 regex가 모르는 환경변수 secret이 모델/JSONL까지 갈 수 있다. |
| F-03 | P2 | config-migration ledger의 crash orphan lock이 이후 throttle 기록을 영구 차단한다. |
| F-04 | P2 | OAuth refresh CAS의 crash orphan이 해당 token key refresh를 영구 차단한다. |
| F-08 | P2 | OAuth browser timeout/open failure가 loopback listener를 닫지 않는다. |
| F-09 | P2 | permission lock의 고정 5초 stale 판정과 무조건 unlink release가 live-holder ABA를 허용한다. |
| F-10 | P2 | migration `settings.json` writers의 unlocked RMW가 concurrent import 결과를 유실한다. |
| F-12 | P2 | shared trust file의 whole-map save가 concurrent explicit trust grant를 유실한다. |
| F-13 | P2 | live glob-rule와 raw memory 문서가 in-place rewrite라 crash 시 기존 bytes까지 손상될 수 있다. |
| F-11 | P3 | shape-invalid ledger entry 하나가 fail-soft migration path를 TypeError로 중단한다. |

### F-07 [P1] command-shape secret 분류 우회

- 근거: command head lookup은 raw first token을 사용한다(`src/security/sensitivity-classifier.ts:324-353,414-435`). shell 집합은 `bash|sh`, flag는 exact `-c|-lc`뿐이다(`:369-384`). interpreter env 검출도 dot form 위주다(`:387-411`). bare `printenv|env` 규칙은 token 길이 1만 secret이다(`:328-332`).
- 재현: 현재 HEAD에서 `/bin/bash -c printenv`, `zsh -c printenv`, `bash -xc printenv`, `bash -c "printenv 2>&1"`, `bash -c "printenv | cat"`, `node -e 'console.log(process["env"])'`가 모두 `public`; `bash -c printenv`와 `node -e 'console.log(process.env)'`만 `secret`이다.
- 도달 경로: `classifyCommandShape`는 bash, PTY, test-runner, container-exec tool output redaction의 source classification에 쓰인다. Layer-2 format regex가 모르는 secret value는 Layer-1이 `public`이면 그대로 남는다.
- 최소 수정/rail: executable basename 정규화, supported shell/flag parser, interpreter code를 `classifyCodeShape`와 공유하고 compound/redirect/prefix command를 구조적으로 검사한다. 위 재현 각각이 RED가 되는 unit + 실제 tool redaction E2E가 필요하다.

### F-03 [P2] migration ledger orphan lock

- 근거: `recordDisposition`은 `{ledger}.lock`을 `wx` 생성하고 `EEXIST`이면 즉시 `false`를 반환한다. age/pid 검증이나 reclaim은 없다(`src/migration/external-config/ledger.ts:96-110,112-132`). 같은 slice의 import-log writer에는 stale/dead-pid reclaim이 있다.
- 재현/영향: dead pid 내용의 lock을 미리 두면 `recordDisposition(...)`은 `false`이고 ledger는 생성되지 않는다. `runForScope`와 `persistConvertedItems`는 이 값을 best-effort로 삼키므로 이후 launch마다 migration이 재제안/재적용될 수 있다(`src/migration/external-config/run.ts:123-139`, `persist.ts:905-910`).
- 최소 수정/rail: migration-local stale/dead-owner reclaim을 ledger lock에도 적용한다. dead-owner reclaim 성공과 live-owner 비탈취를 함께 고정한다.

### F-04 [P2] OAuth refresh CAS orphan

- 근거: `acquireCasClaim`은 `{key}.cas`의 `EEXIST`를 무조건 실패로 처리한다(`src/auth/node-lock-file-store.ts:22-43`). `compareAndSwap`은 이를 `changed`로 반환하고 cleanup은 정상 `finally`에서만 수행한다(`:70-85`).
- 재현/영향: `k.cas` orphan을 심은 뒤 현재 token value와 일치하는 CAS도 `changed`이며 token은 그대로다. 이 store는 `createChatgptRefreshLock`을 통해 ChatGPT OAuth refresh transaction에 사용된다.
- 최소 수정/rail: claim에 owner/token/age를 기록하고 dead/stale claim만 안전하게 reclaim한다. planted orphan 복구와 live concurrent CAS 단일-winner를 고정한다.

### F-08 [P2] OAuth callback listener 수명주기 누수

- 근거: CLI provider는 `received`가 settle될 때만 server를 닫는다(`src/auth/chatgpt-oauth/cli-callback.ts:306-316`). browser flow timeout은 별도 promise가 race에서 reject할 뿐 `received`를 settle/cancel하지 않는다(`src/auth/chatgpt-oauth/browser-flow.ts:143-178`). opener throw도 provider handle을 닫을 수단이 없다(`:134-141`). port에는 explicit close/cancel verb가 없다(`src/auth/chatgpt-oauth/callback-port.ts:41-61`).
- 트리거/영향: callback 없는 timeout 또는 browser-open 실패 후 loopback port가 계속 listen하여 다음 login이 `ports_in_use`가 된다.
- 최소 수정/rail: callback handle에 idempotent cancel/close를 추가하거나 flow-owned abort signal로 provider를 반드시 settle한다. timeout, opener throw, caller abort 각각에서 listener가 즉시 재bind 가능함을 검증한다.

### F-09 [P2] permission lock stale-steal ABA

- 근거: lock birth timestamp는 acquire 때 한 번 기록되고 heartbeat가 없다(`src/permission/json-state-file/locking.ts:109-121`). 5초가 지나면 pid 생존과 무관하게 peer가 unlink/steal한다(`:94-99,125-139`). 원 holder의 release도 ownership 확인 없이 현재 lock path를 unlink한다(`:147-152`).
- 트리거/영향: read-merge-write가 5초 이상 지연되면 B가 A의 live lock을 steal하고, A가 B의 lock을 지운 뒤 C가 임계구역에 들어갈 수 있어 permission/trust-scope merge의 lost update가 가능하다.
- 최소 수정/rail: unique lease token + release-time ownership check를 사용하고, 필요하면 heartbeat/pid liveness를 결합한다. 5초 초과 2-process holder에서 non-steal, stale dead holder reclaim, old holder가 new lock을 못 지우는 ABA rail이 필요하다.

### F-10 [P2] migration settings writers의 unlocked RMW

- 근거: `persistSettings`와 `persistHooks`는 각각 `settings.json`을 읽고 merge한 뒤 atomic rename하지만 read→rename 전체를 보호하는 lock은 없다(`src/migration/external-config/persist.ts:496-520,529-555`). atomic temp file은 torn JSON만 막고 concurrent lost update는 막지 않는다.
- 도달 경로/영향: 두 migration process가 같은 snapshot에서 settings와 hooks를 쓰면 마지막 rename이 다른 결과를 제거한다. hooks는 `src/apps/agent/index.ts:338-344`의 live command-hook loader가 읽는다.
- 최소 수정/rail: migration-local lock 아래에서 re-read/merge/rename한다. 두 프로세스가 서로 다른 hook/settings key를 쓰는 barrier test에서 최종 union을 검증한다.

### F-12 [P2] TrustStore whole-map save lost update

- 근거: 각 `TrustStore` instance는 load한 전체 Map을 유지하고 `flush()`가 전체 object를 그대로 저장한다(`src/config/trust-store.ts:67-102,129-146`). persistence는 atomic rename이지만 merge/lock은 없다(`src/apps/agent/index.ts:258-286`). 실제 trust prompt grant는 `setTrusted` 후 flush한다(`:392-400`).
- 트리거/영향: 서로 다른 cwd의 두 agent process가 같은 trust snapshot을 load한 뒤 각각 grant하면 마지막 save가 첫 grant를 제거한다. `setUntrusted` production producer는 현재 없으므로 기존의 revoke-resurrection 주장은 유지하지 않는다.
- 최소 수정/rail: trust-file-local lock 아래 re-read/merge하되 explicit current-process mutation만 적용한다. two-process distinct grant union을 고정한다.

### F-13 [P2] markdown/memory in-place rewrite

- 근거: JSON migration writer는 temp+fsync+rename을 쓰지만(`src/migration/external-config/persist.ts:254-286`), `writeNoClobber`는 대상에 직접 `writeFile`한다(`:458-463`). `persistMemory`도 `raw_memories.md` 전체를 읽은 뒤 `existing + block`을 같은 path에 직접 쓴다(`:778-795`).
- 도달 경로/영향: `.quanta/rules/*.imported.md`는 live glob-rule loader가 읽고, `raw_memories.md`는 누적 evidence다. crash/disk failure 중 truncate-rewrite가 발생하면 새 block뿐 아니라 기존 memory bytes도 손상될 수 있다. `AGENTS.imported.md`는 live repo-rule reader가 읽지 않으므로 그 경로는 영향 주장에 포함하지 않는다.
- 최소 수정/rail: 동일 directory temp + fsync + rename을 markdown/memory writer에도 적용한다. sync failure injection에서 기존 bytes 보존과 temp cleanup을 고정한다.

### F-11 [P3] malformed ledger entry의 fail-soft 계약 위반

- 근거: loader는 envelope와 `entries` array 여부만 확인하고 element shape 검증 없이 cast한다(`src/migration/external-config/ledger.ts:56-82`). `isThrottled`는 각 element의 `sourceKey`를 바로 읽는다(`:85-88`).
- 재현/영향: `{"version":1,"entries":[null]}`을 load한 뒤 `isThrottled`를 호출하면 `TypeError`다. 이 호출은 `runForScope`와 `persistConvertedItems`의 `NEVER throws` 경로에 catch 없이 있다(`src/migration/external-config/run.ts:123-128`, `persist.ts:886-891`). 외부 손상/수동 편집에 한정되지만 migration startup을 중단한다.
- 최소 수정/rail: entry별 closed-shape validation/filter를 추가하고 null/scalar/missing-field fixture가 empty/valid subset으로 degrade함을 고정한다.

## 검증

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- `git diff --name-only 9b05cd33..HEAD -- src` → 없음. 최초 dump 이후 현재 HEAD까지 제품 소스는 동일하다.
- 직접 재현: command-shape 8개 입력 분류, malformed ledger `TypeError`, planted `.cas` → `changed`/token 불변, planted ledger lock → `false`/ledger 미생성.
- 정적 producer/consumer census: migration throttle/persist, ChatGPT refresh lock, OAuth callback flow, permission merge lock, command-hook load, TrustStore trust prompt, raw memory/glob-rule writers.
