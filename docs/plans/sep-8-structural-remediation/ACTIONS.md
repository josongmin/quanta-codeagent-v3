# Sep-08 — evidence-backed action register

상태: **W7 structural repair in progress on local `main`**. W1–W6 implementation은 유지되며 현재 repair tree는 **not verified**다. G-F5.4 EC2 실기 proof는 열린 갭. G-F9.4 contract rail은 설치됨(이 머신 Docker live 실행, Lima skip). 계획 PASS와 완료 자격은 `verify-waves.mjs`가 별도로 판정한다.

설계·write set·병렬 통합 정책: [README](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/README.md).
실행 wave/group 배정: [WAVES](/Users/songmin/quanta-codeagent-v3/docs/plans/sep-8-structural-remediation/WAVES.md). 172개 액션의 단일 owner와 병렬 write set은 `waves.json`/`verify-waves.mjs`로 검사한다. 액션 내용은 이 문서, 실행 배정은 manifest가 원본이다.
기준 source (계획 작성): `f5f4875799141068af73e604129c8b9a09f76007`. 통합 source (W1+W2, W3 착수 HEAD): `19fc9da2b5f5e7763f2288e09f1af36e44b70b2a`. audit 입력 digest는 README와 동일하다.
이 문서의 근거는 현재 source 계약과 앞선 audit의 재현 기록이다. `docs/bugbash/sep-8-se-audit/`는 baseline 입력이며 W1/W2 구현 후 재작성하지 않는다. source 변경 시 관련 근거·rail을 다시 고정한다.

## 0. 실행 방법과 선행 액션

- [x] **W0.1** HEAD, dirty source digest, audit 문서 digest, Bun/OS/filesystem을 receipt에 기록한다. 현재 dirty audit 7개와 계획 문서는 보존한다.
- [x] **W0.2** 각 package write set을 실제 filename 단위로 확정한다. shared/public exports/composition roots/package/catalog는 integrator만 편집한다. 파일뿐 아니라 같은 정책/동일 테스트 fixture의 중복 소유도 금지한다.
- [x] **W0.3** R02의 lock primitive 후보를 지원 플랫폼에서 실험한다. FD lock의 lifetime, same-process 별도 opener, child inheritance, holder kill, stable inode, symlink/path identity, abort/wait timeout을 검증한다. 새 native dependency/지원 범위 변경은 별도 승인 대상이다.
- [x] **W0.4** legacy wx writer와 새 lock writer의 혼재 차단/전환 절차를 확정한다. process 종료가 필요하면 명시하고, 기존 lock 파일을 age만으로 삭제하지 않는다.
- [x] **W0.5** R11의 process-ready와 DXT-ready 분리, client core 기능 parity 목록을 확정한다. HTTP reauth의 replay 허용 조건과 pending request 종료 정책도 고정한다.
- [x] **W0.6** R09의 unknown/known/estimated 및 legacy ledger hydration 정책, R10의 embedding-space identity와 old index 전환 정책을 확정한다.
- [x] **W0.7** touched god-module/function을 detector 기준으로 목록화하고 해당 package의 책임 분리 안에 포함한다. line-count 낮추기용 wrapper 이동 또는 allowlist 증가는 금지한다.
- [x] **W0.8** owner-local RED test를 먼저 추가하고 실패 원인이 해당 finding인지 확인한다. 기존 suite PASS, source grep, test 파일 존재는 RED receipt가 아니다.

### 실제 blocking dependency

| 작업 | 반드시 선행할 조건 | 기다릴 필요가 없는 것 |
|---|---|---|
| R02 F-03/F-04/F-09/F-10/F-12 및 memory append 동시성 | W0.3 lock proof + W0.4 mixed-writer 정책 | MCP/search/client 변경 |
| R02 F-11 entry validation | malformed fixture와 보존 정책 | lock primitive 구현 |
| R02 F-13 old-byte preservation | strict atomic writer 계약; append union은 lock 추가 필요 | JSON shape validation |
| R03 in-process save/delete, typed read, SQL partial update | 해당 producer의 queue/patch 계약 | 전체 R02 완료 |
| R03 cross-process write 안전성 claim | 지원 topology 확인; 필요 시 검증된 R02 primitive | in-process-only proof를 먼저 얻는 작업 |
| R11 isolation/reauth | W0.5; 공통 client lifecycle 계약 | 다른 P1 전부 완료 |
| R09/R10 | W0.6 각자 provenance/space 계약 | 서로의 구현 완료 |
| R12/R07 | turn/command/event 계약은 공유하되 각 write set 고정 | 무관한 OAuth UI 또는 MCP 변경 |
| R14/R15/R16 root wiring | 해당 owner interface + integrator write slot | 다른 root를 쓰는 독립 leaf test |

공통 원인이 있어도 commit을 거대하게 묶지 않는다. 아래 finding별 변경을 owner-local coherent commit 단위로 만들되, **새 계약만 추가하고 consumer는 구계약에 남은 상태를 완료/배포 가능으로 표시하지 않는다**.

## 1. R01 — source sensitivity / output redaction

### F-07 · P1 · Command-shape 우회

근거: [raw command 분류](/Users/songmin/quanta-codeagent-v3/src/security/sensitivity-classifier.ts:324), [shell/interpreter 분기](/Users/songmin/quanta-codeagent-v3/src/security/sensitivity-classifier.ts:369). 앞선 audit에서 absolute shell, zsh, `-xc`, redirect/pipeline, bracket env 접근이 public으로 분류됐다. 임의 env secret은 format scrubber가 구제하지 못한다.

- [x] **F-07.1** 지원 executable/shell/options/compound/code grammar를 inventory하고, basename·shell option·nested command를 공통 구조로 해석한다. 기존 parser가 있으면 reuse하고 새 regex 목록 누적으로 처리하지 않는다.
- [x] **F-07.2** env 읽기/code-shape 판정을 한 authority로 연결하고 raw-first-token 별도 규칙을 제거한다. unsupported 의심 구조의 sensitivity와 benign control을 명시한다.
- [x] **F-07.3** 위 6개 bypass family + 정상 대조군을 RED→GREEN으로 고정한다. wrapper 중첩·prefix·redirect에서 판정이 사라지지 않는지 확인한다.
- [x] **F-07.4** synthetic 비정형 secret을 실제 tool producer에 넣고 모델/JSONL consumer까지 노출되지 않음을 확인한다. classifier만 고치고 sink metadata가 유실되면 미완료다. 현재 증명: live `makeBashTool().classifySource` → central stream dispatcher → `JsonlRecorder` 실제 파일 readback; raw token 0, redaction marker 존재.

### SEP7-D-11 · P2 · Stdout progress redaction

근거: [tool_progress](/Users/songmin/quanta-codeagent-v3/src/stream/adapters/stdout.ts:260), [provider in_progress](/Users/songmin/quanta-codeagent-v3/src/stream/adapters/stdout.ts:567). 두 free-text 경로는 `oneLine`만 거치지만 인접 error/tool-result는 `redactStr`을 사용한다.

