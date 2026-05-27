/**
 * ADR-0336 — Default app catalog.
 *
 * Static 3-entry list — one per quanta surface — used by the
 * composition root when no plugin-declared overrides are present.
 *
 * Justification for the 3 entries (per memory `surface-model.md`):
 *
 *   - `cli`     — the canonical terminal surface. The default
 *                 mention target for `@@cli` is the surface itself
 *                 (the host process), distinct from `@@browser` (a
 *                 sub-surface owned by the CLI).
 *   - `browser` — the CLI-embedded browser surface. Distinct from
 *                 `desktop` — the CLI owns the browser lifecycle
 *                 (headless / DevTools-attached); the Tauri shell
 *                 hosts a full web UI separately.
 *   - `desktop` — the Web-Tauri desktop surface. Owns its own
 *                 lifecycle; the CLI does not embed it.
 *
 * Each descriptor's `description` is a one-line tagline — the
 * resolver projects this verbatim into the mention body so the
 * model gets a concrete reference to what the user activated.
 */

import type { AppDescriptor } from "./types"

/** The default 3-app catalog. Order: `cli` → `browser` → `desktop`. */
export const DEFAULT_APP_CATALOG: readonly AppDescriptor[] = [
  {
    id: "cli",
    surface: "cli",
    description: "the CLI surface",
  },
  {
    id: "browser",
    surface: "cli-browser",
    description: "the CLI-embedded browser surface",
  },
  {
    id: "desktop",
    surface: "web-tauri",
    description: "the Web-Tauri desktop surface",
  },
]
