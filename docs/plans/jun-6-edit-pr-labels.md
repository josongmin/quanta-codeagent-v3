# RFC: jun-6 — C4 `gh_pr_edit_labels` (add / remove PR labels)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADR: 0484 (gh_pr_edit_labels).

---

## 1. 요약 (Summary)

quanta's gh tools READ labels (`gh issue view --json …,labels`,
`src/tool/gh/index.ts:98`) but cannot **mutate** them. Adding/removing PR labels
is a staple of CI automation — `needs-review` / `ready-to-merge` /
`do-not-merge` / area labels are how agents and bots gate and route PRs. This
RFC designs **`gh_pr_edit_labels`**: a thin, mutating wrapper over
`gh pr edit <pr> --add-label … --remove-label …` with `add`/`remove` string
arrays, the arg-injection-safe ref/label validation the other gh tools use, a
**mutating** manifest row, and the `gitWrite`-lever permission posture of the
existing gh write tools. **Default-OFF** under the shared `QUANTA_GIT_TOOLS`
gate. It is a tight, ~1-file wrapper (`gh` does all the work).

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

`gh pr edit <pr> --add-label "<a>,<b>" --remove-label "<c>"` is the canonical
CLI; it accepts repeatable `--add-label`/`--remove-label` flags (or
comma-joined). The same operation via REST is
`POST /issues/{n}/labels` (add) + `DELETE /issues/{n}/labels/{name}` (remove) —
but the `gh pr edit` porcelain is simpler and matches the other gh tools'
`gh pr <verb>` shape, so we use it (no GraphQL needed, unlike thread-resolve).
CI-automation agents (Claude/Cursor/Codex PR bots) all expose label add/remove
as a first-class mutating action for triage and merge-gating.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

- **Labels are READ-only today.** `gh_issue_view` requests `--json
  title,body,state,labels,url` (`src/tool/gh/index.ts:98`) and `gh_pr_view`
  surfaces PR JSON — both read. `grep -rn "add-label\|remove-label\|edit-label\|
  --label\|labels" src/tool/gh/` shows labels only inside read `--json` field
  lists. There is **no** `gh pr edit` call anywhere — `grep -rn "pr edit\|pr
  *edit\|gh.*edit" src/tool/gh/` → 0 hits.
- **The write-tool pattern to mirror** (verified): `gh_pr_comment`
  (`index.ts:151-177`) — `isReadOnly:()=>false`, `isConcurrencySafe:()=>false`,
  `normalizeRef(input.pr)` guard (`:160`), `argv=["gh","pr","comment",ref,…]`,
  injected `runner` (`:167`), `r.code!==0`→`ok:false` with `stderr.slice(0,500)`.
- **Permission posture** (verified): `gh_pr_auto_merge` (`index.ts:315-316`):
  *"Write — the mode's gitWrite lever is the structural gate; this tool just
  invokes `gh`."*
- **Injected runner + env fence** (verified): `GhRunner`
  (`src/tool/gh/runner.ts:18-58`) with `scrubEnv(CI_ENV_ALLOWLIST_LOCAL)` —
  provider keys never reach `gh`.
- **Ref guard** (verified): `normalizeRef` (`src/tool/gh/ref.ts:14-26`) rejects
  `-`-leading values (arg-injection), accepts a positive int or `http(s)` URL.
- **Manifest** (verified): the `gh_pr_view` group (`manifest.ts:287-306`) under
  `gate:{env:"QUANTA_GIT_TOOLS"}`, `default:{cli:"opt-in"}`, `risk:"network"`.

**Verdict: NOT superseded.** Label mutation is absent; only read exists.

---

## 4. 설계 (Design, closed-port DI)

### 4.1 Tool shape — `gh_pr_edit_labels` (mutating)

