> **⚠️ UPDATE 2026-07-13 — 계측이 이 문서의 우선순위를 뒤집었다.** 실 트라젝토리 dedup 결과
> edit 실패의 41%가 `stale_precondition`(not_found=0)이고, 근본원인은 "성공 edit이 fresh hash를
> 안 돌려줘 연속 same-file edit이 자기유발 stale"임이 밝혀졌다. 더 싼 root-fix(`QUANTA_EDIT_FRESH_HASH`,
> 성공시 post-edit sha256 반환)를 구현·검증 완료 — 아래 E1(keystone)은 **secondary로 강등**, E2는 보류.
> 계측·근본원인·구현 전체는 [06-edit-fresh-hash-measured-fix.md](06-edit-fresh-hash-measured-fix.md).

# jul-12 OmO absorption — #3: edit-mismatch REMAP self-correct (scoped slice only)

North-star: **agent-state observability** — the model must SEE *why* an edit
failed and *where* the target drifted, not be told to blindly re-read. This slice
turns a bare "re-read the file" failure into a localized "these lines changed"
signal so the model's next action is observably grounded.

Constraints (hard):
- **No duplicate implementation.** We already own the stale-defense (sha256 +
  mtime + content-match) AND a line-diff renderer (`diff-preview.ts`). This
  proposal reuses both; it invents no third diff engine and no new safety layer.
- **No cheap heuristics.** The hint is a *deterministic diff* over real bytes
  (current-disk vs a real baseline), never a regex guess at "what probably moved".
- **Hellgate ≥3R.** RED repro (a stale edit whose failure output carries NO
  localized diff today) → green → adversarial self-audit ≥3 rounds.
- **Measure-first (THIS candidate IS gated).** default-OFF flag + an
  edit-success-rate / re-read-count / tokens-per-successful-edit A/B. This
  candidate does **NOT** inherit the leak-fix exception — it is a behavior/quality
  lever, so it must be *measured* before it ships ON. If the A/B is flat, delete it.

---

## 현황 (증거 기반, file:line)

Our edit tool (`src/tool/edit/index.ts`, `makeEditTool` at :485) already has a
**3-layer stale defense** — parity with (or stronger than) OmO's hashline scheme,
so there is **nothing to adopt on the safety axis**:

1. **sha256 precondition** — `checkHashPrecondition` (index.ts:97-118). When the
   caller supplies `expected_hash` (schema :47-50), the tool computes
   `sha256Hex(source)` over CURRENT bytes and refuses on mismatch with a typed
   `stale_precondition` failure (index.ts:105-110). Gate wired at planEdit
   (index.ts:336-337).
2. **mtime guard (TOCTOU clobber protection)** — `editPreCommitDeny`
   (index.ts:458-479) calls `guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)`;
   a target modified on disk since read is rejected `{mode:"rejected",
   reason:"stale_read"}`. This guard is **DEFAULT-ON** (strict kill-switch
   `QUANTA_STALE_READ_GUARD=off`, `gate.ts` `staleReadGuardEnabled`).
3. **content-match** — the exact/fuzzy replacement itself: if `old_string` is not
   present verbatim, `buildMismatchResult` returns `{mode:"not_found"}`
   (index.ts:61-89). This is the read-time-content correctness check.

**THE GAP — the failure FEEDBACK, not the safety.** All three layers, on failure,
hand the model a *"re-read the whole file"* instruction with **no localized
signal about which lines drifted**:

- `stale_precondition` → `"…Re-read the file and re-issue the edit with the fresh
  expected_hash."` (index.ts:114-115) — hashes only, zero content locality.
- `stale_read` mtime → `STALE_WRITE_MESSAGE` `"…Re-read the file with the read
  tool, then re-apply your change…"` (`stale-read-guard/types.ts:59-62`) — no
  diff, no line numbers.
- `not_found` → strategy-hint + optional `nearestNote` (index.ts:73-89,
  `nearestCandidateHint` :149-164) — this is the *closest* we get today, but it
  reports at most ONE whitespace-equal line; it is not a "here is the region that
  changed" diff.

