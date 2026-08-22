/**
 * RFC-06 F5 — the node fs + OS-reveal adapter behind {@link SkillActionPorts}.
 *
 * `@/skill` may not import `@/storage` / node built-ins in the leaf action
 * module, so this adapter is where node:fs / node:child_process are reached —
 * mirroring `node-disabled-store` / `admin-policy-loader-fs`. It provides:
 *
 *   - `resolveCanonicalSkill` — an ACTION-TIME live re-scan (`buildSkillSnapshot`
 *     + `registry.lookup`), so copy/reveal reflect a disk mutation that landed
 *     after the surface was built (RFC-06 F5 RED (a)).
 *   - `statBytes` / `readFileUtf8` / `realpath` — the bounded-read + path-jail
 *     fs primitives.
 *   - `reveal` — the OPTIONAL OS reveal capability, present ONLY on a platform
 *     with a real reveal command (darwin / win32 / linux). On any other platform
 *     it is OMITTED, so {@link revealSkill} returns the honest typed `unsupported`
 *     receipt rather than a silent success (RFC-06 F5 RED (c)).
 */

import { buildSkillSnapshot, type SkillSnapshotInputs } from "../../registry"
import type { SkillActionPorts } from "../actions"

/** Build the OPTIONAL OS reveal function for THIS platform, or `undefined` when
 *  no reveal command exists (⇒ a typed `unsupported` reveal receipt). Reveals
 *  the file's containing directory, selecting the file where the platform
 *  supports it (macOS `open -R`, Windows `explorer /select,`). */
export const nodeRevealCapability = (
  platform: NodeJS.Platform = process.platform,
): ((absPath: string) => Promise<void>) | undefined => {
  const spec: { readonly cmd: string; readonly args: (p: string) => string[] } | undefined =
    platform === "darwin"
      ? { cmd: "open", args: (p) => ["-R", p] }
      : platform === "win32"
        ? { cmd: "explorer", args: (p) => [`/select,${p}`] }
        : platform === "linux"
          ? { cmd: "xdg-open", args: (p) => [dirOf(p)] }
          : undefined
  if (spec === undefined) return undefined
  return async (absPath: string): Promise<void> => {
    const { spawn } = await import("node:child_process")
    await new Promise<void>((resolve, reject) => {
      const child = spawn(spec.cmd, spec.args(absPath), { stdio: "ignore" })
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0 || code === null ? resolve() : reject(new Error(`${spec.cmd} exited ${code}`)),
      )
    })
  }
}

const dirOf = (p: string): string => {
  const norm = p.replace(/[/\\]+$/u, "")
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"))
  return cut <= 0 ? norm : norm.slice(0, cut)
}

/**
 * Build the production {@link SkillActionPorts}. `snapshotInputs` drives the
 * ACTION-TIME re-scan (the SAME inputs the session's `buildSkillRuntimeAuthority`
 * used, so the winner resolution matches). `reveal` defaults to the
 * platform-derived capability but can be overridden (a headless/web surface
 * passes `null` to force the honest `unsupported` receipt).
 */
export const createNodeSkillActionPorts = (opts: {
  readonly snapshotInputs: SkillSnapshotInputs
  readonly reveal?: ((absPath: string) => Promise<void>) | null
}): SkillActionPorts => {
  const reveal = opts.reveal === null ? undefined : (opts.reveal ?? nodeRevealCapability())
  return {
    resolveCanonicalSkill: async (name) => {
      const snapshot = await buildSkillSnapshot(opts.snapshotInputs)
      return snapshot.registry.lookup(name)?.skill
    },
    statBytes: async (absPath) => {
      const { stat } = await import("node:fs/promises")
      return (await stat(absPath)).size
    },
    readFileUtf8: async (absPath) => {
      const { readFile } = await import("node:fs/promises")
      return await readFile(absPath, "utf8")
    },
    realpath: async (absPath) => {
      const { realpath } = await import("node:fs/promises")
      return await realpath(absPath)
    },
    ...(reveal !== undefined ? { reveal } : {}),
  }
}
