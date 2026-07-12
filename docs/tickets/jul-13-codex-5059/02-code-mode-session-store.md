# C5059-02 — Bounded code-mode session store

- **Priority:** P1
- **Class:** TRUE-GAP
- **Effort:** S/M
- **Status:** BLOCKED
- **Dependencies:** C5059-01 continue verdict

## Goal

Expose `store(key, value)` and `load(key)` to successive `code_cell` calls in one agent session without creating cross-session memory, an unbounded heap, or a second host-capability path.

## Owner surfaces

- `src/codemode/types.ts`: closed injected store port and limits.
- `src/codemode/runtime.ts`: QuickJS helper bindings only.
- `src/tool/codemode-tool.ts` / agent composition root: one session-owned store instance.
- `src/security`: existing redaction chokepoint; do not duplicate secret matching.

## Contract

- Session namespace is mandatory; no global or cross-session lookup.
- Keys are bounded strings and cannot use reserved/prototype names.
- Values are a closed JSON-serializable shape; functions, handles, cycles, `undefined`, and host objects are rejected.
- Enforce injected limits for key count, key bytes, per-value bytes, and total bytes.
- Redact on write and again on read. Store contents never enter telemetry.
- Session close clears the store deterministically.
- Helpers are session-local data operations. They cannot call tools, filesystem, network, process APIs, or permission APIs.
- A failed write is typed and leaves prior state unchanged.

## Non-goals

- Cross-session/user memory.
- Filesystem persistence.
- `image()`, `generatedImage()`, cell-actor resume, or a new IPC host.
- Replacing the existing return-value output contract.

## Acceptance

- Cell A stores a nested JSON value; Cell B in the same session loads the same value.
- A different session cannot observe it.
- Quota overflow, cyclic input, forbidden keys, and unsupported values fail closed with no partial mutation.
- Secret-shaped values are not returned verbatim and are absent from logs/events.
- Session teardown reports zero retained entries.
- Existing surface-escape tests remain green; `store/load` cannot reach `CodeCellDispatchPort` except through an explicit `tools.*` call authored separately by the cell.

## Proof rail

- New unit rail for serialization, quotas, key isolation, clear, and redaction.
- New two-cell integration rail using the real QuickJS runtime and one shared session store.
- Extend `code-mode-surface-escape-hellgate.test.ts` with helper-host-reach mutations.

