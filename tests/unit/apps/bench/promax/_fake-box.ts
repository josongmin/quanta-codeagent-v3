/**
 * THE FAKE BOX, in one place.
 *
 * Seven test files each hand-rolled the same responder — "if the command
 * mentions X, answer Y" — with five to twelve branches apiece. Duplication that
 * size is not a style problem here; it is how a single modelling mistake became
 * seven. `if (cmd.includes("$HOME"))` was written to model the home probe and
 * ALSO matched the `"$HOME"/.local/bin/uv venv …` step, so the grader phase's
 * venv command was answered by the probe branch in every one of them: a
 * bootstrap that stopped building its interpreter environment altogether would
 * not have reddened a single test.
 *
 * So the branches live here once, each matching the command it actually models,
 * and a file that needs something different overrides by NAME rather than by
 * writing another `includes` chain.
 */

import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import type { SpawnResult } from "@/apps/bench/remote/backend"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"

export type Reply = { code: number; stdout: string; stderr: string }
export const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "" })
export const fail = (code = 1, stderr = ""): Reply => ({ code, stdout: "", stderr })

/** What the box's `sha256sum` reports for each pinned file. */
const PINNED_DIGESTS: ReadonlyArray<readonly [string, string]> = [
  ["data/swe-bench-promax.json", PROMAX_V1_SNAPSHOT.dataset_sha256],
  ["data/eval.json", PROMAX_V1_SNAPSHOT.eval_sha256],
  ["src/evaluation/test_run.py", PROMAX_V1_SNAPSHOT.evaluator_sha256],
]

export interface FakeBoxOpts {
  /** JSONL the box's patch-gen pass left in `preds`. */
  readonly predictions?: string
  /** the evaluator's pass-rate document. */
  readonly passRate?: string
  /** tab-separated `id\timage\tdigest` lines for the provenance step. */
  readonly imageProvenance?: string
  /** answer for the grade invocation itself. */
  readonly grade?: Reply
  /** replaces the whole responder for commands this returns non-undefined for. */
  readonly override?: (cmd: string) => Reply | undefined
}

export interface FakeBox {
  /** every command the box was sent, in order */
  readonly issued: string[]
  readonly ssh: (cmd: string) => Promise<Reply>
}

/**
 * Each branch matches the ONE command it models.
 *
 * `printf %s "$HOME"` rather than `$HOME`, and the pass-rate `cat` distinguished
 * from the predictions `cat` — both distinctions were absent before, and both
 * hid a real command from every assertion in the suite.
 */
/**
 * A TABLE, matched in order, not an if-chain.
 *
 * Each row matches the ONE command it models. `printf %s "$HOME"` rather than
 * `$HOME`, and the pass-rate `cat` distinguished from the predictions `cat` —
 * both distinctions were absent before, and both hid a real command from every
 * assertion in the suite.
 */
const CASES: ReadonlyArray<{
  readonly when: (cmd: string) => boolean
  readonly reply: (cmd: string, opts: FakeBoxOpts) => Reply
}> = [
  { when: (c) => c.includes('printf %s "$HOME"'), reply: () => ok("/home/ubuntu") },
  { when: (c) => c.includes("--version"), reply: () => ok("Python 3.11.14\n") },
  {
    when: (c) => c.includes("sha256sum"),
    reply: (c) => {
      const hit = PINNED_DIGESTS.find(([suffix]) => c.includes(suffix))
      return hit === undefined ? fail(1, "no such file") : ok(`${hit[1]}  x`)
    },
  },
  {
    when: (c) => c.includes("image-provenance.py"),
    reply: (_c, o) => ok(o.imageProvenance ?? ""),
  },
  {
    when: (c) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.preds),
    reply: (_c, o) => ok(o.predictions ?? ""),
  },
  {
    when: (c) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.passRate),
    reply: (_c, o) => ok(o.passRate ?? ""),
  },
  {
    when: (c) => c.includes("test_run.py") && c.includes("--pred"),
    reply: (_c, o) => o.grade ?? ok(),
  },
]

const respond = (cmd: string, opts: FakeBoxOpts): Reply =>
  opts.override?.(cmd) ?? CASES.find((c) => c.when(cmd))?.reply(cmd, opts) ?? ok()

export const cannedReply = (cmd: string, opts: FakeBoxOpts = {}): Reply => respond(cmd, opts)

export const fakeBox = (opts: FakeBoxOpts = {}): FakeBox => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      return respond(cmd, opts)
    },
  }
}

/** The heredoc body the box was asked to write to the graded-predictions path. */
export const writtenGradedPredictions = (issued: readonly string[]): string | undefined => {
  const write = issued.find((c) => c.startsWith("cat > ") && c.includes("QUANTA_PROMAX_PREDS_EOF"))
  if (write === undefined) return undefined
  // `cat > path <<'MARKER'\n<body>\nMARKER` — splitting on the marker leaves the
  // closing quote of `<<'MARKER'` on the front of the body
  return (write.split("QUANTA_PROMAX_PREDS_EOF")[1] ?? "").replace(/^'/, "").trim()
}

export type { SpawnResult }
