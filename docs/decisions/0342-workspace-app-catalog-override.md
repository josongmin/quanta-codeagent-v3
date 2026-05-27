# ADR-0342 — Per-workspace `.quanta/apps.json` app-catalog override

- Status: Accepted (slice extension landed, default-OFF; composition
  wire-up deferred to the caller — composition root sets
  `cfg.appCatalog = await createWorkspaceAppCatalog(cfg.cwd, fs)` when
  it wants per-workspace customization).
- Date: 2026-05-27
- Related: ADR-0336 (app catalog closed-port surface — this ADR
  extends its slice). ADR-0339 (plugin-declared skill set extension —
  this ADR's precedence policy is the OPPOSITE direction and the
  contrast is justified below).

## Context

ADR-0336 ships `src/agent/app-catalog/` with a hard-coded
`DEFAULT_APP_CATALOG` (3 entries: `cli` → `cli`, `browser` →
`cli-browser`, `desktop` → `web-tauri`) and a closed `AppCatalogPort`.
The default 3-entry list intentionally enumerates the three quanta
surfaces but cannot accommodate a workspace that wants to expose a
project-specific app (e.g. `@@figma` pointing at the embedded browser
on a design-tools repo) — the catalog is frozen at composition time.

Two ways to extend the catalog were considered:

1. **Plugin-declared apps** — add `apps?: AppDescriptor[]` to
   `PluginManifest` and let plugins ship extension entries. Symmetric
   with ADR-0339's `unionActiveSkills`. Out of scope here: requires a
   new closed-enum field on `PluginManifest` which is a separate ADR.
2. **Per-workspace file** — let a workspace declare its own apps via
   a `.quanta/apps.json` file. Smaller surface, no schema change to
   the plugin manifest, ROI proven by Cursor / Codex `.cursorrules` /
   `~/.codex` precedent.

This ADR picks (2). (1) remains open as a future sibling ADR.

## Decision

Extend the `src/agent/app-catalog/` slice with three new modules + a
re-exporting barrel update. **Default-OFF**: no production path
imports the new factory; callers opt in by replacing
`defaultAppCatalog` with `createWorkspaceAppCatalog(cwd, fs)` at
composition.

### `loader.ts` — `loadWorkspaceAppCatalog`

```ts
loadWorkspaceAppCatalog(
  workspaceRoot: string,
  fs: FilesystemPort,
): Promise<readonly AppDescriptor[]>
```

Reads `<workspaceRoot>/.quanta/apps.json` and returns the subset of
validated entries. NO-THROW end-to-end:

| Failure mode                                  | Result          |
| --------------------------------------------- | --------------- |
| Empty / missing `workspaceRoot`               | `[]`            |
| `fs.readFile` returns `null` (file absent)    | `[]`            |
| `fs.readFile` throws (ENOENT, perms, …)       | `[]`            |
| `JSON.parse` throws (malformed JSON)          | `[]`            |
| Top-level JSON is not an object               | `[]`            |
| `apps` field absent / not an array            | `[]`            |
| One entry has missing / non-string id         | entry skipped   |
| One entry has unknown `surface` value         | entry skipped   |
| One entry has non-string `description`        | entry skipped   |
| Valid sibling next to an invalid entry        | sibling preserved |

The closed `surface` enum is mirrored verbatim from `AppSurface`
(`cli` | `web-tauri` | `cli-browser`). Adding a new surface requires
updating both the type and the runtime `VALID_SURFACES` set — by
design, since adding a surface is an ADR-0336 §Frozen-level change.

### `merge.ts` — `mergeAppCatalogs`

```ts
mergeAppCatalogs(
  base:      readonly AppDescriptor[],
  overrides: readonly AppDescriptor[],
): readonly AppDescriptor[]
```

Pure. Composes two catalogs under **workspace-wins precedence** on
`id` collision; new ids in `overrides` are appended after the base
entries (preserving base order, then override-submission order).
NO-THROW: non-array inputs treated as empty; malformed entries
skipped.

### `workspace-catalog.ts` — `createWorkspaceAppCatalog`

```ts
createWorkspaceAppCatalog(
  workspaceRoot: string,
  fs: FilesystemPort,
): Promise<AppCatalogPort>
```

One-liner composition of the loader + merge over
`DEFAULT_APP_CATALOG` + `createInMemoryAppCatalog`. Missing /
malformed workspace file ⇒ returns a port over
`DEFAULT_APP_CATALOG` verbatim.

### Local `FilesystemPort`

```ts
interface FilesystemPort {
  readFile(path: string): Promise<string | null>
}
```

