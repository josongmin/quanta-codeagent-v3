# W1-D receipt — Sep-07 SOLID/SE and duplicate-development audit

```text
AUDIT_ASSIGNMENT|lane=D|scope=session,memory,storage,kernel,stream,artifact|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-D.md
```

## Snapshot

W0 receipt was **absent** at start and still absent at write. Coordinator
dispatched lane D against a dirty shared checkout. Exclusive D production paths
(`src/{session,memory,storage,kernel,stream,artifact}`) are **clean vs HEAD**
(porcelain empty pre and post). Inspection used tracked HEAD files only.
Uncommitted files outside D are not part of this completion claim.

| Field | Pre-inspection | Post-inspection |
|---|---|---|
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| branch | `main` | identical |
| origin/main | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| merge-base | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` | identical |
| ahead/behind | `0 0` | identical |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) | identical |
| unstaged/tracked diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` | identical |
| untracked manifest SHA-256 | `e3144092830e882813b8faf905e5e8fdebbcd59dddc1f5f5100aa57eb24e2612` (7 files) | `2665730301e5476d4ccb40a625824b026333d49054552d370f48c183ba2a18e3` (8 files) |
| D production porcelain | empty | empty |

Untracked-manifest drift is **sibling receipt**
`docs/plans/sep-7-solid-se-audit/receipts/W1-C.md` appearing during this
inspection. HEAD, staged diff, unstaged tracked diff, and D production files
did not change. This is not a D-scope STALE.

Authority-document hashes:

| Path | Working tree | HEAD blob |
|---|---|---|
| AGENTS.md | `79de5da2fad6835f007654552180ba3c44312ab13f9049d6f04131f82411702c` | same |
| AGENT_CORE.md | `d1f585c79692ee9ca27b2dde36da25d01df0c17883676b3c392f6ee035dd7d82` | same |
| AGENT_PLAYBOOK.md | `288bb7e2fe1f2dbf60051d5ac0186f025e7b009dbbedefd29f2ca74afeb4f4b6` | same |
| docs/ARCHITECTURE.md | `16626624c6001dc16093000f0a1071a44402391f2f3940e5dff3cd24109b0fcf` | `f190b0a28ddb1ce914772d3cf919b4dbce7ab411aaad2c7580364a32f2650fdd` |
| tests/README.md | `ba80760a592f1b3e70a2394bfa7f45ddecaf17f3b2cdec8468204eb61d351967` | same |
| package.json | `97c0650b754616cf72e5215aa7273c914840c314a141e8e83de3c0e37d8556e4` | same |
| biome.json | `86028e6e6c5e33a138cb5ed224f200fb4e704751b6aad14aee4c5477a2339703` | same |
| tsconfig.json | `622ad399076687a1e3cdc01ce3b0b46edd344e2bb3da963bf0ea30223a77564b` | same |
| tsconfig.base.json | `c4ca874cd213452f545c273569a8d220566d763188bb26b64f77433ef51aa22f` | (present) |
| tests/unit/_arch/slice-boundary-configs.ts | `1e570be7ac9ecd80ede42399e98d8fabb948642be66ae2b4c93654dc0f4458d6` | `315560288012f4e6f2cc149f0605a539faac9676149e2e606fb3580a89115697` |
| tools/god-code/detect.ts | `0ffa10d217ab9f5e536181806fc1bfedeebfea53b86a8d219170ca28f981e5a5` | same |
| tools/god-code/allowlist.json | `9ce34fb2ee886193a369217b6aeac6d80ea2f30b8dfcf311e9047bdc46de34a3` | same |
| tools/dev/lint-debt-ceiling.json | `b56462a0d3b891d175a55ccb72026218018184dd9f50ac95f6c7d4c2fbeaaf24` | same |

`docs/ARCHITECTURE.md` and `slice-boundary-configs.ts` differ HEAD vs working
tree. Those files are W2/W3 reserved. Lane D did not use dirty architecture
text as ownership proof; live TypeScript under the exclusive D slices is the
owner.

If a later W0 receipt names a different HEAD or a different **tracked** diff
hash, this receipt is **STALE**. Untracked-manifest inequality caused only by
other W1 receipts is expected on this dirty checkout.

Attribution for every finding below: **pre-existing** (HEAD ≡ origin/main).

Retired SEP5/SEP6 items were **not reopened**: D9, D13, D14, D20, D21, D26,
D29; SEP6 N12/S8/S9. Triggers were not reproduced as specified.

## Coverage counts

| Universe | Count |
|---|---:|
| Exclusive production `src/**/*.ts` (tests excluded) | 121 |
| Classified | 121 |
| Unclassified | 0 |
| Colocated `*.test.ts` / `__tests__` under D src | 12 |
| Same-name unit dirs `tests/unit/{session,memory,kernel,stream}` | 11+9+28+8 = 56 |
| `tests/unit/{storage,artifact}` dirs | 0 (tests live at root / colocated) |
| God-MODULE >1000 in D | 0 |
| Cohort 900–999 in D | 1 (`src/session/store.ts` 981) |
| God-FUNCTION >150 (allowlist has **no** D entries) | 0 confirmed (`runTurn` ~134) |
| P0/P1 retained findings | 0 |
| P2 retained findings (after 2026-09-08 gap-fill) | 10 |
| P3 retained findings | 0 (P3 items kept as inventory) |

By slice (production files / lines):

| Slice | Files | Lines |
|---|---:|---:|
| session | 26 | 5949 |
| memory | 45 | 6066 |
| storage | 16 | 2604 |
| kernel | 16 | 3533 |
| stream | 15 | 3805 |
| artifact | 3 | 327 |
| **total** | **121** | **22284** |

## Inspected consumer paths (finding-bearing)

Coordinator re-read owner + at least one reachable consumer for every retained
finding. Cross-lane paths are evidence, not D write ownership.

