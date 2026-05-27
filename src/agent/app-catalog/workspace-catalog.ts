/**
 * ADR-0342 — Convenience factory: workspace overrides + default merge
 * + port wrap.
 *
 * One-liner the composition root calls to upgrade
 * {@link defaultAppCatalog} to a workspace-aware catalog:
 *
 *   cfg.appCatalog = await createWorkspaceAppCatalog(cfg.cwd, fs)
 *
 * Pure composition over {@link loadWorkspaceAppCatalog},
 * {@link mergeAppCatalogs}, and {@link createInMemoryAppCatalog}.
 * NO-THROW end-to-end — any loader / parser failure degrades to the
 * default catalog verbatim.
 *
 * Slice fence: this module re-uses only `./{loader,merge,
 * in-memory-catalog,default-catalog}` siblings.
 */

import { DEFAULT_APP_CATALOG } from "./default-catalog"
import { createInMemoryAppCatalog } from "./in-memory-catalog"
import type { FilesystemPort } from "./loader"
import { loadWorkspaceAppCatalog } from "./loader"
import { mergeAppCatalogs } from "./merge"
import type { AppCatalogPort } from "./types"

/**
 * Load `<workspaceRoot>/.quanta/apps.json`, merge with
 * {@link DEFAULT_APP_CATALOG} under workspace-wins precedence, and
 * wrap the result as an {@link AppCatalogPort}.
 *
 * @param workspaceRoot absolute workspace root directory.
 * @param fs            injected async {@link FilesystemPort}.
 * @returns             port over the merged descriptor list. Always
 *                      a valid port — missing / malformed workspace
 *                      file ⇒ port over {@link DEFAULT_APP_CATALOG}
 *                      verbatim.
 */
export const createWorkspaceAppCatalog = async (
  workspaceRoot: string,
  fs: FilesystemPort,
): Promise<AppCatalogPort> => {
  const overrides = await loadWorkspaceAppCatalog(workspaceRoot, fs)
  const merged = mergeAppCatalogs(DEFAULT_APP_CATALOG, overrides)
  return createInMemoryAppCatalog(merged)
}
