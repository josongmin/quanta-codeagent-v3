import { matchMention } from "@/integrations/github"

const cpu = (fn: () => void): number => {
  const s = process.cpuUsage()
  fn()
  const d = process.cpuUsage(s)
  return d.user + d.system
}
const bodyOf = (bytes: number) => `${"x".repeat(bytes - 16)}\n@quanta go`
const measure = (bytes: number, k: number): number => {
  const b = bodyOf(bytes)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < k; i++) best = Math.min(best, cpu(() => { matchMention(b, ["@quanta"]) }))
  return best
}
const MB = 1024 * 1024
for (const n of [1, 2, 4, 8, 10]) {
  console.log(n, "MB ->", measure(n * MB, 5), "us")
}
const t1 = measure(1 * MB, 5)
const t10 = measure(10 * MB, 5)
console.log("ratio 10MB/1MB =", (t10 / t1).toFixed(2))
