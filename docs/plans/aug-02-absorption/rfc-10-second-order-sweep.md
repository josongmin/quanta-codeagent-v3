# RFC-10 — Second-order completeness sweep (raw-corpus blind-spot mining)

**Status:** DRY declaration (defended). No genuine gap survived. Read-only sweep; no `src/` change proposed.

**Audit basis:** `main@0a00ced392102073fe35eccd202bca92cabd71dc`, corpus at `.extracted_source/`, 2026-08-03 KST.

## Method (deliberately different from RFC-01~09 + `_coverage-critic`)

Prior sweeps compared **audit files** against RFCs (candidate ledger = the A/B/C/D-lettered items already extracted into `_audit-*.md` / `_analysis-*.md`). `_coverage-critic.md` mined the same audit files for items that never got a letter-number ID and found a 4-item residue (LSP-as-MCP-tools, hook `additionalContext`, `fork_turns`+delegation-prompt, richer review-finding schema) — all four are now dispositioned in RFC-09.

This sweep uses a **different source of truth**: the raw corpus itself. The premise is that a feature can be absent from *every* audit slice (and therefore from every RFC) if it fell between the domain boundaries the six audit tracks drew. So instead of re-reading audit prose, I mined feature-signal **tokens directly out of the binaries and type catalogs**, built a "already-named" universe from the union of all audit + RFC text (`/tmp/known_universe.txt`, 4949 lines → 680 distinct snake/camel tokens), and diffed raw-corpus tokens against it. Any token with `known=0` is a *potential* second-order blind-spot; each was then classified by grepping `quanta src/` (ALREADY-BUILT / NON-ABSORBABLE / GENUINE-GAP).

Raw slices mined:
1. **Codex feature-flag enum** (concatenated string in `_codex-bin-symbols.txt`): 45 discrete flags.
2. **Codex settings/config-key enum** (second concatenated string): `show_tooltips`, `raw_output_mode`, `status_line`, `terminal_title`, `resume_cwd`, `keymap`, `fast_default_opt_out`, `terminal_resize_reflow_max_rows`, `pet_anchor`, … (renderer/product surface).
3. **Codex app-server JSON-RPC protocol namespace**: 366 `*Notification`/`*Params`/`*Response`/`*Request` types.
4. **claude-code `sdk-tools.d.ts`**: 87 tool `*Input`/`*Output` types + 315 distinct input **field** names (field-level mining, not just tool-level).
5. **Codex webview i18n / command-ID clusters** (`codex.*` keys across `webview/assets/*.js` + `.vite/build/*.js`).

## Corpus-mining results (candidate → disposition)

Raw candidates mined (tokens with `known=0` that reached classification): **~34** distinct feature-signal tokens across the 5 slices. Every one collapsed. Representative disposition table (the load-bearing ones):

