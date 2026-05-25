# ADR-0203: User-authored playbook frontmatter (procedure / success-criteria / forbidden-actions / macros / inline-trigger)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0040 (SKILL.md 6-field strict frontmatter — the
  pre-existing lenient parser this slice composes ABOVE without mutating),
  ADR-0098 (repo-rules tree — read-only port consumed by the validator),
  ADR-0134 (skill 7-scope tiering — orthogonal to the procedural fields),
  ADR-0149 (engineering-skills-bundle — the bundled skills that benefit
  from authoring playbooks against the new slots)
- **References**: `src/skill/playbook/**`,
  `tests/unit/playbook-frontmatter-hellgate.test.ts`

## Research grounding

5-vendor convergence (`docs/analysis/경쟁사리뷰/`) on the
"user-authored task macro" surface:

| Vendor              | Key primitive                                                 |
|---------------------|---------------------------------------------------------------|
| **Devin Playbooks** | Procedure (action-verb-per-line) + Specifications + Forbidden Actions + `!name` macros + version history |
| **Windsurf**        | `.windsurf/workflows/<name>.md`, 12 KB cap, slash `/<name>` manual, workflow-from-workflow, 4-tier precedence |
| **Aider AI!**       | source-comment inline trigger (`// fix this AI!` in saved file → dispatch) |
| **Cody commands**   | prompt mode (chat \| edit-code), 4 built-in + custom `.cody/commands.json` |
| **Codex `.system/SKILL.md`** | frontmatter `allowed-tools` + closed allow list |

Our current state (per cluster memory `cc-v2-sota-absorption`,
`codex-system-skills-pattern`, `may-24-adr-0131-0135-sprint`):
ADR-0040 lands the strict 6-field skill frontmatter
(name / description / userInvocable / allowedTools / category / stability);
ADR-0134 layers the 7-scope tag; ADR-0149 bundles 4 engineering-task
prompts. The frontmatter has slots for **what tools** a skill may invoke
but no slots for **what procedure**, **what success looks like**, **what
must never happen**, or **what macros expand inside the procedure**.
Authors who want Devin-style playbooks today have to encode procedure as
prose in the markdown body, which loses MECE structure AND prevents
HARD_DENY enforcement.

## Context

Three observations frame the slice:

1. **The procedural slots are author-facing, not LLM-facing.** A model
   does not "execute" `procedure:` directly — the host renders it into the
   prompt as structured guidance. Therefore the slice MUST NOT couple to
   the agent loop, the tool layer, or the permission seam. The validator
   exposes a `(frontmatter, actionRepr) → verdict` function the host
   wires into its own dispatch — the playbook slice itself dispatches
   nothing.

2. **Inline trigger is the only "live" surface.** Aider's `AI!`
   comment-marker scan is the one piece that needs to run as a watcher.
   The watcher must NOT depend on `chokidar` (install blocked in this
   environment; verify-workflow memory) — `node:fs.watch({ recursive:
   true })` covers the contract with weaker but acceptable debounce
   semantics, and the port shape is unchanged when chokidar later swaps
   in (a one-line adapter-body change).

3. **Forbidden-actions must be HARD_DENY, not soft.** A Devin Playbook
   that says "never push to prod" needs a verdict that fires BEFORE the
   tool runs, not a string the model reads and may decide to ignore.
   This is the validator's only job — short-circuit substring containment
   against a case-insensitive haystack, returning a typed
   `ForbiddenActionMatch` the host renders.

A naïve approach would extend the strict 6-field frontmatter schema
(`src/skill/skill-frontmatter.ts`). This is rejected because the strict
schema's contract is "drift in this frontmatter = drift in the
LLM-callable surface". The new slots are AUTHORING-facing, not
LLM-callable, so they belong in a parallel parser the host calls IN
ADDITION TO the strict one when it knows it is loading a playbook.
Existing strict-schema consumers stay byte-identical (verified by
HELL-PB-01).

## Decision

Add a new leaf slice `src/skill/playbook/` with five modules + a barrel,
all importing only `node:fs`, `node:fs/promises`, `node:path`, the `yaml`
library (already a dep for `yaml_read`), and local sibling files. NO
imports from `@/agent`, `@/tool`, `@/permission`, `@/storage`. The
existing `src/skill/skill-frontmatter.ts` and `src/skill/frontmatter.ts`
are NOT modified — the playbook slice is purely additive.

### Modules

