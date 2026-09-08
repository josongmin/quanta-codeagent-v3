# W1-H receipt — media, voice, browser, git, patch, subagent, side-agent

```text
AUDIT_ASSIGNMENT|lane=H|scope=media,voice,browser,git,patch,subagent,side-agent|receipt=docs/plans/sep-7-solid-se-audit/receipts/W1-H.md
```

Read-only worker. Scope classified, not fixed.

---

## Snapshot

| Field | Value |
|---|---|
| `w0_receipt` | **ABSENT** at inspection start (`docs/plans/sep-7-solid-se-audit/receipts/W0.md` missing). Coordinator dispatched H before W0. Local freeze used. Invalidate this receipt if a later W0 disagrees. |
| HEAD | `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd` |
| branch | `main` |
| `origin/main` | same commit (ahead 0 / behind 0) |
| merge-base | same |
| staged diff SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) |
| unstaged diff SHA-256 | `b693d4693650443b72d5910a98fa9573bc633bcda34171e261e37445d058918e` |
| untracked count (inspection) | 7 |
| untracked manifest SHA-256 (inspection) | `0c7b458ad8f96b46e912f3f8ea481537c22a6351b38fda8d40423c49e8e9d411` |
| porcelain | 98 paths at inspection; **zero** under H production |
| H production dirty | false (HEAD == worktree for H src) |
| pre/post inspection (HEAD, staged, unstaged) | **unchanged** |
| untracked after this receipt | 10; manifest `4f5888c5f3939cf07b2975d8153d0d869966a572a7088832766a329fb6282ae5`. Delta = this file + sibling `W1-C.md` + `W1-F.md`. Not production drift. |

Authority document hashes (worktree vs HEAD):

| Path | HEAD SHA-256 | worktree | note |
|---|---|---|---|
| `AGENTS.md` | `79de5da2…1702c` | same | clean |
| `AGENT_CORE.md` | `d1f585c7…d7d82` | same | clean |
| `AGENT_PLAYBOOK.md` | `288bb7e2…b4f4b6` | same | clean |
| `docs/ARCHITECTURE.md` | `f190b0a2…650fdd` | `16626624…9b0fcf` | **DIRTY** — reserved W2/W3; H did not treat WT as truth |
| `tests/README.md` | `ba80760a…351967` | same | clean |
| `package.json` | `97c0650b…556e4` | same | clean |
| `biome.json` | `86028e6e…39703` | same | clean |
| `tests/unit/_arch/slice-boundary-configs.ts` | `31556028…15697` | `1e570be7…4458d6` | **DIRTY** — reserved; H side-agent `allowImports` file-narrowing present on both |
| `tools/god-code/detect.ts` | `0ffa10d2…81e5a5` | same | clean |
| `tools/god-code/allowlist.json` | `9ce34fb2…e34a3` | same | clean |
| `tools/dev/lint-debt-ceiling.json` | `b56462a0…eaf24` | same | clean |

Inspection truth for H source: **committed HEAD**, which equals the H worktree.

Retired-campaign rule: SEP5 D7/D13/D23 and SEP6 side-agent allow-narrowing are **not reopened** unless their documented trigger reproduced on this snapshot. SEP6 P2 register baseline is this same HEAD.

---

## Coverage counts

| Universe | Count |
|---|---:|
| Production `.ts` under exclusive H slices | 110 |
| Colocated test in src (`src/voice/transcriber/__tests__/local-whisper-drain-hellgate.test.ts`) | 1 |
| Production `.mjs` (`src/side-agent/worker-entry.mjs`) | 1 |
| **Inspected files** | **112 / 112** |
| Total lines (ts + mjs) | 19191 |
| God-module >1000 | 0 |
| Cohort 900–999 | 0 |
| Function body >150 | 0 (`createProcessSideAgentDaemonRegistry` interior 147) |
| H src in god-code allowlist | 0 |

| Slice | files | lines |
|---|---:|---:|
| media | 13 | 747 |
| voice | 11 (incl. 1 colocated test) | 1731 |
| browser | 26 | 4071 |
| git | 23 | 3055 |
| patch | 8 | 1886 |
| subagent | 24 | 6060 |
| side-agent | 6 ts + 1 mjs | 1479 + 162 |

Mirrored tests: same-name `tests/unit/{media,git,patch,subagent}` exist; `tests/unit/{voice,browser,side-agent}` dirs absent (root `tests/unit/{voice,browser,side-agent}-*.test.ts` own the SUT). No `tests/integration/{media,voice,browser,git,patch,subagent,side-agent}/` dirs. Root tests that import `@/{media,voice,browser,git,patch,subagent,side-agent}` were mapped (see consumers).

---

## Inspected consumer paths (production, H-external)

Cross-lane imports recorded as evidence, not write ownership.