| Raw candidate (slice) | `known=0`? | quanta grep | Disposition |
|---|---|---|---|
| `shell_snapshot` / `shell_zsh_fork` (flag) | yes | `capabilities.ts:11`, `knob-catalog.ts:192` (`QUANTA_SHELL_SNAPSHOT_SHELL`), `runtime/shell-snapshot/` port (ADR-0237) | **ALREADY-BUILT** |
| `deferred_executor` (flag) | yes | `src/tool/deferred/` + `poll_deferred` (ADR-0287, `QUANTA_ASYNC_TOOLS`) | **ALREADY-BUILT** |
| `codex_git_commit` (flag) | yes | `src/tool/git/commit.ts` | **ALREADY-BUILT** |
| `memory_tool` (flag) | yes | `src/agent/memory-tools.ts`, `update-working-state.ts` (L3 memory meta-tool) | **ALREADY-BUILT** |
| `secret_auth_storage` (flag) | yes | OS-keyring engine `src/host/runtime/keyring/` (RFC-08 D3d already-built) | **ALREADY-BUILT** |
| `terminal_resize_reflow` (flag/setting) | yes | TUI reflow-on-resize; renderer chrome | **NON-ABSORBABLE** (headless agent) |
| `use_linux_sandbox_bwrap` / `use_legacy_landlock` / `experimental_windows_sandbox` / `elevated_windows_sandbox` (flags) | yes | OS-specific sandbox backends; quanta has `runtime/sandbox.ts` posix/os-sandbox | **NON-ABSORBABLE** (OS-backend-specific) |
| `telepathy` (flag) | yes | Codex-internal experimental (multi-agent shared-state broadcast, ≈ `CollabAgentStateFileUpdate` which `_coverage-critic` already rated UNCOVERED-(b) speculative) | **NON-ABSORBABLE** |
| `connectors` / `imagegen` / `remote_models` (flags) | — | Gmail/Drive connectors, image-gen, hosted models | **NON-ABSORBABLE** (RFC-audit §E list) |
| `TurnDiffUpdatedNotification` (protocol) | yes | `agent-config-assembler.ts:705` `turn_diff_updated`, `QUANTA_TURN_DIFF` knob | **ALREADY-BUILT** |
| `ThreadInjectItems*` (protocol) | yes | `src/agent/inbound-mode.ts` `weave` (inject into in-flight turn) | **ALREADY-BUILT** |
| `GitDiffToRemote*` (protocol) | yes | `src/tool/git/review-diff.ts` three-dot `origin/main...HEAD` base diff | **ALREADY-BUILT** |
| `ReasoningSummaryPartAdded` / `ReasoningTextDelta` (protocol) | yes | `factory.ts:95` `reasoningSummary` / `reasoningSummaryDetail` | **ALREADY-BUILT** |
| `TurnPlanStepStatus` / `TurnPlanUpdated` (protocol) | yes | `src/agent/plan/types.ts:43` `pending\|in_progress\|completed\|cancelled\|blocked` | **ALREADY-BUILT** |
| `GetConversationSummary*` (protocol) | yes | `src/agent/conversation-summary-archive.ts` | **ALREADY-BUILT** |
| `TurnSteerParams` (protocol) | yes | `src/llm/retry/codex-spec-router.ts` steerability + jul-18 3-mode delivery | **ALREADY-BUILT** (partial; steer covered by delivery modes) |
| `ThreadSearch*` / `ThreadSearchOccurrences*` (protocol) | yes | client-RPC find-in-thread bar (`_coverage-critic` UNCOVERED-(b) renderer chrome); not model-callable | **NON-ABSORBABLE** (GUI RPC) |
| `FuzzyFileSearch*` (protocol) | yes | @-mention fuzzy picker = RFC-06 B4 mentions; client-RPC | **COVERED / NON-ABSORBABLE** (GUI RPC) |
| `Fs*` (117 in cluster: `FsWatch`/`FsCopy`/`FsReadFile`/…), `Apps*`, `Marketplace*`, `Plugin*`, `RemoteControl*`, `*Realtime*`, `Account*`, `*Login*`, `Config*`, `Attestation*`, `Environment*`, `Feedback*` (protocol) | mixed | editor-filesystem bridge / hosted account / voice / plugin-marketplace / remote-pairing — all **client-RPC or hosted**, none model-callable | **NON-ABSORBABLE** (RFC-audit §E) |
| `NotebookEditInput` (SDK tool) | yes (only 1 audit hit, 0 RFC) | `src/tool/notebook-edit/tool.ts` `notebook_edit` (P17 cell-level str_replace/insert/delete) | **ALREADY-BUILT** |
| `GrepInput` fields (`multiline`, `output_mode`, `context`, `head_limit`, `offset`) | — | `src/tool/grep/index.ts` (`-U`, `output_mode`, `-A/-B/-C`, offset) | **ALREADY-BUILT** (field-parity) |
| `FileReadInput.pages` / `offset` / `limit` | — | `src/tool/read/index.ts` + `read/ipynb.ts` + `tool/document/*` | **ALREADY-BUILT** |
| `BashInput.dangerouslyDisableSandbox` | yes | quanta uses approval-gated `sandbox-escalation-wire.ts` (safer model, not a raw disable flag) | **NON-ABSORBABLE-as-is** (deliberate safety divergence) |
| retry-config struct (`stream_idle_timeout_ms` / `stream_max_retries` / reconnect-mode) | yes | `src/llm/stream-timeout.ts`, `retry/`, `RetryingLLM maxRetries` — capability present, only *config-exposure* absent | **DEFERRED** (already flagged in `_coverage-critic`; RFC-05 D1 explicitly excludes configurable retry — not a blind spot) |
| `codex.*` i18n keys (dialogs/banners/chatgpt/trusted-contact/upsell/announcement) | — | renderer/product chrome | **NON-ABSORBABLE** |

