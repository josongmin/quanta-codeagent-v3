/**
 * PMX-04 — WHICH IMAGES a box grade actually ran against.
 *
 * Every ProMax verdict is decided inside a container built from a per-instance
 * image, so "which image" is as much a part of what produced the number as
 * "which evaluator". Gate 2's evidence requires digest pins covering the assigned
 * set.
 *
 * ## The names are read, not guessed
 *
 * The pinned evaluator resolves each image as
 *
 *     golden_entry.get("image_name") or f"key4127/refactor-dockerhub:{instance_id}"
 *
 * and the golden document lives IN the checkout — inside the grader window, and
 * already hash-verified by that phase. So this asks the same file the evaluator
 * asks, with the same fallback.
 *
 * ## A tag is not provenance
 *
 * `repo:tag` can point at different bytes tomorrow. The RepoDigest is the pin, so
 * an image the daemon cannot digest is a FAULT, and so is an assigned instance
 * the box never reported on — either would leave a receipt that looks complete
 * while covering less than it claims.
 *
 * ## 🔴 Why the program is a FILE, not a `-c` string
 *
 * It used to be embedded with `JSON.stringify(pySource)`, as if that were shell
 * quoting. It is not: the result is a DOUBLE-quoted shell string, and the
 * newlines joining the source became the two-character escape `\n`, which bash
 * passes through literally. Python then received one line and raised
 * `SyntaxError: unexpected character after line continuation character` — while
 * the pipeline still exited 0 with empty stdout, so every assigned instance
 * faulted and every completed grade was discarded. It shipped through eight live
 * runs because the tests asserted on the command STRING and never executed it.
 *
 * `JSON.stringify` also leaves `$` and backticks untouched, so the same line was
 * an injection point for any instance id or path reaching it.
 *
 * So the program is shipped as a file over ssh stdin (the idiom this repo already
 * uses for the swebench shim) and invoked with `shq`-quoted argv. Nothing
 * interpolated is re-interpreted by a shell, and there is no embedded-quoting
 * question left to get wrong.
 *
 * It also does the `docker image inspect` itself rather than piping into a bash
 * `while IFS=$'\t' read` loop: that construct is bash-only and splits silently
 * wrong under dash, which is what `sh -c` would give it.
 *
 * PURE: builds a program and a command, and parses output. Issues nothing.
 */
import { shq } from "../../remote/box-session/shell"

/** A well-formed OCI content digest, as `RepoDigests` reports it. */
const REPO_DIGEST = /@sha256:[0-9a-f]{64}$/

/** Where the program is written on the box. Under the campaign root, so the
 *  chunk scrub and the campaign teardown both already cover the directory. */
export const PROMAX_IMAGE_PROVENANCE_SCRIPT_PATH = "/opt/quanta/promax/image-provenance.py"

/**
 * The program, verbatim. Reads the checkout's golden, resolves each assigned
 * instance's image name with the evaluator's own fallback, asks the daemon for
 * its RepoDigest, and prints `<id>\t<name>\t<digest>` — an EMPTY third field when
 * the daemon has no digest, so the parser can tell "no digest" from "never
 * reported".
 *
 * Ids arrive as argv, never interpolated into source.
 */
export const PROMAX_IMAGE_PROVENANCE_SCRIPT = `import json, subprocess, sys

golden_path, ids = sys.argv[1], sys.argv[2:]
with open(golden_path, "r", encoding="utf-8") as fh:
    g = json.load(fh)
rows = g if isinstance(g, list) else list(g.values())
by = {r.get("instance_id"): r for r in rows if isinstance(r, dict)}

for instance_id in ids:
    entry = by.get(instance_id) or {}
    image = entry.get("image_name") or ("key4127/refactor-dockerhub:" + instance_id)
    try:
        out = subprocess.run(
            ["docker", "image", "inspect", "--format",
             "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", image],
            capture_output=True, text=True, timeout=60,
        )
        digest = out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        digest = ""
    print(instance_id + "\\t" + image + "\\t" + digest)
`

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
 * The command that RUNS the already-uploaded program.
 *
 * Every interpolated value goes through `shq` — the repo's shell quoter, whose
 * own doc names this hazard ("a preset/model/instance-id containing … `$(...)`,
 * backtick"). An instance id is third-party data from the upstream corpus, so it
 * is not trusted input.
 */
export const buildProMaxImageProvenanceCommand = (input: {
  readonly checkoutRoot: string
  readonly venvPython: string
  readonly scriptPath: string
  readonly instanceIds: readonly string[]
}): string => {
  const checkout = input.checkoutRoot.replace(/\/+$/, "")
  return [
    shq(input.venvPython),
    shq(input.scriptPath),
    shq(`${checkout}/data/swe-bench-promax.json`),
    ...input.instanceIds.map(shq),
  ].join(" ")
}

/** Parse the program's output against the ASSIGNED set, fail-closed. */
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