| H owner | Reachable production consumers read |
|---|---|
| `@/media` | **none** in `src/` (tests only) |
| `@/voice` | `src/apps/cli/voice-cmd.ts`, `src/apps/cli/repl/voice-live-wire.ts`; type: `src/realtime/voice-session/default-session.ts` |
| `@/browser` | `src/host/runtime/agent-config-assembler.ts`, `src/tool/browser/index.ts` (+ session-holder/result-map) |
| `@/git` | `src/agent/loop-helpers.ts`, `src/tool/bash/index.ts`, `src/tool/git/conflict-parser/parse.ts` (SSOT forwarder), `src/tool/git/review-diff.ts` |
| `@/patch` | `src/tool/apply-patch.ts`, `src/tool/apply-patch-structured-tool.ts`, `src/tool/apply-patch-fallback-wire.ts`, `src/agent/shadow-verify-adapters/apply-v4a.ts`, `src/agent/ownership-policy.ts`, `src/apps/cli/preflight.ts` |
| `@/subagent` | `src/agent/coordination-broker-wire.ts`, `src/agent/side-agent-runner.ts`, `src/agent/tier1/subagent-*.ts`, `src/host/runtime/peer-team-wire.ts`, CLI/web-daemon factories |
| `@/side-agent` | `src/agent/side-agent-runner.ts`, `src/host/runtime/agent-config-assembler.ts`, `src/host/runtime/side-agent-fork-port.ts`; child: `src/side-agent/worker-entry.mjs` → `worker-charter-runner.ts` |

---

## Complete file manifest

Fingerprint key: `authority / invariant / input / output / state / effect / failure-policy / lifecycle`.

Largest-fn is approximate inclusive span from a brace matcher (navigation). No body >150.

### media (dead production stack)

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/media/index.ts` | barrel | 2 | — | media hellgates | tests only | export-facade / — |
| `src/media/stt/port.ts` | `SpeechToTextPort` | 22 | — | `tests/unit/media/stt-hellgate.test.ts` | adapters | STT-port / Result no-throw / AudioBlob / Transcript\|SttError / none / HTTP via adapter / typed / call |
| `src/media/stt/types.ts` | Transcript/SttError | 31 | — | stt-hellgate | adapters | types |
| `src/media/stt/deepgram-adapter.ts` | DG REST + shared STT transport helpers | 200 | `createDeepgramAdapter` ~40 | stt-hellgate, boundary-cancellation | registry | STT-HTTP / 30s+wav\|mp3 / blob / Transcript / none / fetchWithDeadline / typed / call |
| `src/media/stt/openai-whisper-adapter.ts` | Whisper REST | 93 | factory ~36 | same | registry | STT-HTTP / verbose_json / blob / Transcript / none / POST multipart / typed / call |
| `src/media/stt/registry.ts` | env select + optional DG→Whisper fallback | 105 | `createSttFromEnv` ~44 | HELL-S-07..10 | **none prod** | STT-select / env keys / env / SpeechToTextPort / none / adapter chain / headless if no keys; `fallbackOnError` hidden retry / call |
| `src/media/stt/headless-stub.ts` | canned STT | 12 | — | stt, voice-confirm | registry | stub |
| `src/media/stt/index.ts` | barrel | 23 | — | — | tests | barrel |
| `src/media/voice/port.ts` | `captureOnce` | 26 | — | `tests/unit/media/voice-input-hellgate.test.ts` | sox/headless | capture-once / wav\|mp3 / — / AudioBlob / none / spawn via impl / typed / call |
| `src/media/voice/types.ts` | AudioBlob | 22 | — | — | stt+voice | types |
| `src/media/voice/sox-capture.ts` | sox one-shot | 166 | factory ~20 | voice-input | **none prod** | sox-capture / trim / opts / blob / child / Bun.spawn / typed / start→stop |
| `src/media/voice/headless-stub.ts` | wav stub | 35 | — | voice-input | tests | stub |
| `src/media/voice/index.ts` | barrel | 10 | — | — | tests | barrel |

### voice (live recorder; transcriber adapters unwired)

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/voice/index.ts` | ADR-0208 barrel | 39 | — | voice-* hellgates | voice-cmd, voice-live-wire | barrel |
| `src/voice/port.ts` | `AudioRecorderPort` | 66 | — | `tests/unit/voice-recorder-hellgate.test.ts` | impls | recorder-handle / start-stop / opts / handle / none / spawn / typed / start→stop |
| `src/voice/types.ts` | AudioBytes wav\|webm | 75 | — | — | recorder/transcriber | types |
| `src/voice/default-recorder.ts` | sox→arecord→parec cascade | 363 | `createPlatformRecorder` ~61 | voice-recorder | **voice-live-wire** | recorder / backend cascade+25MiB / opts / handle / child / Bun.spawn / typed / start→SIGTERM |
| `src/voice/mac-mic-recorder.ts` | sox-only pin | 29 | — | recorder | unwired | thin pin |
| `src/voice/transcriber/port.ts` | `TranscriberPort` | 72 | — | `tests/unit/voice-transcriber-hellgate.test.ts` | adapters, voice-cmd **types** | STT-rich / segments+lang+abort / TranscribeReq / VoiceTranscript / none / HTTP/spawn / typed / call |
| `src/voice/transcriber/openai-whisper-transcriber.ts` | Whisper REST | 247 | factory ~33 | VT hellgate | **create\* none prod** | STT-HTTP / 60s wav\|webm / req / transcript / timeout ctrl / fetch+AbortController / typed / call |
| `src/voice/transcriber/deepgram-transcriber.ts` | DG REST | 285 | `doFetch` ~34 | VT | **none prod** | STT-HTTP / URLSearchParams nova-3 / req / transcript / timeout ctrl / fetch / typed / call |
| `src/voice/transcriber/local-whisper-transcriber.ts` | whisper.cpp | 336 | `runBinary` ~48 | VT + colocated drain hellgate | **none prod** | local-STT / 120s drain / req / transcript / temp dir / spawn / timeout+typed / run→cleanup |
| `src/voice/transcriber/index.ts` | barrel no registry | 38 | — | — | voice-cmd types | barrel |
| `src/voice/transcriber/__tests__/local-whisper-drain-hellgate.test.ts` | colocated drain pin | 181 | helper ~45 | self | — | test |