Net: on a stale/mismatch edit the model's cheapest recovery is a **full re-read of
the file** — a token tax proportional to file size, and an opaque agent state
("something changed, go look again") rather than an observable one ("lines 40-46
moved; retarget there").

We ALSO already own the diff machinery the fix needs — no new engine:
- `src/apps/cli/diff-preview.ts` — `diffLines` (:273) + `renderUnified` (:265)
  emit git-style hunks with `@@ -old +new @@` headers and line-number gutters
  (:266-290). This is the exact "which lines changed, with context" render OmO
  hand-rolls in its `HashlineMismatchError.formatMessage`.
- `src/tool/tool-diff-capture.ts` (`captureToolDiff`, :25) — the before/after
  hand-off seam already used post-commit; the same before/after pair is what a
  failure hint would diff.

---

## OmO source read (what it actually does)

`/tmp/oh-my-openagent/packages/hashline-core/`:
- **`hash-computation.ts`** — every read line is tagged `{lineNumber}#{hash}|{content}`
  (`formatHashLine` :23-26), xxhash32 over `trimEnd()`-normalized content, with a
  whitespace-only line seeded by `lineNumber` to avoid collisions (:7-13). Edit
  refs must cite `123#a3f9`.
- **`validation.ts`** — on an edit ref whose hash no longer matches the current
  line, `validateLineRefs` REJECTS **before** mutating (:162-181) and throws
  `HashlineMismatchError`. That error carries (a) a **remap table**
  old-ref→new-ref (:91-96) and (b) a **`>>>`-marked context window**
  (`formatMessage` :99-135, `MISMATCH_CONTEXT=2` lines each side) so the model
  self-corrects **without re-reading the whole file**.
- **`autocorrect-replacement-lines.ts`** — restores the model's re-wrapped
  newlines to the original file's newline shape.

Two separable ideas here:
1. **The always-on hash-anchor read format** — a per-read token tax: every line
   the model reads carries a `#a3f9|` prefix, forever.
2. **The mismatch→remap→self-correct feedback loop** — a diff/context window
   emitted ONLY on the failure path, zero standing cost.

---

## What we DON'T adopt, and why

**REJECT the full always-on hashline read format (idea #1).** Verdict: net
negative for us.

- **Per-read token tax.** Prefixing every read line with `{n}#{hash}|` inflates
  EVERY file read the model does, on every turn, for the entire run. On a
  200-line file that is 200 extra `\d+#[A-Z]{2}\|` tokens the model pays to read
  and (worse) must echo back correctly in edit refs. The cost is *standing* and
  scales with read volume — the dominant token sink in a coding agent.
- **Marginal safety gain we ALREADY HAVE.** The anchors buy staleness detection.
  We already detect staleness three ways (sha256 + mtime + content-match, 현황
  above), all at **zero standing cost** — the sha256 is one hash of bytes we
  already read, the mtime is a stat we already do, the content-match is the edit
  itself. Adding line-hash anchors is a *fourth*, redundant, expensive detector.
- **New output-contract surface.** Hashline forces the model's edit refs into a
  `{line}#{hash}` grammar (validation.ts `parseLineRef` :42-65 throws on any
  deviation). Our edit contract is plain `old_string`/`new_string`. Switching
  grammars is a large, risky change to the hottest tool for a detector we don't
  need.
- **Prior audit corroborates.** The full-hashline candidate scored **63/100** in
  prior review precisely because the token tax dominated its marginal safety
  upside.

We keep our read contract **unchanged**. Zero new standing token cost is a
first-class design goal of this slice.

---

## 제안 / IMPLEMENT (S-effort)

Adopt ONLY OmO's cheap 20% — **the mismatch→remap→self-correct feedback** — and
emit it *only on the already-existing failure path*, reusing our own diff
renderer. This is the "cheap 20% that gets 80%": the model gets the same
"here is what drifted, retarget locally" signal OmO gives, without the read-time
tax.

### E1 — localized stale-region hint on precondition / mtime failure (KEYSTONE)
On `stale_precondition` (index.ts:105-116) and `stale_read`
(editPreCommitDeny :467-475), append a **localized diff snippet** of the region
around the edit target, replacing the bare "re-read the whole file" line:

- Baseline for the diff = the region the model *believed* it was editing. On the
  `stale_precondition`/`stale_read` paths we hold the CURRENT on-disk bytes but
  **not** the model's read-time snapshot (`ReadFileState` stores mtime +
  content-*hash* only — `stale-read-guard/state.ts:106-136`, NOT the bytes). So
  E1's usable baseline is the model's own `old_string` (the exact text it expected
  to find) vs the current-disk lines in that neighborhood.
- Locate the neighborhood deterministically: find where `old_string`'s first
  non-blank anchor line last matched (reuse `nearestCandidateHint` locator logic,
  index.ts:149-164), take ±context lines of CURRENT bytes, and render via
  `renderUnified(before=old_string, after=current_region, maxLines, {hunks:true})`
  from `diff-preview.ts:265` — **no new diff engine**.
- Emit `>>>`-style / `@@`-gutter markers (renderUnified already produces
  line-number gutters) so the model sees "your text expected lines A-B; disk now
  has X-Y" and retargets **locally** instead of re-reading the file.

### E2 — enrich the `not_found` hint (already 80% there)
The `not_found` path (buildMismatchResult :61-89) already carries `nearestNote`
(one whitespace-equal line). Upgrade `nearestNote` from a single-line report to
the SAME localized `renderUnified` hunk: `old_string` vs the nearest-matching
region of the file. This is the richest baseline case (we hold `old_string`
verbatim) and the smallest delta — the plumbing (`nearestNote` param) already
exists.

**Read contract UNCHANGED.** No line is annotated at read time; nothing changes
on the success path. The hint is computed lazily, ONLY when an edit has already
failed — a path the model was ALREADY paying a re-read for. Standing token cost =
**0**.

### Non-goals (explicit)
- We do NOT adopt `autocorrect-replacement-lines.ts` (newline re-wrapping) — our
  `eol.ts` + fuzzy ladder already normalize EOL/whitespace; separate slice if ever.
- We do NOT persist read-time content bytes to enable a *full* file remap table
  on the precondition path. That would add a per-read memory cost (store the
  snapshot) — the same "standing cost" trap we rejected. E1's `old_string`-anchored
  neighborhood diff is the zero-standing-cost version. (If the A/B shows the
  precondition path specifically needs a richer baseline, revisit as a scoped
  follow-up with its own measurement.)

---

## Gating (measure-first — NO leak-fix exception)

- **Flag: default-OFF.** New knob (e.g. `QUANTA_EDIT_REMAP_HINT`), default OFF,
  byte-identical failure output when unset. NOTE the *shape* differs from the
  stale-read guard's DEFAULT-ON strict kill-switch: this is a **quality lever**,
  not a safety control, so it is opt-IN and default-OFF (do not copy
  `gateDisabledStrict`; use the plain opt-in gate vocabulary).
- **A/B metric — the model must earn this.** Measure on a SWE/edit-heavy slice:
  1. **edit-success-rate** (fraction of edits that land within N retries),
  2. **re-read count** after a failed edit (should DROP — the whole point),
  3. **tokens-per-successful-edit** (localized hint should be net-negative vs a
     full re-read; if the hint costs MORE than the re-read it replaced, kill it).
- **Kill criterion.** Flat or negative on all three ⇒ delete the slice (per
  no-heuristics / measure-first: n=1 does not ship a loop change).
- **Paired control.** default-OFF path stays byte-identical; hellgate pins the OFF
  output verbatim (the three existing failure strings above) and pins the ON path
  with a red-on-injection test (remove the hint ⇒ test red).

---

## Effort / risk

- **Effort: S.** Reuses `renderUnified`/`diffLines` (diff-preview.ts) + the
  existing `nearestNote` param + the two existing failure-result builders. No new
  engine, no read-contract change, no schema change. Estimated blast radius: the
  two failure-result sites in `edit/index.ts` + a small locator/render helper +
  the flag.
- **Risks:**
  - *Baseline mismatch* — the `old_string`-anchored neighborhood can mis-locate if
    the edit target moved far; the render must **fail-open to today's byte-identical
    message** when no confident anchor is found (never emit a misleading diff). Same
    conservative posture as `nearestCandidateHint` (returns `null` → no note).
  - *Token regression* — a large hunk could cost more than the re-read it replaces;
    cap via `renderUnified`'s `maxLines` and let the A/B's tokens-per-edit metric be
    the hard gate.
  - *Cross-surface drift* — the hint text is a model-facing contract; pin it in the
    edit hellgate so CLI/web/bench all render the identical failure string.

---

## Score (scoped remap-only slice)

**78/100** vs **63/100** for the full always-on hashline scheme.

Rationale: the full scheme's 63 was dragged down by the per-read token tax for a
safety gain we already own (3-layer stale defense, 현황). The scoped slice strips
that tax entirely — **zero standing cost**, read contract unchanged — while
keeping OmO's genuinely valuable part (the mismatch→remap→self-correct feedback
loop). It reuses our own `diff-preview` renderer and the existing `nearestNote`
seam (no duplicate impl). It loses points only for: (a) still requiring a
measured A/B before it ships (unproven efficacy, correctly gated), and (b) the
precondition-path baseline being `old_string`-anchored rather than a true
read-time snapshot (a deliberate zero-standing-cost trade, not free lunch).