- [x] **SEP7-D-11.1** stdout의 free-text/이미 sanitizing된 field를 구분해 renderer boundary를 정한다. 색상/개행 formatting이 redaction보다 먼저 secret을 분할하지 않게 한다.
- [x] **SEP7-D-11.2** 두 progress field를 `redactStr → oneLine`에 연결하고 raw bypass를 제거한다. domain event 구조 자체는 불필요하게 변경하지 않는다.
- [x] **SEP7-D-11.3** tool/provider progress 양쪽에 synthetic recognized token을 넣고 실제 stdout에 원문이 없음을 검증한다. 정상 path/status 출력은 보존한다.
- [x] **SEP7-D-11.4** 두 호출 중 하나를 제거한 mutation이 해당 test를 RED로 만드는지 확인한다. bare import 검사는 완료 증거가 아니다.

## 2. R02 — file transactions / domain policy

### F-03 · P2 · Migration ledger orphan

근거: [ledger lock acquisition/cleanup](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/ledger.ts:96), [throttle consumer](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/run.ts:123). orphan `EEXIST`가 영구 false로 남고 best-effort caller는 기록 실패 후 진행한다.

- [x] **F-03.1** W0.3/W0.4 이후 ledger resource에 lock adapter를 주입한다. migration의 best-effort 결과와 lock failure reason은 분리한다.
- [x] **F-03.2** lock 아래 ledger re-read/validate/update/atomic replace를 수행하고 기존 orphan-sensitive wx 구현을 제거한다.
- [x] **F-03.3** 실제 child가 holder인 상태에서 kill한 뒤 새 process가 기록을 성공하는 rail과 live holder 비탈취 대조군을 추가한다.
- [x] **F-03.4** `runForScope`/persist consumer가 성공한 ledger 기록을 다음 실행의 throttle에 사용하는지 검증한다. lock helper 재획득 성공만으로 닫지 않는다.

### F-04 · P2 · OAuth CAS orphan

근거: [CAS claim](/Users/songmin/quanta-codeagent-v3/src/auth/node-lock-file-store.ts:33), [compareAndSwap](/Users/songmin/quanta-codeagent-v3/src/auth/node-lock-file-store.ts:70). `.cas`가 존재하면 실제 expected 비교 전에 changed로 종료한다.

- [x] **F-04.1** auth lease/generation 상태와 이를 갱신하는 파일 임계구역을 구분한다. domain CAS 의미는 `LockFileStorePort` owner에 남기고 token 내용은 logs에 넣지 않는다.
- [x] **F-04.2** 검증된 lock 아래 expected read→compare→replace/delete를 수행하고 permanent `.cas` wedge를 제거한다. `changed`와 I/O/lock unavailable은 계약에 맞게 구분한다.
- [x] **F-04.3** orphan recovery, concurrent equal-expected CAS single winner, CAS delete, I/O failure를 실제 multi-process rail로 검증한다. file mode 0600도 검사한다.
- [x] **F-04.4** ChatGPT refresh transaction까지 연결해 dead owner 이후 refresh가 진행되고 live refresh generation은 훼손되지 않음을 확인한다.

### F-09 · P2 · Permission live-steal / ABA

근거: [5초 stale 판단](/Users/songmin/quanta-codeagent-v3/src/permission/json-state-file/locking.ts:94), [무조건 unlink release](/Users/songmin/quanta-codeagent-v3/src/permission/json-state-file/locking.ts:147). age로 live holder를 제거할 수 있고 old release가 successor lock을 지운다.

- [x] **F-09.1** W0.3에서 stable inode/FD lifetime 또는 동등하게 증명된 primitive를 선택한다. read-token-then-unlink를 ABA 해결책으로 승인하지 않는다.
- [x] **F-09.2** permission read/merge/write 전체를 임계구역 안에 두고 mtime-only steal/unconditional unlink를 제거한다. abort/timeout도 소유 중인 handle만 정리한다.
- [x] **F-09.3** A holder >5초, B contender, C contender를 barrier로 제어해 동시에 한 writer만 진입함을 검증한다. A kill 후 B가 진행하는 경우도 포함한다.
- [x] **F-09.4** 지연된 old release가 new holder에 영향을 주지 않음을 테스트한다. 같은 process refcount가 독립 transaction을 동시에 허용하지 않는지도 검사한다.

### F-10 · P2 · Settings/hooks lost update

근거: [persistSettings](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/persist.ts:496), [persistHooks](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/persist.ts:529). 각각 atomic rename이지만 같은 settings file의 read→merge→rename은 잠기지 않는다.

- [x] **F-10.1** 두 writer가 동일 normalized resource key를 사용하게 한다. settings와 hooks용 별도 lock으로 나누지 않는다.
- [x] **F-10.2** critical section 안에서 최신 JSON을 읽고 해당 import delta만 merge한 뒤 strict atomic replace한다. 이전 read snapshot 기반 전체 overwrite를 제거한다.
- [x] **F-10.3** 두 OS process의 read/write를 barrier로 경합시켜 distinct setting/hook union과 unrelated keys 보존을 확인한다.
- [x] **F-10.4** 실제 command-hook loader가 merged 결과를 읽는 consumer rail과 malformed input/failure 시 기존 파일 보존을 확인한다.

### F-12 · P2 · Trust whole-map overwrite

근거: [TrustStore mutation/flush](/Users/songmin/quanta-codeagent-v3/src/config/trust-store.ts:67), [persistence root](/Users/songmin/quanta-codeagent-v3/src/apps/agent/index.ts:258), [grant producer](/Users/songmin/quanta-codeagent-v3/src/apps/agent/index.ts:392). 현재 reachable 문제는 distinct explicit grant 유실이며 revoke producer는 확인되지 않았다.

- [x] **F-12.1** persistence port를 `load + commit explicit mutations` 계약으로 바꾼다. pure config slice에 filesystem/auth/storage import를 추가하지 않는다.
- [x] **F-12.2** root adapter에서 lock→fresh read→현재 instance dirty delta만 merge→atomic replace를 수행한다. 성공한 flush 이후 해당 delta만 acknowledge하고 도중에 추가된 mutation은 남긴다.
- [x] **F-12.3** 서로 다른 cwd의 두 process가 같은 시작 snapshot에서 grant한 뒤 둘 다 남는지 확인한다. retry/double flush 및 flush 중 추가 grant도 포함한다.
- [x] **F-12.4** stale whole-map save를 제거하고 grant UI→flush→새 instance read까지 검증한다. 미입증 revoke-resurrection을 완료 범위로 부풀리지 않는다.

### F-13 · P2 · Live document truncate-rewrite

근거: [direct document write](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/persist.ts:458), [raw memory append-RMW](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/persist.ts:778). 실패 시 신규 block뿐 아니라 기존 bytes까지 손상될 수 있다.

- [x] **F-13.1** rules와 raw memory writer를 same-directory temp/sync/rename으로 연결한다. no-clobber/idempotency 의미와 기존 file mode를 보존한다. atomic replace와 overwrite 권한은 별개다.
- [x] **F-13.2** raw memory read+append+replace에는 같은 resource lock을 사용한다. torn-write 방지와 concurrent append union을 별도 invariant로 검증한다.
- [x] **F-13.3** temp write/sync/rename 실패 각각에서 old bytes 보존과 temp cleanup을 확인한다. rename 후 directory-sync 실패는 already-applied/uncertain durability로 명시하고 unchanged라고 하지 않는다.
- [x] **F-13.4** live glob-rule loader가 결과를 읽고 raw memory의 기존 block이 남음을 확인한다. 직접 truncate write와 EXDEV-copy 성공 fallback은 이 경로에서 제거한다.