### browser

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/browser/index.ts` | barrel | 72 | — | `tests/unit/browser-slice-boundary.test.ts` | assembler, tool/browser | barrel |
| `src/browser/port.ts` | `BrowserPort` | 193 | — | adapter hellgates | both adapters + tool | browser-port / Result / verbs / Result / session via impl / CDP/stub / typed / spawn→close |
| `src/browser/types.ts` | domain errors | 223 | — | snapshot/console | slice | types |
| `src/browser/snapshot.ts` | DOM→YAML + RefMap | 123 | `createRefMap` ~40 | `browser-snapshot-hellgate` | page-ops, stub | snapshot / ref map / node / yaml / none / none / — / call |
| `src/browser/cdp-allowlist.ts` | model CDP allowlist | 44 | — | `browser-cdp-allowlist-hellgate` | page-ops.cdp, stub | allowlist / closed methods / cmd / bool / none / none / deny / call |
| `src/browser/cdp-adapter.ts` | CDP compose | 101 | `createCdpBrowser` ~49 | adapter hellgates | assembler | compose |
| `src/browser/cdp-adapter/deps.ts` | chrome probe | 51 | ~8 | adapter | bring-up | deps |
| `src/browser/cdp-adapter/session-state.ts` | tab helpers | 108 | ~8 | tabs hellgate | ops | session-state |
| `src/browser/cdp-adapter/bring-up.ts` | WS + domain enable | 174 | `connectAndEnable` ~59 | adapter | lifecycle spawn | bring-up / enable best-effort / — / session / none / WS / swallow enable fail / connect |
| `src/browser/cdp-adapter/lifecycle-ops.ts` | spawn/close/Map | 200 | spawn ~105 | `browser-cdp-session-map-leak-hellgate` | createCdpBrowser | lifecycle / map reap / spec / browser / Map / spawn chrome / typed / spawn→close |
| `src/browser/cdp-adapter/page-ops.ts` | nav/snapshot/cdp | 170 | `pageOps` ~142 | adapter+wait | port | page-ops |
| `src/browser/cdp-adapter/interaction-ops.ts` | click/type/… | 226 | `interactionOps` ~131 | adapter | port | input-ops |
| `src/browser/cdp-adapter/element-ops.ts` | ref poll | 117 | ~14 | wait | interaction/page | element |
| `src/browser/cdp-adapter/input-events.ts` | Input.* envelopes | 113 | ~22 | press-key | interaction | cdp-input |
| `src/browser/cdp-adapter/page-scripts.ts` | in-page JS | 155 | ~20 | adapter | interaction/page | scripts |
| `src/browser/cdp-adapter/tab-ops.ts` | multi-tab | 182 | `tabOps` ~101 | tabs hellgate | port | tabs |
| `src/browser/cdp/cdp-session.ts` | id↔reply correlator | 406 | `sessionRouting` ~100 | `browser-cdp-session-hellgate` | bring-up | CDP-corr / settle-once / frames / Result / pending+waiters / conn.send / timeout/closed / dispose+markDead |
| `src/browser/cdp/ports.ts` | IO ports | 76 | — | fakes | adapter | ports |
| `src/browser/cdp/defaults.ts` | Bun/Node adapters | 138 | thin | real-chrome e2e | assembler | defaults / exit-kill on default spawner / — / — / — / spawn / — / process |
| `src/browser/cdp/process-exit-kill-guard.ts` | host-exit child kill | 70 | factory ~37 | map-leak LEAK-06 | defaults | exit-kill / empty⇒unlist / proc / void / pending set / kill / report kill err / register→empty |
| `src/browser/cdp/dev-tools-endpoint.ts` | DevToolsActivePort poll | 71 | ~28 | endpoint-collect hellgate | lifecycle | endpoint |
| `src/browser/cdp/collect.ts` | a11y collect | 264 | script ~48 | collect hellgates | page-ops | collect |
| `src/browser/cdp/console-buffer.ts` | bounded console ring | 117 | ~34 | console hellgate | bring-up | ring / cap / event / entries / ring / none / drop-old / session |
| `src/browser/cdp/network-buffer.ts` | bounded net ring | 135 | ~34 | network hellgate | bring-up | ring (clone of console) |
| `src/browser/headless-stub.ts` | deterministic port | 89 | factory ~46 | tests | **tests only** | stub-port / weaker verbs no-op DOM / — / ok / fixture / none / ok / spawn→close |
| `src/browser/headless-stub/methods.ts` | stub bodies | 453 | ~22 | same | stub factory | stub-impl |

### git

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/git/index.ts` | barrel | 55 | — | git-slice-boundary | `@/git` importers | barrel |
| `src/git/conflict-parser.ts` | conflict-marker SSOT | 705 | `classifyTopLevel` ~61 | `tests/unit/git/conflict-parser*.test.ts` + ssot-ratchet | tool forwarder | conflict-parse / marker-length / string / blocks+diags / none / none / throw-on-input else diag / call |
| `src/git/cloud-branch-snapshot.ts` | dirty-tree→cloud branch | 665 | `runSnapshot` ~137 | `git-cloud-branch-snapshot.test.ts` | **barrel only; no live prod caller** | cloud-snapshot / force-with-lease / opts / {branch,sha} / FileLockPort / GitProcessPort / SnapshotError fail-closed / lock try/finally |
| `src/git/directive-emit/index.ts` | ADR-0221 barrel | 33 | — | git-directive-* | loop-helpers, tools | barrel |
| `src/git/directive-emit/types.ts` | call-site union (`stage.files`, `push.ref/force`) | 52 | — | emit hellgate | slice | ::git-callsite |
| `src/git/directive-emit/port.ts` | emitter port | 23 | — | same | emitter | emit-port |
| `src/git/directive-emit/phase-guard.ts` | final-answer only | 23 | — | HELL-DE-02 | defaultEmitter | phase |
| `src/git/directive-emit/validate.ts` | structural | 78 | ~14 | HELL-DE-12 | defaultEmitter | validate |
| `src/git/directive-emit/serializer.ts` | `::git-<kind>{json}` | 51 | ~14 | HELL-DE-05 | emitter | wire-ser / alpha keys / directive / line / none / none / total / call |
| `src/git/directive-emit/parser.ts` | wire parse | 87 | — | HELL-DE-07 | tests/hosts | wire-parse / known-kind / line / directive\|null / none / none / null no-throw / call |
| `src/git/directive-emit/emitter.ts` | noop + sink | 62 | ~19 | HELL-DE-01 | loop-helpers | emit-adapter |
| `src/git/directive-emit/turn-collector.ts` | per-turn buffer | 176 | ~58 | turn-collector hellgate | loop-helpers→turn-closeout | turn-buffer / FIFO / directive / Results / buffer[] / emit / swallow+typed / flush |
| `src/git/passive-classify/index.ts` | barrel | 33 | — | — | bash/host | barrel |
| `src/git/passive-classify/types.ts` | VcsEvent | 102 | — | hellgate | classifier | types |
| `src/git/passive-classify/classifier.ts` | stdout→event | 356 | ~43 | `passive-vcs-classify-hellgate` | bash-hook | classify / exit0+patterns / input / VcsEvent\|null / none / none / null / call |
| `src/git/passive-classify/pr-action.ts` | `gh pr` argv | 183 | ~35 | `git/passive-classify-pr-action.test.ts` | classifier | gh-pr-grammar |
| `src/git/passive-classify/sink.ts` | event sink | 32 | — | — | bash-hook, assembler | sink |
| `src/git/passive-classify/bash-hook.ts` | knob+sink | 66 | ~25 | passive + bash wire | `tool/bash/index.ts` | hook / default-OFF / cmd+stdout / event\|null / none / sink / catch / post-exec |
| `src/git/review-source/index.ts` | barrel | 19 | — | — | review-diff | barrel |
| `src/git/review-source/types.ts` | DiffSource | 71 | — | resolve tests | resolve | types |
| `src/git/review-source/ports.ts` | GitReadPort | 27 | — | — | resolve; adapter in tool | ports |
| `src/git/review-source/resolve.ts` | DiffSource→op | 82 | switch | `git/review-source-resolve.test.ts` | `tool/git/review-diff.ts` | resolve / fail-closed / DiffSource / Resolution / none / port / unavailable / call |
| `src/git/review-source/generated-attributes.ts` | linguist filter | 74 | ~14 | generated-attributes test | review-diff | gen-filter |