| Owner | Consumer (lane) |
|---|---|
| `session/crash-resume.ts` `markSessionInterrupted` | `runner/orchestrate/crash-resume-wire.ts` (E), `apps/cli/repl.ts` (G) |
| `session/store.ts` `rewindToMessage` | `runner/session-ops/index.ts` `cmdRewind` (E) |
| `session/rewind.ts` `rewindSession` | `apps/cli/rewind-cmd.ts` (G) |
| `session/store.ts` `appendEnvelope` | **zero** `src/**` call sites; barrel re-export only. Readers: `apps/cli/inspect-cmd.ts` ENOENT→`[]` (G), `apps/cli/why-cmd.ts` (G) |
| `session/import-export.ts` / `import-export-fs.ts` | `apps/cli/session-cmd.ts:203` `exportSessionToFile(..., { quantaVersion, now })` — no `emitV2`/`withDigest` (G) |
| `session/store.ts` `deleteSession` | `runner/session-ops/index.ts` `cmdDelete` (E); concurrent `saveSessionById` via `persist-turn.ts` (E) |
| `session/store.ts` `saveSessionById` | `runner/orchestrate/persist-turn.ts` (E) also calls V1 `saveSession` from `@/agent` when `--state` set |
| `kernel/session/objective-command.ts` | `src/host/runtime/internal/context-binding.ts:502` **does** wire `mutateObjective` (G) — absent-host arm unreached on that host |
| `storage/git-runner/runner.ts` | shadow-odb, `tool/git/runner.ts` re-export (B) |
| `memory/consolidate/git.ts` | `memory/consolidate/writer.ts` `FileMemoryWriter` |
| `stream/item-stream-projector.ts` | `agent/optional-ports.wireItemStreamTap` (A), `host/.../turn-runner.createTurnStreamPort` (G) |
| `kernel/session/session-host-turn-event-projection.ts` | kernel scheduler stream path; passthrough of `item.stream` |

## Complete file manifest

Fingerprint key: `auth/inv/in/out/st/fx/fail/lc`. Test owner is the closest
mapped rail, not an exhaustive list.

### `src/session/**` (26)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `index.ts` | 220 | barrel | re-export | none | none | apps/cli, runner, host, sdk | (none) | n/a | barrel / V2-alongside-V1 documented |
| `store.ts` | 981 | V2 snapshot persistence | save/load/archive/rename/fork/delete/rewind/appendEnvelope | `<id>.json` + index | tmp+rename, **no fsync** | persist-turn, crash-resume, rewind, session-ops | colocated lock/archive + `session-store.test.ts` | `forkSession` ~48 | **auth=id-snapshot SSOT**; in-proc save lock; rewind JSONL untouched; delete unlocked |
| `types.ts` | 541 | V2 schema | types | `SESSION_VERSION=2` | none | store, import-export | envelope/meta longtail | n/a | schema / optional rollback+objective |
| `envelope.ts` | 515 | JSONL record schema ADR-0034 | schemas | none | none | encoder, inspect, why | `session-envelope-*.test.ts` | schemas | **auth=envelope schema**; ≠ kernel `SessionEvent` |
| `envelope-encoder.ts` | 190 | encode/decode/append | encode/decode/iterate/appendSessionLine | none | O_APPEND, no fsync | store.appendEnvelope, inspect | encoding/streaming tests | `iterateSessionFile` ~28 | inv=canonical keys+LF; decode Result never-throw |
| `import-export.ts` | 635 | export/import port | exportSession/importSession | none | none | import-export-fs, CLI | `t06-digest-canonical-hellgate` | `importSession` ~51 | **digest optional**; v1 default |
| `import-export-fs.ts` | 68 | FS adapter | export/import file | disk | Bun.write | `session-cmd.ts` | slash hellgate | `importSessionFromFile` ~21 | no digest/v2 flags from CLI |
| `crash-resume.ts` | 289 | interrupted-turn marker | mark/clear/detect/buildOffer | `SessionMeta.interruptedTurn` | RMW via store | crash-resume-wire, CLI repl | `session/crash-resume.test.ts` | `markSessionInterrupted` ~28 | **gate default-OFF**; persist swallow NEVER-throws |
| `rewind.ts` | 279 | rewind/fork wrapper | rewindSession/forkSessionAtMessage | none | store truncate | rewind-cmd | `rewind-wrapper.test.ts` | `rewindSession` ~78 | fail=**throws** on missing id |
| `index-store.ts` | 149 | listing cache | upsertMeta/listSessions | `index.jsonl` | rewrite+rename | store commit, CLI list | `session-index.test.ts` | `readIndexMap` ~27 | snapshot SSOT; corrupt lines skip |
| `paths.ts` | 105 | path+id sanitize | sessionsRoot/sessionFilePath/sanitizeId | none | none | store, inspect | `session-paths.test.ts` | `sanitizeId` | no traversal |
| `root-port.ts` | 67 | tenant root port | SessionRootProvider | none | none | store async paths | `root-port.test.ts` | default provider | omit ≡ sync root |
| `attach-session.ts` | 116 | attach SSOT | attachSessionToLive | none | injected effects | CLI session-switch, web | `attach-session-hellgate.test.ts` | ~31 | crown order; typed outcome |
| `workspace-ownership.ts` | 210 | ownership FSM | transitionWorkspaceState | rides snapshot | none | runner session-ops | worktree tests (E) | transition | closed transitions; cwd-pin default-OFF |
| `rollback-record.ts` | 208 | rollback DTO | append/upsert/resolve | rides snapshot | none | agent thread-rollback (A) | persist-turn-rollback | `appendRollbackIntent` ~28 | first-terminal-wins |
| `store-health.ts` | 248 | diagnostic | checkSessionStoreHealth | none | readdir | CLI doctor, web | `store-health.test.ts` | ~66 | NEVER-throws; not hot-path |
| `inspect-source.ts` | 314 | JSONL→inspect | findByToolCallId | none | none | inspect-cmd, why-cmd | envelope hellgates | projector fold | empty if no jsonl |
| `why-explainer.ts` | 223 | /why prompt | buildWhyPrompt | none | none | why-cmd | CLI tests | prompt builder | empty rail ⇒ empty why |
| `derive-turns.ts` | 124 | transcript→turns | deriveTurns | none | none | history-cmd | CLI | ~8 | turn segmentation |
| `git-fingerprint.ts` | 85 | git triple | captureGitFingerprint | none | injected GitRunner | agent git-observability (A) | (agent) | ~40 | best-effort per field; `import type` from `@/tool/git/types` |
| `fork-objective.ts` | 109 | fork objective clone | cloneObjectiveForFork | none | none | store.forkSession | `fork-objective.test.ts` | ~75 | new generation, no progress copy |
| `user-question/broker.ts` | 140 | pending-question | createUserQuestionBroker | in-memory Map | none | runner assemble, agent tool-adapter | `user-question-broker.test.ts` | ~63 | in-proc only; CAS settle |
| `user-question/types.ts` | 68 | DTOs | types | none | none | broker | broker test | n/a | owner=root\|task |
| `user-question/index.ts` | 15 | barrel | re-export | none | none | runner | broker test | n/a | barrel |
| `objective-posture-schema.ts` | 19 | posture zod | schema | none | none | types/store | meta-longtail | n/a | fail-closed unknown version |
| `objective-blocker-schema.ts` | 31 | blocker zod | schema | none | none | types/store | meta-longtail | n/a | legacy fields loadable |

