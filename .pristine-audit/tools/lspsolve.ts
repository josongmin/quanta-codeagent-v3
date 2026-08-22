import { lspNavProvider, __resetSharedPyrightSessionsForTest } from "@/agent/lsp-bridge"
const REPO=`${process.env.HOME}/swe-bench-repos/django`
const ac=new AbortController()
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
// (instance, 심볼, 그 심볼을 import하는 파일에서 usage 찾기)
const targets=[
  ["13315 Exists","Exists","django/db/models/sql/where.py"],
  ["13315 OuterRef","OuterRef","django/db/models/sql/subqueries.py"],
  ["12325 FieldDoesNotExist","FieldDoesNotExist","django/db/models/base.py"],
  ["13297 lazy","lazy","django/template/defaultfilters.py"],
]
for(const [name,sym,file] of targets){
  const F=`${REPO}/${file}`
  const sess=await lspNavProvider().open(F, REPO, ac.signal)
  if(!sess){console.log(`${name}: no session`);continue}
  const lines=(await Bun.file(F).text()).split("\n")
  // usage: sym( 또는 sym, 가 본문에 (import 라인 제외) 나오는 곳
  let ln=-1,col=-1
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    if(line===undefined) continue
    if(/^\s*(from|import)\s/.test(line))continue
    const c=line.search(new RegExp(`\\b${sym}\\b`)); if(c>=0){ln=i;col=c;break}
  }
  if(ln<0){console.log(`${name}: usage 못찾음`);await sess.stop();continue}
  let res="null"
  for(let i=0;i<5;i++){ const d=await sess.definition(F,{line:ln,character:col},ac.signal).catch(()=>null)
    if(d&&d.length){res="✅ "+d.map((x:any)=>x.uri.split('/django/').pop()+':L'+((x.range?.start?.line??-1)+1)).join(',');break}
    await sleep(600) }
  console.log(`${name} @${file}:${ln+1} → ${res}`)
  await sess.stop(); await __resetSharedPyrightSessionsForTest()
}
