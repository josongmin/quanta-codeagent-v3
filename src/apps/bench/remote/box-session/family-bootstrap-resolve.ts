/**
 * LEAF — resolve a family's DECLARED remote bootstrap onto a box config.
 *
 * Composition roots (`full-remote`, `pool`, `box up`) own the typed
 * {@link BenchRunConfig}. They call this BEFORE provision/attach so
 * `ec2-lifecycle.ts` never names a family. `undefined` for every family
 * without a bootstrap ⇒ the returned config is byte-identical to the input
 * aside from the shallow copy.
 *
 * The defect this repairs was positional: full-remote resolved at the launch
 * root, but `pool` / `box up` built a provision config with family token only.
 * ProMax then ran `setupBoxForFamily` with `bootstrap: undefined`, and
 * `executeFamilyRemoteBootstrap` silently no-op'd — a fresh box skipped the
 * pinned checkout while the report still claimed the pin. Warm reuse already
 * refused that shape; fresh provision did not.
 */
import { familyRemoteBootstrap } from "../../profiles/bootstrap"
import type { BenchRunConfig } from "../../run-config"
import type { FullRemoteConfig } from "./types"

export const withResolvedFamilyBootstrap = (
  cfg: FullRemoteConfig,
  runConfig: BenchRunConfig,
): FullRemoteConfig => {
  const bootstrap = cfg.remoteBootstrap ?? familyRemoteBootstrap(runConfig)
  return { ...cfg, ...(bootstrap !== undefined ? { remoteBootstrap: bootstrap } : {}) }
}
