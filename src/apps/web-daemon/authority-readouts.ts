/**
 * RFC-06 F4 — the web-daemon's skills readout, projected off the ONE shared
 * `SkillRuntimeAuthority` (never an independent discovery scan).
 *
 * Before F4, `runtime-factory.ts`'s `buildReadoutSources.skills` ran its OWN
 * disk-discovery merge (user dir + bundled system) — a SECOND discovery path
 * that bypassed the session's live authority. A skill disabled through the
 * authority (F1 `setEnabled`) stayed visible in the web `/skills` panel: the
 * jul-15 "badge shows Disabled but the surface still lists it as active" trust
 * lie, on the web surface.
 *
 * F4 deletes that scan. The `/skills` readout now reads the SAME authority the
 * prompt inventory, ToolSearch, direct invocation and the CLI surface read, so
 * the web panel can never disagree with the live active set. Cross-process
 * convergence: the accessor `sync()`s the durable disabled-set at read time (a
 * management-read boundary), then projects the `active` view — matching the
 * always-fresh semantics the old re-scan gave, without a second registry.
 *
 * Slice fence: this file lives on the `web-daemon` surface and imports only
 * `@/skill` (the authority + its view types). It never reaches into `@/apps/*`
 * (the surface-coupling ratchet), and the readout renderer that consumes the
 * returned rows (`readout.ts`) still imports no `@/skill` value type — the row
 * shape is the same narrow `{ name, description }` structural view it already
 * declared for `WebReadoutSources.skills`.
 */

import { join } from "node:path"
import { buildSkillRuntimeAuthority } from "@/runner/assemble/session-authorities"
import { errMessage, logger, quantaHomeDirFrom } from "@/shared"
import type { SkillRuntimeAuthority } from "@/skill"

/** The narrow structural row the web `/skills` readout renders (mirror of the
 *  `WebReadoutSources.skills` element shape — no `@/skill` value type leaks into
 *  `readout.ts`). */
export interface SkillReadoutRow {
  readonly name: string
  readonly description: string
}

/**
 * Build the web `/skills` readout accessor over the shared authority. Returns
 * the SAME `() => Promise<readonly {name,description}[]>` shape
 * `WebReadoutSources.skills` expects, so `buildReadoutSources` just threads it
 * through — no change to the readout route or renderer.
 *
 * Reads the LIVE `active` projection (durably-disabled + admin-banned rows
 * already excluded by the authority), after a `sync()` so a disable persisted by
 * another process/session is reflected on the next readout. Sorted by name to
 * match the readout renderer's own ordering (stable panel output).
 */
export const buildSkillsReadoutSource =
  (authority: SkillRuntimeAuthority): (() => Promise<readonly SkillReadoutRow[]>) =>
  async (): Promise<readonly SkillReadoutRow[]> => {
    // Management-read boundary — re-read the durable disabled set + republish the
    // projections at the persisted revision (never mutates the durable store), so
    // the web panel converges with a cross-process disable.
    const view = await authority.sync()
    return view.active
      .map((s) => ({ name: s.name, description: s.description }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

/**
 * RFC-06 F4 — build the ONE durable skill runtime authority for a web-daemon
 * session (mirror of the CLI `buildCliSkillAuthority`). Same discovery the pre-F4
 * readout scan used (userDir + bundled system), now DURABLE (a JSON disabled-set
 * store under `~/.quanta`, or `<userSkillsDir>/.disabled.json`) and SHARED across
 * surfaces: the prompt/ToolSearch/invocation read it via `config.skills.authority`
 * and the `/skills` readout reads its `active` projection. `orgConfigDir` is left
 * null (no admin policy wired at this surface yet — the builder's real
 * `loadAdminPolicy` still runs and returns null). Fail-open ⇒ undefined ⇒ the
 * readout serves the honest missing-source line and `buildSkillBlock` mints the
 * interim authority. Lives here (not `runtime-factory.ts`) to keep that
 * composition root under the god-module cap.
 */
export const buildWebSkillAuthority = async (
  skills: { readonly dir?: string } | undefined,
  env: Record<string, string | undefined>,
): Promise<SkillRuntimeAuthority | undefined> => {
  if (skills === undefined) return undefined
  const dir = skills.dir
  try {
    return await buildSkillRuntimeAuthority({
      snapshotInputs: dir !== undefined ? { userDir: dir } : {},
      disabledSetPath:
        dir !== undefined
          ? join(dir, ".disabled.json")
          : join(quantaHomeDirFrom(env), "skills-disabled.json"),
    })
  } catch (e) {
    logger.warn(
      "web-daemon: skill runtime authority build failed; continuing without convergence",
      {
        error: errMessage(e),
      },
    )
    return undefined
  }
}