### F-11 · P3 · Malformed ledger entry

근거: [envelope-only loader](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/ledger.ts:56), [entry dereference](/Users/songmin/quanta-codeagent-v3/src/migration/external-config/ledger.ts:85). `{entries:[null]}`이 `isThrottled`에서 TypeError를 만든다.

- [x] **F-11.1** entry required fields와 accepted version을 명시하고 element별 validator를 만든다. valid subset과 corruption diagnostic을 분리한다.
- [x] **F-11.2** unsafe cast를 제거하고 malformed subset 때문에 fail-soft migration startup이 throw하지 않게 한다. 원문 보존/후속 rewrite 정책을 함께 정한다.
- [x] **F-11.3** null/scalar/missing field/wrong type/valid mixed fixtures를 실제 throttle consumer로 통과시킨다.
- [x] **F-11.4** 정상 throttle 동작을 유지하고 malformed entry를 놓는 mutation에서 test가 RED인지 확인한다. 이 작업은 lock primitive 완료를 기다리지 않는다.

## 3. R03 — source-of-truth persistence

### SEP7-D-05 · P2 · Delete/save resurrection

근거: [save queue](/Users/songmin/quanta-codeagent-v3/src/session/store.ts:578), [queue 밖 delete](/Users/songmin/quanta-codeagent-v3/src/session/store.ts:874), [autosave producer](/Users/songmin/quanta-codeagent-v3/src/runner/orchestrate/persist-turn.ts:181).

- [x] **SEP7-D-05.1** save/delete/create의 순서와 generation 소유자를 정의한다. old autosave가 delete 이후 도착하는 경우와 정당한 새 create를 구분한다.
- [x] **SEP7-D-05.2** snapshot+index delete를 같은 per-session queue에 넣고 stale generation save를 거부한다. queue 안에서 queue-dependent flush를 기다리지 않는다.
- [x] **SEP7-D-05.3** parked save→delete waits→save release→delete complete→late old save 순서를 강제하고 snapshot/index 둘 다 부재임을 검사한다.
- [x] **SEP7-D-05.4** 실제 delete command/autosave consumer를 연결하고 unrelated session 저장은 진행됨을 확인한다. cross-process 미검증이면 그 보장은 receipt에서 제외한다.

### SEP7-D-06 · P2 · Corrupt index row loss

근거: [invalid row skip](/Users/songmin/quanta-codeagent-v3/src/session/index-store.ts:28), [upsert rewrite](/Users/songmin/quanta-codeagent-v3/src/session/index-store.ts:109), [list](/Users/songmin/quanta-codeagent-v3/src/session/index-store.ts:134).

- [x] **SEP7-D-06.1** snapshot은 원본, index는 projection으로 선언하고 invalid-row diagnostic/원문 보존/재구축 경로를 정한다. list마다 전체 scan을 강제하지 않도록 recovery trigger를 명시한다.
- [x] **SEP7-D-06.2** 발견된 손상을 valid snapshot으로 복구한 뒤 index를 교체한다. unreadable snapshot은 silent drop하지 않고 진단/원문을 남긴다.
- [x] **SEP7-D-06.3** corrupt one row→다른 session upsert→원래 session이 picker/list에 다시 보임을 확인한다. snapshot-write/index-write 사이 crash도 재발견해야 한다.
- [x] **SEP7-D-06.4** cross-session index RMW 직렬화와 delete/rebuild 경쟁을 검증한다. silent filtered-map overwrite를 제거하고 recovery 실패를 정상 empty list로 바꾸지 않는다.

### SEP7-D-07 · P2 · Corrupt snapshot as fresh resume

근거: [read result collapse](/Users/songmin/quanta-codeagent-v3/src/session/store.ts:463), [rehydrate consumer](/Users/songmin/quanta-codeagent-v3/src/sdk/runtime/session/rehydrate.ts:90), [durable-tip caller](/Users/songmin/quanta-codeagent-v3/src/sdk/runtime/runtime.ts:26).

- [x] **SEP7-D-07.1** read result를 found/missing/corrupt/unreadable로 정의하고 loader→SDK adapter까지 전달한다. public convenience API가 필요하면 명시 wrapper로 제한한다.
- [x] **SEP7-D-07.2** durable resume에서 corrupt/unreadable은 typed refusal, genuine missing은 기존 허용 정책으로 분기한다. 모든 catch→undefined를 제거한다.
- [x] **SEP7-D-07.3** nonzero log tip+malformed JSON/schema mismatch/read failure 각각이 `ResumeRehydrateRefusedError`인지 확인한다. missing/valid empty 정상 대조군을 포함한다.
- [x] **SEP7-D-07.4** 거절 후 원 snapshot/log가 덮어써지지 않고 fresh autosave가 시작되지 않음을 실제 runtime entry에서 검증한다.

### SEP7-D-10 · P2 · Unrelated update destroys corrupt BLOB

근거: [decode→save update](/Users/songmin/quanta-codeagent-v3/src/memory/adapters/sqlite.ts:233), [corrupt embedding omit](/Users/songmin/quanta-codeagent-v3/src/memory/adapters/sqlite.ts:328). omitted embedding이 whole-row save에서 SQL NULL로 바뀐다.

- [x] **SEP7-D-10.1** update patch의 미지정/set/clear semantics를 정하고 column-local SQL update를 사용한다. column 이름은 closed allowlist로 제한한다.
- [x] **SEP7-D-10.2** embedding을 소유하지 않는 update에서 decode/reserialize를 제거한다. 다른 metadata default/merge 의미도 기존 계약을 유지한다.
- [x] **SEP7-D-10.3** raw BLOB `00`을 심고 text/score-only update 후 SQL raw bytes가 동일하고 corruption callback도 계속 관측되는지 확인한다.
- [x] **SEP7-D-10.4** explicit embedding set/clear, missing row, transaction failure를 검증한다. 이 수정은 session repository abstraction에 결합하지 않는다.

## 4. R04 — patch semantics / recovery truth

### H-PATCH-01 · P1 · Rename metadata loss

근거: [rename discard](/Users/songmin/quanta-codeagent-v3/src/patch/unified-to-v4a.ts:101), [old-path emit](/Users/songmin/quanta-codeagent-v3/src/patch/unified-to-v4a.ts:201), [실제 tool conversion](/Users/songmin/quanta-codeagent-v3/src/tool/apply-patch.ts:406).

- [x] **H-PATCH-01.1** file-section IR에 from/to/rename metadata를 보존하고 consistency/path checks 후 canonical V4A로 변환한다.
- [x] **H-PATCH-01.2** rename+edit/rename-only를 `Update File`+`Move to`로 표현한다. public parsed op는 기존 `kind:"update", moveTo`이며 새 move variant를 만들 필요가 없다.
- [x] **H-PATCH-01.3** 기존 S-OP-5의 wrong-path 기대를 뒤집고 old path 부재/new path edited bytes/moved result를 apply-level로 검증한다.
- [x] **H-PATCH-01.4** malformed/inconsistent rename, destination collision, quoted path/symlink 정책을 확인하고 metadata discard fallback을 제거한다.

### H-PATCH-02 · P2 · Rollback incomplete hidden