### `src/memory/**` (45)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `index.ts` | 112 | barrel | public | none | none | agent/runner/apps | fence hellgates | n/a | Stage1+Persistent+Dream |
| `ports.ts` | 40 | PersistentStorePort | type | none | none | adapters, assemble | memory-adapters | n/a | update no-op / all unbounded |
| `types.ts` | 318 | MemoryEntry SSOT | type+normalize | none | none | ranking/adapters | memory-routing-meta | normalizeEntry | EMBED_DIM, buckets |
| `store-path.ts` | 79 | sqlite path | resolveStorePath | none | existsSync | memory-factory | durable-store-default | resolveStorePath | home vs legacy cwd |
| `telemetry-port.ts` | 134 | inverted telemetry | type | none | none | ranking | memory-telemetry-port | n/a | content-free allow-list |
| `ranking.ts` | 285 | recall rank | rankEntries | none | none | both stores | memory-hellgate | rankEntries ~62 | FRESHNESS_WEIGHT copy vs eviction |
| `eviction.ts` | 154 | eviction plan | planEviction | none | none | agent/memory persist | decay-frequency | planEviction | same weights, /3 scale |
| `dedup.ts` | 105 | near-dupe | findNearDuplicates | none | none | agent persist | memory-dedup-planner-e2e | ~30 | cosine OR jaccard |
| `vector.ts` | 64 | vec math | serialize/deserialize | none | none | sqlite, ranking | sqlite-delete-async | deserializeVec | fail-open odd BLOB |
| `working.ts` | 81 | session buffer | createWorkingMemory | messages[] | mutate | loop, sanitization | adapter hellgate | tokenEstimate | shallow snapshot |
| `adapters/in-memory.ts` | 70 | volatile store | class | Map | none | buildStoreCore | memory-adapters | update | clone embeddings |
| `adapters/sqlite.ts` | 354 | durable store | class | bun:sqlite WAL | mkdir, SQL | buildStoreCore | sqlite-delete-async, memory-sqlite | ctor ~71 | all/recall unbounded; kind remap silent |
| `auto-trigger/index.ts` | 11 | barrel | assembleMemoryAuto | none | none | session-memory-auto | session-memory-auto | n/a | no 2nd trigger |
| `auto-trigger/wire.ts` | 46 | env→slot | assembleMemoryAuto | none | none | session-memory-auto | CLI/brain-mode | assembleMemoryAuto | default-ON explicit ADR-0413 |
| `typed-event/index.ts` | 40 | barrel | factory | none | none | registry, r2 (A) | port-contract | n/a | class hidden |
| `typed-event/port.ts` | 38 | closed port | type | none | none | in-memory-store | port-contract | n/a | sync, no persist |
| `typed-event/in-memory-store.ts` | 54 | default adapter | factory | array | none | registry wrap (A) | in-memory-store.hellgate | since | no cap; durable wrap is FOREIGN |
| `typed-event/types.ts` | 248 | 8-variant union | type | none | none | r2, mention | hellgate exhaust | n/a | append unvalidated |
| `history-sanitization/index.ts` | 15 | barrel | port+adapter | none | none | session-bootstrap | adapter hellgate | n/a | |
| `history-sanitization/port.ts` | 121 | closed port | type | none | none | llm wrapping (E) | wrapping.hellgate | n/a | NO-THROW |
| `history-sanitization/types.ts` | 61 | reason/result | type | none | none | adapter | adapter hellgate | n/a | closed enum |
| `history-sanitization/working-memory-adapter.ts` | 260 | wm sanitizer | factory | via wm | wm.replace | session-bootstrap | adapter hellgate | sanitizeTail | DIP: no `@/llm` value import |
| `history-sanitization/reconcile-tool-pairing.ts` | 18 | reexport | reconcileToolPairing | none | none | `@/shared` | history-pairing | n/a | fence-legal share |
| `dream/index.ts` | 54 | barrel | trigger+policy | none | none | cli dream-cmd | session-memory-auto | n/a | default-OFF |
| `dream/port.ts` | 70 | 3 ports | type | none | none | trigger | — | n/a | JSON state in runner |
| `dream/types.ts` | 133 | policy/state | type | none | none | trigger, wire | — | n/a | lock TTL 10min |
| `dream/wire.ts` | 46 | cfg→DreamSlot | assembleDreamPolicy | none | none | session-memory-auto | — | assembleDreamPolicy | default-OFF |
| `dream/in-memory-state.ts` | 29 | test state | class | field | none | tests | — | n/a | stale `json-file-state.ts` comment |
| `dream/team-write-target.ts` | 144 | team md write | FileDreamWriteTarget | none | mkdir/write | session-memory-auto | — | write ~31 | MEMORY.md forbidden |
| `dream/cross-session-trigger.ts` | 363 | auto-dream glue | onSessionEnd/dream | firing bool | lock, write | session-memory-auto | e2e auto-trigger | fireLocked ~65 | InMemoryLock FOREIGN |
| `consolidate/index.ts` | 55 | barrel | runPhase1/2 | none | none | agent consolidator | consolidate-* | n/a | |
| `consolidate/types.ts` | 347 | Stage1/Phase ports | type | none | none | store, phase* | consolidate-store | isMemoryOutcome ~61 | dir-rename comment stale |
| `consolidate/constants.ts` | 64 | caps | const | none | none | writer, phase | — | n/a | MEMORY_SUMMARY_MAX_BYTES |
| `consolidate/paths.ts` | 31 | ~/.quanta/memory | resolveMemoryDirPaths | none | none | store-path, writer | durable-store-default | n/a | |
| `consolidate/schema.ts` | 101 | stage1 DDL | ensureConsolidateSchema | db | ALTER | Stage1Store | consolidate-store | ensure ~76 | memories untouched |
| `consolidate/store.ts` | 318 | Stage1 sqlite | class | db | SQL | session-memory-auto | consolidate-store.test | ctor ~60 | fetch cap 10k |
| `consolidate/git.ts` | 195 | GitPort spawn | ChildProcessGitPort | none | Bun.spawn git | FileMemoryWriter | consolidate-writer | addCommit ~57 | **full env, no timeout, no abort** |
| `consolidate/reader.ts` | 54 | load summary md | loadMemorySummary | none | read | session-memory-auto | — | n/a | |
| `consolidate/writer.ts` | 280 | 3-file writer | MemoryWriter | none | write/rename/git | runPhase2 | consolidate-writer.test | writeAtomic ~80 | 3 rename, no fsync |
| `consolidate/grammar.ts` | 172 | preference parse | pure | none | none | phase/lint | memory-grammar | — | count-based confidence |
| `consolidate/lint.ts` | 213 | frontmatter warn | lint | none | none | CLI/writer | — | — | warnings only |
| `consolidate/phase1.ts` | 162 | distill | runPhase1 | none | store.upsert | consolidator-hook | consolidate-phase1 | ~122 | LLM via inverted port |
| `consolidate/phase2.ts` | 203 | consolidate | runPhase2 | none | writer+watermark | consolidator, dream | consolidate-phase2 | ~132 | watermark after write |
| `consolidate/phase2-llm.ts` | 205 | Phase2Port LLM | LlmPhase2Port | none | none | session-memory-auto | phase2-llm hellgate | buildUserMessage ~45 | Phase2Summarizer inversion |
| `consolidate/phase2-promotion.ts` | 119 | promotion gate | select | none | none | phase2 | memory-promotion | — | fail hard-exclude |

