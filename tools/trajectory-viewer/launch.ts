#!/usr/bin/env bun
/**
 * Shortcut launcher — bake bench-trajectory.jsonl (+ companion .meta.json files)
 * into data.js and open the viewer.
 *
 * Usage:
 *   bun tools/trajectory-viewer/launch.ts                          # global bench-trajectory.jsonl
 *   bun tools/trajectory-viewer/launch.ts trajectories/20260708-… # specific session
 *   bun tools/trajectory-viewer/launch.ts trajectories/            # whole session dir
 */
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "fs"
import { execSync } from "child_process"
import { join, resolve, dirname, basename } from "path"

const dir = import.meta.dir
const arg = process.argv[2]

// ── resolve trajectory path ──
let trajectoryPath: string
if (arg) {
  const p = resolve(arg)
  // if arg is a directory, load all .jsonl files in it as one merged stream
  if (existsSync(p) && statSync(p).isDirectory()) {
    // Each .jsonl file = ONE session (one bench-instance run). Do NOT merge —
    // preserve file boundaries so the viewer shows one session per file. Scan
    // RECURSIVELY: full-remote fetch extracts per-box cassettes into
    // `trajectories/<box>/<ts>-<instanceId>.jsonl` subdirs.
    const files = walkJsonl(p)
    if (!files.length) { console.error(`No .jsonl files in ${p}`); process.exit(1) }
    const sessions = files.map(rel => ({ name: rel, text: readFileSync(join(p, rel), "utf8") }))
    const dataPath = join(dir, "data.js")
    const metas = collectMetas(p)
    const observe = collectObserve(p, files)
    writeDataJs(dataPath, sessions, metas, observe)
    console.log(`Loaded ${files.length} session(s) from ${p}${Object.keys(observe).length ? ` (+observe: ${Object.keys(observe).length} instance(s))` : ""}`)
    open(dir)
    process.exit(0)
  }
  trajectoryPath = p
} else {
  // No arg: prefer trajectories/ dir (per-session files) over the global flat file
  const trajSubdir = join(dir, "../../trajectories")
  if (existsSync(trajSubdir) && statSync(trajSubdir).isDirectory()) {
    const files = walkJsonl(trajSubdir)
    if (files.length > 0) {
      const sessions = files.map(rel => ({ name: rel, text: readFileSync(join(trajSubdir, rel), "utf8") }))
      const metas = collectMetas(trajSubdir)
      writeDataJs(join(dir, "data.js"), sessions, metas, collectObserve(trajSubdir, files))
      console.log(`Loaded ${files.length} session(s) from trajectories/`)
      open(dir)
      process.exit(0)
    }
  }
  trajectoryPath = join(dir, "../../bench-trajectory.jsonl")
}

if (!existsSync(trajectoryPath)) {
  console.error(`Not found: ${trajectoryPath}`)
  console.error("Usage: bun tools/trajectory-viewer/launch.ts [path.jsonl | trajectories/]")
  process.exit(1)
}

const raw = readFileSync(trajectoryPath, "utf8")
console.log(`Loaded: ${trajectoryPath} (${(raw.length / 1024).toFixed(0)} KB)`)

// ── look for companion .meta.json files ──
// If loading a specific session file: look for same-prefix .meta.json
// If loading the global file: look for all metas in ./trajectories/
const metas = (() => {
  const trajDir = dirname(trajectoryPath)
  const base = basename(trajectoryPath, ".jsonl")
  // companion: same basename with .meta.json
  const companion = join(trajDir, base + ".meta.json")
  if (existsSync(companion)) return [JSON.parse(readFileSync(companion, "utf8"))]
  // fallback: global file → load all from trajectories/ subdir
  const trajSubdir = join(trajDir, "trajectories")
  return collectMetas(trajSubdir)
})()

const dataPath = join(dir, "data.js")
// single file = single session
writeDataJs(dataPath, [{ name: basename(trajectoryPath), text: raw }], metas)
open(dir)
console.log("Opened trajectory viewer.")

// ── helpers ──
/** Recursively collect `.jsonl` cassette paths (relative to `root`, excluding
 *  `preds*`), sorted. Recursion is what reaches the per-box `trajectories/<box>/`
 *  subdirs the full-remote fetch extracts into. */
