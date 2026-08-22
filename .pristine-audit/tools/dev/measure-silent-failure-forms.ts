import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, sep } from "node:path"
const SRC = join(process.cwd(), "src")
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else if (extname(p) === ".ts" && !p.endsWith(".d.ts")) o.push(p) } return o }
const isProd = (p: string) => !p.endsWith(".test.ts") && !p.includes(`${sep}__tests__${sep}`)
const prod = walk(SRC).filter(isProd)
const count = (re: RegExp) => prod.reduce((s, f) => s + [...readFileSync(f, "utf8").matchAll(re)].length, 0)
const countLine = (re: RegExp, ex: RegExp) => prod.reduce((s, f) => s + readFileSync(f,"utf8").split("\n").filter(l => re.test(l) && !ex.test(l)).length, 0)
console.log("BARE", count(/\}\s*catch\s*\{/g))
console.log("NULLISH", count(/\.catch\(\s*\(\)\s*=>\s*(?:null|undefined)\s*\)/g))
console.log("EMPTY_RET", count(/catch \{\n\s*return (?:\[\]|\{\}|""|0|false)\n\s*\}/g))
console.log("DEBUG_CATCH", count(/catch \(\w+\) \{\n(?:\s*\/\/[^\n]*\n)*\s*logger\.debug\(/g))
console.log("DEBUG_PROMISE", count(/\.catch\(\s*\(?\w*\)?\s*=>\s*\{?\s*logger\.debug\(/g))
console.log("SLEEP", count(/new Promise\(\s*\(?(?:r|res|resolve)\w*\)?\s*=>\s*setTimeout\(/g))
console.log("STRINGIFY", countLine(/(?:writeFileSync|writeFile|Bun\.write)\([^\n]*JSON\.stringify/, /atomic|tmp/))