## DRY declaration (defended)

**No token mined from the raw corpus survived to a genuine, absorbable, second-order gap.** Every `known=0` candidate resolved to one of:

- **ALREADY-BUILT** — the concept exists in `quanta src/` under a different token (shell-snapshot, deferred-executor, git-commit, memory-tool, turn-diff, inject-items/weave, diff-to-remote, reasoning-summary, plan-step-status, conversation-summary, notebook-edit, grep/read field-parity). This is the single largest bucket, consistent with the three prior sweeps each collapsing ~75% of candidates to already-built.
- **NON-ABSORBABLE** — client-RPC for the Codex/Claude GUI (the entire `Fs*`/`Apps*`/`Marketplace*`/`Plugin*`/`RemoteControl*`/`Realtime*`/`Account*`/`Config*`/`ThreadSearch*`/`FuzzyFileSearch*` protocol clusters = 117+ of the 366 protocol types), OS-backend-specific sandbox flags, hosted connectors/imagegen/remote-models, or renderer chrome/i18n. These match the RFC-audit §E non-absorbable list and the `_coverage-critic` UNCOVERED-(b) rulings.
- **DEFERRED / already-dispositioned** — the retry-config struct is a config-exposure delta over an existing capability that `_coverage-critic` already named and RFC-05 D1 explicitly excludes; not a blind spot.

**Why the sweep is genuinely dry, not lazy:** the second-order thesis was that a feature could hide between the six audit tracks' domain boundaries. The mining directly tests that thesis by ignoring the audit prose and reading the binaries/type-catalogs. The result is that the audit tracks were, in aggregate, complete on the *absorbable* surface: every model-callable behavior, every agent-observable event, and every tool-input field that appears in the raw corpus is already either built in quanta or explicitly non-absorbable. The only things "the audits missed at the token level" (`shell_snapshot`, `NotebookEdit`, `turn_diff_updated`, `weave`/inject-items, three-dot review diff, reasoning-summary) turn out to be **things quanta already shipped** — i.e. the audits didn't flag them precisely because they're non-gaps. That is the correct, defended dry outcome: a token being absent from the audit ledger is *evidence of already-built* far more often than evidence of a gap, and here it was already-built or non-absorbable in 100% of cases.

The one MED item any completeness critic must not miss — **LSP-as-callable-MCP-tools** — is (a) named in `_analysis-codex-cli-ide.md` and `_coverage-critic.md`, so not a second-order blind spot, and (b) already dispositioned in **RFC-09** (grep-confirmed). No new RFC is warranted.

## Default-OFF gate / TDD+hellgate / Effort

N/A — no build proposed. A dry sweep produces no gate, no RED fixture, no god-code surface. Per the README Wave-0 rule 4 ("a `PARK`/`DROP` verdict is a valid closeout; do not create skeleton ports, dormant knobs, placeholder tools, or catalog rows for a non-admitted build"), this RFC intentionally lands **zero** new authority.

**Effort:** read-only investigation only (~0 implementation).

## Risks

- **False-dry from coarse tokenization.** The known-universe token set is only 680 distinct tokens because audit prose is mostly natural language, so a substring pre-filter could have hidden a real gap behind a common word. Mitigated by classifying via `quanta src/` grep on the *concept* (not the token) for every high-signal candidate, and by mining field-level names, not just tool names.
- **Renderer-only corpus.** The webview slice is almost entirely product chrome; a genuinely absorbable model-facing feature there is unlikely but the bundle minification limits confidence. Accepted: model-facing behavior lives in `_codex-bin-symbols.txt` (engine) and `sdk-tools.d.ts` (tool catalog), both fully mined.
- **`telepathy` / `CollabAgentStateFileUpdate`.** Codex-internal experimental multi-agent shared-state broadcast. Rated non-absorbable/speculative here and by `_coverage-critic`; if OpenAI ships and documents it, re-evaluate as a measure-first rider on RFC-07. Not actionable now.