```ts
const prEditLabelsSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  add: z.array(z.string()).optional().describe("Label names to add"),
  remove: z.array(z.string()).optional().describe("Label names to remove"),
}).refine(v => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0,
  { message: "at least one of add/remove must be non-empty" })
```

`isReadOnly:()=>false`, `isConcurrencySafe:()=>false` (mirror `gh_pr_comment`,
`index.ts:157-158`). Execute:

```ts
const ref = normalizeRef(input.pr)
if (ref === undefined) { yield ok:false refRejected("PR", input.pr); return }
const labels = [...(input.add ?? []), ...(input.remove ?? [])]
const bad = labels.find(isUnsafeLabel)        // arg-injection / empty guard
if (bad !== undefined) { yield ok:false labelRejected(bad); return }
const argv = ["gh","pr","edit",ref]
for (const l of input.add ?? [])    argv.push("--add-label", l)
for (const l of input.remove ?? []) argv.push("--remove-label", l)
const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
if (r.code !== 0) { yield ok:false `gh pr edit failed: ${r.stderr.slice(0,500)}`; return }
yield ok:true (r.stdout.trim() || "labels updated")
```

`isUnsafeLabel(l)` rejects empty strings and any `-`-leading value (a label
named `--repo` would be parsed by `gh` as a flag — same arg-injection class
`normalizeRef` defends, `ref.ts:5-12` note). Each label is pushed as a
**separate argv element** after its `--add-label`/`--remove-label` flag (never
shell-joined), so commas/spaces inside a label name are literal, not
re-split — no shell, `Bun.spawn` argv (no `bash -c`).

### 4.2 Permission / HARD_DENY posture

- `risk:"mutating"`, `isReadOnly:false`. The **mode's `gitWrite` lever is the
  structural gate** (same statement as `gh_pr_auto_merge`, `index.ts:315-316`):
  in a mode where `gitWrite` is off (plan mode), the tool is inadmissible via
  the existing `MUTATING_TOOL_TABLE` / dispatch-guard
  (`src/agent/dispatch-guard/default-guard.ts`).
