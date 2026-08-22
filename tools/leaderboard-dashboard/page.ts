/**
 * BFND-03 — the dashboard PAGE: the exact HTML byte-string the browser receives.
 *
 * Extracted verbatim from `server.ts` so the shipped artifact is IMPORTABLE.
 * `server.ts` calls `Bun.serve` at import, so no test could ever observe the page
 * it actually serves; every "does the page ship X" rail had to re-assemble the
 * concatenation itself, which meant deleting a suite's client wiring left every
 * test green. Here the page is a pure function of its inputs, so a rail can bind
 * the REAL artifact.
 *
 * The shell names no benchmark suite. Each suite's style + script arrive through
 * the projector registry (`suiteClientAssets`), and the shell dispatches on the
 * `SUITE_VIEWS` registrations those bundles make.
 */
import { FAMILY_CARDS_SCRIPT } from "./page-family-cards"
import { suiteClientAssets } from "./projectors/registry"

export interface DashboardPageOpts {
  /** Port of the live-trace receiver the page’s trace tab iframes. */
  readonly tracePort: number
}

/** Render the dashboard page. Pure: same inputs + same registered suites ⇒ same bytes. */
export const renderDashboardPage = (opts: DashboardPageOpts): string => /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SWE-bench Leaderboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { padding: 14px 18px; border-bottom: 1px solid #21262d; display: flex;
           align-items: baseline; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; color: #e6edf3; }
  .muted { color: #768390; }
  /* RFC jun-29 R4 dataset-family chips — pro/live are visually fenced off from verified. */
  .fam { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10px;
         font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
         vertical-align: 1px; border: 1px solid transparent; }
  .fam-pro { background: #3a2d12; color: #e3b341; border-color: #5c4516; }
  .fam-live { background: #122a3a; color: #58a6ff; border-color: #1f4a6b; }
${suiteClientAssets().style}
  /* top-level benchmark selector */
  .benchsel { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .benchsel button { background: #161b22; color: #adbac7; border: 1px solid #30363d;
    border-radius: 999px; padding: 6px 16px; cursor: pointer; font: inherit; font-size: 13px; }
  .benchsel button:hover { border-color: #388bfd; color: #e6edf3; }
  .benchsel button.active { background: #1f6feb; color: #fff; border-color: #2f81f7; font-weight: 600; }
  .benchsel button .bn { font-size: 10px; color: inherit; opacity: .75; margin-left: 6px; }
  /* C-D: the badge's coverage, printed BESIDE the pair it qualifies. */
  .benchsel button .bn i.cov { font-style: normal; opacity: .7; margin-left: 4px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; padding: 12px 18px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px;
          padding: 10px 14px; min-width: 120px; }
  .card .n { font-size: 22px; color: #e6edf3; }
  .card .l { color: #768390; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  nav { display: flex; gap: 6px; padding: 0 18px; border-bottom: 1px solid #21262d; }
  nav button { background: none; border: none; color: #768390; padding: 8px 12px;
               cursor: pointer; border-bottom: 2px solid transparent; font: inherit; }
  nav button.active { color: #e6edf3; border-bottom-color: #2f81f7; }
  .wrap { padding: 14px 18px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 3px 7px; text-align: center; border-bottom: 1px solid #1b212a; white-space: nowrap; }
  th { position: sticky; top: 0; background: #0d1117; color: #768390; font-weight: 600;
       cursor: pointer; user-select: none; }
  td.inst { text-align: left; color: #adbac7; }
  td.q-yes { color: #3fb950; font-weight: 700; }
  td.q-no { color: #f85149; font-weight: 700; }
  td.profile { white-space: normal; max-width: 180px; text-align: left; font-size: 11px; line-height: 1.5; }
  .yes { color: #2ea043; }
  .no { color: #30363d; }
  tr:hover td { background: #11161d; }
  .tier-E { color: #3fb950; } .tier-M { color: #d29922; }
  .tier-H { color: #f85149; } .tier-x { color: #8b949e; }
  .controls { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  input, select { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
                  border-radius: 6px; padding: 5px 8px; font: inherit; }
  .pill { padding: 1px 6px; border-radius: 10px; font-size: 11px; background: #21262d; color: #adbac7; }
  .bar { height: 7px; background: #21262d; border-radius: 4px; overflow: hidden; display: inline-block; width: 90px; vertical-align: middle; }
  .bar > i { display: block; height: 100%; background: #2f81f7; }
  .live { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
  .live pre { white-space: pre-wrap; color: #768390; margin: 4px 0 0; font-size: 11px; }
  pre.ora { white-space: pre-wrap; max-height: 360px; overflow: auto; background: #0d1117;
            border: 1px solid #21262d; border-radius: 6px; padding: 8px; margin: 4px 0; font-size: 11px; }
  details summary { cursor: pointer; padding: 3px 0; }
  tr.mrow { cursor: pointer; }
  .kbtn { background: #161b22; color: #adbac7; border: 1px solid #30363d; border-radius: 6px;
          padding: 5px 10px; cursor: pointer; font: inherit; }
  .kbtn.active { background: #1f6feb33; color: #e6edf3; border-color: #2f81f7; }
  a { color: #2f81f7; text-decoration: none; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(1,4,9,.7);
                   z-index: 50; align-items: flex-start; justify-content: center; padding: 40px 16px; }
  .modal-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
               width: min(960px, 100%); max-height: 86vh; overflow: auto; padding: 16px 20px;
               box-shadow: 0 12px 48px rgba(0,0,0,.5); }
  .modal-head { display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; position: sticky; top: -16px; background: #161b22; padding: 4px 0; }
  .modal-head h3 { margin: 0; font-size: 14px; }
  .modal-close { background: #21262d; color: #adbac7; border: 1px solid #30363d; border-radius: 6px;
                 cursor: pointer; font-size: 14px; line-height: 1; padding: 4px 9px; }
  .modal-close:hover { background: #30363d; color: #e6edf3; }
  /* 🛠 관리 tab form */
  .mng-l { display: block; font-size: 11px; color: #768390; margin-bottom: 8px; }
  .mng-l input[type=text], .mng-l select { display: block; width: 100%; margin-top: 3px;
            background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
            padding: 5px 7px; font: inherit; }
  .mng-l.mng-cb { display: flex; align-items: center; gap: 6px; }
  .mng-l.mng-cb input { margin: 0; }
  .mng-btn { background: #1f6feb; color: #fff; border: 1px solid #2f81f7; border-radius: 6px;
             padding: 6px 14px; cursor: pointer; font: inherit; margin-top: 4px; }
  .mng-btn:hover { background: #388bfd; }
  .mng-stop { background: #4d1f1f; border-color: #6b2222; color: #ffb4ab; }
  .mng-stop:hover { background: #6b2222; }
</style>
</head>
<body>
<header>
  <h1 id="h1title">SWE-bench Verified — Leaderboard</h1>
  <span class="muted" id="stamp"></span>
  <span class="muted">auto-refresh <span id="cd">5</span>s</span>
</header>
<div class="benchsel" id="benchsel"></div>
<div class="cards" id="cards"></div>
<nav>
  <button data-tab="matrix" class="active">전체 문제 매트릭스</button>
  <button data-tab="runs">우리 런</button>
  <button data-tab="scaffolds">경쟁 스캐폴드</button>
  <button data-tab="knobs">Knob / 프로필</button>
  <button data-tab="live">라이브</button>
  <button data-tab="trace">🔭 트레이스</button>
  <button data-tab="manage">🛠 관리</button>
</nav>
<div class="wrap" id="view"></div>
<div class="modal-overlay" id="modal">
  <div class="modal-box" id="modal-box">
    <div class="modal-head"><h3 id="modal-title"></h3><button class="modal-close" id="modal-close">✕ 닫기</button></div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
let DATA = null, TAB = "matrix", SORT = { key: "hash", dir: -1 };
// Active benchmark VIEW id. Scopes cards/matrix to one benchmark; default
// verified = byte-identical to the pre-multi-benchmark single view.
let BENCH = "verified";
// BFND-03 — suite id → its render hooks. Each suite's client bundle registers
// itself here; the shell below dispatches through it and names no suite itself.
var SUITE_VIEWS = {};
const TRACE_PORT = ${opts.tracePort};
const SCAF_SHOW = ["sonar-o45","trae-dbo","OH-o45","live-gem3","prom-gpt5","mini-o45"];
const SCAF_LABEL = { "sonar-o45":"Sonar", "trae-dbo":"Trae", "OH-o45":"OpenHands", "live-gem3":"Live-SWE", "prom-gpt5":"Prometheus", "mini-o45":"mini+Opus4.5" };
// HTML-escape covering & < > " ' — & MUST be replaced first so we never
// double-escape (turning a later &lt; into &amp;lt;). Used for BOTH text and
// attribute contexts (title="...", data-...), which is why ' and " are both here.
function esc(s){ return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

// Which SUITE the active view belongs to, off the registry-built benchmark list.
// An unknown/absent view falls back to the page's default (SWE) shell.
function suiteOfView(id){
  var bs = (DATA && DATA.benchmarks) || [];
  for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return bs[i].suite;
  return "swe-bench";
}
// The active view's registered render hooks, or null for the default shell.
function suiteView(){ return SUITE_VIEWS[suiteOfView(BENCH)] || null; }

${suiteClientAssets().script}

async function poll() {
  try {
    const r = await fetch("/api/data");
    DATA = await r.json();
    render();
  } catch (e) { document.getElementById("stamp").textContent = "fetch error: " + e; }
}

function tierClass(t){ return "tier-" + (t === "×" ? "x" : t); }
// Wall-clock of the winning run, compact: 47s / 6.1m / 1.3h.
function fmtDur(ms){
  if (!ms || ms <= 0) return "";
  var s = ms/1000;
  if (s < 90) return Math.round(s) + "s";
  var m = s/60;
  if (m < 90) return (m < 10 ? m.toFixed(1) : Math.round(m)) + "m";
  return (m/60).toFixed(1) + "h";
}
// WHEN it was solved — relative if recent, else M/D HH:MM (local).
function fmtWhen(ms){
  if (!ms || ms <= 0) return "";
  var d = new Date(ms), now = Date.now(), age = (now - ms)/1000;
  if (age < 3600) return Math.max(1, Math.round(age/60)) + "분 전";
  if (age < 86400) return Math.round(age/3600) + "시간 전";
  var p = function(n){ return (n<10?"0":"")+n; };
  return (d.getMonth()+1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function render() {
  if (!DATA) return;
  document.getElementById("stamp").textContent = "as of " + new Date(DATA.generatedAt).toLocaleTimeString();
  renderBenchSel();
  document.getElementById("h1title").textContent = benchLabel(BENCH) + " — Leaderboard";
  renderCards();
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === TAB));
  const v = document.getElementById("view");
  if (TAB === "runs") v.innerHTML = renderRuns();
  else if (TAB === "matrix") {
    // A suite with its own matrix mirrors the SWE shell/body split below: on a background
    // refresh (or a keystroke) only the table body redraws, so the search box keeps focus
    // + cursor (P3-D focus-loss fix).
    var svm = suiteView();
    if (svm && svm.matrix) {
      if (document.getElementById(svm.matrix.tableId)) svm.matrix.draw();
      else svm.matrix.shell(v);
    }
    // A FAMILY-scoped fold — never the verified matrix under another family's title (P3-D
    // mislabel fix). A family that registered its own view renders it; the rest get the fold.
    else if (BENCH !== "verified") { var fvm = famView(); if (fvm && fvm.matrix) fvm.matrix(v); else renderFamMatrix(v); }
    // On a background refresh, only redraw the table body so the search box
    // keeps focus and scroll position; full rebuild only on first open.
    else if (document.getElementById("mtable")) drawMatrix();
    else renderMatrix(v);
  }
  else if (TAB === "scaffolds") v.innerHTML = renderScaffolds();
  else if (TAB === "knobs") renderKnobs(v);
  else if (TAB === "trace") { if (!document.getElementById("trace-frame")) v.innerHTML = renderTrace(); }
  else if (TAB === "manage") { if (!document.getElementById("mng")) { v.innerHTML = renderManage(); mngInit(); } }
  else v.innerHTML = renderLive();
}

let KNOBS = null, KNOB_VIEW = "matrix";
async function renderKnobs(v) {
  if (!KNOBS) {
    v.innerHTML = '<p class="muted">knob 카탈로그 불러오는 중…</p>';
    try { KNOBS = await (await fetch("/api/knobs")).json(); }
    catch (e) { v.innerHTML = '<p class="q-no">카탈로그 로드 실패</p>'; return; }
  }
  if (KNOBS.missing) {
    v.innerHTML = '<p class="muted">knob-catalog.json 없음 — 생성: <code>bun run tools/leaderboard-dashboard/gen-knob-catalog.ts</code></p>';
    return;
  }
  drawKnobs(v);
}

const kesc = s => esc(s);

function knobGroups() {
  const K = KNOBS, groups = {};
  for (const id of Object.keys(K.knobs)) { const g = K.knobs[id].group || '기타'; (groups[g] ??= []).push(id); }
  const order = ["localize","hint","verify","select","repair","patch","structure","exec","기타"].filter(g => groups[g]);
  return { groups, order };
}

function showModal(title, html) {
  document.getElementById("modal-title").textContent = title;
  const body = document.getElementById("modal-body");
  body.innerHTML = html;
  document.getElementById("modal").style.display = "flex";
  // Cross-links inside the modal (preset ⇄ knob) via data attrs — no inline JS.
  body.querySelectorAll(".pjump").forEach(e => e.onclick = () => showPresetModal(e.dataset.p));
  body.querySelectorAll(".kjump").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
}

// Full detail for one knob — every field we have.
function showKnobModal(id) {
  const k = KNOBS.knobs[id]; if (!k) return;
  const gl = (KNOBS.groupLabels||{})[k.group] || k.group;
  let h = '<div style="margin-bottom:8px">'+kesc(k.desc)+'</div>';
  h += '<table style="margin-bottom:10px"><tbody>'+
    row("그룹", gl) + row("env 변수", k.envKey||'—') + row("단위", k.unit||'—') +
    row("상대 비용", k.cost!=null ? ('×'+k.cost+(k.cost>=10?' ⚠️ 비쌈':'')) : '—') +
    row("충돌(conflicts)", (k.conflicts&&k.conflicts.length)?k.conflicts.join(', '):'—') +
    row("출처", k.source||'—') +
    row("적용 경로", k.inRegistry?'framework 레지스트리 (knob.apply)':'bench 드라이버 (benchPostureFromState)') +
    '</tbody></table>';
  h += '<h3 style="font-size:12px;color:#768390;margin:10px 0 4px">이 knob을 쓰는 프로필 ('+k.usedBy.length+')</h3>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">프로필</th><th>값</th></tr></thead><tbody>';
  for (const u of k.usedBy) h += '<tr><td class="inst pjump" data-p="'+u.preset+'" style="cursor:pointer">'+u.preset+'</td><td><span class="q-yes">'+kesc(u.value)+'</span></td></tr>';
  h += '</tbody></table>';
  showModal('🎛 ' + id, h);
}
function row(k, v) { return '<tr><td class="muted" style="text-align:left;padding-right:14px">'+k+'</td><td style="text-align:left">'+kesc(v)+'</td></tr>'; }

// Full detail for one preset — rationale + every knob it sets, with descriptions.
function showPresetModal(name) {
  const p = KNOBS.presets[name]; if (!p) return;
  let h = '';
  if (p.desc) h += '<div style="margin-bottom:10px;line-height:1.6">'+kesc(p.desc)+'</div>';
  h += '<div class="muted" style="font-size:11px;margin-bottom:6px">'+p.knobCount+' knob 설정</div>';
  const { groups, order } = knobGroups();
  h += '<table><thead><tr><th class="inst" style="text-align:left">knob</th><th>값</th><th style="text-align:left">설명</th></tr></thead><tbody>';
  for (const g of order) for (const id of groups[g]) {
    if (!(id in p.knobs)) continue;
    const k = KNOBS.knobs[id];
    h += '<tr><td class="inst kjump" data-id="'+id+'" style="cursor:pointer">'+id+'</td>'+
      '<td><span class="q-yes">'+kesc(p.knobs[id])+'</span></td>'+
      '<td style="text-align:left;font-size:11px" class="muted">'+kesc(k?k.desc:'')+'</td></tr>';
  }
  h += '</tbody></table>';
  showModal('🧩 프로필 · ' + name, h);
}

function drawKnobs(v) {
  const K = KNOBS;
  const { groups, order: groupOrder } = knobGroups();
  const presets = K.presetOrder.filter(p => K.presets[p] && K.presets[p].knobCount); // drop empty (baseline)

  let h = '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">'+
    '<button class="kbtn" data-kv="matrix">프로필 × Knob 매트릭스</button>'+
    '<button class="kbtn" data-kv="presets">프로필 카드</button>'+
    '<button class="kbtn" data-kv="glossary">Knob 사전</button>'+
    '<span class="muted" style="font-size:11px">'+presets.length+' 프로필 · '+Object.keys(K.knobs).length+' knob · 행/헤더 클릭=상세 · 값(1=켜짐 / off / 숫자=깊이·예산·후보수)</span></div>';

  if (KNOB_VIEW === "matrix") {
    h += '<div style="overflow:auto;max-height:75vh"><table><thead><tr><th class="inst" style="text-align:left;position:sticky;left:0;top:0;z-index:3;background:#0d1117">프로필</th>';
    for (const g of groupOrder) for (const id of groups[g])
      h += '<th class="kh" data-id="'+id+'" title="'+kesc(K.knobs[id].desc)+'" style="cursor:pointer;writing-mode:vertical-rl;transform:rotate(180deg);height:150px;font-size:10px;white-space:nowrap">'+id+'</th>';
    h += '</tr></thead><tbody>';
    for (const p of presets) {
      const kv = K.presets[p].knobs;
      h += '<tr><td class="inst kp" data-p="'+p+'" style="cursor:pointer;position:sticky;left:0;background:#0d1117">'+p+'</td>';
      for (const g of groupOrder) for (const id of groups[g]) {
        const val = kv[id];
        const cell = val==null ? '<span class="no">·</span>'
          : (val==="off" ? '<span class="q-no" style="font-size:10px">off</span>'
            : '<span class="q-yes">'+kesc(val)+'</span>');
        h += '<td>'+cell+'</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div>';
  } else if (KNOB_VIEW === "presets") {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">';
    for (const p of presets) {
      const P = K.presets[p];
      const tags = Object.keys(P.knobs).slice(0,99).map(id => '<span class="pill" style="margin:1px">'+id+(P.knobs[id]!=="1"?'='+kesc(P.knobs[id]):'')+'</span>').join(' ');
      h += '<div class="card kp" data-p="'+p+'" style="cursor:pointer;display:block;min-width:0">'+
        '<div style="color:#e6edf3;font-weight:700;margin-bottom:3px">'+p+' <span class="muted" style="font-weight:400;font-size:10px">'+P.knobCount+' knob</span></div>'+
        (P.desc?'<div class="muted" style="font-size:10px;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'+kesc(P.desc)+'</div>':'')+
        '<div style="font-size:10px;line-height:1.9">'+tags+'</div></div>';
    }
    h += '</div>';
  } else {
    for (const g of groupOrder) {
      const gl = (K.groupLabels||{})[g] || g;
      h += '<h3 style="margin:14px 0 6px;color:#e6edf3;font-size:13px">'+gl+'</h3>';
      h += '<table><thead><tr><th class="inst" style="text-align:left">knob</th><th style="text-align:left">설명</th><th>비용</th><th>env</th><th>출처</th><th>프로필</th></tr></thead><tbody>';
      for (const id of groups[g]) {
        const k = K.knobs[id];
        h += '<tr class="kg" data-id="'+id+'" style="cursor:pointer"><td class="inst">'+id+(k.unit?' <span class="muted" style="font-size:10px">'+kesc(k.unit)+'</span>':'')+
          (k.inRegistry?'':' <span class="pill" title="bench 드라이버가 적용(레지스트리 외)">drv</span>')+'</td>'+
          '<td style="text-align:left">'+kesc(k.desc)+'</td>'+
          '<td class="'+(k.cost>=10?'q-no':'muted')+'" style="font-size:10px">'+(k.cost!=null?'×'+k.cost:'—')+'</td>'+
          '<td class="muted" style="font-size:10px">'+kesc(k.envKey||'—')+'</td>'+
          '<td class="muted" style="font-size:10px">'+kesc(k.source||'—')+'</td>'+
          '<td class="muted">'+k.usedBy.length+'</td></tr>';
      }
      h += '</tbody></table>';
    }
  }
  v.innerHTML = h;
  v.querySelectorAll(".kbtn").forEach(b => {
    b.classList.toggle("active", b.dataset.kv === KNOB_VIEW);
    b.onclick = () => { KNOB_VIEW = b.dataset.kv; drawKnobs(v); };
  });
  v.querySelectorAll(".kh").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
  v.querySelectorAll(".kg").forEach(e => e.onclick = () => showKnobModal(e.dataset.id));
  v.querySelectorAll(".kp").forEach(e => e.onclick = () => showPresetModal(e.dataset.p));
}

// ── top-level benchmark selector (suite-agnostic) ───────────────────────────
function benchLabel(id) {
  const bs = (DATA && DATA.benchmarks) || [];
  for (const b of bs) if (b.id === id) return b.label;
  return id === "verified" ? "SWE-bench Verified" : id;
}
function renderBenchSel() {
  const el = document.getElementById("benchsel");
  const bs = (DATA && DATA.benchmarks) || [{ id: "verified", label: "SWE-bench Verified" }];
  // one solved/total badge per benchmark so the selector doubles as a scoreboard.
  const badge = function(id) {
    const camps = (DATA.campaigns || []).filter(c => c.viewId === id);
    if (!camps.length) return "";
    const best = camps.slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
    // C-D: the badge is a scoreboard, so it prints a rate — and therefore its
    // coverage. resolved/assigned can only understate, but "8/16 with 8 of 16
    // validly graded" and "8/16 with 16 of 16" are different claims.
    if (!best) return "";
    var cov = best.coverage ? '<i class="cov" title="공식 채점 커버리지 = grading_valid/assigned">'+esc(best.coverage)+'</i>' : "";
    return '<span class="bn">'+best.resolved+'/'+best.total+cov+'</span>';
  };
  el.innerHTML = bs.map(b =>
    '<button data-bench="'+esc(b.id)+'" class="'+(BENCH===b.id?"active":"")+'">'+esc(b.label)+badge(b.id)+'</button>'
  ).join("");
  el.querySelectorAll("button").forEach(function(btn){
    btn.onclick = function(){ BENCH = btn.dataset.bench; TAB = (TAB==="knobs"||TAB==="trace"||TAB==="manage")?TAB:"matrix"; render(); };
  });
}
${FAMILY_CARDS_SCRIPT}

function renderCards() {
  // A suite that owns its own cards renders them; otherwise the SWE shell decides.
  var svc = suiteView();
  if (svc && svc.cards) return svc.cards();
  if (BENCH !== "verified") { var fvc = famView(); return (fvc && fvc.cards) ? fvc.cards() : renderFamCards(); }
  const q = DATA.quanta;
  const ids = Object.keys(q);
  const solved = ids.filter(i => q[i].passed).length;
  const ran = ids.length;
  // ceiling-adjusted: drop instances no public submission solved (#<=1).
  // FLAG-C: also drop re-runnable measurement-holes (throttle/infra/env) — a
  // 429 on a frontier-solved problem is NOT a capability gap, it's unmeasured.
  let realMiss = 0, ceilMiss = 0, unmeasured = 0;
  for (const id of ids) {
    if (q[id].passed) continue;
    const f = q[id].fail;
    if (f && f.reRunnable) { unmeasured++; continue; }
    const row = DATA.rows[id];
    if (row && row.hash <= 1) ceilMiss++; else realMiss++;
  }
  const cards = withRefusedCard([
    ["해결 / 실행", solved + " / " + ran, DATA.coverage ? "데이터셋 "+DATA.coverage.datasetTotal : ""],
    ["천장보정 점수", solved + " / " + (solved + realMiss), "ceiling("+ceilMiss+") · 미측정("+unmeasured+") 제외"],
    ["진짜 격차", realMiss, "프론티어는 푸는데 미스 · 미측정("+unmeasured+") 제외"],
    bestCampaignCard(DATA.campaigns, ""),
    ["리포트 파일", DATA.runs.length, (DATA.campaigns||[]).length+" 캠페인"],
    ["라이브 박스", DATA.live.length],
  ]);
  document.getElementById("cards").innerHTML = cards.map(c =>
    '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
    (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>').join("");
}

// RFC jun-29 R4: dataset family is a partition, not a flavor — a pro resolved-rate must
// never sit in the same row-space as a verified one without a label. verified shows no
// chip (byte-identical to the legacy look); pro/live get a colored chip.
var FAM_FILTER = "";
function famChip(fam) {
  if (!fam || fam === "verified") return "";
  return '<span class="fam fam-'+esc(fam)+'">'+esc(fam)+'</span> ';
}
// RFC jun-29: our datasetFamily → external (dataset,set) we're measured against.
// verified ⇒ null (its own surface; byte-identical, no external column). Mirrors the
// unit-tested externalCoordFor in external-comparison.ts (kept in sync there).
function extCoordFor(fam) {
  if (fam === "pro") return { dataset: "pro", sets: ["public-731"] };
  if (fam === "live") return { dataset: "live", sets: ["verified", "lite"] };
  return null;
}
// Top external model for a family from DATA.externalBaselines, or null. Defensive:
// missing/empty baselines ⇒ null (the column shows —, never crashes).
function extSotaForFamily(fam) {
  var b = DATA.externalBaselines;
  if (!b || !Array.isArray(b.models)) return null;
  var coord = extCoordFor(fam);
  if (!coord) return null;
  for (var si = 0; si < coord.sets.length; si++) {
    var set = coord.sets[si];
    var top = null;
    for (var i = 0; i < b.models.length; i++) {
      var m = b.models[i];
      if (m.dataset !== coord.dataset || m.set !== set) continue;
      if (top === null || m.rate > top.rate) top = m;
    }
    if (top) return top;
  }
  return null;
}
function renderRuns() {
  // Campaigns roll shards up into one logical run (clean-shard×6 → SOTA-clean).
  // The runs tab lists ALL families with a chip + optional per-family FAM_FILTER; the
  // top-level BENCH selector governs the matrix/cards/scaffolds tabs (benchmark-scoped
  // views), NOT this flat list — so a mixed pro+live+verified run history stays visible.
  let camps = (DATA.campaigns||[]).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)));
  if (FAM_FILTER) camps = camps.filter(c => c.viewId === FAM_FILTER);
  let h = '<p class="muted">샤드는 한 캠페인으로 묶음. 행 펼치면 멤버 리포트. 해결률 분모는 측정된 시도만(throttle/인프라/env=미측정 제외).</p>';
  // External SOTA column only when a non-verified (pro/live) campaign is in view AND
  // baselines loaded — keeps an all-verified dashboard byte-identical (no ext column,
  // no external-baselines references rendered).
  const showExt = !!DATA.externalBaselines &&
    camps.some(c => { const f = c.datasetFamily; return (f === "pro" || f === "live") && !!extSotaForFamily(f); });
  const extHead = showExt ? '<th title="이 데이터셋의 공개 외부 SOTA 해결률 (pro=public-731 · live=verified/lite) — 우리 % 옆에 나란히 (R4: verified는 비교 안 함)">외부 SOTA</th>' : '';
  h += '<table><thead><tr><th class="inst" style="text-align:left">캠페인</th><th>모델</th><th>preset</th><th>멤버</th><th>해결</th><th title="공식 채점 캠페인은 resolved/assigned(raw) — 옆의 cov가 유효 분모 손실">%</th>'+extHead+'<th title="throttle/인프라/env로 측정 못해 분모서 제외 — 재런 대상">미측정</th><th>갱신</th></tr></thead><tbody>';
  for (const r of camps) {
    const pct = r.total ? Math.round(100*r.resolved/r.total) : 0;
    const unmeasured = r.unmeasured || 0;
    let extCell = '';
    if (showExt) {
      const fam = r.datasetFamily;
      const top = (fam === "pro" || fam === "live") ? extSotaForFamily(fam) : null;
      // External names + set come from external JSON → esc() at this HTML boundary.
      extCell = top
        ? '<td class="muted" title="'+esc(top.name)+' · '+esc(top.set)+' · '+top.resolved+'/'+top.total+'">ext SOTA '+Math.round(100*top.rate)+'% <span style="font-size:10px">('+esc(top.name)+')</span></td>'
        : '<td class="muted">—</td>';
    }
    h += '<tr><td class="inst" title="'+esc(r.members.join(", "))+'">'+famChip(r.datasetFamily)+esc(r.key)+'</td><td class="muted">'+esc(r.model)+'</td><td class="muted">'+esc(r.preset)+'</td>'+
      '<td class="muted">'+r.members.length+'</td>'+
      '<td>'+r.resolved+'/'+r.total+'</td>'+
      '<td><span class="bar"><i style="width:'+pct+'%"></i></span> '+pct+'%'+(r.coverage? ' <span class="muted" style="font-size:10px" title="공식 채점 커버리지 = grading_valid/assigned. 분모가 줄어든 만큼 여기 보인다">cov '+esc(r.coverage)+'</span>':'')+'</td>'+
      extCell+
      '<td class="muted" title="재런 가능한 측정 구멍 — 해결률 분모서 제외됨">'+(unmeasured? '⟳ '+unmeasured : '·')+'</td>'+
      '<td class="muted">'+ (r.mtime? new Date(r.mtime).toLocaleString() : '—') +'</td></tr>';
  }
  return h + '</tbody></table>';
}

function renderMatrix(v) {
  v.innerHTML = \`
    <div class="controls">
      <input id="search" placeholder="instance 검색…" value="\${MATRIX_FILTER.q}" />
      <select id="filter">
        <option value="all">전체</option>
        <option value="ran">우리가 돌린 것</option>
        <option value="solved">우리 해결</option>
        <option value="missed">우리 미스</option>
        <option value="gap">진짜 격차(미스 & #>1)</option>
        <option value="ceiling">천장(#≤1)</option>
      </select>
      <select id="repo"><option value="">모든 repo</option></select>
      <span class="muted" id="mcount"></span>
    </div>
    <div class="muted" style="font-size:11px;margin-bottom:8px;line-height:1.7">
      ❌ 실패분류 —
      <b>패치햇는데틀림</b>: 패치 채점됐으나 타겟테스트(FAIL_TO_PASS) 여전히 실패 ·
      <b>기존테스트깸</b>: 패치가 PASS_TO_PASS 깨뜨림(regression) ·
      <b>게이트차단</b>: admission 게이트가 패치 막음(채점 못감) ·
      <b>패치생성실패</b>: 모델이 쓸 패치 못만듦 ·
      <b>채점/실행에러</b>: 인프라 에러(모델탓 아님) ·
      <b>타임아웃</b> · <b>미제출(불명)</b>
      &nbsp;|&nbsp; preset <b>*</b> = 파일경로서 추정(리포트에 미기록) · 🏆 = 경쟁사 풀이 트랜스크립트 보유(4개뿐)
    </div>
    \${DATA.externalBaselines ? '<div class="muted" style="font-size:11px;margin-bottom:8px;line-height:1.7">해결가능성 — <span class="pill" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">ext✓</span> 외부 모델이 푼 인스턴스(provably solvable → 우리 미스는 진짜 격차) · <span class="pill" style="background:#5a1e1e;color:#f0a0a0;font-size:10px">⚠ verifier-broken</span> gold 패치가 verifier 통과 못함 → 모델 미스 아님(제외)</div>' : ''}
    <div id="mtable"></div>\`;
  const sel = v.querySelector("#filter"); sel.value = MATRIX_FILTER.kind;
  const repoSel = v.querySelector("#repo");
  const repos = [...new Set(Object.values(DATA.rows).map(r=>r.repo))].sort();
  repoSel.innerHTML = '<option value="">모든 repo</option>' + repos.map(r=>'<option>'+r+'</option>').join("");
  repoSel.value = MATRIX_FILTER.repo;
  v.querySelector("#search").oninput = e => { MATRIX_FILTER.q = e.target.value; drawMatrix(); };
  sel.onchange = e => { MATRIX_FILTER.kind = e.target.value; drawMatrix(); };
  repoSel.onchange = e => { MATRIX_FILTER.repo = e.target.value; drawMatrix(); };
  drawMatrix();
}

const MATRIX_FILTER = { q: "", kind: "all", repo: "" };
const ORACLE_CACHE = {};

function oracleHtml(o) {
  if (o.error) return '<span class="muted">' + o.error + '</span>';
  // Our verdict + failure reason (from the merged run records).
  const me = (DATA.quanta||{})[o.id];
  let verdict = '';
  if (me && me.passed) {
    verdict = '<div style="margin-bottom:6px;color:#3fb950">✅ 우리 해결 — '+me.passes+'/'+me.attempts+'회'+
      (me.bestTurns?', 최소 '+me.bestTurns+'턴':'')+(fmtDur(me.passDurationMs)?', ⏱ '+fmtDur(me.passDurationMs):'')+(fmtWhen(me.passMtime)?', 📅 '+fmtWhen(me.passMtime):'')+(me.passPreset?' · '+esc(me.passPreset):'')+(me.passModel?' · '+esc(me.passModel):'')+'</div>';
  } else if (me) {
    const f = me.fail;
    verdict = '<div style="margin-bottom:6px;color:#f85149">❌ 우리 미해결 — 시도 '+me.attempts+'회'+(me.failTurns?', 최대 '+me.failTurns+'턴':'')+'</div>'+
      (f ? '<div style="margin-bottom:6px;font-size:11px" class="muted">실패원인: <b style="color:#e6edf3">'+esc(f.klass)+'</b>'+
        ' · 종료='+esc(f.termination)+' · FAIL_TO_PASS 실패='+f.f2p+' / PASS_TO_PASS 깨짐='+f.p2p+
        (f.repro?' · 재현테스트='+esc(f.repro):'')+'</div>' : '');
  }
  return verdict + '<div style="margin-bottom:6px">' +
      (o.github ? '<a href="'+o.github+'" target="_blank">🔗 GitHub commit ('+o.repo+')</a>  ' : '') +
      '<span class="muted">'+o.instanceId+' · '+o.difficulty+'</span></div>' +
    '<details open><summary class="muted">문제 설명</summary><pre class="ora">'+esc(o.statement)+'</pre></details>' +
    '<details><summary class="muted" style="color:#3fb950">✅ 정답(gold) 패치 — 오라클</summary><pre class="ora">'+esc(o.patch)+'</pre></details>' +
    '<details><summary class="muted">테스트 패치</summary><pre class="ora">'+esc(o.testPatch)+'</pre></details>' +
    (o.frontierTraj
      ? '<details><summary style="color:#d29922">🏆 프론티어 경쟁사 풀이 트랜스크립트 ('+o.frontierTraj.turns+'턴)</summary><pre class="ora">'+esc(o.frontierTraj.text)+'</pre></details>'
      : '');
}

async function openModal(id) {
  const overlay = document.getElementById("modal");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");
  if (!overlay || !body) return;
  title.textContent = id;
  body.innerHTML = '<span class="muted">오라클 불러오는 중…</span>';
  overlay.style.display = "flex";
  let o = ORACLE_CACHE[id];
  if (!o) {
    try { o = await (await fetch("/api/oracle?id=" + encodeURIComponent(id))).json(); ORACLE_CACHE[id] = o; }
    catch (e) { body.innerHTML = '<span class="q-no">오라클 로드 실패</span>'; return; }
  }
  // Guard against a slow fetch resolving after the user opened another row / closed.
  if (overlay.style.display === "none" || title.textContent !== id) return;
  body.innerHTML = oracleHtml(o);
}

function closeModal() {
  const overlay = document.getElementById("modal");
  if (overlay) overlay.style.display = "none";
}

// Unified row set: every instance we have ANY evidence for — competitor
// matrix ∪ SWE-bench dataset ∪ our run records. Nothing we ran disappears.
function unifiedRows() {
  const q = DATA.quanta, rows = DATA.rows, ds = DATA.dataset || {};
  const ids = new Set([...Object.keys(rows), ...Object.keys(ds), ...Object.keys(q)]);
  const out = [];
  for (const id of ids) {
    const m = rows[id] || { id, repo: id.replace(/-\\d+$/, ""), cells: {}, hash: -1, tier: "?" };
    const d = ds[id] || {};
    out.push({
      id,
      repo: m.repo,
      cells: m.cells,
      hash: m.hash,
      tier: m.tier,
      difficulty: d.difficulty || "?",
      statement: d.statement || "",
      me: q[id] || null,
    });
  }
  return out;
}

function drawMatrix() {
  let rows = unifiedRows();
  const f = MATRIX_FILTER;
  rows = rows.filter(r => {
    const me = r.me;
    if (f.repo && r.repo !== f.repo) return false;
    if (f.q && !r.id.includes(f.q)) return false;
    if (f.kind === "ran") return !!me;
    if (f.kind === "solved") return me && me.passed;
    if (f.kind === "missed") return me && !me.passed;
    if (f.kind === "gap") return me && !me.passed && r.hash > 1;
    if (f.kind === "ceiling") return r.hash >= 0 && r.hash <= 1;
    return true;
  });
  rows.sort((a,b) => {
    let av, bv;
    if (SORT.key === "hash") { av=a.hash; bv=b.hash; }
    else if (SORT.key === "inst") { av=a.id; bv=b.id; }
    else if (SORT.key === "turns") { av=(a.me&&a.me.bestTurns)||9e9; bv=(b.me&&b.me.bestTurns)||9e9; }
    else if (SORT.key === "quanta") { av=(a.me?(a.me.passed?2:1):0); bv=(b.me?(b.me.passed?2:1):0); }
    else { av=a.cells[SORT.key]?1:0; bv=b.cells[SORT.key]?1:0; }
    if (av<bv) return SORT.dir; if (av>bv) return -SORT.dir; return 0;
  });
  document.getElementById("mcount").textContent = rows.length + "개";
  let h = '<table><thead><tr>';
  h += '<th class="inst" data-k="inst" style="text-align:left">instance</th>';
  h += '<th data-k="quanta">QUANTA</th><th data-k="turns">턴</th><th title="우리가 돌린 스캐폴드 프로파일(issue-hint/repro-vote) · 모델">프로파일</th><th>난이도</th>';
  for (const s of SCAF_SHOW) h += '<th data-k="'+s+'">'+(SCAF_LABEL[s]||s)+'</th>';
  h += '<th data-k="hash" title="135개(공개 134 + mini-o45) 중 이 문제를 푼 개수 — 낮을수록 어려움. mini가 푼 행은 천장(0) 아님">해결/전체스캐폴드</th><th>tier</th></tr></thead><tbody>';
  for (const r of rows) {
    const me = r.me;
    let qcell = '<td class="muted">·</td>';
    if (me && me.passed) qcell = '<td class="q-yes" title="'+esc(me.passedBy.slice(0,8).join(", "))+'">✅<span class="muted" style="font-size:10px"> '+me.passes+'/'+me.attempts+'</span></td>';
    else if (me) {
      const fk = me.fail ? me.fail.klass : '';
      const ftitle = me.fail ? (me.fail.klass+' · '+me.fail.termination+(me.fail.repro?' · repro:'+me.fail.repro:'')+' · F2P'+me.fail.f2p+'/P2P'+me.fail.p2p) : ('시도 '+me.attempts+'회');
      qcell = '<td class="q-no" title="'+esc(ftitle)+'">❌'+(fk?' <span class="muted" style="font-size:10px">'+esc(fk)+'</span>':'')+'</td>';
    }
    // Turns: cheapest passing run, else most-effort failing run.
    const turns = me ? (me.passed ? (me.bestTurns || '?') : (me.failTurns || '')) : '';
    // Profile we ran: the winning profile on a pass, else every profile tried —
    // one per line so the column stays narrow.
    let presetCell = '<span class="muted">·</span>';
    if (me) {
      const presetsArr = me.passed && me.passPreset ? [me.passPreset] : (me.presets || []);
      const mdl = me.passed && me.passModel ? me.passModel : (me.models || []).join('/');
      const lines = presetsArr.map(esc);
      const body = lines.length ? lines.join('<br>') : '—';
      // Solve time + WHEN solved — only on a pass (the winning run).
      const dur = me.passed ? fmtDur(me.passDurationMs) : '';
      const durSpan = dur ? ' <span class="pill" title="해결 소요시간(승리 런 wall-clock)" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">⏱ '+dur+'</span>' : '';
      const when = me.passed ? fmtWhen(me.passMtime) : '';
      const whenSpan = when ? ' <span class="pill" title="해결 시각(승리 런 report 기록시점)" style="background:#1e2a3a;color:#8ab4f8;font-size:10px">📅 '+when+'</span>' : '';
      presetCell = '<span title="'+esc(presetsArr.join(' / ')+' · '+(mdl||'—'))+'">'+body+durSpan+whenSpan+
        (mdl ? '<br><span class="muted" style="font-size:10px">'+esc(mdl)+'</span>' : '')+'</span>';
    }
    const hashCell = r.hash < 0
      ? '<span class="muted">—</span>'
      : (r.hash === 0
          ? '<span title="공개 134제출 전부 실패 = 천장(데이터 누락 아님)">0 <span class="pill" style="background:#5a1e1e;color:#f0a0a0">천장</span></span>'
          : r.hash);
    const tierCell = r.tier === '?' ? '<span class="muted">—</span>' : '<span class="'+tierClass(r.tier)+'">'+r.tier+'</span>';
    const ftn = (DATA.frontierTurns||{})[r.id];
    const ftBadge = ftn ? ' <span class="pill" title="프론티어 경쟁사 풀이 턴">🏆'+ftn+'t</span>' : '';
    // SOLVABILITY markers (RFC jun-29): WHY did an instance fail?
    //  ⚠ verifier-broken — gold patch failed the verifier → NOT a model miss (excluded).
    //  ext✓ — ≥1 external model resolved it (DATA.externalBaselines.liveResolvedBy) →
    //         provably solvable, so OUR miss is a genuine capability gap.
    let solvBadge = '';
    if (me && me.goldBroken) {
      solvBadge += ' <span class="pill" title="gold 패치가 이 인스턴스 verifier를 통과 못함 → 모델 미스 아님, 해결률서 제외" style="background:#5a1e1e;color:#f0a0a0;font-size:10px">⚠ verifier-broken</span>';
    }
    const resolvers = ((DATA.externalBaselines||{}).liveResolvedBy||{})[r.id];
    if (Array.isArray(resolvers) && resolvers.length) {
      // resolver names come from external JSON → esc().
      solvBadge += ' <span class="pill" title="외부 모델이 푼 인스턴스 (provably solvable): '+esc(resolvers.slice(0,8).join(", "))+'" style="background:#1e3a2a;color:#7ee2a8;font-size:10px">ext✓'+(resolvers.length>1?' '+resolvers.length:'')+'</span>';
    }
    h += '<tr class="mrow" data-id="'+esc(r.id)+'"><td class="inst">'+esc(r.id)+
      ' <span class="dbtn" data-id="'+esc(r.id)+'" title="문제·오라클·trajectory 상세" style="cursor:pointer;color:#58a6ff;font-weight:700;padding:0 4px">ⓘ</span>'+ftBadge+solvBadge+'</td>'+qcell+
      '<td class="muted">'+turns+'</td><td class="profile muted">'+presetCell+'</td><td class="muted" style="font-size:11px">'+r.difficulty+'</td>';
    for (const s of SCAF_SHOW) h += '<td class="'+(r.cells[s]?'yes':'no')+'">'+(r.cells[s]?'✅':'·')+'</td>';
    h += '<td>'+hashCell+'</td><td>'+tierCell+'</td></tr>';
  }
  h += '</tbody></table>';
  document.getElementById("mtable").innerHTML = h;
  document.querySelectorAll("#mtable th[data-k]").forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (SORT.key === k) SORT.dir *= -1; else { SORT.key = k; SORT.dir = -1; }
    drawMatrix();
  });
  document.querySelectorAll("#mtable .dbtn").forEach(b => b.onclick = e => { e.stopPropagation(); openModal(b.dataset.id); });
}

function renderScaffolds() {
  // A suite with its own competitor scaffold set renders it; the SWE scaffold
  // summary below is the default shell's.
  var svs = suiteView();
  if (svs && svs.scaffolds) return svs.scaffolds();
  let h = '<table><thead><tr><th class="inst" style="text-align:left">스캐폴드</th><th>모델</th><th>resolved/500</th><th>%</th></tr></thead><tbody>';
  for (const s of DATA.topScaffolds) {
    h += '<tr><td class="inst">'+esc(s.key)+'</td><td class="muted">'+esc(s.model)+'</td><td>'+s.resolved+'</td>'+
      '<td><span class="bar"><i style="width:'+s.pct+'%"></i></span> '+s.pct+'%</td></tr>';
  }
  return h + '</tbody></table>';
}

function renderLive() {
  if (!DATA.live.length) return '<p class="muted">최근 6시간 내 라이브 로그 없음.</p>';
  return DATA.live.map(b =>
    '<div class="live"><b>'+esc(b.dir)+'</b> / '+esc(b.log)+
    ' <span class="pill">'+b.lines+' lines</span>'+
    (b.lastInstance? ' <span class="pill">'+esc(b.lastInstance)+'</span>':'')+
    ' <span class="muted">'+new Date(b.mtime).toLocaleTimeString()+'</span>'+
    '<pre>'+ esc(b.tail||'') +'</pre></div>'
  ).join("");
}

// Live OTEL trace waterfall (otel-trace-sink) embedded as an iframe. The frame is
// built ONCE on first switch to this tab (the render() guard skips rebuild on the
// 5s poll) so it never reloads/flickers mid-stream. Points at TRACE_PORT on the
// same host the dashboard is served from.
function renderTrace() {
  var host = location.hostname || "127.0.0.1";
  var url = "http://" + host + ":" + TRACE_PORT + "/";
  return '<div class="muted" style="padding:6px 0 10px">라이브 에이전트 트레이스 — OTLP 수신기 :' + TRACE_PORT
    + '. 벤치를 <code>QUANTA_OTEL_ENDPOINT=http://127.0.0.1:' + TRACE_PORT + '</code> 로 돌리면 워터폴이 실시간으로 찬다. '
    + '비면 싱크가 꺼진 것(대시보드가 자동 spawn하지만, 아니면 <code>quanta-bench trace</code>). '
    + '<a href="' + url + '" target="_blank" style="color:#2f81f7">↗ 새 탭</a></div>'
    + '<iframe id="trace-frame" src="' + url + '" style="width:100%;height:78vh;border:1px solid #21262d;border-radius:8px;background:#0b0e14"></iframe>';
}

// === 🛠 관리 (Manage) tab — benchmark management console =====================
// THIN client over the /api/launch · /api/running · /api/launch-log · /api/box/stop
// routes. ALL strings that reach innerHTML go through esc() (XSS): launchId, dataset,
// preset, family, box iid, log/output text. Built ONCE per tab-open (the #mng guard
// in render()); its own pollers (running 5s / log 3s) own its live state thereafter.
var MNG_DEFAULTS = {
  verified: "tools/leaderboard-dashboard/rawdata/verified-full.jsonl",
  pro: "~/.quanta/bench/datasets/pro-5.jsonl",
  live: "~/.quanta/bench/datasets/live-5.jsonl"
};
var MNG_SEL = null;          // selected launchId (console tail target)
var MNG_RUN_TIMER = null, MNG_LOG_TIMER = null;

function renderManage() {
  var presets = (KNOBS && KNOBS.presetOrder && KNOBS.presetOrder.length)
    ? KNOBS.presetOrder
    : ["agentless-v1","agentless-v3-thin-strict","baseline"];
  var presetOpts = presets.map(function(p){ return '<option value="'+esc(p)+'">'+esc(p)+'</option>'; }).join("");
  return '<div id="mng">'
    + '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">'
    // --- Run launcher ---
    + '<div class="card" style="min-width:320px;max-width:380px">'
    +   '<div class="l" style="margin-bottom:8px">런 발사</div>'
    +   '<label class="mng-l">데이터셋 패밀리'
    +     '<select id="mng-family">'
    +       '<option value="verified">verified</option>'
    +       '<option value="pro">pro</option>'
    +       '<option value="live">live</option>'
    +     '</select></label>'
    +   '<label class="mng-l">데이터셋 경로<input id="mng-dataset" type="text" value="'+esc(MNG_DEFAULTS.verified)+'"></label>'
    +   '<label class="mng-l">프리셋<select id="mng-preset">'+presetOpts+'</select></label>'
    +   '<label class="mng-l">모델<input id="mng-model" type="text" value="gpt-5.5"></label>'
    +   '<label class="mng-l">인스턴스 필터 (선택)<input id="mng-instances" type="text" placeholder="예: django__django-12345"></label>'
    +   '<label class="mng-l mng-cb"><input id="mng-ondemand" type="checkbox"> on-demand 박스 (spot 회수 없음)</label>'
    +   '<button id="mng-launch" class="mng-btn">🚀 발사</button>'
    +   '<div id="mng-launch-msg" class="muted" style="font-size:11px;margin-top:6px;min-height:14px"></div>'
    + '</div>'
    // --- Running now ---
    + '<div style="flex:1;min-width:420px">'
    +   '<div class="l" style="margin-bottom:8px">현재 실행 중</div>'
    +   '<div id="mng-box-summary" class="muted" style="font-size:11px;margin-bottom:6px"></div>'
    +   '<table style="font-size:12px"><thead><tr><th>패밀리</th><th>데이터셋</th><th>프리셋</th><th>상태</th><th>PID</th><th>경과</th></tr></thead>'
    +   '<tbody id="mng-launches"><tr><td colspan="6" class="muted">로딩…</td></tr></tbody></table>'
    +   '<div class="l" style="margin:14px 0 6px">박스</div>'
    +   '<table style="font-size:12px"><thead><tr><th>인스턴스</th><th></th></tr></thead>'
    +   '<tbody id="mng-boxes"><tr><td colspan="2" class="muted">로딩…</td></tr></tbody></table>'
    + '</div>'
    + '</div>'
    // --- Console ---
    + '<div class="l" style="margin:16px 0 6px">콘솔 <span id="mng-con-id" class="muted" style="font-size:11px"></span></div>'
    + '<pre id="mng-console" style="background:#0b0e14;border:1px solid #21262d;border-radius:8px;padding:10px;height:46vh;overflow:auto;white-space:pre-wrap;font-size:11px">런을 선택하면 로그가 여기 흐른다.</pre>'
    + '</div>';
}

function mngInit() {
  // family change → swap the dataset default (only if user hasn't typed a custom one).
  var famSel = document.getElementById("mng-family");
  var dsIn = document.getElementById("mng-dataset");
  famSel.onchange = function(){
    var def = MNG_DEFAULTS[famSel.value];
    // only auto-fill if the box still holds a known default (don't clobber edits)
    if (dsIn.value === MNG_DEFAULTS.verified || dsIn.value === MNG_DEFAULTS.pro || dsIn.value === MNG_DEFAULTS.live || dsIn.value === "")
      dsIn.value = def;
  };
  document.getElementById("mng-launch").onclick = mngLaunch;
  mngPollRunning();
  if (MNG_RUN_TIMER) clearInterval(MNG_RUN_TIMER);
  if (MNG_LOG_TIMER) clearInterval(MNG_LOG_TIMER);
  MNG_RUN_TIMER = setInterval(function(){ if (TAB === "manage") mngPollRunning(); }, 5000);
  MNG_LOG_TIMER = setInterval(function(){ if (TAB === "manage" && MNG_SEL) mngPollLog(); }, 3000);
}

async function mngLaunch() {
  var msg = document.getElementById("mng-launch-msg");
  var body = {
    family: document.getElementById("mng-family").value,
    dataset: document.getElementById("mng-dataset").value,
    preset: document.getElementById("mng-preset").value,
    model: document.getElementById("mng-model").value,
    instances: document.getElementById("mng-instances").value,
    onDemand: document.getElementById("mng-ondemand").checked
  };
  msg.style.color = "#768390"; msg.textContent = "발사 중…";
  try {
    var r = await fetch("/api/launch", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok) { msg.style.color = "#f85149"; msg.textContent = "실패: " + esc(j.error || ("HTTP "+r.status)); return; }
    msg.style.color = "#3fb950"; msg.innerHTML = "발사됨: " + esc(j.launchId) + " (pid " + esc(j.pid) + ")";
    MNG_SEL = j.launchId;
    mngPollRunning(); mngPollLog();
  } catch (e) { msg.style.color = "#f85149"; msg.textContent = "오류: " + esc(e); }
}

async function mngPollRunning() {
  try {
    var r = await fetch("/api/running");
    var j = await r.json();
    var rows = (j.launches || []).map(function(l){
      var age = mngAge(l.startedAt);
      var sel = (l.launchId === MNG_SEL) ? ' style="background:#161b22"' : '';
      var st = l.status === "running"
        ? '<span class="q-yes">running</span>'
        : '<span class="muted">exited'+(l.exitCode!=null?'('+esc(l.exitCode)+')':'')+'</span>';
      return '<tr class="mng-lrow" data-id="'+esc(l.launchId)+'"'+sel+' style="cursor:pointer">'
        + '<td>'+famChip(l.family)+'</td>'
        + '<td class="muted" title="'+esc(l.dataset)+'" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+esc(l.dataset)+'</td>'
        + '<td class="muted">'+esc(l.preset)+'</td>'
        + '<td>'+st+'</td>'
        + '<td class="muted">'+esc(l.pid)+'</td>'
        + '<td class="muted">'+esc(age)+'</td></tr>';
    }).join("");
    document.getElementById("mng-launches").innerHTML = rows || '<tr><td colspan="6" class="muted">아직 발사된 런 없음.</td></tr>';
    document.querySelectorAll(".mng-lrow").forEach(function(tr){
      tr.onclick = function(){ MNG_SEL = tr.dataset.id; mngPollRunning(); mngPollLog(); };
    });
    mngRenderBoxes(j.boxStatus);
  } catch (e) { /* transient — keep last view */ }
}

// box status is whatever 'box status --json' emits; render a compact summary + a
// terminate button per instance id we can find. Shape-tolerant (esc all text).
function mngRenderBoxes(bs) {
  bs = bs || {};
  var summary = "";
  try { summary = JSON.stringify(bs).slice(0, 400); } catch (e) { summary = ""; }
  document.getElementById("mng-box-summary").textContent = summary ? ("box status: " + summary) : "";
  // collect instance ids (i-…) anywhere in the status payload.
  var ids = mngCollectIids(bs);
  var rows = ids.map(function(id){
    return '<tr><td class="inst">'+esc(id)+'</td>'
      + '<td><button class="mng-btn mng-stop" data-iid="'+esc(id)+'" style="padding:2px 8px;font-size:11px">종료</button></td></tr>';
  }).join("");
  document.getElementById("mng-boxes").innerHTML = rows || '<tr><td colspan="2" class="muted">실행 중인 박스 없음.</td></tr>';
  document.querySelectorAll(".mng-stop").forEach(function(btn){
    btn.onclick = function(){ mngStopBox(btn.dataset.iid); };
  });
}

// Walk an arbitrary JSON value, collecting unique EC2 instance-id strings.
function mngCollectIids(v) {
  var out = {}, re = /^i-[0-9a-f]{8,}$/;
  (function walk(x){
    if (x == null) return;
    if (typeof x === "string") { if (re.test(x)) out[x] = 1; return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") { for (var k in x) walk(x[k]); }
  })(v);
  return Object.keys(out);
}

async function mngStopBox(iid) {
  if (!confirm("박스 종료: " + iid + " ?")) return;
  try {
    var r = await fetch("/api/box/stop", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ iid: iid }) });
    var j = await r.json();
    var msg = document.getElementById("mng-launch-msg");
    if (!r.ok) { msg.style.color = "#f85149"; msg.textContent = "종료 실패: " + esc(j.error || ("HTTP "+r.status)); }
    else { msg.style.color = j.ok ? "#3fb950" : "#d29922"; msg.innerHTML = "종료 " + (j.ok?"OK":"비정상") + ": " + esc((j.output||"").slice(-200)); }
    mngPollRunning();
  } catch (e) { /* surface nothing fatal */ }
}

async function mngPollLog() {
  if (!MNG_SEL) return;
  var con = document.getElementById("mng-console");
  if (!con) return;
  document.getElementById("mng-con-id").textContent = MNG_SEL;
  try {
    var r = await fetch("/api/launch-log?id=" + encodeURIComponent(MNG_SEL));
    var txt = await r.text();
    if (!r.ok) { con.textContent = "로그 읽기 실패: " + txt; return; }
    var lines = txt.split("\\n");
    var tail = lines.slice(-400).join("\\n");
    var atBottom = (con.scrollTop + con.clientHeight >= con.scrollHeight - 30);
    con.textContent = tail || "(로그 비어 있음)";
    if (atBottom) con.scrollTop = con.scrollHeight;
  } catch (e) { /* transient */ }
}

function mngAge(startedAt) {
  if (!startedAt) return "";
  var s = (Date.now() - startedAt) / 1000;
  if (s < 90) return Math.round(s) + "s";
  var m = s / 60;
  if (m < 90) return (m < 10 ? m.toFixed(1) : Math.round(m)) + "m";
  return (m / 60).toFixed(1) + "h";
}

document.querySelectorAll("nav button").forEach(b => b.onclick = () => { TAB = b.dataset.tab; render(); });

// Modal close: ✕ button, click on backdrop (not the box), or Escape.
document.getElementById("modal-close").onclick = closeModal;
document.getElementById("modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

let cd = 5;
setInterval(() => { cd--; if (cd <= 0) { cd = 5; poll(); } document.getElementById("cd").textContent = cd; }, 1000);
poll();
</script>
</body>
</html>`