근거: [unconditional rolled-back error](/Users/songmin/quanta-codeagent-v3/src/patch/applier.ts:122), [undo error swallow](/Users/songmin/quanta-codeagent-v3/src/patch/applier.ts:226), [unchanged message](/Users/songmin/quanta-codeagent-v3/src/patch/message-for-model.ts:70).

- [x] **H-PATCH-02.1** original commit failure와 undo results를 분리한 typed outcome을 정의한다. unchanged는 모든 required undo 성공일 때만 허용한다.
- [x] **H-PATCH-02.2** inverse journal을 mutation 전에 준비하고 mutate-then-throw도 복구 대상에 넣는다. undo failure는 path/cause와 함께 수집한다.
- [x] **H-PATCH-02.3** commit failure+undo failure를 주입해 실제 partial bytes와 `rollbackIncomplete`가 일치하는지 검사한다. 성공 rollback 대조군은 unchanged를 유지한다.
- [x] **H-PATCH-02.4** model-facing formatter/tool result까지 ambiguous/dirty 상태를 전파하고 swallow/무조건 clean 문구를 제거한다. multi-file crash atomicity를 새로 보장한다고 하지 않는다.

## 5. R05 — side-agent lifecycle

### H-SA-02 · P1 · Process backer cadence/bounds absent

근거: [shared contract](/Users/songmin/quanta-codeagent-v3/src/side-agent/types.ts:150), [process spawn](/Users/songmin/quanta-codeagent-v3/src/side-agent/process-registry.ts:227), [single charter send](/Users/songmin/quanta-codeagent-v3/src/side-agent/process.ts:218).

- [x] **H-SA-02.1** parent-owned spec validation/trigger admission/lifecycle state machine을 추출하고 양 backer를 runPass 실행 adapter로 둔다.
- [x] **H-SA-02.2** wakeId terminal당 1회 accounting, non-overlap, bounded event coalescing, interval/maxWakes/idle reap/stop을 구현한다. finding 수에 따른 wake count를 제거한다.
- [x] **H-SA-02.3** 같은 contract suite를 in-process/process backer에 적용해 invalid spec, repeated wake, max stop, idle reap, multiple finding 한 wake를 검증한다.
- [x] **H-SA-02.4** 실제 child readiness/kill/late terminal에서도 timer/listener/concurrency budget이 반환되는지 검증한다. registry가 running이라고만 하는 one-shot 경로를 제거한다.

### H-SA-01 · P2 · Synthetic finding on null/failure

근거: [null collapse](/Users/songmin/quanta-codeagent-v3/src/side-agent/worker-entry.mjs:68), [synthetic finding emission](/Users/songmin/quanta-codeagent-v3/src/side-agent/worker-entry.mjs:133), [null contract](/Users/songmin/quanta-codeagent-v3/src/side-agent/types.ts:39).

- [x] **H-SA-01.1** IPC terminal을 no_finding/failed/cancelled/completed-with-findings로 구별하고 version/wakeId 검증을 추가한다. 정확한 wire spelling은 R05 계약에서 한 번만 정의한다.
- [x] **H-SA-01.2** 정상 null과 LLM import/provider/pass failure를 다른 결과로 유지한다. 둘 다 finding feed에 synthetic text를 추가하지 않는다.
- [x] **H-SA-01.3** viable LLM seam의 null/throw/empty/real finding으로 OS-worker rail을 실행하고 feed 내용과 wake accounting을 검증한다.
- [x] **H-SA-01.4** failure는 status/diagnostic channel에서만 관측하고 no_finding은 정상 terminal임을 확인한다. parent/child의 구식 fallback decoder를 제거한다.

## 6. R06 — scheduler recovery

### G-F4 · P2 · Durable running row stuck

근거: [reclaimBefore + claimToken](/Users/songmin/quanta-codeagent-v3/src/scheduler/automation-engine/port.ts:205), [ticker claim caller](/Users/songmin/quanta-codeagent-v3/src/scheduler/automation-engine/ticker.ts:110). engine 기능은 존재하지만 live ticker가 reclaim을 전달하지 않는다.

- [x] **G-F4.1** renewal 또는 실행 상한/ownership proof와 reclaim window를 함께 정한다. 기존 claimToken/finalize fence를 재사용하며 두 번째 lease 체계를 만들지 않는다.
- [x] **G-F4.2** ticker와 composition에 정책을 배선하고 renewal/ownership-lost/cancel outcome을 처리한다. old token의 finalize는 계속 거절한다.
- [x] **G-F4.3** durable child claim→kill→restart ticker→reclaim 및 live long-running 비탈취를 검증한다. engine 단독 호출이 아니라 실제 ticker rail을 사용한다.
- [x] **G-F4.4** 외부 부작용 attempt identity와 replay 정책을 정한다. exactly-once를 약속하지 않고 결과 불명 비멱등 실행은 recovery-required로 남긴다.

## 7. R07 — cancellation ownership

### G-F12 · P2 · Pending user input survives turn abort

근거: [pending map registration](/Users/songmin/quanta-codeagent-v3/src/apps/web-daemon/web-user-input-port.ts:118), [socket-only cleanup](/Users/songmin/quanta-codeagent-v3/src/apps/web-daemon/server/ws-handlers.ts:500).

- [x] **G-F12.1** request를 session/turn/prompt identity와 originating signal에 묶고 정확히 한 번 settle하는 cleanup을 정한다.
- [x] **G-F12.2** turn abort에서 해당 요청만 cancel한다. terminal event는 보조 cleanup이며 blocked tool 종료를 기다리는 terminal만으로 취소하지 않는다.
- [x] **G-F12.3** socket 유지+request pending+turn abort에서 promise settled/pending 0을 검증한다. late answer와 같은 connection의 다른 turn도 테스트한다.
- [x] **G-F12.4** success/failure/abort/socket close race의 listener/timer 제거를 검증하고 global cancelAll로 무관한 turn을 지우는 구현은 넣지 않는다.

### F-08 · P2 · OAuth loopback listener leak

근거: [received-only close](/Users/songmin/quanta-codeagent-v3/src/auth/chatgpt-oauth/cli-callback.ts:306), [opener and timeout race](/Users/songmin/quanta-codeagent-v3/src/auth/chatgpt-oauth/browser-flow.ts:134), [handle contract](/Users/songmin/quanta-codeagent-v3/src/auth/chatgpt-oauth/callback-port.ts:41).

- [x] **F-08.1** callback handle에 idempotent close/cancel 또는 flow-owned abort 계약을 정의하고 opener 이전부터 flow가 자원을 소유하게 한다.
- [x] **F-08.2** success/timeout/open throw/caller abort 모두 finally에서 listener/timer/pending receive를 정리한다.
- [x] **F-08.3** 각 종료 경로 직후 실제 loopback port에 다시 bind하고 두 번째 login 시도가 진행되는지 확인한다.
- [x] **F-08.4** close-vs-callback race와 unhandled rejection을 검증한다. 성공 callback만 자원을 해제하는 기존 경로를 제거한다.

## 8. R08 — LSP cache / waiter

### P2-A-02 · P2 · Shadow negative cache

근거: [독립 cache](/Users/songmin/quanta-codeagent-v3/src/agent/shadow-verify-adapters/check-lsp-test.ts:63), [canonical false eviction](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge/availability.ts:47).

