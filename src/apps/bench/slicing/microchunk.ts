/**
 * Multi-Auth Fleet (jun-20) — T-4 microchunk routing.
 *
 * Chunk-level account leasing (T-3) approximates per-problem parallelism WITHOUT
 * invasive per-instance auth mixing inside one `bench run`: just make the chunks
 * smaller. `chunkSize=1` ⇒ one problem per chunk ⇒ the scheduler spreads single
 * problems across accounts. This splits a dataset jsonl into deterministic,
 * runId-stable slices the pool accepts unchanged.
 *
 * The pure planner ({@link planMicrochunks}) does no I/O so it's fully testable;
 * {@link writeMicrochunks} is the thin filesystem shell.
 *
 * PMX-02: the slicer no longer parses the dataset. It used to split on newlines
 * and read `instance_id` out of each line itself — a THIRD independent parser
 * beside the run path and the remote preflight, and one that silently produces
 * garbage for a family whose corpus is an official JSON array (one "line" holding
 * every row, or a pretty-printed array split mid-object). It now takes the
 * family's own {@link FamilyCorpusReader}, so a slice is always a slice of what
 * the run would actually have executed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { FamilyCorpusReader } from "../profiles/corpus-row"

/** A planned slice: its stable runId, the instance ids it carries, and the raw
 *  jsonl lines (verbatim from the source — no rewriting, so no token material can
 *  be injected into a slice artifact). */
export interface PlannedMicrochunk {
  readonly runId: string
  readonly instanceIds: readonly string[]
  readonly lines: readonly string[]
}

/** A written slice: where it lives on disk, plus its routing identity. */
export interface Microchunk {
  readonly runId: string
  readonly datasetPath: string
  readonly instanceIds: readonly string[]
}

/** FS-safe runId fragment (no slashes/spaces — pool's `assertUniqueChunkRunIds`
 *  and the runId-scoped box dir both require this). */
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "_")

/** Derive a base runId from a dataset path (filename without extension). */
export const baseRunIdFromPath = (path: string): string =>
  sanitize(basename(path).replace(/\.jsonl?$/i, "")) || "chunk"

/**
 * Split dataset jsonl text into ordered slices of `chunkSize` instances each.
 * Deterministic: same input ⇒ same runIds in the same order. runIds are
 * zero-padded by total slice count so they sort lexicographically in run order;
 * a 1-instance slice also carries the (sanitized) instance id for readability,
 * but the ordinal prefix is what GUARANTEES uniqueness even on duplicate ids.
 */
export const planMicrochunks = (
  datasetText: string,
  baseRunId: string,
  chunkSize: number,
  /** The FAMILY's reader — required, so no caller can slice a corpus with a
   *  format assumption the run itself does not share. */
  readRows: FamilyCorpusReader,
): PlannedMicrochunk[] => {
  const size = Math.max(1, Math.floor(chunkSize) || 1)
  const rows = readRows(datasetText)
  if (rows.length === 0) return []
  const groups: (typeof rows)[] = []
  for (let i = 0; i < rows.length; i += size) groups.push(rows.slice(i, i + size))
  const width = String(groups.length).length
  return groups.map((group, i) => {
    const instanceIds = group.map((row) => row.instanceId)
    const ord = String(i + 1).padStart(width, "0")
    const suffix = size === 1 && instanceIds[0] !== undefined ? `-${sanitize(instanceIds[0])}` : ""
    // `sourceLine` is VERBATIM for the JSONL families (so a slice stays
    // byte-identical to its source, as before) and the PUBLIC projection for a
    // family whose corpus ships gold inline — a chunk file is scp'd to the box the
    // agent runs on, so it must never be able to carry gold.
    return {
      runId: `${baseRunId}-${ord}${suffix}`,
      instanceIds,
      lines: group.map((r) => r.sourceLine),
    }
  })
}

export interface WriteMicrochunkOpts {
  readonly datasetPath: string
  readonly chunkSize: number
  /** The FAMILY's dataset reader (see {@link planMicrochunks}). */
  readonly readRows: FamilyCorpusReader
  /** Where slice jsonl files are written. Default: `<dataset dir>/.microchunks-<base>`. */
  readonly outDir?: string
  /** Test seams. */
  readonly readFile?: (path: string) => string
  readonly writeFile?: (path: string, content: string) => void
  readonly ensureDir?: (path: string) => void
}

/** Default on-disk slice dir for a dataset — deterministic, so re-runs overwrite
 *  the same paths rather than accumulating. */
export const defaultMicrochunkDir = (datasetPath: string): string =>
  join(dirname(datasetPath), `.microchunks-${baseRunIdFromPath(datasetPath)}`)

/**
 * Materialize microchunks on disk and return their routing identities (ready to
 * map into `PoolChunk[]`). Each slice file contains ONLY the verbatim source
 * lines — no auth/token bytes are ever written.
 */
export const writeMicrochunks = (opts: WriteMicrochunkOpts): Microchunk[] => {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const write = opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c))
  const ensure = opts.ensureDir ?? ((p: string) => void mkdirSync(p, { recursive: true }))
  const outDir = opts.outDir ?? defaultMicrochunkDir(opts.datasetPath)
  const base = baseRunIdFromPath(opts.datasetPath)
  const planned = planMicrochunks(read(opts.datasetPath), base, opts.chunkSize, opts.readRows)
  if (planned.length === 0) return []
  ensure(outDir)
  return planned.map((p) => {
    const datasetPath = join(outDir, `${p.runId}.jsonl`)
    write(datasetPath, `${p.lines.join("\n")}\n`)
    return { runId: p.runId, datasetPath, instanceIds: p.instanceIds }
  })
}