Sibling to the plugin-discovery `FilesystemPort` but **async** (the
plugin-discovery port is sync). Kept local because:

- Catalog load happens once at composition root; matching the
  caller's `Promise<AppCatalogPort>` factory shape avoids forcing
  callers to `sync`-bridge.
- Sync vs. async is a contract difference, not implementation detail;
  splitting the ports lets each slice evolve its I/O model
  independently.
- Single method (`readFile` only) — smaller surface than the
  discovery port's `readDir + readFile`.

The slice ships no default Node adapter — callers wire one
explicitly (`async readFile(p) { try { return await fs.readFile(p, "utf8") } catch { return null } }`).

## Workspace-wins precedence — justification

`unionActiveSkills` in ADR-0339 uses CALLER-wins precedence: a plugin
that re-declares a skill the caller already has must defer to the
caller's entry. This ADR uses the OPPOSITE direction — workspace
overrides REPLACE default catalog entries on collision.

The directions are not contradictory; they are symmetric **from the
user's perspective**:

| ADR     | Base (what gets replaced)  | Override (who wins)        |
| ------- | -------------------------- | -------------------------- |
| 0339    | Plugin's declared skills   | Caller (user-pinned host)  |
| **0342** | `DEFAULT_APP_CATALOG`     | Workspace `.quanta/apps.json` |

In both ADRs, **the more user-specific source wins**:

- ADR-0339: the caller (host config / user-pinned skill / mention
  injection) is closer to user intent than a third-party plugin's
  declared list.
- ADR-0342: the workspace `.quanta/apps.json` *is* the user-specific
  source; the global default 3-entry list is the impersonal fallback.

The terminology flip ("override" wins in 0342, "caller" wins in 0339)
masks this consistency. Callers wiring both must understand: workspace
file > default, but caller-pinned > plugin-supplied. ADR-0339
documents itself as "plugin extension is a **supplement**, not an
override" — by the same logic, `.quanta/apps.json` is an
**override**, not a supplement, because it is the same kind of
user-specific source as ADR-0339's "caller."

## Non-goals (negative invariants)

- **No environment-variable override.** Replacing the catalog via
  `$QUANTA_APP_CATALOG=path/to/file` is not supported — only the
  fixed `<workspaceRoot>/.quanta/apps.json` location is read. A
  future ADR may add env-var precedence if a use case emerges.
- **No runtime catalog mutation.** The port returned by
  `createWorkspaceAppCatalog` is constructed once and snapshot-frozen
  (per `createInMemoryAppCatalog`). Editing `.quanta/apps.json` mid-
  session has no effect until the next composition (i.e. next CLI
  session). Hot-reload is a future ADR.
- **No remote / network-loaded catalog.** Filesystem-only. The
  `FilesystemPort` shape would technically accept an HTTPS-backed
  implementation, but the ADR intentionally does not endorse it; the
  port docs say "filesystem" so callers do not silently mix transports.
- **No JSON-schema validator dependency.** Runtime validation is
  hand-rolled (~12 lines per entry). The slice ships zero new deps.
- **No `apps.yaml` / `apps.toml` parity.** The file MUST be JSON. A
  YAML / TOML loader is a separate ADR.

## Wire-up

The composition root opts in via:

```ts
import { createWorkspaceAppCatalog } from "@/agent/app-catalog"

cfg.appCatalog = await createWorkspaceAppCatalog(cfg.cwd, {
  async readFile(path) {
    try { return await readFile(path, "utf8") } catch { return null }
  },
})
```

No production path imports the new factory by default — this ADR is
slice-only. Wire-up belongs to a follow-up ADR or a downstream caller
that owns its workspace concept.

## Tests

Three hellgate files:

- `__tests__/loader.hellgate.test.ts` — 17 cases (file-absent,
  JSON.parse failure, shape failure, valid entries, per-entry
  validation, workspace root edge cases).
- `__tests__/merge.hellgate.test.ts` — 10 cases (empty edges,
  precedence on collision, new-id append, defensive input shape).
- `__tests__/workspace-catalog.hellgate.test.ts` — 4 cases (missing
  file ⇒ default, override appends, override wins, malformed ⇒
  default).

Total = 31 hellgate cases; the ADR's stated minimum is 16.

## Slice fence

- New files: `src/agent/app-catalog/{loader,merge,workspace-catalog}.ts`
  + barrel update.
- No mutation outside `src/agent/app-catalog/`.
- No `node:fs`, `node:path`, `path.join` imports — POSIX-style join
  inlined so the loader runs in any JS host that provides a
  {@link FilesystemPort}.
- No new external dependency.
