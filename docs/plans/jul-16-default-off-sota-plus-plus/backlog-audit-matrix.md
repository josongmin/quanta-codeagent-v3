# Default-OFF backlog — per-feature audit matrix (2026-07-18)

Generated from `tools/feature-catalog/default-off-ledger.yaml` after the source audit. `wired` proves an assembly/consumer path, not efficacy or an external operational receipt. Wave R adds the first explicit promotion receipt for `apply-patch-structured-result`; other rows retain their snapshot state.

| feature_id | decision | reachability | ON proof | OFF proof | receipt | audit verdict |
|---|---|---|---|---|---|---|
| adaptive-thinking | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| adversarial-repro-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| agent-jobs-batch | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| ai-session-title | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| apply-patch-structured-result | enable-now | wired | wire | unit | `25d19d89b` | explicit CLI promotion; real registry + real-FS partial/jail rail |
| approval-gate-wire | repair-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| appshot-verify-loop | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| assistant-language-auto-detect | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| ast-grep-tool | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| at-mention-autocomplete | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| auto-dream-cross-session | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| auto-mode-rule-overlay | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| automation-engine-wire | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| automation-tool-inbox-cli | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| background-compaction | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| background-side-agent | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| bash-mode-per-call-sandbox | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| bench-find-refs-steer | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| bench-trajectory-record | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| branch-search-progress | repair-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| bridge-attestation | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| budget-probe-ledger-wire | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| canvas-web-components | measure-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| circumvention-detector | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| cli-jun11-repl-input-ux | enable-now | wired | wire | wire | none | composition/wire covered; no execution receipt |
| cli-jun11-turn-input-layer | enable-now | wired | wire | wire | none | composition/wire covered; no execution receipt |
| closeout-critic-gate | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| code-coverage | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| code-mode-js-runtime | measure-first | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| codebase-indexer | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-compaction-event-emit | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-context-change-injection-wire | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-disk-persistence-and-env-swap | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-mention-injection-pipeline | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-multi-process-flock | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| codex-r2-observability-decorators | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-plugin-system | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-sqlite-session-registry | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-system-prompt-cache-and-audit | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| codex-r2-typed-event-store | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| collect-evidence | repair-first | wired | real-loop | real-loop | none | real-loop covered; no execution receipt |
| command-hooks | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| compaction-visibility | hold | wired | wire | unit | none | composition/wire covered; no execution receipt |
| conflict-parser-lib | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| conversation-action-steering | enable-now | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| debug-inspect | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| dockersandbox | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| dxt-user-config | measure-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| edit-repair-loop | measure-first | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| effort-classifier | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| embed-cache | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| env-probe | measure-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| external-editor-compose | enable-now | wired | wire | wire | none | composition/wire covered; no execution receipt |
| fast-apply-fallback | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| fast-apply-merge | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| fast-apply-wire | enable-now | wired | wire | wire | none | composition/wire covered; no execution receipt |
| fault-evidence-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| flock-operations-telemetry | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| force-background | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| gh-pr-code-tour | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| git-co-change | measure-first | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| git-directive-emit-leaf | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| git-directive-emit-protocol | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| github-actions-trigger-adapter | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| github-pr-from-pr-cli | hold | wired | wire | wire | none | composition/wire covered; no execution receipt |
| github-webhook-host-scaffold | enable-now | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| guardian-per-action-assessment | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| identity-mid-session-prompt-rebuild | hold | consumer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| image-gen | measure-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| infertooltier-secure-by-default-fallback | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| issue-hint-expected-actual-opt-in | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| item-stream-fine-grained | measure-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| jun7-manifest-codex-compat | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| jwks-agent-identity | hold | forward-contract | unit | unit | none | dormant/unconsumed; no promotion proof |
| keybindings-config | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| llm-record-replay | hold | wired | wire | unit | none | composition/wire covered; no execution receipt |
| loadreporules-cwd | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| localize-phase-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| mcp-launch-governance | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| mcp-tasks-live | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| mcp-tool-annotations-content | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| memory-cross-session-inject | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| message-batches-client-core | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| mid-turn-interruption | enable-now | wired | unit | wire | none | unit-only ON proof; promotion proof missing |
| mid-turn-steering | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| mode-cycle-pill | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| model-preset-sticky-resolver | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| model-tag-auto-hook | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| model-tag-versioning | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| multi-source-rules-vendor-detector | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| n6-pty-attach | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| ndjson-introspection | repair-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| no-patch-breaker-knob | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| node-repl-persistent-kernel | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| notebook-edit-cell-tool | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| notify-presence-suppression | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| observability-live-wire | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| observability-wire | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| observability-ws-sink | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| office-authoring | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| passive-vcs-classify | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| patch-budget-admission | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| patch-hygiene-knob | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| per-hunk-diff-accept-reject | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| per-tool-checkpoint-granularity | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| pipeline-composition-root-wire | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| platform-base-shell-argv | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| playbook-trigger-cli-bind | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| playbook-trigger-flag-echo | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| pptx-authoring | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| pre-compact-hitl | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| precedence-rule-r3-p1 | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| prefix-rule-dsl | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| primary-rail-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| product-onboard-skill | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| projects-kb | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| prompt-cache-observability | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| prompt-suggestion | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| proof-driven-bench-closure | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| radar-cards-proposal-queue | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| ratelimit-dual-window-snapshot | repair-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| ratelimit-snapshot-render | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| read-file-unchanged-dedup | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| realtime-websocket-codex | hold | wired | wire | unit | none | composition/wire covered; no execution receipt |
| reasoning-carryover | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| recovery-router-codex-spec | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| remote-runner | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| repair-escalation-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| repl-slash-ctx-mega-wire | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| repro-doubt-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| repro-test-mwe-vote | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| response-in-progress | repair-first | wired | wire | wire | none | composition/wire covered; no execution receipt |
| retry-transient-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| run-ledger-attribution | repair-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| run-tests | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| run-workflow | enable-now | wired | real-loop | wire | none | real-loop covered; no execution receipt |
| sandbox-escalation | measure-first | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| search-pipeline-composer | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| semantic-search-port | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| session-prewarm-ttfm | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| shadow-verify | repair-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| shell-snapshot-runshell-wire | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| side-agent-os-process-daemon | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| skill-mcp-deps | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| spawn-batch-tool | enable-now | wired | wire | wire | none | composition/wire covered; no execution receipt |
| spec-fidelity-steer-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| spinner-stall-detection | enable-now | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| stage1-phase2-consume-and-vendor-glob-wire | repair-first | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| stale-read-guard | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| streaming-boomerang | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| streaming-cancellation-primitive | hold | seam-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| structured-output-mode | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| subagent-6-tools | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| subagent-fs-ownership-enforce | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| subagent-introspect-tools | enable-now | wired | real-loop | unit | none | real-loop covered; no execution receipt |
| subagent-read-inbox | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| subagent-resume-replay | repair-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| surface-composition-wire-r1 | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| surface-wire-r2 | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| syntax-aware-chunking | repair-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| team-broker-coordination | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| team-dag-coordination | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| team-idle-barrier-coordination | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| template-literal-windsurf | hold | producer-only | unit | unit | none | dormant/unconsumed; no promotion proof |
| three-way-restore | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
| tier1-subagent-block | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| tool-interrupt-block | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| untrusted-source-envelope | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| verification-plan-knob | measure-first | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| voice-input-stt-slice | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| vscode-chatsessions-surface | hold | wired | unit | unit | none | unit-only ON proof; promotion proof missing |
| web-agent-state-channel | enable-now | wired | wire | unit | none | composition/wire covered; no execution receipt |
| worktree-tool | measure-first | wired | wire | unit | none | composition/wire covered; no execution receipt |