### patch

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/patch/index.ts` | barrel | 25 | — | patch-slice-boundary | tool/agent/cli | barrel |
| `src/patch/types.ts` | V4A AST + FS port | 163 | ctors | parser/applier | slice | types |
| `src/patch/parser.ts` | V4A text→AST throw | 299 | `stepInUpdate` ~32 | `tests/unit/patch/parser.test.ts` | apply-patch, ownership, structured | parse / strict V4A / text / Patch / none / none / throw PatchParseError / call |
| `src/patch/applier.ts` | plan/commit/journal | 761 | `applyPatch` ~59 | `tests/unit/patch/applier*.test.ts` | `@/patch` consumers | apply / plan-before-write / Patch+FS / ApplyResult / overlay+journal / FS mutate / throw after best-effort rollback / plan→commit |
| `src/patch/structured.ts` | per-op Result apply | 180 | `applyOneOp` ~31 | `patch-structured-apply-hellgate` | structured tool | structured / partial-ok ADR-0464 / op / Result / none / applyPatch / typed / per-op |
| `src/patch/structured-types.ts` | outcomes | 81 | — | structured | structured+tool | types |
| `src/patch/message-for-model.ts` | err→hint | 115 | ~24 | structured | structured | projection |
| `src/patch/unified-to-v4a.ts` | unified→V4A best-effort | 262 | ~23–29 | `tests/unit/patch/unified-to-v4a*.test.ts` | `tool/apply-patch.ts` | convert / no-throw / unified / V4A / none / none / best-effort; parse later / call |

### subagent

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/subagent/index.ts` | barrel | 106 | — | slice-boundary | apps/agent/host | barrel |
| `src/subagent/types.ts` | contracts | 229 | — | unit/subagent* | slice | types |
| `src/subagent/registry.ts` | TaskRegistry SoT | 415 | methods <150 | unit/subagent* | agent-tool, handlers, host | task-life / owner-token / TaskRecord / events / Maps / abort+emit / deny-stop / register→evict |
| `src/subagent/team/registry.ts` | peer membership | 173 | factory ~78 | team-membership | peer-team-wire | team-scope / one-team / ids / members / Maps / none / soft-no-op / mint→reap |
| `src/subagent/agent-tool.ts` | trio `agent` tool | 742 | schema ~126 | unit/subagent* | tier1/subagent | spawn-trio / depth+lineage / AgentInput / ToolEvent / TaskRegistry / runner FF / deny / bg-register |
| `src/subagent/handlers-6.ts` | 6-tool handlers | 719 | `handleSpawnAgent` ~100 | 6-tools hellgate | dispatch-6 | spawn-six / hostCap / SpawnInput / union / same reg / runner / error-kind / same |
| `src/subagent/tools-6.ts` | zod contracts | 371 | — | tools-6-contracts | handlers, agent-tools-6 | contract |
| `src/subagent/agent-tools-6.ts` | 6 Tool assembler | 257 | factory ~136 | 6-tools | tier1 | tool-wire |
| `src/subagent/dispatch-6.ts` | name→handler | 258 | small | 6-tools | agent-tools-6 | router |
| `src/subagent/exec-command.ts` | shell/pty exec | 335 | `prepareExec` ~68 | exec-*-hellgate, env-scrub | handlers | exec / scrub+jail / ExecInput / ExecOut / PtyMap / Bun.spawn / error-cause / grace |
| `src/subagent/exec-kill.ts` | kill port | 42 | — | exec-tree-kill | exec-command | kill-port |
| `src/subagent/turn-gate.ts` | park/wake/interrupt | 224 | methods <150 | turn-wake hellgate | runner; **foreign** `agent/loop/turn-gate` adapter | gate / woke-queued / wait / results / park+abort / AbortController / dispose-settle / arm→dispose |
| `src/subagent/turn-wake.ts` | waker map | 138 | ~81 | turn-wake | runner, introspect | wake-router |
| `src/subagent/introspect-tools.ts` | list/followup | 537 | followup ~53 | introspect | tier1/introspect | followup |
| `src/subagent/task-tools.ts` | task_output/stop | 237 | ~49 | unit/subagent* | trio wire | poll/stop |
| `src/subagent/agent-type.ts` | type validate | 140 | small | agent-type | agent-tool | typed-kind |
| `src/subagent/agent-meta.ts` | side meta map | 36 | — | introspect | handlers | optional meta |
| `src/subagent/role.ts` | role→tool policy | 101 | small | role tests | policy | role matrix |
| `src/subagent/nicknames.ts` | nickname | 131 | small | runner-identity | runner | cosmetic id |
| `src/subagent/coordination/index.ts` | barrel | 62 | — | — | agent | barrel |
| `src/subagent/coordination/broker.ts` | escalation pure | 220 | small | agent tests | `coordination-broker-wire` | grant / leaderId / msg / decision / none / none / undef / one-shot |
| `src/subagent/coordination/dag.ts` | DAG pure | 261 | dfs ~22 | batch | dag-gate | dep-order |
| `src/subagent/coordination/dag-gate.ts` | DAG runner wrap | 203 | factory ~81 | batch | tier1/subagent-batch | gate / block-on-fail |
| `src/subagent/coordination/idle-barrier.ts` | team idle | 123 | ~15 | team-idle e2e | side-agent-runner, registry | fan-in idle |