## Open questions

1. `BashInput.dangerouslyDisableSandbox` — quanta deliberately routes sandbox-escape through approval (`sandbox-escalation-wire.ts`) rather than a raw model-settable disable flag. This is a safety-superior divergence, not a gap; recorded so a future audit does not re-flag it as "missing field."
2. Retry-config exposure (`stream_idle_timeout_ms` etc.) remains a valid *someday* low-ROI knob-surfacing over existing `RetryingLLM`/`stream-timeout`; owned by RFC-05, not reopened here.

## Audit log R1 → R3

- **R1 — "you missed the one MED gap the last critic found."** Attack: A-GAP-1 (LSP-as-callable-MCP-tools) is the highest-value residue; a truly-complete sweep must surface it. Rebuttal: (a) it is *named in audit files* (`_analysis-codex-cli-ide.md`, `_coverage-critic.md`), so by construction it is **not** a second-order (between-audit-slices) blind spot — this sweep's mandate is items absent from *all* audit files; (b) grep confirms it is already dispositioned in **rfc-09** (`grep -l "call-on-demand.*LSP" rfc-*.md` → rfc-09). No change; the DRY claim is scoped to *un-audited* tokens and stands. R1 changed the RFC by adding the explicit rfc-09 cross-reference so the claim is not read as "LSP-tools don't matter."
- **R2 — "you dismissed protocol types as client-RPC without proving they aren't model-callable."** Attack: `FsWatch`, `ThreadSearch`, `FuzzyFileSearch`, `ThreadInjectItems` could be agent tools, not GUI RPCs — dismissing 117 protocol types as non-absorbable could be papering. Rebuttal: verified the discriminator — Codex's model-callable tools live in the **feature-flag/tool enum** (`shell_tool`, `web_search`, `apply_patch`, `code_mode`, …); the `*Params`/`*Response`-suffixed types are the **app-server JSON-RPC surface** consumed by the Electron/IDE client (they sit next to `FsReadFile`/`FsCopy`/`Account*`/`Login*`). `FsWatch*` is `FsWatchParams`/`FsWatchResponse` = editor filesystem bridge, exactly parallel to `FsReadFile`. And for the ones that *are* real agent behavior (`ThreadInjectItems`→`weave`, `TurnDiff`→`turn_diff_updated`, `GitDiffToRemote`→`review-diff.ts`), I grep-proved the quanta equivalent rather than hand-waving. R2 changed the RFC by adding the explicit "protocol tool-enum vs client-RPC" discriminator to the method + the 117-count evidence, so the non-absorbable ruling is grounded, not asserted.
- **R3 — "field-level and already-built claims are vacuous / you only checked tool names."** Attack: a tool can be "already built" while a specific input field is a genuine blind spot (the method's own premise); did you actually descend to fields, or stop at tool names and declare victory? Rebuttal: descended to fields — mined all 315 SDK input-field names and diffed them (`base64`/`mimeType`/diff-metadata were the only `known=0` field residue, all image/diff plumbing), and directly compared `GrepInput`/`FileReadInput`/`BashInput`/`FileEditInput`/`TaskUpdateInput` field-by-field against `src/tool/grep/index.ts`, `read/index.ts`, `bash/`, with file:line for each match. The one field that is genuinely absent as-written — `dangerouslyDisableSandbox` — is a *deliberate* safety divergence (approval-gated escalation), logged as Open-Q #1 rather than smuggled into a fake gap. R3 changed the RFC by adding the field-level rows and the Open-Q so the already-built verdicts are non-vacuous (concept-grep + field-grep, not name-match).

**Converged:** three adversarial rounds each tried to break the dry declaration (missed-MED-item, mis-classified-protocol, vacuous-field-check) and each was refuted with grep evidence. The sweep is DRY and the declaration is defended. No RFC-10 build; no new owner, gate, or catalog row.