- [x] **P2-A-02.1** shadow probe의 binary/timeout/context를 canonical availability 계약에 매핑한다.
- [x] **P2-A-02.2** false/rejected result를 영구 cache하는 별도 Map을 제거하고 canonical success-only cache에 위임한다.
- [x] **P2-A-02.3** false→true probe에서 두 번째 호출이 실제 probe하고 shadow check가 복구됨을 검증한다. concurrent in-flight dedup도 보존한다.
- [x] **P2-A-02.4** 성공 cache 재사용·binary key 분리·timeout을 검사하고 false cache를 되살린 mutation에서 RED를 확인한다.

### P2-A-05 · P2 · Diagnostics null/reject cache

근거: [open promise cache](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-diagnostics-hook.ts:74), [production null opener](/Users/songmin/quanta-codeagent-v3/src/agent/lsp-bridge/diagnostics.ts:33).

- [x] **P2-A-05.1** in-flight dedup와 successful-session reuse는 유지하고 null/rejection만 재시도 가능하게 정의한다.
- [x] **P2-A-05.2** entry promise identity를 비교한 conditional eviction을 구현한다. 늦은 실패가 새 client를 제거하지 않게 한다.
- [x] **P2-A-05.3** null→live, rejection→live, concurrent opens, old failure/new success race를 실제 edit-triggered diagnostics consumer로 검증한다.
- [x] **P2-A-05.4** dispose-during-open의 late client close와 rejection handling을 확인하고 permanent negative entry를 제거한다.

### C-F12 · P3 · Diagnostics timeout waiter retention

근거: [timeout](/Users/songmin/quanta-codeagent-v3/src/lsp/adapters/base/diagnostics-hub.ts:18), [publish/teardown cleanup](/Users/songmin/quanta-codeagent-v3/src/lsp/adapters/base/diagnostics-hub.ts:42).

- [x] **C-F12.1** waiter에 개별 identity와 idempotent finish 함수를 두고 timeout/publish/dispose를 같은 cleanup에 연결한다.
- [x] **C-F12.2** timeout에서 자기 callback을 제거하고 빈 URI key만 삭제한다. 같은 URI 전체를 지우지 않는다.
- [x] **C-F12.3** 반복 timeout 후 retained callbacks/keys가 0인지 fake timer로 확인한다. concurrent live waiter는 late publish로 정상 resolve해야 한다.
- [x] **C-F12.4** publish-timeout-dispose 경쟁에서 중복 settle/timer leak이 없는지 검증한다. 세션 teardown까지 기다리는 cleanup 의존을 제거한다.

## 9. R09 — pricing provenance

### P1-A-02 · P1 · Meter/ledger pricing policy divergence

근거: [meter pricingKnown gate](/Users/songmin/quanta-codeagent-v3/src/agent/loop/emit-helpers.ts:99), [ledger raw reprice sink](/Users/songmin/quanta-codeagent-v3/src/agent/loop/emit-helpers.ts:121), [fallback](/Users/songmin/quanta-codeagent-v3/src/agent/budget-ledger.ts:454), [stop consumer](/Users/songmin/quanta-codeagent-v3/src/agent/loop/stop-conditions.ts:68).

- [x] **P1-A-02.1** canonical normalized usage+eventCost+provenance를 ledger까지 전달하는 계약을 정의한다. known/unknown/estimated enforcement 정책을 W0.6에서 고정한다.
- [x] **P1-A-02.2** ledger의 implicit fallback 재가격화/enforcement를 제거하고 unknown은 현재 정책대로 USD breach에서 제외한다. token/time budgets와 known-model 비용은 유지한다.
- [x] **P1-A-02.3** 실제 emitUsage→meter+ledger→stop에서 unknown model/낮은 hard limit을 넣어 USD stop 없음, known 초과에서는 stop임을 검증한다.
- [x] **P1-A-02.4** cross-run persistence/hydration 및 advisory sink가 동일 provenance를 사용하는지 검사한다. legacy 값의 출처가 없으면 known으로 승격하지 않는다.

### G-F15 · P2 · Unpriced eval reported as zero

근거: [count와 cost 분리 유실](/Users/songmin/quanta-codeagent-v3/src/apps/eval/report/coverage-matrix.ts:123), [zero defaults](/Users/songmin/quanta-codeagent-v3/src/apps/eval/report/coverage-matrix.ts:185), [always-dollar rendering](/Users/songmin/quanta-codeagent-v3/src/apps/eval/report/markdown.ts:41).

- [x] **G-F15.1** rollup에 known subtotal과 pricing completeness/unpriced count를 보존한다. 토큰 있음과 가격 측정됨을 다른 사실로 유지한다.
- [x] **G-F15.2** all-unknown은 unavailable, mixed는 partial subtotal, 실제 known-zero는 zero로 렌더링한다. headline과 상세 table을 같은 projection에 연결한다.
- [x] **G-F15.3** all-unknown/mixed/known-zero/known-positive/no-usage fixtures로 markdown과 structured report를 함께 검증한다.
- [x] **G-F15.4** `$0` default로 completeness를 숨기는 경로를 제거하고 report consumers/기존 schema reader의 호환을 확인한다.

## 10. R10 — search availability / vector identity

### E-SEARCH-01 · P2 · Explicit failed backend reports ready/no-hit

근거: [null initialization](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-index-backend.ts:604), [ready + noop ports](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-index-backend.ts:800), [search consumer](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-pipeline.ts:222), [mention consumer](/Users/songmin/quanta-codeagent-v3/src/host/runtime/internal/mention-symbol-deps.ts:140).

- [x] **E-SEARCH-01.1** single-flight async readiness와 typed unavailable contract를 정하고 initialization/operation 실패를 구분한다.
- [x] **E-SEARCH-01.2** 실제 operations가 readiness를 await하고 search/mention consumer가 failure를 처리하게 한다. static state field 추가만으로 끝내지 않는다.
- [x] **E-SEARCH-01.3** valid explicit store의 create/capability/remote failure를 넣어 no-hit와 구별되는 결과를 검증한다. 정상 explicit/no-hit 대조군을 둔다.
- [x] **E-SEARCH-01.4** null→[]/noop 및 explicit store 자동 대체를 제거한다. partial upsert/retry의 caller-visible 결과도 명시한다.

### E-EMBED-01 · P2 · Embedding space mismatch

근거: [fallback chain](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-index-backend.ts:239), [64d return](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-index-backend.ts:294), [dimension truncation](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/search-index-backend.ts:349). 앞선 probe는 1536d provider 실패+32,769 bytes에서 64d를 반환했다.

- [x] **E-EMBED-01.1** model/revision/dimension/normalization을 포함한 embedding-space identity를 index/query에 고정한다. dimension만 맞춘 hash도 허용하지 않는다.
- [x] **E-EMBED-01.2** provider 실패 시 typed error 또는 같은 model의 명시 chunking을 사용한다. hash mode가 필요하면 전체 index를 별도 namespace에 둔다.
- [x] **E-EMBED-01.3** 32,769-byte 실패, same-dimension/different-model, query/index mismatch를 RED→GREEN으로 검증하고 silent cosine truncation을 제거한다.
- [x] **E-EMBED-01.4** old index의 identity 불명 상태를 검증/rebuild로 전환한다. new index 완료 전 old index를 덮거나 삭제하지 않고 rollback/read compatibility를 확인한다.

