/**
 * A1 — Filesystem-backed write port for the repro artifact sink.
 *
 * Keeps `repro-artifacts-sink.ts` fs-FREE (pure, unit-testable with a fake port);
 * THIS module is the thin node:fs adapter the composition root binds in production.
 * Rooted UNDER the run's observe directory so the artifacts ride the existing
 * observe tarball back from full-remote boxes (no fetch-manifest edit).
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  makeReproArtifactSink,
  type ReproArtifactSink,
  type ReproArtifactWritePort,
} from "./repro-artifacts-sink"

/** Build an fs-backed write port rooted at `rootDir`. Each `writeFile(relPath)`
 *  creates parent dirs then writes — best-effort is the caller's concern (the
 *  sink swallows per-candidate errors). */
export const makeReproArtifactFsPort = (rootDir: string): ReproArtifactWritePort => ({
  writeFile: async (relPath: string, content: string): Promise<void> => {
    const abs = join(rootDir, relPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  },
})

/** Production sink: pure sink over an fs port rooted at `rootDir` (typically
 *  `<observeDir>/<runId>`). */
export const makeReproArtifactFsSink = (rootDir: string): ReproArtifactSink =>
  makeReproArtifactSink(makeReproArtifactFsPort(rootDir))
