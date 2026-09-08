# Sep-08 SE audit — agent-6 (레인 D)

> **Lane:** D (`session`, `memory`, `storage`, `kernel`, `stream`, `artifact`)
> **이 세션:** W1-D + 2026-09-08 병렬 갭헌트 보완.
> **Canonical receipt:** [`docs/plans/sep-7-solid-se-audit/receipts/W1-D.md`](../../plans/sep-7-solid-se-audit/receipts/W1-D.md)
> **구현 없음.** 분류만. 121파일 표는 W1-D.
>
> **파일 번호:** 이 대화는 원래 `agent-4.md`에 D를 썼으나, 병렬 세션이 그 경로를 **Lane E**로 덮어씀 (`agent-1=G, 2=F, 3=H, 4=E, 5=C`). D 덤프는 여기 `agent-6.md`.

```text
AUDIT_ASSIGNMENT|lane=D|scope=session,memory,storage,kernel,stream,artifact
```

## 1. 스냅샷

| 항목 | 값 |
|---|---|
| W1-D 검사 HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` = 당시 origin/main |
| 갭헌트 시점 repo HEAD | `9b05cd33b008b52bf54c9f2391070afcbfbaa8fe` |
| D production `0b14f5c..9b05cd33` | **diff 0** — D 바이트 불변. W1-D는 D에 대해 STALE 아님 |
| D porcelain | empty |
| W0 | 없음. HEAD-only 검사. uncommitted는 완료 청구에 없음 |

권한 문서 읽음. `ARCHITECTURE.md` / `slice-boundary-configs.ts`는 W1-D 검사 시점엔 WT≠HEAD였으나 `9b05cd33`에 커밋됨 — 현재 둘 다 clean.

**Attribution:** 전부 pre-existing.

## 2. 커버리지

| | |
|---|---:|
| production `.ts` | **121/121** |
| 라인 | 22284 |
| god-MODULE >1000 | 0 |
| cohort 900–999 | `session/store.ts` 981 |
| god-FUNCTION >150 | 0 (공식 AST detector 기준. 최장 = `stream/adapters/stdout.ts::emit` **149** — 천장까지 1줄; `runTurn` 118) |
| P0/P1 | **0** |
| P2 유지 (갭헌트 후) | **11** |

방법: 1차 3갈래(session+kernel / memory+storage / stream+artifact) + 코디네이터 재독. 2차 같은 3갈래 **갭헌트**(fail-open 형제, lock 구멍, redact, sqlite write-back, kernel approval).

## 3. 재오픈 안 함

D9, D13, D14, D20, D21, D26, D29, SEP6 N12/S8/S9. D13 git 정책 드리프트는 측정됨(전량 env, timeout/abort 없음)이지만 leak/injection/orphan/timeout 재현 없음 → `X-GIT-SPAWN`.

## 4. 유지 파인딩 P2 × 11

### 1차 (W1-D)

**SEP7-D-01 crash-resume persist fail-open** (aug-25 #52)
- `crash-resume.ts:48-49` default-OFF, `:135-140` mark swallow, `:170-175` clear swallow, `:207-214` detect skip, `:77-79` RMW reject-tail.
- 게이트 ON + `saveSessionById` throw → 재시작이 크래시를 못 봄.
- swallow는 **미테스트**. 유일한 NEVER-throws 테스트(`tests/unit/session/crash-resume.test.ts:134`)는 missing-session 조기반환(`:126`/`:160`)만 침 — catch 미진입. 3파일 35테스트 중 persist 실패 주입 0건.
- 형제 reader: detect → CLI bootstrap offers. writer: session-turn-driver `withCrashResumeMarker`.

**SEP7-D-02 rewind 실패정책 분열** (aug-25 #51)
- `store.ts:935-957` `{removed:0}` never throw. `rewind.ts:149-157` throw.
- 분열은 **msgId-not-found / already-last 한정**: `cmdRewind`(`session-ops/index.ts:617-622`) exit 0 vs `/rewind` throw. missing-session은 분열 아님 — `cmdRewind:612-616`이 선점검 후 exit 1. `rewind.ts:164`는 `rewindToMessage`를 **호출**하는 wrapper(peer 아님).

**SEP7-D-03 envelope producer 0**
- `appendEnvelope` 생산 호출 0. inspect/why ENOENT→`[]`. persist-turn은 V1/V2 snapshot만.

**SEP7-D-04 unsigned export** (aug-25 #103)
- CLI `session-cmd.ts:203` v1, digest 없음. `verifyV2Digest` absent → return.

**SEP7-D-05 lock 밖 mutator: delete + fork**
- `deleteSession:874-878` unlock. `forkSession:824-871` unlock.
- delete∥save → 파일 부활. fork∥save → 찢어진 클론. `forkSessionAtMessage`는 잘리기 전 클론이 list에 보임.

### 갭헌트 신규

**SEP7-D-06 index corrupt skip이 다음 upsert에서 세션을 지움**
- `index-store.ts:28-57` 깨진 줄 skip. 주석 “heal”. `upsertMeta:109-118`이 살아남은 줄만 rewrite → **drop**.
- 스냅샷 JSON은 남음. list/picker/crash-resume 후보/doctor `indexValid`(list는 throw 안 함)에서 증발.
- store-health `:162` “delete it to force a rebuild”는 부분적으로만 참: `reconcileIndexFromMeta`(`store.ts:685`, `:714`/`:718`)가 **id로 로드된 세션 1건**은 복구함. 없는 것은 **디렉터리 스캔 rebuild** — `listSessions`(`index-store.ts:134-149`)는 인덱스만 읽고 fs fallback 없음 ⇒ id를 모르면 영영 안 보임.

**SEP7-D-07 load가 missing≡malformed → `undefined`**
- `readSavedSession:463-497` 네 arm 모두 `undefined`. 단 `:468`(missing file)은 **warn 없음**; warn은 `:473`/`:483`/`:491` 셋. 결함 본체는 warn이 아니라 **반환값이 네 경우를 뭉갠다**는 것.
- sdk `rehydrate.ts:90-94`는 `undefined`를 빈 재개로 봄. `ResumeRehydrateRefusedError`는 스냅샷 **객체**가 있을 때만. durable log tip>0 + 깨진 JSON → 빈 transcript.

**SEP7-D-08 inspect/why 프로덕션 리더가 decode 실패를 무음 skip (오너 = 레인 G)**
- 실제 위치는 `apps/cli/inspect-cmd.ts:337-355`(`/* default reader (production) */`)와 `apps/cli/why-cmd.ts:399-415` — 둘 다 자체 `if (r.ok)` 루프. `inspect-cmd.ts:333-334` 주석이 약속한 projector warn은 미이행.
- `/replay`(`wire-builders.ts:197-214`)만 skip을 세고 warn. 그 hint가 “/inspect shows details”라 오히려 오도.
- `session/inspect-source.ts:301-313`(`readEnvelopes`)은 호출자 0 (src+tests 전수) + `:299` `/* back-compat reader (test seam) */` ⇒ **죽은 코드**. 이 finding의 원 인용은 무효.

**SEP7-D-09 approval persist throw → `turn.failed`**
- `onApprovalRequested:181` `appendEvents` (throw). completed(`:331`)/aborted(`:449`)/failed(`:495`)/errored(`:540`) **넷**은 `appendTerminalEvents` isolator.
- `scheduler-turn-execution.ts:218-261` catch가 non-abort throw를 `onTurnFailed`.
- 승인 대기가 실패 턴이 됨. hellgate가 approval을 안 침.

**SEP7-D-10 sqlite `update`가 fail-open embedding drop을 영구 기록**
- `update:233-241` `rowToEntry`(observer 없음) → `save` → `embedding=NULL`.
- odd BLOB + reinforce/decay/memory_update → 벡터 삭제. `onCorruptEmbedding`은 read 경로만, production 미배선.

**SEP7-D-11 stdout redact 구멍**
- `stdout.ts:261` `tool_progress` `oneLine`만. `:570` `in_progress` message. `:387` `response_queued.hint`.
- `assistant_text`/`tool_result`/`error`/`decision`은 `redactStr`. 진행 문구(명령·경로)가 TTY로 나감.
- D26 아님 (드롭이 아니라 렌더 누수).

## 5. W2-X 지문

| id | 요지 | 왜 파인딩 아님 |
|---|---|---|
| X-AUTH-3 | V1 agent/state vs V2 store vs kernel | persist-turn 독립 게이트. 계약 다름 |
| X-JSONL-3 | envelope / kernel jsonl / stream recorder | D20. schema/dir/gate 다름. envelope writer 0 |
| X-ATOMIC | session writeSessionFile no fsync vs storage atomic-write | D20/D29 |
| X-GIT-SPAWN | git-runner scrub+30s vs consolidate/git 전량 env | D13 트리거 미재현. **둘 다 D** |
| X-JAIL-ROOT | service equal=inside vs fs-jail-lib equal=outside | 근거는 **dual-consumer 부재**뿐 — `fsJailLib(` 프로덕션 소비자 1(`artifact-preview-resolver.ts:83`) vs `resolveJailed` 다수, 공유 호출자 없음. canonicalize SSOT는 equal-path 분기를 설명 못 함 |
| X-ITEM | projector vs kernel passthrough | 파이프라인. drift hellgate 있음 |
| X-DEGRADE | Tee onFirstDegrade CLI만 | 배선 G. JsonlRecorder는 보통 throw 안 함 → latch 맹점 |
| X-DECISION | decisionEmitter → stdout+jsonl | G compose |
| X-TYPED-EVENT | in-memory only | durable wrap은 A |
| X-STOP | kernel value-import `@/agent/stop-category` | 정책 A |
| X-DREAM | persistCompleted catch vs E JsonFileDreamState NO-THROW | D catch는 죽은 코드. 실제 silent write는 E |
| X-WRITEFILE | file_history restore가 atomic 있는 포트에서 `writeFile` | 레인 B |
| X-FRESHNESS | ranking vs eviction 가중치 복사 | 실패 모드 없음 |

## 6. 갭헌트에서 닫은 구멍 (inventory / no-finding)

- jsonl-recorder emit-after-close: 코드는 close 가드 없음. **live close→emit 소비자 0.**
- SIGTERM liveRecorders Set: close 시 delete, 유계.
- skip vs KIND_MAP: 교집합 공백 0.
- SseStream: `new SseStream` src 0. close 후 emit은 가드됨.
- item-lifecycle `start("thinking")` 호출 0.
- artifact FIFO 1000: Map eviction 있음.
- event-log-jsonl mid-file fail-loud. torn-final skip은 문서화.
- user-question broker: PARKED in-memory.
- git-fingerprint per-field swallow: ADR-0106.
- store-health NEVER throw: 핫패스 아님. rebuild 거짓말은 D-06에 흡수.
- EXDEV copyFile: same-dir temp, unreachable.
- shadow-odb captureSafetyNet throw (fail-closed). cleanup per-dir skip은 HELL-5 spec.
- memory DIP `@/llm` value import 0.
- auto-trigger hidden fallback 없음.

## 7. 테스트 정직성 (추가)

| rail | 갭 |
|---|---|
| crash-resume NEVER throws | 봉인 아님 — persist 실패 주입 테스트 0건(미커버) → D-01 |
| index “heal” 주석 | upsert drop RED 없음 → D-06 |
| rehydrate refuse | loader가 undefined 주면 빈 성공 → D-07 |
| inspect envelopes | skip 무음. replay만 정직 → D-08 |
| kernel-terminal-append-hang | approval 미커버 → D-09 |
| sqlite-delete-async / C-18 observer | update write-back 미커버 → D-10 |
| stdout redact hellgates | tool_progress 미커버 → D-11 |

## 8. write set

| ID | D files | 금지 |
|---|---|---|
| D-01 | `crash-resume.ts` | runner wire, repl |
| D-02 | `store.ts`, `rewind.ts` | session-ops, rewind-cmd |
| D-03 | `store.ts`, barrel | persist-turn (E), inspect/why (G) |
| D-04 | `import-export.ts`, `-fs.ts` | session-cmd (G) |
| D-05 | `store.ts` delete+fork | session-ops |
| D-06 | `index-store.ts` (+ store-health 주석) | doctor를 유일한 수정으로 쓰지 말 것 |
| D-07 | `store.ts` miss vs corrupt | sdk만 고쳐 store를 그대로 두면 안 됨 |
| D-08 | **레인 G** `apps/cli/inspect-cmd.ts`, `apps/cli/why-cmd.ts` (D 파일 아님) | `inspect-source.ts` 수정 금지 — 죽은 코드라 no-op fix |
| D-09 | `scheduler-turn-terminals.ts` | — |
| D-10 | `sqlite.ts` `update` | agent/memory 정책 이전 |
| D-11 | `stdout.ts` | stream-callbacks를 D가 쓰지 말 것 |

## 9. 미검증

런타임 미실행. ENOSPC(crash-resume, approval append), delete∥save, odd-BLOB+update, TTY secret, D13 hang, cross-process OS lock, `src/` 밖 envelope writer.

## 10. 터미널

**DONE** — 121파일 분류 + 갭헌트 보완. 수정 없음.
W2는 D 바이트가 `0b14f5c`와 같은지 확인한 뒤 이 노트와 W1-D를 같이 쓸 것.