## 11. R11 — MCP carrier / session lifecycle

### C-F1 · P1 · Isolation knob unwired

근거: [flag parser](/Users/songmin/quanta-codeagent-v3/src/mcp/isolated-client.ts:56), [normal host client](/Users/songmin/quanta-codeagent-v3/src/host/mcp-composition.ts:121), [transport seam](/Users/songmin/quanta-codeagent-v3/src/mcp/client/transport-factory.ts:1). 추가 구현 전제: [DXT first-line consume](/Users/songmin/quanta-codeagent-v3/src/plugin-isolation/bun-spawner.ts:521).

- [x] **C-F1.1** 기존 McpClient core를 유지하고 isolated McpTransport adapter를 설계한다. 별도 client를 활성화해 protocol 기능이 줄어드는 교체는 피한다.
- [x] **C-F1.2** OS process-ready와 DXT ready-line mode를 분리해 initialize를 기다리는 표준 stdio server가 시작 가능하게 한다. dead/oversize send는 typed failure로 전달한다.
- [x] **C-F1.3** normal/supervised/skill/plugin construction에서 동일 factory를 사용하고 flag OFF/ON, 기존 manifest isolation 정책, timeout/TERM→KILL을 production 경로로 검증한다.
- [x] **C-F1.4** IsolatedMcpClient의 중복 protocol state를 delegating facade로 축소/제거하고 feature YAML을 실제 동작과 맞춰 build한다. DXT control과 실제 stdio child를 둘 다 통과해야 한다.

### C-F9 · P2 · Reauth without initialize

근거: [start-only replacement](/Users/songmin/quanta-codeagent-v3/src/mcp/client.ts:822), [fresh sessionId state](/Users/songmin/quanta-codeagent-v3/src/mcp/transports/http-sse.ts:231), [session/protocol negotiation](/Users/songmin/quanta-codeagent-v3/src/mcp/transports/http-sse.ts:336).

- [x] **C-F9.1** generation-scoped replacement transaction과 single-flight reauth를 정의한다. initialize 중 401이 자기 refresh를 기다리는 recursion을 막는다.
- [x] **C-F9.2** candidate start→initialize→initialized→publish 순서를 구현하고 old pending requests의 outcome, stale response, stop/failed candidate cleanup을 명시한다.
- [x] **C-F9.3** stateful HTTP fixture로 401→새 session id/protocol pin→허용된 retry를 검증한다. concurrent 401/initialize 실패/stop-during-refresh/old response를 포함한다.
- [x] **C-F9.4** 완료 불명 side-effecting tool call을 자동 replay하지 않는다. old close/DELETE가 새 session에 영향을 주지 않는지 확인하고 start-only swap을 제거한다.

## 12. R12 — session typed boundary

### C-F2 · P2 · Missing typed verbs

근거: [canonical commands](/Users/songmin/quanta-codeagent-v3/src/protocol/session/commands.ts:207), [surface omissions](/Users/songmin/quanta-codeagent-v3/src/protocol/session/verb-surface.ts:55), [wire builders](/Users/songmin/quanta-codeagent-v3/src/ipc/session/handle.ts:675), [SDK conformance](/Users/songmin/quanta-codeagent-v3/src/sdk/runtime/handle-adapter.ts:43).

- [x] **C-F2.1** command discriminant별 public/internal visibility와 executor mapping을 exhaustively 정의한다. host-only `turn.submit` 등은 explicit exclusion이며 외부 공개하지 않는다.
- [x] **C-F2.2** objective/posture/skill verb를 양 builder에 연결하고 canonical command encoding을 사용한다. wire receipt와 execution completion semantics를 유지한다.
- [x] **C-F2.3** 세 command의 wire→kernel 결과와 in-process 결과를 conformance rail로 비교한다. permissions/error/receipt correlation도 검사한다.
- [x] **C-F2.4** 새 command에 mapping 없으면 compile/test 실패하게 하고 private command 노출도 실패하게 한다. public surface별 수동 누락 가능 목록을 제거한다.

### C-F11 · P2 · Event payload unchecked

근거: [envelope 이후 cast](/Users/songmin/quanta-codeagent-v3/src/protocol/session/codec.ts:238), [approval dereference](/Users/songmin/quanta-codeagent-v3/src/ipc/session/handle.ts:345), [persisted replay](/Users/songmin/quanta-codeagent-v3/src/kernel/session/event-log-jsonl.ts:209).

- [x] **C-F11.1** 모든 event discriminant에 payload validator를 배정한다. required/optional/version semantics는 protocol owner에 두고 kernel domain policy를 역import하지 않는다.
- [x] **C-F11.2** common envelope 다음 payload validation을 수행하고 invalid event를 consumer 이전에 typed decode error로 반환한다.
- [x] **C-F11.3** event variant당 valid case와 required-field malformed case를 생성해 exhaustive table/floor를 검사한다. `approval:null` wire 및 persisted-log rail을 포함한다.
- [x] **C-F11.4** corrupt replay는 원문 보존+typed refusal/diagnostic이며 silently skip 또는 재저장으로 숨기지 않는다. existing optional/version fixtures와 unsafe cast 제거를 확인한다.

## 13. R13 — benchmark family profile

### G-F5 · P1 · ProMax bootstrap / readiness divergence

근거: [boxGrade early return](/Users/songmin/quanta-codeagent-v3/src/apps/bench/remote/box-session/ec2-lifecycle.ts:483), [skipped family setup](/Users/songmin/quanta-codeagent-v3/src/apps/bench/remote/box-session/ec2-lifecycle.ts:520), [swebench-only readiness](/Users/songmin/quanta-codeagent-v3/src/apps/bench/remote/box-session/ec2-lifecycle.ts:711).

- [x] **G-F5.1** 기존 dataset profile에서 required setup/probes를 정의하고 bootstrap와 warm selection이 같은 profile을 소비하게 한다.
- [x] **G-F5.2** common setup→optional grader shim→항상 family setup→profile readiness로 phase를 분리한다. boxGrade 전체 early return과 universal swebench probe를 제거한다.
- [x] **G-F5.3** fake SSH로 ProMax setup 1회 및 warm reuse, SWE-bench shim control, phase failure non-ready를 검증한다.
- [ ] **G-F5.4** 실제 EC2 provision/reuse proof가 필요하면 승인된 환경에서 별도 수행한다. 비용 있는 실행을 자동 시작하지 않고 local-only proof gap을 명시한다.

## 14. R14 — remote production wiring

### G-F9 · P1 · Docker/Lima seam absent

근거: [empty production seams](/Users/songmin/quanta-codeagent-v3/src/apps/cli/index.ts:95), [required Docker/Lima ports](/Users/songmin/quanta-codeagent-v3/src/remote/runner/registry.ts:47).

