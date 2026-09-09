/**
 * Shared CLI/web skill-authority composition (G-F11).
 *
 * Resolves org dir once, feeds `snapshotInputs` + `loadAdminPolicy`, and
 * fail-opens on generic construction errors. Malformed org policy stays
 * fail-loud via {@link SkillAdminPolicyLoadError} — wiring must not swallow it.
 */
import { join } from "node:path"
import { errMessage, quantaHomeDirFrom } from "@/shared"
import type { AdminPolicyReader, DisabledStorePort, SkillRuntimeAuthority } from "@/skill"
import { buildSkillRuntimeAuthority, SkillAdminPolicyLoadError } from "../build-skills"
import { resolveOrgConfigDir } from "./org-config-dir"

export interface ComposeSessionSkillAuthorityInput {
  readonly skills?: { readonly dir?: string }
  readonly env: Record<string, string | undefined>
  /** `null` = opt-out; omit = default resolve; string = explicit dir. */
  readonly orgConfigDir?: string | null
  readonly systemDir?: string
  readonly readPolicyFile?: AdminPolicyReader
  readonly disabledStore?: DisabledStorePort
  readonly warn?: (info: { error: string }) => void
}

const emitWarn = (warn: ((info: { error: string }) => void) | undefined, error: string): void => {
  if (warn === undefined) return
  try {
    warn({ error })
  } catch {
    // Diagnostic failure must not replace fail-open with throw.
  }
}

export const composeSessionSkillAuthority = async (
  input: ComposeSessionSkillAuthorityInput,
): Promise<SkillRuntimeAuthority | undefined> => {
  if (input.skills === undefined) return undefined
  const dir = input.skills.dir
  const orgConfigDir = resolveOrgConfigDir(input.env, input.orgConfigDir)
  try {
    return await buildSkillRuntimeAuthority({
      snapshotInputs: {
        ...(dir !== undefined ? { userDir: dir } : {}),
        ...(input.systemDir !== undefined ? { systemDir: input.systemDir } : {}),
        orgConfigDir,
      },
      orgConfigDir,
      ...(input.readPolicyFile !== undefined ? { readPolicyFile: input.readPolicyFile } : {}),
      ...(input.disabledStore !== undefined
        ? { disabledStore: input.disabledStore }
        : {
            disabledSetPath:
              dir !== undefined
                ? join(dir, ".disabled.json")
                : join(quantaHomeDirFrom(input.env), "skills-disabled.json"),
          }),
    })
  } catch (e) {
    if (e instanceof SkillAdminPolicyLoadError) throw e
    emitWarn(input.warn, errMessage(e))
    return undefined
  }
}