- Editing labels is **not** destructive history rewriting, so it is **not** in
  the HARD_DENY destructive set and needs no special HITL beyond the standard
  mutating-tool permission flow (a permissive CI mode runs it directly; an
  interactive mode prompts per the mode's policy). It is strictly less risky than
  `gh_pr_comment` (no content authored) and `gh_pr_auto_merge` (no merge).

### 4.3 Closed-port DI

Inject `GhRunner` (default `defaultGhRunner`) — the only boundary. No clock, no
randomness, no git runner (pure `gh pr edit`). Fully unit-testable with a fake
runner; no network.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

Rides the existing `QUANTA_GIT_TOOLS` gate (`manifest.ts:301`),
`default:{cli:"opt-in"}`. No new knob. Default surfaces byte-identical (gh tools
opt-in; absent the flag the tool does not register).

### 5.2 Manifest row (mutating)

Add `"gh_pr_edit_labels"` to the `gh_pr_view` group `group:[…]` array
(`manifest.ts:289-299`); per-tool `isReadOnly:false` ⇒ dispatch-guard treats it
mutating. Drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`)
requires the name present or CI fails.

### 5.3 fc + fence

One fc node **"gh-pr-edit-labels"** on the feature axis + the manifest entry
(fc↔manifest drift stays green). New small factory either inline in
`src/tool/gh/index.ts` beside `gh_pr_comment` (it is a tiny wrapper) or a
`src/tool/gh/pr-edit-labels.ts` file re-exported from the barrel
(`index.ts:33-34` pattern); added to the `ghTools(runner, opts)` array
(`index.ts:409`).

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, fake runner — no network)

- **arg-injection (ref):** `pr:"--web"` → `refRejected`, runner never called.
- **arg-injection (label):** `add:["--repo"]`, `remove:["-R/x"]`, `add:[""]` →
  `labelRejected`, runner never called. Assert the unsafe label never reaches
  argv.
- **argv exactness:** `add:["a","b"], remove:["c"]` → argv ==
  `["gh","pr","edit",ref,"--add-label","a","--add-label","b","--remove-label",
  "c"]` (each label a separate element; comma/space inside a label name stays
  literal — `add:["needs review, urgent"]` is ONE element, not re-split).
- **empty input:** no add/remove → schema `.refine` rejects ("at least one…").
- **failure envelope:** `r.code!==0` → `ok:false` with `stderr.slice(0,500)`,
  never throws.
- **gitWrite gate:** mode with `gitWrite` off → inadmissible (mode matrix).
- **env fence:** fake runner asserts `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` absent
  from the env passed to `gh` (reuse `runner.ts` allowlist assertion).
- **default-OFF:** `QUANTA_GIT_TOOLS` unset → not registered (real assembler).

### 6.2 e2e (gh-gated — skip if `gh` unauthenticated)

Against a scratch PR: `add:["needs-review"]` then `remove:["needs-review"]`;
`gh pr view --json labels` confirms the round-trip. Live-only (smoke tier-1).

---

## 7. 단계 (Phasing)

Single phase — it is a thin wrapper. `gh_pr_edit_labels` + manifest/fc rows +
hellgate. Default-OFF. (Optional later: a `gh_issue_edit_labels` sibling sharing
the same arg-builder — deferred; identical shape, `gh issue edit`.)

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Arg-injection via label names** (a label literally named `--add-label` or
  `-R/owner/evil`). Eliminated by `isUnsafeLabel` rejecting `-`-leading/empty
  before argv + passing each label as a separate `Bun.spawn` argv element (no
  shell). Same defense class as `normalizeRef` (`ref.ts`).
- **Non-existent label.** `gh pr edit --add-label <missing>` fails with a
  non-zero code → deterministic `ok:false` (gh's own error surfaced, sliced to
  500 chars). No special handling needed; fail-soft.
- **Token leak to `gh`.** Reuses `runner.ts` `scrubEnv` allowlist (asserted in
  hellgate).
- **Alternative — fold into a general `gh_pr_edit` (title/body/labels/etc.).**
  Rejected for v1: a focused label tool keeps the schema tiny and the risk
  surface obvious; a kitchen-sink edit tool muddies the permission story. Labels
  are the high-frequency CI-automation case.
- **Alternative — REST (`gh api`).** Rejected: `gh pr edit` porcelain matches
  the other gh tools' `gh pr <verb>` shape and needs no GraphQL/REST plumbing
  (unlike thread-resolve, which has no porcelain). Simpler = fewer bugs.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented):**
- `gh_pr_edit_labels` factory — inline in `src/tool/gh/index.ts` (beside
  `gh_pr_comment`) or `src/tool/gh/pr-edit-labels.ts` re-exported from the
  barrel; added to `ghTools(...)` (`index.ts:409`).
- `docs/decisions/0484-gh-pr-edit-labels.md`.

**Touched (gate-wiring only):**
- `src/tool/surface/manifest.ts:289-299` — add name to the `gh_pr_view` group.
- fc node + `tests/unit/tool-surface-manifest-hellgate.test.ts`.
- new `tests/.../gh-pr-edit-labels.hellgate.test.ts` + gated e2e.

**Audited ground truth (cited, NOT modified):**
- `src/tool/gh/index.ts:98` (labels READ via `--json`), `:151-177`
  (`gh_pr_comment` write pattern), `:315-316` (gitWrite posture), `:409`
  (`ghTools` array).
- `src/tool/gh/runner.ts:18-58` (injected runner + `scrubEnv` fence).
- `src/tool/gh/ref.ts:14-26` (`normalizeRef` arg-injection guard).
- `src/tool/surface/manifest.ts:287-306` (`gh_pr_view` group row).
- `src/agent/dispatch-guard/default-guard.ts` (gitWrite / HARD_DENY gating).
