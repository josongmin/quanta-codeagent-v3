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
import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { join, resolve, dirname, basename } from "path"

const dir = import.meta.dir
const arg = process.argv[2]

// ── resolve trajectory path ──
let trajectoryPath: string
if (arg) {
  const p = resolve(arg)
  // if arg is a directory, load all .jsonl files in it as one merged stream
  if (existsSync(p) && require("fs").statSync(p).isDirectory()) {
    // Each .jsonl file = ONE session (one bench-instance run). Do NOT merge —
    // preserve file boundaries so the viewer shows one session per file.
    const files = readdirSync(p)
      .filter(f => f.endsWith(".jsonl") && !f.startsWith("preds"))
      .sort()
    if (!files.length) { console.error(`No .jsonl files in ${p}`); process.exit(1) }
    const sessions = files.map(f => ({ name: f, text: readFileSync(join(p, f), "utf8") }))
    const dataPath = join(dir, "data.js")
    const metas = collectMetas(p)
    writeDataJs(dataPath, sessions, metas)
    console.log(`Loaded ${files.length} session(s) from ${p}`)
    open(dir)
    process.exit(0)
  }
  trajectoryPath = p
} else {
  // No arg: prefer trajectories/ dir (per-session files) over the global flat file
  const trajSubdir = join(dir, "../../trajectories")
  if (existsSync(trajSubdir) && require("fs").statSync(trajSubdir).isDirectory()) {
    const files = readdirSync(trajSubdir)
      .filter(f => f.endsWith(".jsonl") && !f.startsWith("preds"))
      .sort()
    if (files.length > 0) {
      const sessions = files.map(f => ({ name: f, text: readFileSync(join(trajSubdir, f), "utf8") }))
      const metas = collectMetas(trajSubdir)
      writeDataJs(join(dir, "data.js"), sessions, metas)
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
function collectMetas(dir: string): object[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith(".meta.json"))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")) } catch { return null } })
    .filter(Boolean)
}

// Bake one session PER FILE. `sessions` is [{name, text}] — the viewer builds
// one session entry per element (no heuristic re-segmentation).
function writeDataJs(dataPath: string, sessions: { name: string; text: string }[], metas: object[]) {
  const parts = [`window.__SESSIONS__ = ${JSON.stringify(sessions)};`]
  if (metas.length) parts.push(`window.__META__ = ${JSON.stringify(metas)};`)
  writeFileSync(dataPath, parts.join("\n"))
}

function open(viewerDir: string) {
  execSync(`open "${join(viewerDir, "index.html")}"`)
}