function walkJsonl(root: string, sub = ""): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, sub)).sort()) {
    const rel = sub ? join(sub, name) : name
    const st = statSync(join(root, rel))
    if (st.isDirectory()) out.push(...walkJsonl(root, rel))
    else if (name.endsWith(".jsonl") && !name.startsWith("preds")) out.push(rel)
  }
  return out
}

/** Recursively load every `.meta.json` sidecar under `dir` (matches walkJsonl). */
function collectMetas(dir: string): object[] {
  if (!existsSync(dir)) return []
  const out: object[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collectMetas(p))
    else if (name.endsWith(".meta.json")) {
      try { out.push(JSON.parse(readFileSync(p, "utf8"))) } catch { /* skip */ }
    }
  }
  return out
}

// Bake one session PER FILE + the scaffold ACTION stream (observe) keyed by
// instanceId. The trajectory is the LLM cassette (req/resp); observe holds the
// scaffold's own actions (sandbox / tree / repro-select / verify / patch /
// recovery) that never enter the cassette. The viewer merges both by timestamp.
function writeDataJs(
  dataPath: string,
  sessions: { name: string; text: string }[],
  metas: object[],
  observe: Record<string, unknown[]> = {},
) {
  const parts = [`window.__SESSIONS__ = ${JSON.stringify(sessions)};`]
  if (metas.length) parts.push(`window.__META__ = ${JSON.stringify(metas)};`)
  if (Object.keys(observe).length) parts.push(`window.__OBSERVE__ = ${JSON.stringify(observe)};`)
  writeFileSync(dataPath, parts.join("\n"))
}

/**
 * Collect the scaffold ACTION stream from full-remote `observe-<box>.tar.b64`
 * archives (looked up in `dir` and its parent — the trajectories/ dir sits under
 * full-remote/ next to the observe tarballs). Extracts each, reads every
 * `<instanceId>.<attempt>.jsonl`, and groups its events by instanceId. Best-
 * effort: any missing tar / bad archive is skipped silently.
 */
function collectObserve(dir: string, files: string[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  const seen = new Set<string>()
  // Only pull observe for the box(es) actually loaded — a session file lives at
  // `<boxSuffix>/<...>.jsonl`, next to `observe-<boxSuffix>.tar.b64`. Without this
  // the whole full-remote/ history (hundreds of archives) would be bundled.
  const wanted = new Set(files.map(f => f.split("/")[0]).filter(s => s.startsWith("i-")))
  for (const base of [dir, resolve(dir, "..")]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      if (!name.startsWith("observe-") || !name.endsWith(".tar.b64") || seen.has(name)) continue
      const suffix = name.slice("observe-".length, -".tar.b64".length)
      if (wanted.size && !wanted.has(suffix)) continue
      seen.add(name)
      try {
        const tmp = join(dir, `.observe-tmp-${name.replace(/[^A-Za-z0-9]/g, "_")}`)
        execSync(`rm -rf ${JSON.stringify(tmp)}; mkdir -p ${JSON.stringify(tmp)}; base64 -d < ${JSON.stringify(join(base, name))} | tar -x -C ${JSON.stringify(tmp)}`)
        for (const rel of walkJsonl(tmp)) {
          // `<instanceId>.<attempt>.jsonl` — instanceId is the part before the
          // first dot; skip the repro candidate sidecars (they live in subdirs).
          const file = rel.split("/").pop() ?? rel
          if (rel.includes("/repro/")) continue
          const id = file.replace(/\.\d+\.jsonl$/, "").replace(/\.jsonl$/, "")
          const events = readFileSync(join(tmp, rel), "utf8")
            .split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l) } catch { return null } })
            .filter(Boolean)
          if (events.length) (out[id] ??= []).push(...events)
        }
        execSync(`rm -rf ${JSON.stringify(join(dir, `.observe-tmp-${name.replace(/[^A-Za-z0-9]/g, "_")}`))}`)
      } catch { /* skip bad archive */ }
    }
  }
  return out
}

function open(viewerDir: string) {
  execSync(`open "${join(viewerDir, "index.html")}"`)
}