### side-agent

| path | role | lines | largest | test owner | consumer | fingerprint |
|---|---|---:|---|---|---|---|
| `src/side-agent/index.ts` | leaf barrel | 39 | — | slice-boundary | host, agent | barrel (does **not** re-export charter runner) |
| `src/side-agent/types.ts` | daemon ports | 169 | — | — | registries | daemon-port |
| `src/side-agent/registry.ts` | in-process supervise | 394 | helpers <80 | `side-agent-hellgate` | side-agent-runner | inproc-daemon / cap / Spec / id / Maps / interval+run / throw-cap / spawn→stop |
| `src/side-agent/process-registry.ts` | OS-process supervise | 327 | factory **147** | process-registry hellgate | assembler (`QUANTA_SIDE_AGENT_PROCESS`) | process-daemon / same port XOR inproc / Spec / id / Map / fork IPC / cap / spawn→stop |
| `src/side-agent/process.ts` | fork supervisor | 290 | factory ~118 | process-supervisor | process-registry | respawn / backoff |
| `src/side-agent/worker-charter-runner.ts` | child composition | 260 | assemble ~35 | process-llm e2e, depth hellgate | **worker-entry.mjs** | charter-LLM / catch→null / Charter / Finding\|null / none / LLM+runner / **null-on-fail** / one-pass |
| `src/side-agent/worker-entry.mjs` | forked child IPC | 162 | `handleCharter` | process os-fork e2e | fork port | child-IPC / LLM-or-degrade / charter / finding IPC / none / import+send / **degrade emits finding** / ready→charter→shutdown |