- [x] **G-F9.1** CLI-local dependency builder에서 Docker process와 Lima process/VM 설정을 resolve한다. selection 자체는 backend command를 실행하지 않는다.
- [x] **G-F9.2** integrator가 CLI selector에 adapter를 주입하고 disabled/misconfigured/unavailable 결과를 CLI code/message로 연결한다. shell string 대신 argv를 사용한다.
- [x] **G-F9.3** 실제 CLI route에 fake adapter를 넣어 env docker/lima 선택이 factory 및 operation dispatch까지 도달하는지 검사한다. default/unset/missing binary/VM도 포함한다.
- [x] **G-F9.4** empty-seam 경로를 제거하고 실제 Docker/Lima runtime rail을 설치 환경에서 분리해 기록한다. P1이므로 배정된 W3-I 안에서 R14를 첫 순서로 통합한다.

## 15. R15 — configuration truth

### E-PROV-01 · P2 · Wrong status provider

근거: [legacy picker](/Users/songmin/quanta-codeagent-v3/src/llm/factory.ts:424), [actual transport ladder](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/llm.ts:446), [status consumer](/Users/songmin/quanta-codeagent-v3/src/apps/cli/status-cmd.ts:57), [doctor consumer](/Users/songmin/quanta-codeagent-v3/src/apps/cli/doctor/default-probes.ts:32).

- [x] **E-PROV-01.1** existing transport resolver에 requested/effective/reason DTO를 정의한다. credential provider와 actual transport를 같은 field로 뭉개지 않는다.
- [x] **E-PROV-01.2** live status는 boot snapshot, preflight doctor는 동일 resolver의 현재 결과를 표시한다. cloud ladder를 consumer에 복사하지 않는다.
- [x] **E-PROV-01.3** Bedrock/Vertex/Foundry/Mantle 각 selector와 legacy control에서 constructed adapter↔status↔doctor를 비교한다.
- [x] **E-PROV-01.4** 독립 pickProvider 기반 진단을 제거하고 DTO/log에 credential 값이 없으며 live/preflight 시점 차이를 구분하는지 확인한다.

### G-F6 · P2 · Eval env precedence

근거: [eval reverse order](/Users/songmin/quanta-codeagent-v3/src/apps/eval/index.ts:165), [CLI canonical load](/Users/songmin/quanta-codeagent-v3/src/apps/cli/index.ts:30), [shared loader](/Users/songmin/quanta-codeagent-v3/src/shared/env-files.ts:1).

- [x] **G-F6.1** eval을 shared loader의 `.env.dev → .env.local → .env` first-wins에 연결하고 기존 shell env 우선권을 유지한다.
- [x] **G-F6.2** eval의 독립 parser/order loop를 제거한다. dotenv values를 provenance log에 출력하지 않는다.
- [x] **G-F6.3** temp directory 세 env 파일의 충돌 key와 shell override를 실제 entrypoint loader rail로 검증한다.
- [x] **G-F6.4** missing file/empty value/기존 env/다른 cwd 대조군을 확인한다. process.env singleton rail은 child process로 격리한다.

### E-KNOB-01 · P3 · Runtime/bench boolean mismatch

근거: [read-outline local set](/Users/songmin/quanta-codeagent-v3/src/runner/knobs/knobs/read-outline.ts:17), [test-runner local set](/Users/songmin/quanta-codeagent-v3/src/runner/knobs/knobs/test-runner.ts:17), [canonical tokens](/Users/songmin/quanta-codeagent-v3/src/shared/env-flag.ts:24).

- [x] **E-KNOB-01.1** 두 parser를 기존 `isTruthyToken`에 위임한다. shared vocabulary를 두 번째 상수로 복사하지 않는다.
- [x] **E-KNOB-01.2** local ENABLING set을 제거하고 rejected/disabled 처리 의미를 runtime 계약과 맞춘다.
- [x] **E-KNOB-01.3** 모든 canonical true/false/unrecognized token을 runtimeConfig와 resolveBenchKnobs에 넣어 활성화 및 report metadata parity를 검증한다.
- [x] **E-KNOB-01.4** `yes` 제거 mutation에서 actual bench report rail이 RED인지 확인한다. parser helper만 검사하지 않는다.

## 16. R16 — authority inputs / explicit degradation

### G-F11 · P2 · Org skill authority unwired

근거: [CLI snapshot inputs](/Users/songmin/quanta-codeagent-v3/src/apps/cli/repl/session-setup.ts:350), [web inputs](/Users/songmin/quanta-codeagent-v3/src/apps/web-daemon/authority-readouts.ts:97), [missing→null authority](/Users/songmin/quanta-codeagent-v3/src/runner/assemble/session-authorities/build-skills.ts:68).

- [x] **G-F11.1** org path resolution을 기존 authority 입력 계약에 맞추고 undefined default와 explicit null opt-out을 구별한다.
- [x] **G-F11.2** CLI/web composition에서 한 번 resolve한 org dir을 snapshot에 전달한다. admin/banned/required 해석은 기존 skill authority만 수행한다.
- [x] **G-F11.3** temp org policy/admin skill fixtures로 두 surface의 actual active set 및 banned/required enforcement 변화, env/default/opt-out을 검증한다.
- [x] **G-F11.4** malformed org policy의 기존 failure policy를 유지하고 wiring catch로 silently disable하지 않는다. org input 누락 및 중복 policy parser를 제거한다.

### G-F8 · P3 · Silent permission fallback

근거: [CLI silent catch](/Users/songmin/quanta-codeagent-v3/src/apps/cli/repl.ts:288), [web warning control](/Users/songmin/quanta-codeagent-v3/src/apps/web-daemon/runtime-factory.ts:272).

- [x] **G-F8.1** durable load failure의 effective fallback과 scrubbed cause/path warning 계약을 정한다. fail-soft 정책 자체는 변경하지 않는다.
- [x] **G-F8.2** loader rejection에서 warning sink를 정확히 1회 호출하고 기존 undefined fallback을 유지한다.
- [x] **G-F8.3** read/permission/parse failure, success, warning-sink failure fixtures로 fallback/경고 횟수와 secret 비노출을 검증한다.
- [x] **G-F8.4** CLI 실제 boot consumer에서 degraded posture가 관측되는지 확인하고 silent catch를 제거한다. 일반 startup error framework까지 확장하지 않는다.

### G-F13 · P3 · Silent repo-rules fallback

근거: [agent preset silent catch](/Users/songmin/quanta-codeagent-v3/src/apps/agent/mode-presets/system.ts:42), [web diagnostic control](/Users/songmin/quanta-codeagent-v3/src/apps/web-daemon/runtime-factory/agent-config-base.ts:228).

- [x] **G-F13.1** preset rule loader에 warning sink를 주입하고 no-rules fallback/원인/path의 관측 계약을 정한다. fail-open 정책은 유지한다.
- [x] **G-F13.2** load failure 때 warning 1회와 규칙 없는 결과를 반환한다. diagnostic failure가 기존 fallback을 throw로 바꾸지 않게 한다.
- [x] **G-F13.3** successful load/no file/read failure/parse failure를 구분하고 실제 preset prompt 및 warning을 함께 검증한다.
- [x] **G-F13.4** silent catch를 제거하고 cwd/cause에 포함될 수 있는 credential/path-sensitive 내용을 기존 redaction 정책으로 처리한다.

## 17. 기존 테스트 재사용 지도

아래 경로는 **현재 존재하는 출발점**이다. 현재 finding을 이미 잡는다는 뜻이 아니다. test 내용을 먼저 읽고 새 실패 case를 추가한다. 필요한 real-consumer/OS-child test가 없으면 package 내부에 새 rail을 만든 뒤 CI selection에 등록한다.