- **`types.ts`** — `PlaybookFrontmatter` shape (every field optional),
  `MacroDefinition`, `InlineTriggerConfig`, `ValidatorVerdict`,
  `MacroLookupResult`, `PlaybookParseError`, `PLAYBOOK_MAX_BYTES = 12 KB`.
- **`port.ts`** — `InlineTriggerWatcherPort` (start/stop), `RepoRulesReaderPort`
  (read-only view of ADR-0098's rendered body). Both are interface-only;
  implementations live in sibling files.
- **`frontmatter-parser.ts`** — `parsePlaybookFrontmatter(text)` →
  `PlaybookParseResult`. Delegates YAML to `yaml@2.x` (battle-tested,
  error locations) then applies STRICT type narrowing per field. Unknown
  keys are ignored (forward-compat); present keys must have the right
  shape or surface a typed `PlaybookParseError` with a 1-based line
  number. Enforces the 12 KB cap up front.
- **`validator.ts`** — `evaluatePlaybookAction(fm, actionRepr, repoRules?)`
  → `ValidatorVerdict`. Case-insensitive substring containment against
  `forbiddenActions`. First-hit short-circuit. Optional
  `RepoRulesReaderPort` consumed ONLY by the diagnostic
  `repoRulesMentions` helper — repo rules NEVER mutate the verdict.
- **`dispatcher.ts`** — `buildMacroRegistry(macros)` →
  `MacroRegistry`; `expandStep(step, registry)` →
  `StepExpansion`; `expandProcedure(steps, registry)` aggregates missing
  refs across the list. Macro grammar: `!name` at a non-word left
  boundary expands; `\!name` is literal; suffix `foo!bar` does not parse
  as macro; expansion is ONE pass (no recursion).
- **`inline-trigger-watcher.ts`** — `createInlineTriggerWatcher()` using
  `node:fs.watch` with default 200 ms debounce + glob filter. Returns
  typed `ok:false` for `root-not-found` / `root-not-dir` / `io-error`.
  Also exports `createMemoryWatcher()` for tests — same port, in-memory
  `fire(path, contents)` simulator with manual clock.
- **`index.ts`** — barrel; only re-exports from the five modules.

### Frontmatter schema (added slots)

```yaml
name: deploy-staging
description: ship a build to the staging env
allowed-tools: ["Bash", "Read"]      # legacy (ADR-0040)
procedure:                            # NEW — MECE ordered steps
  - "build the bundle"
  - "run smoke suite"
  - "ship to staging"
success-criteria:                     # NEW — declarative predicates
  - "smoke suite passes"
  - "rollout health green for 5m"
forbidden-actions:                    # NEW — HARD_DENY substrings
  - "push to prod"
  - "rm -rf"
macros:                               # NEW — `!name` shorthand
  abort: "stop and report"
  retry: "rerun the last step"
trigger:                              # NEW — Aider AI! inline dispatch
  comment-marker: "QUANTA!"
  watch-glob: "**/*.{ts,py,js}"
```

EVERY new slot is optional. A SKILL.md whose frontmatter omits all of
them is byte-identical to the pre-0203 lenient skill — pinned by
HELL-PB-01.

### Library choices

- **`yaml@2.9.0`** (already a dep for `yaml_read`) — battle-tested, anchor-
  aware, surfaces error locations the parser can convert to
  `PlaybookParseError.line`. Hand-rolling YAML for nested mappings
  (`trigger:`) would re-create the well-known split-and-narrow defect
  the existing strict parser sidesteps for the flat 6-field case.
- **`node:fs.watch({ recursive: true })`** in lieu of `chokidar` (install
  blocked). Semantics are weaker (no atomic-rename de-dup; we paper over
  with our own 200 ms debounce) but the port is identical so chokidar
  swaps in by changing one adapter body.

### Default-OFF wire

NOTHING in `@/agent`, `@/tool`, `@/permission`, or any other slice
imports `@/skill/playbook` yet. The slice's seams are dormant until a
host:

  1. Calls `parsePlaybookFrontmatter(skillBody)` after the lenient
     parser, in addition to the strict 6-field parser when applicable.
  2. Calls `buildMacroRegistry(fm.macros)` + `expandProcedure(...)` once
     at load time to lint authoring errors.
  3. On every proposed tool call, calls
     `evaluatePlaybookAction(fm, actionRepr)` and forwards
     `ok: false` verdicts to its permission seam as a hard-deny.
  4. (Optional) Calls `createInlineTriggerWatcher().start({...})` on
     session bind, `.stop()` on unbind.

The wire-up is a follow-up slice (per the user instruction block:
"src/agent/* 건드리지 말 것").

## Hellgate (16 cases)

`tests/unit/playbook-frontmatter-hellgate.test.ts`:
HELL-PB-01..16 pin (in order): default-OFF byte-identical, full 4-field +
trigger parse, malformed yaml ⇒ typed line-numbered error, unterminated
fence rejected, wrong shapes rejected for procedure/macros/trigger,
kebab-case macro name enforced (Underscore/Caps/leading-dash/spaces/dots
rejected), forbidden-actions case-insensitive substring HARD_DENY,
empty/undefined forbidden list ⇒ permit, macro registry lookup hit+miss,
expandStep bare ref + escape + suffix-bang + repeat-dedup + missing-left-
verbatim, expandProcedure aggregates missing across steps deduped, file
> 12 KB ⇒ typed reject, memory watcher debounce coalesces same-path,
glob filter on watcher, real `fs.watch` rejects missing/non-dir root
with typed reason, repo-rules port is READ-ONLY (verdict invariant).

117 expect() calls across 16 tests. Runtime ~65 ms.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Extend the strict 6-field schema (skill-frontmatter.ts)** | Strict schema contract is "drift = LLM surface drift". New slots are AUTHOR-facing not LLM-callable. Coupling them would force the strict parser's loud-failure semantics on every authoring iteration. |
| **Modify the lenient parser (frontmatter.ts) in place** | Would break the lenient parser's "unknown keys silently kept" contract that legacy CC v2 skills depend on. Default-OFF byte-identical (HELL-PB-01) is impossible if we mutate the parser. |
| **Hand-roll YAML for nested `trigger:` mapping** | The strict parser hand-rolls because its surface is flat. `trigger:` is a sub-mapping; reproducing yaml-2's escape/quote/anchor handling for one slot is wasted maintenance. `yaml` is already a dep. |
| **`chokidar` for file watching** | Install blocked in this environment (verify-workflow memory). The port shape is identical so chokidar swaps in via one adapter-body change. |
| **Auto-dispatch on inline trigger fire** | Devin's contract is "fire → playbook starts immediately"; Aider's is "fire → composer is prefilled, user confirms". We follow Aider — the watcher's `onFire` is a callback the host wires to its OWN dispatch policy. Auto-dispatch on a file save is the obvious footgun (cf. ADR-0202 voice-confirm-always invariant). |
| **Recursive macro expansion** | An expansion that itself contains `!other` could trigger an infinite cycle and forces a graph-traversal pass. Devin specifies one-pass; we match. Authors who want composition can inline the second macro at the call site. |
| **Forbidden-actions as regex** | Regex is the substring-superset, but regex authoring errors (`*` outside character class etc.) silently corrupt the deny list. Plain substring containment with case-insensitive comparison is the smallest correct primitive. A future ADR can add `forbidden-patterns:` as a SIBLING field if regex demand materializes. |
| **Repo-rules WRITES into playbook verdict** | The user instruction block called for "repo-rules tree와 연동, 읽기만". A repo rule that says "rm -rf is forbidden" must surface via the repo-rules system's own enforcement; the playbook validator must not silently incorporate authority from a different ADR. The `repoRulesMentions` helper exists ONLY to render richer error messages. |

## Consequences

- **Default-OFF byte-identical**: pre-0203 skills parse via the existing
  lenient + strict parsers unchanged; nothing in the playbook slice runs
  unless the host opts in. HELL-PB-01 pins this.
- **Slice fence intact**: `src/skill/playbook/` imports only
  `node:fs`/`node:fs/promises`/`node:path`/`yaml`/local files. NO
  imports from `@/agent`, `@/tool`, `@/permission`, `@/storage` — the
  playbook slice IS the boundary between authored intent and the
  surfaces that act on it.
- **`chokidar` swap target**: the `InlineTriggerWatcherPort` shape is
  identical to what a chokidar-backed adapter would expose. When
  installs unblock, swapping the body of `createInlineTriggerWatcher()`
  is the only change needed; consumers stay byte-identical.
- **Follow-up slices**:
  - Wire `parsePlaybookFrontmatter` into `discoverSkills` so a host that
    opts in reads the new slots without a separate call.
  - Wire `evaluatePlaybookAction` into the permission seam as a
    pre-dispatch gate (gated by ADR-0098 repo-rules tree presence).
  - Wire `createInlineTriggerWatcher` into the CLI session-bind /
    session-unbind hooks.
  - Add `--playbook <name>` slash command surface (Windsurf parity).