---

## Findings

Duplicate rule applied: two live owners + producer–consumer + measured drift or dual-write race. SOLID smell without failure mode → inventory. SEP5/SEP6 not reopened without trigger.

### SEP7-H-SA-01 — process charter fail-open (P1, SE hidden fallback)

- **Attribution:** pre-existing.
- **Owners:** `src/side-agent/worker-entry.mjs` `handleCharter` L133–145; producer `runCharterPassLLM` L74–80 and `src/side-agent/worker-charter-runner.ts` `runCharterPassLLM` L256–258 / `buildLlmPort` L154–158.
- **Consumer:** forked child is the production ingress; parent `createProcessSideAgentDaemonRegistry` treats IPC `{kind:"finding"}` as a real finding (`src/side-agent/types.ts` / `process.ts`). Host wires via `agent-config-assembler` when `QUANTA_SIDE_AGENT_PROCESS`.
- **Failure mode:** when `llmPassViable()` is true (API key or replay cassette) but the LLM pass returns `null` (import failure, empty task, missing provider, runner throw), the child **still emits** `{kind:"finding", summary:"side-agent process pass: <task>", detail: … "pass returned no finding"}`. In-process registry publishes only when `result !== null`. Operators/tools cannot distinguish investigation success from LLM/assembly failure. Detail note exists; IPC kind does not.
- **Test honesty:** no test asserts `"pass returned no finding"` (search empty). OS-fork e2e pins the **no-creds deterministic** path, which hides this branch.
- **Not SEP6 reopen:** `allowImports` for `@/llm`/`@/tool` remain **file-narrowed** to `worker-charter-runner.ts` on HEAD. That is closed.
- **Write set:** `src/side-agent/worker-entry.mjs`; optionally `worker-charter-runner.ts` comments/return type; new H-mirrored hellgate. **Forbidden:** `src/agent/**`, `src/tool/**`, `src/shared/**`.

### SEP7-H-SA-02 — process registry omits in-process cadence/runaway guards (P2, LSP)

- **Attribution:** pre-existing.
- **Owners:** live A `src/side-agent/registry.ts` `validateSpec` / `applyPostPassBounds` / `armTrigger`; live B `src/side-agent/process-registry.ts` `spawn` L228–272 (no validateSpec/maxWakes/idleReap/armTrigger). Supervisor `process.ts` L218–221 one charter on `ready`.
- **Consumer:** `src/tool/side-agent/index.ts` interval/event description + `wakesDone/maxWakes` list; host `maybeWireSideAgent` + `QUANTA_SIDE_AGENT_PROCESS`.
- **Failure mode:** same `SideAgentDaemonRegistry` port; process path one-shots then idles; invalid spec not rejected; tool UI shows guards that do not fire.
- **Write set:** `process-registry.ts` + `tests/unit/side-agent-process-registry-hellgate.test.ts`. **Forbidden:** weaken in-process; tool-copy-only fix.

### SEP7-H-PATCH-01 — unified rename converted to Update(fromPath) (P2, SE correctness)

- **Attribution:** pre-existing, **test-locked**.
- **Owner:** `src/patch/unified-to-v4a.ts` `GIT_META_PREFIXES` drops `rename from/to` (L103–114); `emitFileSection` uses `fromPath` for non-add/delete (L210–226).
- **Consumer:** `src/tool/apply-patch.ts` unified ingress (`unifiedDiffToV4A`).
- **Proof:** `tests/unit/patch/unified-to-v4a-scenarios.test.ts` S-OP-5 L269–286 expects `kind === "update"` on rename meta.
- **Failure mode:** a git rename unified diff applies content onto the **old** path; destination is not created; Move op unused.
- **Write set:** `src/patch/unified-to-v4a.ts` + `tests/unit/patch/unified-to-v4a*.test.ts`. **Forbidden:** `src/tool/**` (tool stays consumer).

### SEP7-H-PATCH-03 — binary/mode-only unified becomes empty successful apply (P2)

- **Attribution:** pre-existing, S-META-3 locks “no op”.
- **Owner:** `unified-to-v4a.ts` discards `Binary files`/mode meta; no `---/+++` ⇒ empty Begin/End. `parsePatch` accepts `{ops:[]}`.
- **Consumer:** `tool/apply-patch.ts` `guardedParseAndApply`.
- **Failure mode:** apply_patch can report success with zero FS change for binary-only unified.
- **Write set:** same converter + scenarios; empty-ops policy. Distinct from PATCH-01 (wrong Update vs silent no-op).

### SEP7-H-PATCH-02 — commit error claims rollback while undo is best-effort (P2, partial-update durability)