### `src/storage/**` (16)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `index.ts` | 48 | barrel | public | none | none | tools, agent, host | storage-slice-boundary | n/a | sha256Hex reexport |
| `types.ts` | 25 | FileInfo | type | none | none | service | — | n/a | |
| `canonicalize-core.ts` | 93 | symlink canonicalize | lexicalNormalize, realResolve | none | lstat/readlink | service, fs-jail-lib | storage.test jail | realResolve ~35 | hops 40; **canonicalize SSOT** |
| `fs-jail-lib.ts` | 59 | FsJailLib | fsJailLib, canonicalizePath | none | none | artifact-preview | — | canonicalizePath | **root equal = outside** |
| `service.ts` | 378 | FileSystemPort+jail | resolveJailed, defaultFileSystemPort | process sink | fs r/w | tools read/write/edit | storage.test | enforceJail | **root equal = inside**; writeFileAtomic optional |
| `atomic-write.ts` | 191 | temp+rename+fsync | writeFileAtomic, sha256Hex | none | write,rename,fsync | edit/write, shadow init, agent/state | atomic-write-fsync-hellgate | writeFileAtomic ~56 | D14/D29 closed fingerprint |
| `git-runner/index.ts` | 9 | barrel | defaultGitRunner | none | none | tool/git reexport, shadow | — | n/a | **canonical GitRunner home** |
| `git-runner/types.ts` | 27 | GitRunner port | type | none | none | runner, shadow | — | n/a | signal optional |
| `git-runner/runner.ts` | 119 | spawn git | defaultGitRunner.run | none | Bun.spawn | shadow-odb, resume-fsm | storage/git hellgates | run ~38 | scrub+30s+abort |
| `shadow-odb/index.ts` | 26 | barrel | defaultShadowOdb | none | none | checkpoint, tools | shadow-odb-hellgate | n/a | default-OFF |
| `shadow-odb/types.ts` | 339 | ShadowOdb port | type | none | none | ops, tools | — | n/a | |
| `shadow-odb/hash.ts` | 37 | workspaceHash | workspaceHash | none | none | ops | shadow hellgate | workspaceHash | 16-hex prefix; not D14 |
| `shadow-odb/cleanup.ts` | 99 | LRU evict | evictLru | none | fs.rm | defaultShadowOdb.cleanup | cleanup-error-path-hellgate | evictLru | NaN no-op |
| `shadow-odb/default.ts` | 127 | factory | defaultShadowOdb | states Map | via ops | apps/cli, agent | init-marker + hellgate | ~62 | thin delegate |
| `shadow-odb/default-helpers.ts` | 268 | path/git helpers | runShadow*, validate | none | git via runner | ops | shadow hellgate | validateWorkspaceRoot ~38 | symlink reject |
| `shadow-odb/default/ops.ts` | 759 | all ShadowOdb ops | opInit…opDiffSinceRef | states.chain | git, atomic marker | default.ts | init-marker, cleanup | captureSafetyNet ~58 | SRP inventory |

### `src/kernel/session/**` (16)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `index.ts` | 49 | barrel | re-export | none | none | sdk/host | slice-boundary | n/a | barrel |
| `ports.ts` | 369 | SessionHost + ctx | interface | none | none | host/sdk implement | projection hellgate | n/a | fat port; many optional methods |
| `state.ts` | 192 | in-proc kernel state | createKernelSessionState | KernelSessionState | none | reducer/scheduler/sdk | session-state-view-token-usage | toSessionStateView ~33 | **≠ disk snapshot** |
| `reducer.ts` | 521 | command→state+events | reduceSessionCommand | revision/seq | none | scheduler | session-kernel.test.ts | handleTurnCancel ~43 | closed+revision CAS |
| `scheduler.ts` | 374 | dispatch | dispatchSessionCommand | lease+controllers | host + eventLog | sdk engine.ts | kernel-scheduler.test.ts | dispatchSessionCommand ~88 | cancel fast-path |
| `scheduler-turn-execution.ts` | 319 | runTurn | runTurn | stream state | host.runTurn | scheduler | kernel-cancel hellgate | **runTurn ~134** | stream append isolated |
| `scheduler-turn-terminals.ts` | 547 | terminal settlement | onTurnCompleted/Aborted/Failed | next kernel state | appendTerminalEvents | execution | stop-category hellgate | onTurnAborted ~74 | **value import `@/agent/stop-category`** |
| `scheduler-append-isolation.ts` | 191 | persist isolation | append/notify sinks | process counters | eventLog.append | execution/terminals | terminal-append-hang | appendTerminalEvents ~10 | diagnostic; never redefine turn |
| `event-log.ts` | 14 | in-memory log | InMemorySessionEventLog | array | none | host persistence default | scheduler tests | append | default-OFF durable |
| `event-log-jsonl.ts` | 312 | durable protocol JSONL | JsonlSessionEventLog | `<dir>/<id>.jsonl` | writeSync, no fsync | persistence when env set | event-log-jsonl.test.ts | loadAndRecover ~47 | **auth=wire SessionEvent**; fail-loud mid-file |
| `lease.ts` | 57 | single-writer | SingleWriterLease | holder id | none | state/scheduler | kernel-lease.test.ts | runWith ~8 | one holder |
| `replay-lite.ts` | 54 | snapshot+tail | replaySnapshotLite | none | none | sdk resume | kernel-replay-lite.test.ts | ~47 | out-of-order throw |
| `session-host-turn-event-projection.ts` | 393 | host event→wire | projectSessionHostTurnEvent | seq/revision bump | none | scheduler stream | projection hellgate | dispatcher ~72 | `item.stream` passthrough |
| `posture-command.ts` | 50 | posture apply | applyPostureCommand | none | host.setPosture | scheduler | posture-set-dispatch | ~25 | **absent host → throw** |
| `skill-command.ts` | 49 | skill apply | applySkillCommand | none | host.setSkillEnabled | scheduler | (kernel skill tests) | ~25 | **absent host → throw** |
| `objective-command.ts` | 42 | objective apply | applyObjectiveCommand | none | host.mutateObjective | scheduler | objective-mutate-dispatch | ~18 | **absent host → silent ok** (documented) |

