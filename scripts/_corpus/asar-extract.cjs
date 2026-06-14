// Minimal asar extractor (canonical Pickle layout). Skips node_modules.
// Layout: [0,8) outer pickle -> headerSize at LE(4). headerBuf[0,4)=pickle
// payload size, [4,8)=json string length, [8,8+len)=JSON. Data base = 8+headerSize.
const fs = require("fs"), path = require("path")
const [,, archive, dest] = process.argv
const fd = fs.openSync(archive, "r")
const head8 = Buffer.alloc(8); fs.readSync(fd, head8, 0, 8, 0)
const headerSize = head8.readUInt32LE(4)
const hbuf = Buffer.alloc(headerSize); fs.readSync(fd, hbuf, 0, headerSize, 8)
const jsonLen = hbuf.readUInt32LE(4)
const header = JSON.parse(hbuf.toString("utf8", 8, 8 + jsonLen))
const base = 8 + headerSize
let nFiles = 0, nBytes = 0, nSkipped = 0
function walk(node, rel) {
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, rel ? rel + "/" + name : name); return }
  if (typeof node.offset === "string") {
    if (rel.split("/").includes("node_modules")) { nSkipped++; return }
    const out = path.join(dest, rel)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const b = Buffer.alloc(node.size)
    if (node.size > 0) fs.readSync(fd, b, 0, node.size, base + parseInt(node.offset, 10))
    fs.writeFileSync(out, b)
    nFiles++; nBytes += node.size
  }
}
walk(header, "")
console.log(`extracted ${nFiles} files, ${(nBytes/1e6).toFixed(1)} MB (node_modules skipped: ${nSkipped})`)