- **Attribution:** pre-existing (documented).
- **Owner:** `src/patch/applier.ts` `rollback` L226–238 swallows undo throws; commit catch L122–128 throws `Patch commit failed and was rolled back`.
- **Consumer:** `applyPatch` callers (`tool/apply-patch.ts`, `structured.ts`, `shadow-verify-adapters/apply-v4a.ts`).
- **Failure mode:** mid-commit I/O fail + undo fail ⇒ caller sees “rolled back” while disk may retain partial ops. Observer/trace fail-open (`wrapObserver` L44–63) is **intentional** and hellgate-owned — not this finding.
- **Write set:** `src/patch/applier.ts` + H-mirrored applier rollback tests. **Forbidden:** merging foreign `FsJailFileSystemPort` atomicity into `@/patch` without W2-X.

### SEP7-H-GIT-01 — dual `::git-*` protocol authority (P2, duplicate authority; W2-X owns merge)

- **Attribution:** pre-existing; both ADRs document sibling shapes.
- **Live owners:** ADR-0221 `src/git/directive-emit` (`stage.files`, `push.ref/force`) **and** ADR-0220 `src/agent/git-directives` (`stage.paths`, `push.remote/branch`) — lane A.
- **Producer:** `src/tool/git/stage.ts` L14–16, L54–87 `build0220Stage` + `build0234Stage`; `src/tool/git/push.ts` same pattern. One successful mutation dual-writes incompatible JSON under the **same** `::git-<kind>` prefix.
- **Measured drift:** field names and push meaning (`ref/force` vs `remote/branch`). A parser for one shape shape-rejects the other.
- **Failure mode:** UI tail vs turn-collector can accept/drop different facts from the same git tool success; no single round-trip.
- **H write set:** `src/git/directive-emit/**` only if W2-X picks this as canonical call-site. **Forbidden for H:** editing `src/agent/git-directives/**` or `src/tool/git/**` as if owned. Do **not** fold D13 GitRunner consolidation into this ticket.

### SEP7-H-MEDIA-01 — dead second STT/capture authority (P2, dead-authority; D7 delete path)

- **Attribution:** pre-existing (SEP5 D7 conditional).
- **Not a two-live-owner duplicate:** `@/media` has **zero** `src/` production imports. Voice HTTP `create*Transcriber(` also has **zero** production call sites; live `@/voice` consumer is `createPlatformRecorder` in `voice-live-wire.ts`. `/voice` refuses without injected recorder+transcriber (`voice-cmd.ts`).
- **Measured policy drift vs voice transcriber (unwired but importable):** timeout 30s vs 60s; mime wav\|mp3 vs wav\|webm; media `fetchWithDeadline` vs voice local AbortController; media `createSttFromEnv` `fallbackOnError` DG→Whisper; Deepgram URL baked query vs `URLSearchParams`.
- **Failure mode:** a second writable HTTP STT + sox-capture stack remains public; accidental compose would apply different timeout/mime/fallback than the live recorder plane. No measured dual-write today.
- **D7:** **Do not** build `voice→media` REST core / `src/shared` transport. **Allowed:** delete unused `@/media` with this consumer-absence proof.
- **Write set:** `src/media/**`, `tests/unit/media/**`, plus reserved W2/W3 for slice-boundary media config / default-off ledger owner_seam. **Forbidden:** REST core extract; peer import voice↔media.

---

## Candidate fingerprints for W2-X

| ID | H owner | Foreign | Contract |
|---|---|---|---|
| X-H-git-directive | `git/directive-emit` `::git-*` call-site | `agent/git-directives` UI-tail | same prefix, drifted JSON; dual emit from `tool/git/{stage,push}` |
| X-H-git-process-port | `GitProcessPort` (cloud-branch; no spawn in `src/git`) | `storage/git-runner`, `tool/git/runner`, rewind-git, memory/consolidate/git, runtime/worktree | D13 **not** reopened from H; spawn/env/timeout live on foreign paths |
| X-H-cdp-corr | `browser/cdp/cdp-session.ts` (pending+waiters settled on dispose/markDead) | `tool/debug/cdp-client.ts` (agent reported dispose settles pending only) | D23 trigger **not** reproduced on **browser** owner |
| X-H-patch-apply | `patch/applier.ts` canonical apply | `tool/apply-patch.ts` jail/stale/budget/unified/OTel | not a second apply engine |
| X-H-atomic-split | `PatchFileSystemPort.writeFile` (no atomic req) | `FsJailFileSystemPort` temp+rename | durability split across fence |
| X-H-stt-http | media adapters (dead) | voice transcriber (unwired create\*) | D7 REST merge **forbidden**; delete-or-keep |
| X-H-recorder | `media/voice` captureOnce (dead) | `voice/default-recorder` (live) | different lifecycle; one live owner |
| X-H-subagent-turn-gate | `subagent/turn-gate.ts` | `agent/loop/turn-gate.ts` thin adapter | not duplicate authority |
| X-H-subagent-spawn | `agent-tool.ts` trio vs `handlers-6.ts` six | `agent/subagent-runner` | shared TaskRegistry; parallel surfaces not dual-write |
| X-H-side-vs-sub | SideAgentDaemonRegistry XOR process | TaskRegistry | different invariants; host XOR |
| X-H-conflict-parse | `@/git/conflict-parser` | tool forwarder | SSOT ratchet non-vacuous (`conflict-parser-ssot-ratchet`) |

