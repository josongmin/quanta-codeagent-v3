/**
 * jun-29 OBSERVE-ONLY candidate-pool sink (impure edge).
 *
 * Writes the breadth pool's per-candidate rows ({@link ./candidate-ledger.ts},
 * pure) + each candidate's full `.patch` under the run's observe artifact root, so
 * the WHOLE pool (not just the adopted winner) rides the observe tarball back for
 * post-hoc analysis. Decision impact ZERO; the driver only wires this when an
 * observe root exists (absent ⇒ the sink is never built ⇒ byte-identical).
 *
 * Append-mode: each repair round adds its rows to the same `candidates.jsonl`.
 */

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { buildCandidatePoolRows } from "./candidate-ledger"
import type { RepairCandidateOutcome } from "./types"

export const writeCandidatePool = async (
  artifactRootPath: string,
  instanceId: string,
  round: number,
  candidates: readonly RepairCandidateOutcome[],
): Promise<void> => {
  const dir = join(artifactRootPath, "repair-candidates", instanceId)
  await mkdir(dir, { recursive: true })

  const rows = buildCandidatePoolRows(round, candidates)
  if (rows.length > 0) {
    const jsonl = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
    const fp = join(dir, "candidates.jsonl")
    const prev = await Bun.file(fp)
      .text()
      .catch(() => "")
    await Bun.write(fp, prev + jsonl)
  }

  // The full diff for each candidate (so a missed-winner's actual edit is readable
  // post-hoc, not just its parsed file list).
  await Promise.all(
    candidates.map((c, i) => Bun.write(join(dir, `cand-r${round}-i${i}.patch`), c.run.patch)),
  )
}
