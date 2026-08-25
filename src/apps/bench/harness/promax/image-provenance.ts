/**
 * PMX-04 — WHICH IMAGES a box grade actually ran against.
 *
 * Every ProMax verdict is decided inside a container built from a per-instance
 * image, so "which image" is as much a part of what produced the number as
 * "which evaluator". The grade receipt named the evaluator bytes, the argv and
 * the cwd, and said nothing about the images: the run scored against whatever
 * `docker pull` happened to fetch, with no record. Gate 2's evidence requires an
 * image freeze covering the assigned set with DIGEST pins.
 *
 * ## The names are read, not guessed
 *
 * The pinned evaluator resolves each image as
 *
 *     golden_entry.get("image_name") or f"key4127/refactor-dockerhub:{instance_id}"
 *
 * and the golden document lives IN the checkout — inside the grader window, and
 * already hash-verified by that phase. So this asks the same file the evaluator
 * asks, with the same fallback, rather than re-deriving a naming rule that could
 * drift away from it.
 *
 * ## A tag is not provenance
 *
 * `key4127/refactor-dockerhub:x` can point at different bytes tomorrow. The
 * RepoDigest is what pins the run, so an image the daemon cannot give a digest
 * for is a FAULT rather than a record — and so is an assigned instance the box
 * never reported on at all. Dropping either would leave a receipt that looks
 * complete while covering less than it claims.
 *
 * PURE: builds a command and parses its output. Issues nothing.
 */

/** A well-formed OCI content digest, as `RepoDigests` reports it. */
const REPO_DIGEST = /@sha256:[0-9a-f]{64}$/

export interface ProMaxImageProvenanceRecord {
  readonly instanceId: string
  /** the tag the evaluator resolved — kept for readability, never as the pin. */
  readonly imageName: string
  /** `repo@sha256:…` — the actual pin. */
  readonly repoDigest: string
}

export type ProMaxImageProvenanceResult =
  | { readonly ok: true; readonly images: readonly ProMaxImageProvenanceRecord[] }
  | { readonly ok: false; readonly faults: readonly string[] }

/**
 * Build the one command that answers "which image, and at which digest" for every
 * assigned instance.
 *
 * One round trip rather than N: the grader window should be as short as it can
 * be, and a per-instance ssh would widen it for no gain.
 *
 * Emits `<instanceId>\t<imageName>\t<repoDigest>` per line. A missing digest
 * leaves the third field EMPTY rather than omitting the line, so the parser can
 * tell "no digest" from "never reported".
 */
export const buildProMaxImageProvenanceCommand = (input: {
  readonly checkoutRoot: string
  readonly venvPython: string
  readonly instanceIds: readonly string[]
}): string => {
  const checkout = input.checkoutRoot.replace(/\/+$/, "")
  const ids = JSON.stringify([...input.instanceIds])
  // The name resolution is a transcription of the pinned evaluator's own line,
  // kept next to it so a reader can compare them.
  const py = [
    "import json,sys",
    `g=json.load(open(${JSON.stringify(`${checkout}/data/swe-bench-promax.json`)}))`,
    "rows=g if isinstance(g,list) else list(g.values())",
    "by={r.get('instance_id'):r for r in rows if isinstance(r,dict)}",
    `for i in ${ids}:`,
    "    e=by.get(i) or {}",
    "    print(i+'\\t'+(e.get('image_name') or ('key4127/refactor-dockerhub:'+i)))",
  ].join("\n")
  return (
    `${input.venvPython} -c ${JSON.stringify(py)} | ` +
    "while IFS=$'\\t' read -r id img; do " +
    'printf "%s\\t%s\\t%s\\n" "$id" "$img" ' +
    '"$(docker image inspect --format \'{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}\' "$img" 2>/dev/null)"; ' +
    "done"
  )
}

/** Parse the command's output against the ASSIGNED set, fail-closed. */
export const parseProMaxImageProvenance = (
  stdout: string,
  assignedInstanceIds: readonly string[],
): ProMaxImageProvenanceResult => {
  const images: ProMaxImageProvenanceRecord[] = []
  const faults: string[] = []
  const seen = new Set<string>()

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    const [instanceId, imageName, repoDigest] = line.split("\t")
    if (instanceId === undefined || imageName === undefined) {
      faults.push(`unreadable image-provenance line: ${JSON.stringify(line.slice(0, 80))}`)
      continue
    }
    seen.add(instanceId)
    if (repoDigest === undefined || repoDigest.trim() === "") {
      faults.push(
        `${instanceId}: the daemon reported NO digest for ${imageName} — the grade ran against ` +
          "an image that cannot be pinned, so it cannot be replayed",
      )
      continue
    }
    if (!REPO_DIGEST.test(repoDigest.trim())) {
      faults.push(`${instanceId}: ${JSON.stringify(repoDigest.trim())} is not a repo@sha256 digest`)
      continue
    }
    images.push({ instanceId, imageName, repoDigest: repoDigest.trim() })
  }

  for (const id of assignedInstanceIds) {
    if (!seen.has(id)) {
      faults.push(`${id}: assigned, but the box reported no image for it at all`)
    }
  }

  return faults.length > 0 ? { ok: false, faults } : { ok: true, images }
}