| Package | 확장할 기존 suite (repo-relative) | 별도로 확보할 proof |
|---|---|---|
| R01 | `tests/unit/security/sensitivity-classifier.test.ts`, `tests/unit/stdout.test.ts`, `tests/unit/sep8-remediation/r01/`, `tests/integration/sep8-remediation/r01/f07-classify-redact-path.test.ts` | live bash `classifySource` → dispatcher → JSONL disk readback |
| R02 | `tests/unit/auth/node-lock-file-store.test.ts`, `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts`, `tests/unit/config-migration-persist-atomic-hellgate.test.ts`, `tests/unit/central-config-trust-store-hellgate.test.ts` | 실제 2/3-process contention/kill/legacy-writer 전환 |
| R03 | `tests/unit/session-index.test.ts`, `tests/unit/session-store.test.ts`, `tests/integration/memory-sqlite.test.ts` | save/delete barrier, runtime durable resume, raw SQLite BLOB readback |
| R04 | `tests/unit/patch/unified-to-v4a-scenarios.test.ts`, `tests/unit/patch/applier-rollback-rename-delete.test.ts`, `tests/unit/sep8-remediation/r04/`, `tests/integration/sep8-remediation/r04/` | apply-tool rename와 Incomplete → dispatch preview (`h-patch-02-tool-result.test.ts`) |
| R05 | `tests/unit/side-agent-process-registry-hellgate.test.ts`, `tests/integration/side-agent-process-os-fork-e2e.test.ts`, `tests/integration/side-agent-process-llm-charter-e2e.test.ts` | 공통 backer contract + child no-finding terminal |
| R06 | `tests/unit/automation-engine-hellgate.test.ts`, `tests/integration/automation-engine-tick-wire-hellgate.test.ts` | durable child kill/restart + live renewal |
| R07 | `tests/unit/web-user-input-port-lifecycle-hellgate.test.ts`, `tests/integration/web-user-input-port-e2e.test.ts`, `tests/unit/auth/chatgpt-oauth-adapter.test.ts` | turn-scoped abort; 실제 loopback 재bind |
| R08 | `tests/unit/shadow-verify-adapters-hellgate.test.ts`, `tests/unit/lsp-diagnostics-hook-hellgate.test.ts` | timed-out waiter retention/race rail |
| R09 | `tests/unit/budget-ledger-pricing-ssot-hellgate.test.ts`, `tests/unit/budget-ledger-persist-hellgate.test.ts`, `tests/integration/budget-ledger-real-loop-e2e.test.ts`, `tests/unit/sep8-remediation/r09/` | unknown pricing cross-sink/stop; eval `projectEvalCost` (`costUsd:null` = unpriced) |
| R10 | `tests/unit/runner/search-index-backend.test.ts`, `tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts` | actual search/mention refusal + identity migration |
| R11 | `tests/unit/mcp/transport-port-hellgate.test.ts`, `tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts`, `tests/unit/mcp-oauth-coalesce-concurrency-r4-hellgate.test.ts`, `tests/unit/mcp/protocol-version-http-header-hellgate.test.ts` | no-sentinel stdio server, stateful HTTP auth/session generation |
| R12 | `tests/unit/protocol/session-codec.test.ts`, `tests/unit/ipc/session-handle-conformance.test.ts`, `tests/integration/sdk-connect-session-handle-e2e.test.ts` | 새 세 verb의 wire/in-process 및 malformed persisted-event replay |
| R13 | `src/apps/bench/profiles/registry.test.ts` | bootstrap/warm reuse fake SSH와 승인된 실제 EC2를 구분 |
| R14 | `tests/unit/remote/runner-port-hellgate.test.ts`, `src/remote/runner/__tests__/lima-injection-hellgate.test.ts` | actual CLI route fake dispatch + 실제 Docker/Lima |
| R15 | `tests/unit/bench-knobs-wiring-hellgate.test.ts`, `tests/unit/llm-providers/claude-use-quartet-wiring-hellgate.test.ts` | boot/status/doctor + eval temp-env precedence |
| R16 | `tests/unit/skill/runtime/skill-runtime-authority-hellgate.test.ts` | CLI/web org input, permission/repo-rules failure warning |

## 18. 통합 액션 / completion checklist

- [ ] **I.1** 각 finding의 `.1` 계약, `.2` owner 변경, `.3` failure rail, `.4` consumer/제거/호환 작업을 완료한다. 각 checkbox에 diff/receipt를 연결하기 전 체크하지 않는다. G-F5.4 유료 EC2 proof가 열려 있으므로 전역 완료는 미체크다.
- [x] **I.2** code/test 변경 후 기존 authority 우회 경로가 없는지 production constructor/producer census를 재실행한다. 이름 grep만으로 제거 완료를 선언하지 않는다.
- [x] **I.3** public API/IPC/저장 포맷 compatibility matrix를 채운다: old reader/new writer, new reader/old writer, mixed process, restart/rollback. 미지원 조합은 실행 차단 또는 명시 migration으로 처리한다.
- [x] **I.4** token/path/secret·corrupt bytes·old index는 보존/진단 정책을 지킨다. recovery를 위해 원본을 삭제하는 자동 cleanup을 추가하지 않는다.
- [x] **I.5** package별 targeted test/정상 대조군/mutation과 typecheck/lint/slice-boundary/god-code/cohort/lint-debt gate를 실행한다. 코드 행수·경고 ceiling 증가는 금지한다.
- [ ] **I.6** serial integrator가 composition roots/exports/catalog를 연결하고 exact integrated source에서 cross-surface smoke와 repository prepush campaign을 실행한다. generated catalog는 YAML에서만 build한다. 현재 source truth tree가 dirty이므로 exact-tree prepush receipt는 아직 없다.
- [x] **I.7** receipt에 source digest·환경·명령·assertion·RED/GREEN/mutation·삭제 경로·compatibility·미검증 runtime 범위를 적는다. fake process와 실제 OS child, 로컬과 cloud 결과를 섞지 않는다.
- [x] **I.8** 최종 39개 status를 집계한다. 남은 proof gap은 open으로 두고 구현률·테스트 통과·CI·merge·runtime 적용을 따로 보고한다.

## 19. 계획 검증과 실행 금지선

- 이 액션리스트 작성은 제품 코드 변경·commit/push·유료 runtime 실행을 포함하지 않는다.
- 기계 검사 결과: finding 39개/severity 일치, package 16개, 각 finding에 고유 액션 4개, 총 체크박스 172개(W0 8 + finding 156 + 통합 8). 중복/누락 없음.
- 문서·근거 링크 106개 target 존재 및 line 범위, 기존 test path 39개 존재, audit input digest 일치를 확인했다. 경로 존재 검사는 test 실행 또는 assertion 충족 증거가 아니다.
- 위 링크 수는 wave 문서 추가 전 검증 기록이다. 이후 W0–W7 배정에는 172개 액션을 추가/삭제하지 않고 모두 한 번씩 포함했다.
- 구조적 품질의 기준은 새 abstraction 수가 아니다. **중복 결정 제거, 실제 consumer 연결, 실패 상태 보존, lifecycle/transaction 종료 보장, 재발 시 RED**가 완료 기준이다.