---

## Inventory (not findings)

- No H god-module / god-function / 900-cohort.
- `conflict-parser.ts` 705 / `applier.ts` 761 / `agent-tool.ts` 742 / `handlers-6.ts` 719 / `cloud-branch-snapshot.ts` 665 — cohesive, no second reason-to-change proven.
- Headless `BrowserPort` weaker than CDP (test double; prod assembler uses CDP).
- `bring-up` swallows Runtime/Log/Network.enable — capture fail-open, designed.
- Console/network buffer clone (same-slice algorithm reuse).
- Four registries (Task / Team / inproc side-agent / process side-agent) — distinct invariants; process vs inproc XOR at host.
- `DEFAULT_MAX_DEPTH` literal 3 in trio and six — drift risk, no measured dual-write.
- `exec-command` env-scrub hellgate is shape-scan honest; no runtime child-env assert.
- `worker-charter-runner` documents unfenced ownership across OS fork (default-OFF² + read-only tool filter) — residual, not a new silent hole.
- Voice transcriber factories unwired; `/voice` fail-closed on missing deps.
- `voice/index.ts` header “Default-OFF: no apps/cli wire” is **stale** vs `voice-live-wire.ts`.
- Media/voice hellgates reach adapters, not a live production ingress; no anti-vacuum / red-on-injection for “must stay wired”.
- `cloud-branch-snapshot` exported but no live prod caller.
- SEP5 D13: `src/git` has no `Bun.spawn`/`child_process`; argv via injected `GitProcessPort` only.
- SEP5 D23: browser correlator dispose/markDead clears pending **and** waiters (`cdp-session.ts`); HELL-SESS-12 / map-leak cover owner. Foreign correlator → W2-X only.

---

## No-finding bounded areas

- `@/browser` / `@/patch` / `@/git` / `@/media` / `@/voice` / `@/subagent` leaf DIP to `@/shared` (side-agent leaf barrel clean; charter runner carve-out file-narrow).
- Conflict-parser SSOT forwarder + ratchet (closed two-file set; forbids reintroducing `parseConflicts` algorithm in the tool module).
- Passive VCS: bash duck-types hook; knob default-OFF.
- Review-source: fail-closed resolve + generated-attr filter; argv conversion stays in tool adapter.
- Applier plan-before-write + journal-before-mutate ordering (rollback honesty is PATCH-02, not this).
- Structured apply reuses `applyPatch` (no second locator).
- CDP session map reaping; process-exit-kill-guard on default spawner.
- Local-whisper has timeout + stdout drain (missing-timeout suspicion refuted).
- Side-agent `allowImports` not whole-slice.

---

## Uninspected conditions

- W0 receipt union/intersection proof (file absent). Dirty non-H tree not classified.
- Real-Chrome e2e under load; real Whisper/Deepgram HTTP.
- Whether any **dynamic string** import of `@/media` exists outside TS `from` (static `src/` scan was zero).
- Full foreign slices (`src/tool/debug/cdp-client.ts`, `src/agent/git-directives/**`, `src/agent/subagent-runner.ts`) beyond cited consumer lines.
- Runtime proof that process-supervisor displays degrade findings as success in a live UI.
- Journal durability when `PatchFileSystemPort` is non-atomic (depends on foreign jail).
- `worker-entry.mjs` under **node** execPath (documented degrade); only bun path inspected statically.

---

## Exact proposed write sets

| ID | H-owned writes | Forbidden |
|---|---|---|
| SEP7-H-SA-01 | `src/side-agent/worker-entry.mjs`; optional `worker-charter-runner.ts`; new hellgate | `src/agent/**`, `src/tool/**`, `src/shared/**` |
| SEP7-H-SA-02 | `src/side-agent/process-registry.ts`; `tests/unit/side-agent-process-registry-hellgate.test.ts` | weaken in-process; tool-copy-only |
| SEP7-H-PATCH-01 | `src/patch/unified-to-v4a.ts`; `tests/unit/patch/unified-to-v4a*.test.ts` | `src/tool/**` |
| SEP7-H-PATCH-03 | same converter + empty-ops policy | tool warning-only |
| SEP7-H-PATCH-02 | `src/patch/applier.ts`; `tests/unit/patch/applier*.test.ts` | foreign atomic FS merge without W2-X |
| SEP7-H-GIT-01 | wait for W2-X; if canonical = H: `src/git/directive-emit/**` + mirrored `tests/unit/git-directive-*` | H must not edit `src/agent/git-directives/**` or `src/tool/git/**`; no GitRunner mega-merge |
| SEP7-H-MEDIA-01 | `src/media/**`; `tests/unit/media/**` | REST core; `src/shared` STT; `src/voice/**` deletion; peer import |

W1 did not edit production, tests (except this receipt), catalog, git, or GitHub.

Hole-check 2026-09-08: added SA-02, PATCH-03. Headless Map leak and voice-live mic-pump are inventory / G fingerprint.

---

DONE
