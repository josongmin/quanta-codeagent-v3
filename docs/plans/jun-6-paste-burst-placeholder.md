# RFC: CLI paste-burst → `[Pasted Content N chars]` placeholder

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADR: 0482 (paste-burst-placeholder).
> ROI: **low-medium** (UX polish for large pastes; not a correctness fix).

---

## 1. 요약 (Summary)

When a user pastes a large block (a log dump, a file, a stack trace) into the CLI input box,
the raw-line reader processes it **per inserted chunk** and **re-renders the whole composer
band on each insert** — every keypress event runs `refreshCandidates()` + `redraw()`
(`src/apps/cli/raw-line-reader.ts:1085,1093`). For a multi-KB paste this is a visible
stutter (N redraws of a growing buffer + slash/`@`-completion churn) and a wall of pasted
text dumped inline in the prompt. The model also receives the full blob verbatim with no
affordance distinguishing "this is pasted content" from "the user typed this."

This RFC designs a **paste-burst detector** that coalesces a large paste into a single
placeholder token — `[Pasted Content N chars]` (Claude-Code / Cursor parity) — rendered in
the input box, while the **real content is stashed** and **re-expanded on submit** so the
model receives the actual bytes, not the placeholder. The detector is grounded in a
**validated terminal signal — bracketed-paste mode** (`ESC[200~` … `ESC[201~`), NOT a magic
timeout: per the codebase's no-arbitrary-heuristics rule, the burst boundary comes from the
terminal's own paste delimiters, which arrive on the SAME `key.sequence` channel the reader
already switches on (e.g. backtab `ESC[Z` at `raw-line-reader.ts:798`). It is **default-OFF**
and **byte-identical** when bracketed paste is unavailable (the placeholder simply never
forms; today's per-char insert path is preserved verbatim).

---

## 2. 경쟁사 레퍼런스 (Competitor reference — verified)

### 2.1 Claude Code / Cursor — `[Pasted text #N +L lines]` placeholder

Both mainstream CLIs collapse a large paste into a bracket token in the composer and keep the
real content out-of-band, expanding it when the message is sent. The exact label format
(`[Pasted Content N chars]` / `[Pasted text #1 +240 lines]`) is the user-facing convention we
mirror. The mechanism both rely on is **bracketed paste mode** (xterm DECSET `?2004`): the
terminal wraps pasted bytes in `ESC[200~` … `ESC[201~` so the application can distinguish a
paste from typed input *deterministically* — there is no timing guess.

### 2.2 The validated signal (xterm spec) — bracketed paste

- `CSI ? 2004 h` enables bracketed paste; `CSI ? 2004 l` disables it.
- A paste then arrives as: `ESC [ 200 ~` <pasted bytes verbatim> `ESC [ 201 ~`.
- This is a **real, standardized terminal protocol** (xterm, iTerm2, Terminal.app,
  VS Code terminal, tmux, kitty all implement it). The start/end markers are the *ground-truth*
  burst boundary — the design hangs entirely on them, satisfying the "base it on a validated
  signal, not a magic timeout" constraint.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 No bracketed-paste handling; paste is detected only by chunk length

- `grep -rn "200~\|201~\|2004\|bracket\|Bracket" src/apps/cli` → **0 hits.** Bracketed paste
  mode is **never enabled** (`CSI ?2004h` is never written) and the markers are **never
  parsed**. The reader's raw-mode setup writes no DECSET: it only does
  `readline.emitKeypressEvents` + `setRawMode(true)` + `resume()`
  (`raw-line-reader.ts:311-316`).
- The ONLY paste signal today is a **length heuristic**: `const isPaste = str.length > 1`
  (`raw-line-reader.ts:1063`), used solely to suppress the `@`-autocomplete dropdown during a
  multi-char insert (`classifyChar({ …, isPaste })`, `:1073`). It does NOT coalesce, stash, or
  render a placeholder — the multi-char `str` is inserted whole into the buffer
  (`state.buf = …slice + str + slice…`, `:1076`) and the band is re-rendered (`:1093`).

### 3.2 The per-keypress insert + full redraw is the cost

- Every printable insert path: classify → mutate `state.buf` → `refreshCandidates()` →
  conditional `@`-dropdown work → `redraw()` (`raw-line-reader.ts:1057-1093`). A paste
  delivered as several keypress events (terminals chunk large pastes) triggers this loop
  repeatedly, each `redraw()` repainting the reserved composer band (`growBandTo` /
  scroll-stability invariant, file header doc).
- `redraw()` is not cheap — it repaints the prompt row, meta row, ghost text, and (when a
  `/`-buffer) the candidate list. Doing it per paste-chunk is the visible stutter.

### 3.3 The reader already switches on `key.sequence` — the hook point exists

- The keypress handler is `onKey(str, key)` (`raw-line-reader.ts:733`); it already inspects
  `k.sequence` for escape sequences (backtab: `k.sequence === ESC + "Z"`, `:798`). So routing
  `k.sequence === ESC + "[200~"` / `"[201~"` is the SAME mechanism, no new plumbing.
- Submit funnels through `settleResolve(state.buf)` (`:517,945`) — the single place the final
  string is produced. Placeholder→content expansion hooks HERE.

### 3.4 Verdict — **NOT superseded.** Honest gap + a heuristic caveat (see §8).

No placeholder coalescing exists; the `isPaste = str.length > 1` flag is dropdown-suppression
only. The bracketed-paste signal is available but unused. **Caveat flagged for the brief:** the
clean design REQUIRES bracketed paste mode. If the host terminal does not support `?2004` (or
Bun's `readline.emitKeypressEvents` does not surface the `200~`/`201~` markers as
`key.sequence` — see §8 risk), then there is NO non-heuristic burst boundary, and per the
no-arbitrary-heuristics rule **we should NOT fall back to a timing/size guess** — we degrade to
today's verbatim insert (default-OFF). This is the honest constraint: the feature is only as
available as the terminal's bracketed-paste support.

---

## 4. 설계 (Design)

### 4.1 Enable bracketed paste, parse the markers (the validated signal)

On reader entry (next to `setRawMode(true)`, `raw-line-reader.ts:315`), when
`stdin.isTTY === true` AND the feature knob is on, write `CSI ?2004h`; on exit (next to the
`setRawMode(wasRaw)` restore, `:493`), write `CSI ?2004l`. This is the ONLY terminal-state
change, fully reverted on every exit path (the reader already has a disciplined
restore-on-settle, `:491-493`).

The `onKey` handler gains a small **paste state machine**, placed ABOVE the printable-insert
block (`:1057`) and below the abort/chord guards:

```
state.pasteActive: boolean          // inside a 200~…201~ bracket
state.pasteBuf: string              // accumulating pasted bytes (bounded, see §4.4)

if (k.sequence === ESC + "[200~") { state.pasteActive = true; state.pasteBuf = ""; return }
if (k.sequence === ESC + "[201~") { commitPaste(); state.pasteActive = false; return }
if (state.pasteActive) { state.pasteBuf += (str ?? ""); return }   // NO redraw per chunk
```

While `pasteActive`, every chunk is appended to `pasteBuf` and the handler **returns without
`refreshCandidates()` / `redraw()`** — collapsing N redraws to ZERO during the paste. The
terminal delivers the bracket as discrete keypress events (start marker, body chunk(s), end
marker); we accumulate silently and render ONCE at `commitPaste`.

### 4.2 Placeholder insert + content stash

`commitPaste()` decides whether to coalesce, using a **validated structural threshold, not a
timing guess**: coalesce when the pasted content is "large" by a *deterministic content
property* — specifically **byte length ≥ a small fixed minimum AND (multi-line OR over a
single-line char budget)**. (This is a content-shape rule on already-delimited paste bytes,
NOT a heuristic for *detecting* a paste — the detection is the bracket markers. A 3-char paste
stays inline; a 2KB / multi-line paste becomes a placeholder. See §8 for why even this
threshold is acceptable: it only chooses *rendering*, never *correctness* — the real bytes are
always preserved.)

```ts
const commitPaste = (): void => {
  const content = state.pasteBuf
  if (!shouldCoalesce(content)) {           // small paste → today's verbatim inline insert
    insertText(content)                      // (reuses the existing :1076 insert + redraw)
    return
  }
  const id = state.pasteStash.size + 1       // monotone per-read id (NOT random)
  state.pasteStash.set(id, content)          // stash the REAL bytes
  const token = `[Pasted Content ${countChars(content)} chars]`
  insertText(token)                          // the placeholder goes in state.buf
  redraw()                                    // ONE redraw for the whole paste
}
```

- The placeholder `[Pasted Content N chars]` is what appears in the composer and what the
  scroll-stable band renders — one short token instead of a wall of text.
- `state.pasteStash: Map<number, string>` holds id→real-content for THIS read. The id is a
  pure counter (no `Math.random` — closed-port discipline).
- Multiple pastes in one read each get their own token + stash entry.

### 4.3 Expansion back to real content on submit

`settleResolve` (`raw-line-reader.ts:517`) is the single submit chokepoint. Before resolving,
expand every placeholder token in `state.buf` back to its stashed content:

```ts
const expandPastes = (buf: string): string =>
  buf.replace(PASTE_TOKEN_RE, (m, idMaybe) => state.pasteStash.get(resolveId(m)) ?? m)
// then: settleResolve(expandPastes(state.buf))  at :812, :931, :945
```

To make expansion robust (the user may edit around the token, or even delete part of it), the
token carries an **invisible stable anchor** rather than relying on parsing `N chars` back to
an id: render `[Pasted Content N chars]` visibly but key the stash by **insertion order +
exact token string match in the buffer**. The cleanest robust form: store the token string
itself as the map key (`Map<string, string>`), so expansion is `buf.replaceAll(tokenStr,
content)` for each stashed token — a deleted/edited token simply does not match and is left
as literal text (graceful: the user sees what they get). The history push
(`:930,944`) stores the **placeholder** form (so `↑` recall shows the compact token), and
expansion happens only on the value handed to `settleResolve` (the model gets real bytes).

> Decision: key the stash by the exact token STRING (`Map<string,string>`), expand via
> `replaceAll` at submit. This avoids embedding parseable ids in user-visible text and
> degrades gracefully if the user edits the token (no crash, no mis-expansion — an
> unrecognized token stays literal).

### 4.4 Bounds / DoS (a paste is attacker-influenced input)

- `pasteBuf` is bounded (e.g. a generous but finite cap, reusing the codebase's input-DoS
  discipline — `write_stdin`'s 64KiB cap is the reference). A paste exceeding the cap is
  truncated with a clear `[Pasted Content N chars (truncated)]` token, never grown unbounded.
- `pasteStash` is bounded per read (the band can hold only so many tokens; a pathological
  thousand-paste read is capped — drop-oldest or refuse with a notice).
- Bracketed paste passes bytes VERBATIM including control chars; the placeholder rendering uses
  the existing `oneLine` / sanitize discipline so a paste containing `ESC[201~`-lookalike text
  cannot break the band (the markers are matched ONLY as standalone `key.sequence` events from
  the terminal, never by scanning body bytes — so a paste *containing* the literal bytes of an
  end marker inside its content cannot prematurely close the bracket; the terminal already
  escaped/handled that per the bracketed-paste spec, which guarantees the body cannot contain
  an unescaped `ESC[201~`).

### 4.5 Closed-port DI / no globals

- No `Date.now` / `Math.random` / `process.env` in the reader changes — the paste id is a
  pure counter, the threshold is a fixed constant, the terminal writes go through the existing
  injected `stdout` (`raw-line-reader.ts:275`, `testIO?.stdout`). The feature knob is read by
  the CLI composition root and passed as a reader option (no env read inside the reader).
- Fully testable over the existing `testIO` fake stdin/stdout
  (`raw-line-reader.ts:268-275`): a test feeds `keypress` events for the `200~` marker, body
  chunks, and the `201~` marker, then asserts the buffer shows the token and `settleResolve`
  receives the expanded content — no real terminal needed.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF, byte-identical)

- A reader option `bracketedPaste?: boolean` on `ReadLineOptions` (default `false`), set by
  the CLI composition root from `QUANTA_BRACKETED_PASTE === "1"` (new env in
  `runtime-config.ts`). When `false` / absent: `?2004h` is never written, the paste state
  machine is inert (no `200~` markers arrive), and the reader is **byte-identical** to today
  (the `isPaste = str.length > 1` dropdown-suppression at `:1063` is untouched).
- Gating on a knob (vs default-ON) is deliberate: bracketed paste subtly changes terminal
  state and a few exotic terminals mishandle the DECSET; default-OFF keeps SWE-bench /
  headless / test surfaces unchanged. Opt-in for interactive users who want the polish.

### 5.2 No new tool / no manifest / no AgentEvent

Pure CLI input-layer change. No `BASE_TOOL_NAMES` / `GATED_TOOLS`, no stream event, no
dispatch change. The model is unaffected (it receives the same expanded string it would have
received from a verbatim paste). Zero drift-guard impact.

### 5.3 fc

Add a small fc node under the CLI/input section: `paste-burst-placeholder`, `labels:
["surface:cli", "absorbed:claude-code"]`, evidence citing the reader changes + the hellgate;
`knobs: [QUANTA_BRACKETED_PASTE]`; `maturity: experimental` (ROI low-medium).

### 5.4 Slice / fence

- Touch `src/apps/cli/raw-line-reader.ts` only (the reader): the `?2004h/l` writes, the paste
  state machine in `onKey`, `commitPaste` / `shouldCoalesce` / `expandPastes`, the
  `pasteActive` / `pasteBuf` / `pasteStash` fields on `State`, and the `expandPastes` call at
  the three `settleResolve(state.buf)` sites (`:812,931,945`).
- `ReadLineOptions` gains `bracketedPaste?`. The CLI composition root passes it.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (`tests/.../raw-line-reader-paste.hellgate.test.ts`, over `testIO`)

- **coalesce:** feed `200~` + a 2KB multi-line body (as one or several chunks) + `201~`;
  assert `state.buf` holds `[Pasted Content 2048 chars]` (ONE token), and exactly ONE `redraw`
  fired during the paste (not N) — the stutter-elimination invariant.
- **expansion on submit:** then feed `return`; assert `settleResolve` received the REAL 2KB
  bytes (not the token), and `history.push` got the PLACEHOLDER form.
- **small paste stays inline:** `200~` + `"hi"` + `201~` → buffer is `hi` (no token), today's
  verbatim path; `shouldCoalesce("hi") === false`.
- **multiple pastes:** two bracketed pastes → two distinct tokens, two stash entries; submit
  expands BOTH to their respective content in order.
- **edited token degrades gracefully:** user backspaces into a token (now non-matching) →
  expansion leaves the partial token literal (no crash, no wrong-content expansion).
- **embedded-marker safety:** a paste whose BODY contains the literal text `ESC[201~` (fed as
  body chunks, NOT as a standalone `key.sequence`) does NOT prematurely close the bracket — the
  whole body coalesces (markers matched only as terminal-delivered `key.sequence` events, §4.4).
- **DoS cap:** a paste over the byte cap → `[Pasted Content N chars (truncated)]`, `pasteBuf`
  bounded; the stash never grows unbounded.
- **default-OFF byte-identity:** with `bracketedPaste:false`, `?2004h` is never written, no
  paste state machine engages, and a multi-char `str` insert is byte-identical to today
  (`isPaste` dropdown-suppression unchanged).
- **restore on every exit:** ctrl-c / settle / external-editor swap all write `?2004l`
  (terminal state never leaks the DECSET past a read).

### 6.2 No live e2e required

The `testIO` fake fully covers the protocol (the markers are deterministic
`key.sequence` strings). An optional manual smoke against a real terminal confirms the
DECSET round-trip, but CI runs entirely on the fake.

---

## 7. 단계 (Phasing)

- **P0 — bracketed-paste capture + placeholder + expansion.** The `?2004h/l` writes, the
  `onKey` state machine, `commitPaste`/`shouldCoalesce`/`expandPastes`, the three submit-site
  expansions, the knob. Hellgate (§6.1). Default-OFF.
- **P1 — UX refinement.** Token line-count in the label (`[Pasted Content N chars +L lines]`,
  Cursor parity); a `/paste` inspector to view a stashed blob before sending.
- **P2 (out of scope) — image paste.** Bracketed paste delivers text; image paste is a
  separate terminal protocol (already partly handled by the image-queue path,
  `src/apps/cli/image-queue.ts`) — not this RFC.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **⚠️ The heuristic caveat (flagged for the brief).** The *detection* boundary is the
  bracketed-paste markers — a fully validated terminal signal, NO timing guess. The ONLY
  judgement call is `shouldCoalesce` (when to render a placeholder vs inline), which is a
  fixed content-shape threshold (byte length + multi-line). This is acceptable under the
  no-arbitrary-heuristics rule because it gates **rendering only** — the real bytes are ALWAYS
  preserved and expanded on submit, so a "wrong" threshold never changes what the model
  receives, only whether the user sees a token or inline text. If even this is too much, the
  threshold can be a user knob (`QUANTA_PASTE_MIN_CHARS`) rather than a baked constant.
- **Does Bun's `readline.emitKeypressEvents` surface `200~`/`201~` as `key.sequence`?**
  (Primary technical risk.) The reader relies on the node-compat keypress decoder
  (`raw-line-reader.ts:312`). Node's readline passes unrecognized escape sequences through as
  `key.sequence`; Bun's polyfill is probe-verified to differ in places (file header doc:
  "Bun's `node:readline` polyfill does NOT invoke the `completer`"). **Mitigation / required
  validation step before P0:** a one-line probe — enable `?2004h`, paste, log every
  `(str, key)` — to confirm the markers arrive as `key.sequence` (and whether the body comes as
  `str` chunks). If Bun instead delivers the WHOLE paste (markers + body) as a single `str`
  with no marker split, the design adapts trivially: parse `str` for the `200~…201~` envelope
  in one shot (still the validated signal, just a different delivery shape). If Bun strips the
  markers entirely (worst case), there is NO validated boundary → we DO NOT ship a timing
  fallback; the feature stays unavailable on that runtime (default-OFF), per the rule.