### `src/stream/**` (15)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `ports.ts` | 5 | StreamPort | emit | none | none | loop, host, CLI tees | — | n/a | 1-method ISP |
| `index.ts` | 44 | barrel | reexport | none | none | apps/runner | — | n/a | |
| `types.ts` | 837 | AgentEvent 45 + RetentionPolicy | types | none | none | every adapter | AGENT_EVENT_TYPES | n/a | closed union; SRP dump inventory |
| `decision-emitter.ts` | 81 | gate narrow port | DecisionEvent | none | delegated emit | CLI compose (G) | decision-event-hellgate (mixed SUT) | — | fail-open swallow |
| `item-lifecycle.ts` | 148 | item_* AgentEvent | AgentEvent | openText/tools | none | wireItemLifecycleStream | item-lifecycle-hellgate | — | default-OFF QUANTA_ITEM_LIFECYCLE |
| `item-stream-projector.ts` | 336 | item core SSOT | AgentEvent | reasoning/tools/plan | none | agent tap + host turn-runner | item-stream-projector-hellgate | — | default-OFF QUANTA_ITEM_STREAM |
| `adapters/tee.ts` | 93 | fan-out | AgentEvent | failures Map | downstream emit | CLI, runner, eval | tee.test.ts | — | non-strict swallow; onFirstDegrade G-wired |
| `adapters/stdout.ts` | 681 | CLI renderer | AgentEvent | inText/inThinking | stdout write | CLI / mode-presets | stdout hellgates | ~50 arms | never-pin; D26 inventory |
| `adapters/sse.ts` | 84 | SSE frames | AgentEvent | nextId, closed | sink.write | **tests only** | sse.test.ts | — | close after silent no-op |
| `adapters/jsonl-recorder.ts` | 505 | trajectory writer | recorded AgentEvent | buf/seq/cap | mkdir + appendFileSync | assemble observeDir | t07-jsonl-recorder-hellgate | emit skip-chain | maxLines 100k; emit after close unguarded |
| `adapters/jsonl-recorder-kind-map.ts` | 153 | durable vs transient | recorded event | none | none | recorder | t07 | n/a | Record compile fail on new type |
| `adapters/jsonl-recorder-data.ts` | 383 | data payload SSOT | recorded event | none | none | recorder | t07 | dataOf | assertNever |
| `adapters/jsonl-recorder-event-data.ts` | 53 | llm/tool/usage payload | event | none | none | data.ts | — | — | costUsd always null |
| `adapters/jsonl-recorder-communication-data.ts` | 41 | peer/delivery payload | event | none | none | data.ts | — | — | |
| `adapters/jsonl-retention.ts` | 361 | byte-window rewrite | path + cap | none | tmp/fsync/rename | **only** CLI session-transcript-retention (G) → **session envelope**, not recorder | jsonl-recorder-retention | — | missing → no-op; no JSON parse |

### `src/artifact/**` (3)

| path | n | role | ingress | state | fx | consumer | test | largest | fingerprint |
|---|---:|---|---|---|---|---|---|---|---|
| `index.ts` | 25 | barrel | registry ∪ markers | none | none | host, web | — | n/a | |
| `registry.ts` | 175 | in-memory artifact store | ArtifactSpec | Map | memory | host gated-tool-ports, web-daemon, artifact-drain | artifact-registry-hellgate | — | NO-THROW; FIFO cap 1000 |
| `rich-markers.ts` | 127 | mermaid/katex segments | text + enabled | regex lastIndex | none | web MarkdownMessage | (web/frontend tests) | — | default-OFF; lossless rejoin |

## Findings

### SEP7-D-01 — crash-resume persist fail-open (aug-25 #52 reproduced)

- **axis:** SE fail-open / durability
- **severity:** P2
- **attribution:** pre-existing (documented as durability-not-correctness)
- **owners:** `src/session/crash-resume.ts` `markSessionInterrupted` / `clearSessionInterrupted`
- **consumers:** `src/runner/orchestrate/crash-resume-wire.ts`; `src/apps/cli/repl.ts`
- **evidence:** gate default-OFF `crash-resume.ts:48-49`; persist `catch` swallow `:135-140` with `logger.warn`; header `:96-98` "NEVER throws". Unit rail `tests/unit/session/crash-resume.test.ts` pins "NEVER throws" as GREEN.
- **failure mode:** when `QUANTA_CRASH_RESUME` is ON and `saveSessionById` throws, the marker is absent. Restart `detectInterruptedSessions` cannot see the crash. Wiring exists (ADR-0528); swallow remains.
- **not a SEP5 reopen.**
- **proposed D write set:** `src/session/crash-resume.ts` (typed persist result, do not swallow when gate ON). Tests: `tests/unit/session/crash-resume.test.ts` plus injection that `saveSessionById` rejects.
- **forbidden:** `src/runner/orchestrate/crash-resume-wire.ts`, `src/apps/cli/repl.ts`
- **uninspected:** live ENOSPC / EACCES injection on a real snapshot file.

### SEP7-D-02 — rewind failure-policy split (aug-25 #51 reproduced)

