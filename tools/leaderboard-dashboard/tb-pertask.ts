/**
 * tb-pertask — parse the Terminal-Bench per-task competitor matrix
 * (`rawdata/tb-pertask.md`) into the structure the dashboard's TB benchmark view
 * renders (RFC 06). It is the TB analogue of `scaffold-solving-summary.md` for
 * SWE-bench: task → difficulty/category + each public scaffold's pass-rate.
 *
 * The markdown table shape (verbatim from the HF leaderboard parse):
 *   | task | 난이도 | category | LemonHar | vix | Judy | Wecode | JJAgent | Capy | 평균 |
 *   | dna-insert | medium | scientific-computing | 100% | 80% | … | **57%** |
 *
 * PURE: text in → {@link TbPertask} out. No fs, unit-tested on a literal fixture.
 */

export interface TbTask {
  task: string
  difficulty: string
  category: string
  /** scaffold display-name → pass-rate percent (0..100). */
  scaffolds: Record<string, number>
  /** mean pass-rate across the listed scaffolds (the table's 평균 column). */
  avg: number
  /** true iff EVERY listed scaffold scored 0% — a true hard ceiling nobody solved. */
  hardCeiling: boolean
}

export interface TbPertask {
  scaffolds: string[]
  tasks: TbTask[]
}

const stripCell = (c: string): string => c.replace(/\*\*/g, "").trim()
const pctToNum = (c: string): number | null => {
  const m = stripCell(c).match(/^(\d+)\s*%$/)
  return m ? Number(m[1]) : null
}

/** Parse the TB per-task markdown table. Rows whose first cell isn't a plausible
 *  task name (header / separator / prose) are skipped. */
export const parseTbPertask = (md: string): TbPertask => {
  const lines = md.split("\n")
  let header: string[] | null = null
  let scaffoldCols: { name: string; idx: number }[] = []
  const tasks: TbTask[] = []

  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue
    const cells = line.split("|").slice(1, -1).map((c) => c.trim())
    if (cells.length < 4) continue
    // separator row (|---|---|)
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
    // header row: first cell literally "task"
    if (header === null && cells[0]?.toLowerCase() === "task") {
      header = cells
      // scaffold columns = everything between category(idx 2) and 평균(last)
      for (let i = 3; i < cells.length - 1; i++) {
        scaffoldCols.push({ name: cells[i] as string, idx: i })
      }
      continue
    }
    if (header === null) continue
    const task = stripCell(cells[0] ?? "")
    if (!/^[a-z0-9][a-z0-9.-]+$/i.test(task)) continue // not a task row
    const difficulty = stripCell(cells[1] ?? "")
    const category = stripCell(cells[2] ?? "")
    const scaffolds: Record<string, number> = {}
    for (const col of scaffoldCols) {
      const v = pctToNum(cells[col.idx] ?? "")
      if (v !== null) scaffolds[col.name] = v
    }
    const vals = Object.values(scaffolds)
    const avg =
      pctToNum(cells[cells.length - 1] ?? "") ??
      (vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0)
    const hardCeiling = vals.length > 0 && vals.every((v) => v === 0)
    tasks.push({ task, difficulty, category, scaffolds, avg, hardCeiling })
  }
  return { scaffolds: scaffoldCols.map((c) => c.name), tasks }
}