- **Terminal compatibility.** A few terminals mishandle `?2004`. Default-OFF + the
  always-paired `?2004l` restore keep the blast radius to opt-in users; a misbehaving terminal
  shows literal `200~` text at worst (visible, not corrupting).
- **Token collision.** A user could TYPE `[Pasted Content 5 chars]` by hand. Mitigation: keying
  the stash by exact token string + only expanding tokens we MINTED this read (the stash map
  membership IS the guard) — a hand-typed lookalike is not in the stash, so it stays literal.
- **Alternative — pure timing-based burst detection (no bracketed paste).** REJECTED outright:
  a "if ≥N chars arrive within T ms it's a paste" rule is exactly the arbitrary heuristic the
  codebase forbids (no validated signal, flaky across SSH latency / slow terminals). The whole
  premise of this RFC is to AVOID that by using the terminal's own delimiters.
- **Alternative — leave paste verbatim (do nothing).** Valid (ROI is low-medium); the cost is
  the redraw stutter + the inline wall of text. This RFC is opt-in polish, not a fix.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented) — reader-local**
- `src/apps/cli/raw-line-reader.ts` — `?2004h/l` writes (next to `:315` / `:493`); paste state
  machine in `onKey` (above the printable-insert block at `:1057`); `commitPaste` /
  `shouldCoalesce` / `expandPastes` helpers; `pasteActive` / `pasteBuf` / `pasteStash` on
  `State`; `expandPastes(state.buf)` at the three `settleResolve` sites (`:812,931,945`);
  `bracketedPaste?` on `ReadLineOptions`.
- `src/shared/runtime-config.ts` — `QUANTA_BRACKETED_PASTE` knob (default false).
- CLI composition root — pass `bracketedPaste` into the reader options.
- `tests/.../raw-line-reader-paste.hellgate.test.ts`.
- fc `paste-burst-placeholder` node + `docs/decisions/0482-paste-burst-placeholder.md`.

**Audited ground truth (cited, NOT modified)**
- `src/apps/cli/raw-line-reader.ts:311-316` — raw-mode setup (NO `?2004h` today).
- `:733,798` — `onKey(str, key)` + the existing `k.sequence === ESC+"Z"` switch (the hook precedent).
- `:1057-1093` — the per-keypress printable insert + `refreshCandidates`/`redraw` (the cost).
- `:1063,1073` — `isPaste = str.length > 1` (dropdown-suppression only, NOT coalescing).
- `:517,812,931,945` — `settleResolve` submit chokepoints (where expansion hooks).
- `:491-493` — the disciplined raw-mode restore (where `?2004l` pairs).
- `:268-275` — the `testIO` fake stdin/stdout (full test coverage without a real terminal).