- **axis:** LSP / two live failure policies for one rewind contract
- **severity:** P2
- **attribution:** pre-existing
- **owners:** `src/session/store.ts` `rewindToMessage`; `src/session/rewind.ts` `rewindSession`
- **consumers:** `src/runner/session-ops/index.ts:617-622` (primitive; `removed===0` → exit 0); `src/apps/cli/rewind-cmd.ts` (`rewindSession` throws on missing/ambiguous id)
- **evidence:** `store.ts:935-957` missing session/id → `{removed:0}`, never throws; `rewind.ts:149-157` throw. Dual live ingress.
- **failure mode:** `session rewind <id> <bad-msg>` reports success. `/rewind` errors. Id-less legacy messages are permanently no-op on the primitive.
- **proposed D write set:** `store.ts` distinguish not-found vs already-last vs missing-session; `rewind.ts` consume that type.
- **forbidden:** `src/apps/cli/rewind-cmd.ts`, `src/runner/session-ops/index.ts`
- **uninspected:** real disk session with id-less messages e2e.

### SEP7-D-03 — envelope JSONL producer unwired; readers fail-open empty

- **axis:** SE built-but-not-wired / test honesty
- **severity:** P2
- **attribution:** pre-existing
- **owners:** `src/session/store.ts` `appendEnvelope` (sole writer seam); `src/session/index.ts` public export
- **consumers:** `rg appendEnvelope` in `src/` = definition + barrel + comment in `apps/cli/session-transcript-retention.ts`. **Zero production calls.** Readers: `apps/cli/inspect-cmd.ts:347-351` ENOENT → `[]`; why-cmd same pattern.
- **failure mode:** `/inspect` and `/why` always empty for envelope events. Tests that call `appendEnvelope` directly do not reach `persistTurn`. Persist ingress (`src/runner/orchestrate/persist-turn.ts`) writes V1 `saveSession` and/or V2 `saveSessionById` only.
- **proposed D write set:** keep seam in `store.ts`; add a D-owned call-site floor that turns RED while production callers remain 0 **or** delete/hide the public export until a producer exists. Wiring the producer is **lane E** (`persist-turn.ts`) — send to W2-X, do not edit E from D.
- **forbidden:** changing inspect-cmd / why-cmd empty semantics to hide the missing producer.
- **related inventory:** rewind does not truncate JSONL (`store.ts:938-941`, aug-25 #50). Dormant while producer count is 0. Not a D20 reopen (this is snapshot vs **same-session** envelope consistency, not sharing JSONL primitives).

### SEP7-D-04 — production export is unsigned; digest verify no-ops when absent (aug-25 #103 reproduced)

- **axis:** SE integrity fail-open
- **severity:** P2
- **attribution:** pre-existing (opt-in by contract)
- **owners:** `src/session/import-export.ts` `verifyV2Digest` / `withDigest`; `src/session/import-export-fs.ts`
- **consumers:** `src/apps/cli/session-cmd.ts:203` `exportSessionToFile(session, { quantaVersion, now }, outPath)` — no `emitV2`, no `withDigest` → **v1, no digest**.
- **evidence:** `import-export.ts:329` digest only if `withDigest === true`; `:542-543` absent digest returns. `t06-digest-canonical-hellgate.test.ts` drives `emitV2: true; withDigest: true` only.
- **failure mode:** CLI export JSON can be tampered and imported. Unsigned is the live production default.
- **proposed D write set:** `import-export.ts` (v2+digest default, or typed unsigned-import warning that cannot be silent). CLI flag plumbing is G — evidence only.
- **forbidden:** `src/apps/cli/session-cmd.ts` as D write.
- **uninspected:** IPC import tamper e2e (lane C owner).

### SEP7-D-05 — `deleteSession` and `forkSession` outside per-session save lock

- **axis:** concurrency / lifecycle
- **severity:** P2 (static interleaving; runtime race not executed this pass)
- **attribution:** pre-existing
- **owners:** `src/session/store.ts` `deleteSession` `:874-878`; `forkSession` `:824-871` (gap-fill sibling)
- **consumers:** `cmdDelete` + same-process `persistTurn` → `saveSessionById`; fork wrappers
- **evidence:** save/update/archive/rename/rewind take `withSessionSaveLock` (`store.ts:578-591`, rewind `:943-950`). delete unlinks without the lock. fork loads source and writes dest without the lock. Comment `:607-610` already admits no OS lock across processes.
- **failure mode:** overlapping delete and save can resurrect the file after unlink. Concurrent fork vs source save can clone a torn snapshot. `forkSessionAtMessage` exposes the untruncated clone between write and rewind.
- **proposed D write set:** wrap `deleteSession` and `forkSession` in `withSessionSaveLock` (source id + dest id). Extend `store-save-lock-toctou.test.ts`.
- **forbidden:** runner session-ops.
- **uninspected:** actual concurrent delete+save / fork+save; cross-process.

## Candidate fingerprints for W2-X

Do not implement from this lane. Compare both owners + a real producer/consumer.

| id | invariant | D owner | foreign / sibling owner | why not a D finding today |
|---|---|---|---|---|
| X-AUTH-3 | session identity persistence | `session/store.ts` V2 id snapshot | `agent/state.ts` V1 path transcript (A); kernel in-proc state | `persist-turn.ts` gates independently (`state` vs `idMeta`). Different contracts. Same-id dual-write race not shown. |
| X-JSONL-3 | append-only JSONL | session envelope `<sessionsRoot>/<id>.jsonl`; kernel `JsonlSessionEventLog` | stream `jsonl-recorder` (same lane, different schema/dir/gate) | D20 closed: different durability. No shared consumer seeing two logs as one. Envelope producer count 0. |
| X-ATOMIC | tmp+rename durability | `writeSessionFile` no fsync; kernel `writeSync` no fsync; `consolidate/writer.ts` 3-rename no fsync | `storage/atomic-write.ts` fsync-before-rename; LSP writer (C, D29 closed) | D20/D29: share primitive only after same-file durability claim. |
| X-GIT-SPAWN | git argv spawn policy | `storage/git-runner/runner.ts` (scrub+30s+abort) vs `memory/consolidate/git.ts` (full env, no timeout) | rewind/worktree (G/B) | **D13 not reopened** (no reproduced leak/injection/orphan/timeout). Measured policy drift only. Both files are D-owned if trigger later hits. |
| X-JAIL-ROOT | jail root-equality | `service.ts:157-160` equal=inside vs `fs-jail-lib.ts` equal=outside | plugin-app-resolver `is-path-inside` (A) | canonicalize is already SSOT. No live dual-consumer of both gates on one path. |
| X-ITEM | item projection | `item-stream-projector.ts` | kernel `session-host-turn-event-projection.ts` (passthrough); protocol agent-state (C) | pipeline, not two AgentEvent→item owners. Drift hellgate exists. |
| X-DEGRADE | Tee first-failure latch | `adapters/tee.ts` `onFirstDegrade` | CLI turn-indicator/summary only (G); runner observe tee unwired | port is D; wiring is G. |
| X-DECISION | decision emit destination | `decision-emitter.ts` swallow helper | CLI `runtime-context-compose` always tees to stdout+jsonl (G) | D vs ADR comment mismatch is G wiring. |
| X-TYPED-EVENT | typed history durability | in-memory adapter only | agent registry `wrapStoreWithDiskMirror` (A) | D port is sync/in-proc by contract. |
| X-STOP | stop-category mapping | `scheduler-turn-terminals.ts` | `@/agent/stop-category` value import (A) | kernel surfaceIsolationOnly; policy lives in A. |
| X-FRESHNESS | rank vs eviction weights | `ranking.ts` vs `eviction.ts` | none | copy-paste numbers; no failure mode. |
| X-VERB | SessionVerbSurface | none in D | ipc vs sdk (C/G) | D9 closed. |

## No-finding bounded areas

- Memory `PersistentStorePort` vs `Stage1StorePort` vs `TypedHistoryEventStore`: different schemas, no dual-write of the same invariant.
- Memory DIP: no `@/llm` value import; `Phase2Summarizer` / sanitization ports invert correctly. Fence hellgate exists.
- Auto-trigger: no hidden fallback; default-ON is ADR-0413 explicit.
- Artifact registry vs rich-markers: different authority (binary store vs text segments).
- StreamPort is emit-only ISP. Adapter extras are not on the port.
- Dual session rails (V1/V2/kernel) are **documented distinct contracts**, not a silent dual-write of one identity.
- `store.ts` 981 is cohort inventory; no function >150. Lock exists for save path (except delete).
- `ops.ts` 759 / `stdout.ts` 681 / `types.ts` 837: cohesion smells without a new failure mode.
- `SseStream`: production `new SseStream` count 0 — dead export inventory.
- D13/D14/D20/D26/D29: triggers not reproduced; fingerprints only.

## Test honesty (finding-adjacent)

| rail | reaches production ingress? | anti-vacuum | red-on-injection | note |
|---|---|---|---|---|
| crash-resume unit | module API yes; runner/CLI bootstrap no | gate on/off | persist-failure swallow pinned GREEN | locks SEP7-D-01 |
| rewind primitive | `rewindToMessage` yes | missing-id → 0 explicit | silent no-op is spec | locks SEP7-D-02 |
| t06 digest | `withDigest:true` only | digest cases ≥1 | unsigned path not RED | locks SEP7-D-04 |
| appendEnvelope tests | **no** persistTurn | assume file exists | vacuous vs production writer | SEP7-D-03 |
| store lock TOCTOU | `saveSessionById` real + barrier | yes | coordinator fold vs omitting save | honest; delete not covered |
| atomic-write-fsync | `writeFileAtomic` | n/a | crash-window sync injection | honest |
| sqlite-delete-async | SqliteStore | n/a | close→reject | not WAL multi-conn |
| jsonl-recorder "maps every AgentEvent type" | 8/45 events | weak | overclaim | inventory |
| memory-fence-no-llm | scan `src/memory` | `assertScanPopulation` | synthetic import | honest DIP rail |
| item-stream-projection-drift | projector vs session plane | yes | field parity | honest |

## Exact proposed write sets

D-owned only. Foreign files listed as W2-X handoff.

| finding | D files | D tests | W2-X / foreign (do not write from D) |
|---|---|---|---|
| SEP7-D-01 | `src/session/crash-resume.ts` | `tests/unit/session/crash-resume.test.ts` | `src/runner/orchestrate/crash-resume-wire.ts`, `src/apps/cli/repl.ts` |
| SEP7-D-02 | `src/session/store.ts`, `src/session/rewind.ts` | `tests/unit/session/rewind.test.ts`, `rewind-wrapper.test.ts` | `src/runner/session-ops/index.ts`, `src/apps/cli/rewind-cmd.ts` |
| SEP7-D-03 | `src/session/store.ts`, `src/session/index.ts` | new D-owned caller-floor / dead-export rail | `src/runner/orchestrate/persist-turn.ts` (producer), inspect/why cmds (G) |
| SEP7-D-04 | `src/session/import-export.ts`, `src/session/import-export-fs.ts` | `tests/unit/session/t06-digest-canonical-hellgate.test.ts` | `src/apps/cli/session-cmd.ts` |
| SEP7-D-05 | `src/session/store.ts` (`deleteSession` + `forkSession`) | `src/session/store-save-lock-toctou.test.ts` | `src/runner/session-ops/index.ts` |
| SEP7-D-06 | `src/session/index-store.ts` | new corrupt-line+upsert RED | doctor probes (G) |
| SEP7-D-07 | `src/session/store.ts` `readSavedSession` | miss-vs-corrupt typed result | `src/sdk/runtime/session/rehydrate.ts` (G) |
| SEP7-D-08 | `src/session/inspect-source.ts` `readEnvelopes` | skip-count surface + hellgate | inspect-cmd / why-cmd (G) |
| SEP7-D-09 | `src/kernel/session/scheduler-turn-terminals.ts` `onApprovalRequested` | terminal-append-hang hellgate covers approval | none |
| SEP7-D-10 | `src/memory/adapters/sqlite.ts` `update` | write-back must not persist dropped embedding | `src/agent/memory.ts` (A) |
| SEP7-D-11 | `src/stream/adapters/stdout.ts` | redact `tool_progress`/`in_progress`/`response_queued.hint` | `src/agent/stream-callbacks.ts` (A) |

## Gap-fill 2026-09-08 (parallel hole hunt)

Repo HEAD at gap-fill: `9b05cd33b008b52bf54c9f2391070afcbfbaa8fe`. D production tree vs original W1-D HEAD `0b14f5c` is **empty** (`git diff --stat` 0). Tracked D bytes unchanged. Original snapshot still valid for D.

D-01 sibling sites (same persist-swallow invariant, not new IDs): `clearSessionInterrupted:170-175`; `detectInterruptedSessions:207-214` per-session skip; `withMarkerRmwLock:77-79` reject-tail. Readers of a missing marker: `detectInterruptedSessions` → CLI `bootstrapCrashResumeOffers`.

D-05 sibling: `forkSession` (`store.ts:824-871`) load+write is **outside** `withSessionSaveLock`. `forkSessionAtMessage` writes a full clone then truncates.

### SEP7-D-06 — index corrupt-line skip drops sessions on next upsert

- **axis:** SE fail-open / derived cache destroying identity
- **severity:** P2
- **owners:** `src/session/index-store.ts` `readIndexMap` `:28-57`, `upsertMeta` `:109-118`
- **consumers:** `listSessions` → CLI picker/`cmdLs`, crash-resume candidate list, doctor `indexValid` (list never throws ⇒ always true)
- **evidence:** comment `:51` claims next upsert "heals"; `upsertMeta` rewrites **only surviving parsed lines**, so a corrupt line for id A is deleted when B upserts. Snapshot JSON for A remains. `store-health.ts` claims deleting the index rebuilds from files — **no rebuild-from-files path exists**.
- **failure mode:** session vanishes from list/detect/picker; `--resume <id>` still works.
- **D write:** `index-store.ts` (do not rewrite-drop unknown ids; or rebuild from `*.json`). Fix store-health comment.
- **forbidden:** doctor probes as the only fix.

### SEP7-D-07 — `loadSessionById` collapses missing ≡ malformed into `undefined`

- **axis:** SE fail-open / invalid representability
- **severity:** P2
- **owners:** `src/session/store.ts` `readSavedSession` `:463-497`
- **consumers:** `src/sdk/runtime/session/rehydrate.ts:90-94,130-136` treats `undefined` as **absent snapshot / empty transcript** even when `durableLog.tip()>0`. Fail-closed `ResumeRehydrateRefusedError` only runs if a snapshot object is returned.
- **evidence:** missing file, EIO, JSON parse, schema mismatch all `return undefined` + warn.
- **failure mode:** corrupt on-disk JSON + durable log present → empty resume, not refusal.
- **D write:** typed miss vs corrupt. G rehydrate can then refuse corrupt.
- **forbidden:** changing only sdk without distinguishing the store result.

### SEP7-D-08 — envelope iterate Result is dropped by D reader (inspect/why silent truncate)

- **axis:** fail-open / test honesty
- **severity:** P2 (dormant while SEP7-D-03 producer count is 0; live if any jsonl exists)
- **owners:** `src/session/inspect-source.ts` `readEnvelopes` `:301-313` (`if (r.ok) yield`; comment claims CLI warn channel, **no call**)
- **consumers:** inspect-cmd `:343-345`, why-cmd. Contrast: `/replay` `wire-builders.ts` counts skips.
- **D write:** surface skip-count from `readEnvelopes`.
- **related:** SEP7-D-03.

### SEP7-D-09 — approval persist throw reclassifies the turn as `turn.failed`

- **axis:** SE outcome redefinition
- **severity:** P2
- **owners:** `scheduler-turn-terminals.ts:181` `onApprovalRequested` uses throwing `appendEvents`; completed/aborted/failed use `appendTerminalEvents` isolator.
- **consumers:** `scheduler-turn-execution.ts:218-225` then catch `:242-261` → `onTurnFailed` for non-abort throws.
- **failure mode:** host returned approval wait; eventLog append ENOSPC → subscriber sees failed turn, not `awaiting_approval`.
- **evidence:** `kernel-terminal-append-hang.hellgate.test.ts` does not cover approval.
- **D write:** route approval append through isolator. RED: append throw ⇒ still `awaiting_approval`.

### SEP7-D-10 — sqlite `update` durable-writes a fail-open embedding drop

- **axis:** SE stale cache / partial-update
- **severity:** P2
- **owners:** `src/memory/adapters/sqlite.ts` `update` `:233-241` uses `rowToEntry` (not `toEntry`) then `save`; corrupt BLOB → `embedding` omitted → INSERT `null`.
- **consumers:** `src/agent/memory.ts` reinforce / eviction decay / memory_update.
- **failure mode:** one corrupt BLOB + any update permanently destroys the vector. `onCorruptEmbedding` is not wired in `buildStoreCore` and is not invoked on this path.
- **D write:** `update` must not persist dropped embeddings (refuse, or keep previous BLOB). Observer on write-back. RED: odd BLOB + update → embedding bytes unchanged.

### SEP7-D-11 — stdout renders `tool_progress` / `in_progress` / `response_queued.hint` without `redactStr`

- **axis:** SE secret leak at terminal boundary
- **severity:** P2
- **owners:** `src/stream/adapters/stdout.ts:261` `oneLine(event.message)` only; `:570` in_progress message; `:387` `response_queued.hint`.
- **consumers:** `src/agent/stream-callbacks.ts` emits `tool_progress`; CLI `StdoutStream`.
- **siblings:** `assistant_text` / `tool_result` / `error` / `decision` already `redactStr`.
- **D write:** those three strings through `redactStr`.
- **not D26** (render leak, not silent drop).

Gap-fill inventory (not findings): jsonl emit-after-close (no live close→emit consumer); SseStream dead; Tee latch vs non-throwing recorder (X-DEGRADE); dream persistCompleted dead catch vs E `JsonFileDreamState` NO-THROW (X fingerprint); `file_history` restore `writeFile` (lane B); EXDEV copyFile dead; event-log-jsonl mid-file fail-loud; user-question PARKED; git-fingerprint per-field swallow by ADR-0106.

## Uninspected conditions

- Cross-process OS file lock on `QUANTA_SESSIONS_DIR` (store comment already scopes this out).
- Live ENOSPC during crash-resume persist.
- Concurrent delete+save interleaving on a real filesystem.
- Hidden envelope writers outside `src/` (scripts, benches named differently).
- `tests/unit/kernel/knob-*` files: path is kernel but SUT may be config knobs (lane F). Not used as D ownership.
- Working-tree dirty ARCHITECTURE / slice-boundary-configs (W2/W3).
- Runtime proof of git hang/orphan on `ChildProcessGitPort` (D13 trigger).
- Full-suite execution (read-only audit; no tests run).
- Runtime ENOSPC on kernel approval append (SEP7-D-09 static only).
- Runtime sqlite odd-BLOB + reinforce write-back (SEP7-D-10 static only).
- Live TTY secret in `tool_progress` (SEP7-D-11 static only).

DONE (gap-fill 2026-09-08; D production still classified; not fixed)
