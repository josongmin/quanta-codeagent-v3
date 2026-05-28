# ADR-0414 — `@file` mention kind (sync, additive extension of frozen ADR-0325)

> Renumbered from a drafted 0413 under the user-deference ADR-collision
> policy: a parallel track landed `0413-memory-learning-default-on-via-session-factory.md`
> (plus an "ADR-0413 Part 1" runLedger/approvalStateMachine commit). The user
> keeps 0413; this slice moved to the next free number, 0414.

**Status:** Accepted (2026-05-28)
**Slice:**
- `src/agent/mention-injection/types.ts` — additive `"file"` member on the
  `MentionKind` enum (no existing member changed).
- `src/agent/mention-injection/parser.ts` — additive `file` regex
  alternatives (`@file:<path>` + bare `@<path>` containing `/` or `.`).
- `src/agent/mention-injection/resolver.ts` — additive `resolveFile(target)`
  method on `MentionResolverPort` + dispatch wiring. Stays **sync**.
- `src/agent/plugin-app-resolver/file-resolver.ts` — new sync `createFileResolver(opts)`
  adapter (`fs.readFileSync` + sync fs-jail + size/binary guards).
- `src/agent/plugin-app-resolver/composite-resolver.ts` — additive `files` dep
  + `resolveFile` wiring (omit ⇒ every file mention → `null`, byte-identical).
- New hellgate batteries under
  `src/agent/mention-injection/__tests__/` and
  `src/agent/plugin-app-resolver/__tests__/`.

**Default-OFF / byte-identical:** an input with **no** `@file` mention is parsed,
resolved, injected and emitted byte-identically to the pre-ADR pipeline. The
composite resolver's `files` dep is optional; omitting it ⇒ every file mention
resolves to `null` (skipped), so the only behavioural delta is opt-in.

## Context

ADR-0325 froze `MentionKind` as a closed 3-kind enum (`skill` / `plugin` / `app`)
mirroring Codex `build_skills_and_plugins`. The freeze note is explicit:
"extending the kind set requires a new ADR." This is that ADR.

The user-facing ask (TKT-004) is a Cursor-style `@file` mention: instead of typing
a path into a tool argument, the user mentions a file inline in the prompt and the
file body is spliced into the per-turn context as a `<mention>` envelope.

### Why `@file` is safe to add here but `@symbol` is NOT (deliberate_hold)

The single most important design constraint is that the **entire mention pipeline
is synchronous**:

- `MentionResolverPort.resolve{Skill,Plugin,App}` are sync
  (`=> MentionResolverResult | null`, frozen by ADR-0330).
- `loop.ts:929-941` (`resolveMentionInjectionMessages`) calls
  `config.mentionInjector(userText)` synchronously.
- `buildInjectionFragments(...)` is sync and pure-ish.

`@file` resolution is `fs.readFileSync` — it fits the existing sync contract with
**zero signature changes**. `resolveFile` is purely additive: a new closed-port
method, a new enum member, new regex alternatives. No existing sync method or
caller is mutated.

`@symbol` (jump-to-definition style) would require a symbol index, which is async
IO (LSP / ctags / embedding lookup). Wiring it would force
`resolveSkill/resolvePlugin/resolveApp/resolveFile → Promise`, which cascades to
`mentionInjector → Promise` and `loop.ts`'s sync call site → `await`. That is the
maximum blast-radius change in the slice. **`@symbol` is therefore a
deliberate_hold** and is reserved for a separate ADR that owns the sync→async
cascade as its explicit subject. This ADR does NOT touch async.

## Decision

### 1. Enum extension (`"file"`)

`MentionKind = "skill" | "plugin" | "app" | "file"`. The existing three members
keep their exact ordering and semantics; `"file"` is appended. The ADR-0325 freeze
is honoured by *this* successor ADR — the enum is re-frozen at 4 kinds and a 5th
again requires a new ADR.

### 2. Parser syntax — how `@file` is disambiguated from `@skill`

`@skill` is `@[a-z][a-z0-9-]*` — a kebab identifier with NO `/`, `.`, or `_`.
A file path always contains at least one path/extension separator. Two file forms,
tried BEFORE the `@skill` alternative so a path is never mis-read as a skill:

1. **Explicit prefix** `@file:<path>` — unambiguous. `<path>` is a run of
   "safe path" chars `[A-Za-z0-9._/\-]` (no whitespace, no `..` segment guard is
   left to the resolver / fs-jail, not the lexer). Always wins over `@skill`.
2. **Bare path** `@<path>` where `<path>` starts with `[A-Za-z0-9._]`, contains at
   least one `/` or `.`, and is a run of safe-path chars. The "at least one `/` or
   `.`" requirement is the disambiguator: `@code-review` (no `/`, no `.`) stays a
   `skill`; `@src/x.ts` or `@README.md` becomes a `file`.

Left-boundary rule (rule 3 of ADR-0325) is reused verbatim: `foo@bar.com` after a
word char is still NOT a mention (email false-positive guard preserved). The
`target` for a file mention is the raw path string (sigil/prefix stripped); it is
NOT constrained to kebab-case (file paths legitimately contain `/`, `.`, mixed
case).

### 3. Resolver — sync `resolveFile`

`MentionResolverPort.resolveFile(target): MentionResolverResult | null`. The
production adapter `createFileResolver(opts)` captures a workspace root and:

- Resolves `target` relative to the root, canonicalises, and rejects (returns
  `null`) anything outside the fs-jail (sync `is-path-inside` containment, same
  library the async `fsJailLib` uses — but called synchronously).
- `fs.readFileSync` the file. Missing / dir / unreadable ⇒ `null` (graceful).
- Size cap (default 256 KiB, matching the read-tool ergonomic) ⇒ over-cap files
  are truncated with a trailing notice, never `null` (the user explicitly asked
  for the file).
- Binary guard: a NUL byte in the first 8 KiB ⇒ `null` (don't splice binary).

NO-THROW: every branch degrades to `null`; the ADR-0325 `safeCall` wrapper is the
belt-and-suspenders second line.

### 4. Inject + emit

`inject-messages.ts` is already kind-agnostic — it reads `fragment.kind` directly,
so a `file` fragment renders `<mention kind="file" target="...">…</mention>`
with the body defanged by `embedUntrusted`. No change needed.

`event-emitter.ts` only emits `skill_activation` for `skill` kind; `file` (like
`plugin` / `app`) is silently skipped at the typed-history side-channel. A
`file_reference` typed variant is a possible follow-up but is out of scope.

## Consequences

- Pure-additive: 37 existing mention-injection tests + the plugin-app-resolver
  composite tests stay green with no edits.
- `@symbol` remains a clean future ADR with the async cascade as its subject.
- Wire-up into the composition root (passing a real `files` dep) is a follow-up;
  this slice ships the port + adapter + parser additively and stays default-OFF.
