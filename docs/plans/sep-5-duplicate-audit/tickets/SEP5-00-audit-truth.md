# SEP5-00 — correct the duplicate-development audit truth

**Priority:** P0 documentation gate
**Status:** LANDED (2026-09-06 closeout; index matches live code)
**Depends on:** none
**Finding coverage:** D0, D9, D12, D14, D18, D20, D24, D28, D29, D30 and global rules

## Goal

Prevent workers from implementing proposals already disproved by the live code.
This ticket changes audit truth only; it must not change runtime behavior.

## Current facts to record

- `src/` has 50 top-level directories: 49 registered library slices plus the
  `apps` composition root.
- The machine owner is `tests/unit/_arch/slice-boundary-configs.ts`, an
  open-by-default denylist. `@/agent` is not the only cross-slice-capable module;
  `host`, `sdk`, and `kernel` are surface-isolation-only and `runner`/`ipc` have
  custom deny rules.
- App fences are surface-specific. `terminal -> headless` is forbidden, while
  CLI currently imports `@/apps/headless` in `serve-stdio-cmd.ts`.
- `KNOB_INVENTORY.length === 353`, `RUNTIME_CONFIG_KNOBS.length === 192`, their
  env-key intersection is zero, and inventory entries with
  `home:"runtime-config"` are 228, not 227.
- The raw `process.env.QUANTA_*` ratchet ceiling is 43; current measured usage is
  43.
- `SessionVerbSurface<R>` plus source-level positive/negative type pins already
  enforce the D9 key/result-grade shape.
- MCP OAuth's outer `inFlightToken` covers fresh interactive authorization, while
  `createTokenRotator` covers refresh persistence. They are different scopes.

## Write set

| File | Change |
|---|---|
| `docs/bugbash/sep-05-duplicate-development.md` | Correct snapshot, rules, counts, classification, and execution order |
| `docs/plans/sep-5-duplicate-development/tickets/README.md` | Keep links/status synchronized if ticket IDs change |

Do not touch the existing dirty `docs/bugbash/aug-25-wave1.md`.

## Required edits

1. Change “50 slices” to “49 library slices + apps composition root.”
2. Replace the global app-import statement with links to the actual Biome
   surface rules.
3. Mark D9/D12/D14/D18/D20/D24/D30 closed as duplicate-removal proposals.
4. Move D29 to intentional separation.
5. Change D28's count to 228 and explain that `home` is a target typed owner,
   not proof that a typed field currently exists.
6. Report raw-env actual and ceiling separately: `43 / ceiling 43`.
7. Replace the old PR list with SEP5-01 through SEP5-10.
8. Preserve unresolved scope: HTTPS secret egress remains opaque without MITM;
   focused green tests are not full-CI closure.

## Derivation commands

```sh
find src -mindepth 1 -maxdepth 1 -type d | wc -l
find src -mindepth 1 -maxdepth 1 -type d -not -name apps | wc -l
bun test tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts
bun -e '/* import both knob arrays and print lengths/intersection/home count */'
```

The final implementation should place the knob-count derivation in a checked
test/helper rather than relying on a prose-only `bun -e` snippet.

## Verification and drift control

- This documentation-only ticket does not add a product behavioral test. Its
  numeric claims are regenerated from runtime arrays or existing architecture
  tests at the exact HEAD; prose constants are never the authority.
- Record command, stdout, exit code, HEAD, and dirty paths together. A count
  copied from the source audit without rerunning the derivation is stale.
- The knob population/ownership assertions become executable under SEP5-10's
  `tests/unit/knob-read-authority-parity.test.ts`; the 49-slice config/entrypoint
  equality remains owned by
  `tests/unit/slice-boundary-config-parity.test.ts`.
- Negative control for each count helper: feed a cloned array with one duplicate,
  one missing entry, and one mismatched owner; require the helper to name the
  injected item. Do not add a source regex that only counts identifiers.
- Before marking this ticket done, verify every ticket link resolves and rerun
  `git diff --check`. A broken plan link or changed pre-existing dirty path is a
  documentation failure.

## Acceptance criteria

- Every index row is `execute`, `conditional`, `intentional`, or `closed`.
- No closed item remains under “still live.”
- Every numeric claim has a reproducible command or test.
- No code file or generated feature catalog is modified.

## Stop conditions

- The source audit file is concurrently owned or changed after the snapshot.
- Correcting a claim would require guessing a product decision rather than
  describing current behavior.
