/**
 * PMX-02 fixture builder — a SYNTHETIC, officially-SHAPED ProMax corpus.
 *
 * Deliberately NOT the real 170-row bundle: that file is gold-bearing and must
 * never enter git (PMX-00). Instead this synthesizes rows with the exact
 * upstream SHAPE — verified by PMX-00 against all 170 real rows — and PLACEHOLDER
 * bodies for every grader-only field, so a leak assertion can look for a marker
 * string that could only have come from the gold side.
 *
 * Shape facts a naive fixture gets wrong (both are load-bearing here):
 *  - `created_at` is an INTEGER, not an ISO string;
 *  - rows are NOT key-uniform: `pull_number` is present on 104/170 and
 *    `issue_numbers` on 3/170, so neither may be required.
 * The default fixture reproduces both, so a validator that required either, or
 * that typed `created_at` as a string, would fail against this fixture exactly
 * as it would fail against the real corpus.
 */

/** The seven upstream languages and their REAL full-corpus counts (PMX-00). */
export const PROMAX_LANGUAGE_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  c: 20,
  "c++": 22,
  go: 23,
  java: 26,
  python: 29,
  rust: 22,
  typescript: 28,
})

/** Marker bodies. Any of these appearing on an agent-visible surface is a leak. */
export const GOLD_PATCH_MARKER = "PMX02-GOLD-PATCH-BODY"
export const GOLD_TEST_PATCH_MARKER = "PMX02-GOLD-TEST-PATCH-BODY"
export const EVAL_SCRIPT_MARKER = "PMX02-EVAL-SCRIPT-BODY"

const hex40 = (seed: string): string => {
  let out = ""
  let i = 0
  while (out.length < 40) {
    out += Array.from(`${seed}#${i}`)
      .map((ch) => (ch.codePointAt(0) ?? 0).toString(16))
      .join("")
    i += 1
  }
  return out.slice(0, 40)
}

export interface FixtureRowOverrides {
  readonly [key: string]: unknown
}

/** One officially-shaped ProMax dataset row (GOLD-BEARING, like upstream). */
export const promaxDatasetRow = (
  instanceId: string,
  language: string,
  index: number,
  overrides: FixtureRowOverrides = {},
): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    instance_id: instanceId,
    repo: `promax-org/${language.replace(/[^a-z0-9]/g, "")}-lib`,
    base_commit: hex40(`${instanceId}:base`),
    environment_setup_commit: hex40(`${instanceId}:env`),
    language,
    image_name: `swebench-promax/${instanceId.toLowerCase()}:v1`,
    working_dir: index % 2 === 0 ? "/testbed" : `/workspace/${language}`,
    problem_statement: `PROBLEM ${instanceId}: the ${language} widget does not widget.`,
    hints_text: "",
    // INTEGER, not a string — upstream fact verified by PMX-00.
    created_at: 1_700_000_000 + index,
    patch: `--- a/src.${language}\n+++ b/src.${language}\n@@\n+${GOLD_PATCH_MARKER}-${instanceId}\n`,
    test_patch: `--- a/test.${language}\n+++ b/test.${language}\n@@\n+${GOLD_TEST_PATCH_MARKER}-${instanceId}\n`,
  }
  // SPARSE fields — present on a minority of rows, exactly as upstream.
  if (index % 3 === 0) base.pull_number = 1000 + index
  if (index % 17 === 0) base.issue_numbers = [`${index}`]
  return { ...base, ...overrides }
}

/** The eval record for one instance (grader-only). */
export const promaxEvalRecord = (instanceId: string): Record<string, unknown> => ({
  instance_id: instanceId,
  eval_script: `#!/bin/bash\necho ${EVAL_SCRIPT_MARKER}-${instanceId}\n`,
})

export interface SyntheticCorpus {
  readonly datasetText: string
  readonly evalText: string
  readonly rows: readonly Record<string, unknown>[]
  readonly instanceIds: readonly string[]
}

/**
 * Build a corpus with `counts[language]` rows per language, in a deliberately
 * NON-sorted, interleaved emission order so any test that observes "dataset
 * order" is not accidentally observing "sorted order".
 */
export const buildSyntheticProMaxCorpus = (
  counts: Readonly<Record<string, number>> = PROMAX_LANGUAGE_COUNTS,
  mutate?: (rows: Record<string, unknown>[], evalMap: Record<string, unknown>) => void,
): SyntheticCorpus => {
  const languages = Object.keys(counts)
  const rows: Record<string, unknown>[] = []
  const evalMap: Record<string, unknown> = {}
  const maxPerLanguage = Math.max(0, ...languages.map((l) => counts[l] ?? 0))
  let index = 0
  for (let n = 0; n < maxPerLanguage; n += 1) {
    for (const language of languages) {
      if (n >= (counts[language] ?? 0)) continue
      const slug = language.replace(/[^a-z0-9]/g, "p")
      const instanceId = `promax__${slug}-${String(n + 1).padStart(3, "0")}`
      rows.push(promaxDatasetRow(instanceId, language, index))
      evalMap[instanceId] = promaxEvalRecord(instanceId)
      index += 1
    }
  }
  mutate?.(rows, evalMap)
  return {
    // The OFFICIAL on-disk form is a pretty-printed JSON ARRAY — a JSONL reader
    // sees zero rows in it, which is the whole point of the adapter.
    datasetText: `${JSON.stringify(rows, null, 2)}\n`,
    evalText: `${JSON.stringify(evalMap, null, 2)}\n`,
    rows,
    instanceIds: rows.map((r) => String(r.instance_id)),
  }
}

/** The PMX-40 quota table, verbatim from the ticket. */
export const PMX_40_QUOTAS: Readonly<Record<string, number>> = Object.freeze({
  c: 5,
  "c++": 5,
  go: 5,
  java: 6,
  python: 7,
  rust: 5,
  typescript: 7,
})
