/**
 * BFND-03 — the Terminal-Bench CLIENT render layer, extracted verbatim-in-spirit
 * out of the dashboard god-module and given to the suite that owns it.
 *
 * The page shell no longer knows Terminal-Bench exists: this bundle registers
 * itself into the shell's `SUITE_VIEWS` table under its suite id, and the shell
 * dispatches by looking the ACTIVE view's suite up in that table.
 *
 * One deliberate semantic change from the pre-BFND-03 code: the headline cards
 * read the run's PERSISTED official-shaped totals (BFND-02 stamps them on every
 * Terminal artifact) instead of re-folding an any-pass union across runs and
 * arms. The per-task ✅/❌ table still folds the lossless per-trial receipts —
 * that is a table of verdicts, not a second score.
 *
 * Everything in here is a plain-JS string shipped inside the page's <script>.
 * Every value that reaches innerHTML goes through the page's `esc` helper.
 */

export const TERMINAL_BENCH_CLIENT_STYLE = `
  /* Terminal-Bench: the "winnable target" row chip. */
  .fam-tb-target { background: #13233a; color: #79c0ff; border-color: #1f6feb; }`

export const TERMINAL_BENCH_CLIENT_SCRIPT = `
// ── Terminal-Bench view (owned by tools/leaderboard-dashboard/projectors) ────
var TB_MFILTER = { q: "", f: "all" };

// Runs of THIS SUITE. Selection is by benchmarkSuite — never by a dataset
// family: Terminal-Bench stopped riding the family axis in BFND-02, so a report
// that merely CLAIMS the old family string is not a Terminal run.
function tbRuns() {
  return (DATA.runs || []).filter(function(r){ return r.benchmarkSuite === "terminal-bench"; });
}
// Which A/B arm a run belongs to. The EXPLICIT report.arm wins; the preset
// substring is only a fallback for pre-arm reports (an oc1/owned-only run's
// preset lacks "levers" and would otherwise poison the baseline control).
function tbArmOf(r) {
  if (r.arm) return r.arm;
  return (r.preset || "").toLowerCase().indexOf("levers") >= 0 ? "levers" : "baseline";
}
// Best run of an arm by its PERSISTED resolved/total (arm === null ⇒ any arm).
// This FORMATS a stored metric; it never re-folds the per-trial receipts.
function tbBestRun(arm) {
  var runs = tbRuns(), best = null;
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    if (arm !== null && tbArmOf(r) !== arm) continue;
    if (best === null || (r.resolved/Math.max(1,r.total)) > (best.resolved/Math.max(1,best.total))) best = r;
  }
  return best;
}
// Never fabricate a 0/0 score out of "no runs" — say so.
function tbScore(run) { return run ? (run.resolved + " / " + run.total) : "—"; }

// Per-task verdict marks — a TABLE, not a score: any-pass across this suite's
// runs, split by arm. D1 (RFC jul-3): an agent-CRASH (auth death / harness
// exception) is a re-runnable infra hole, so it yields NO verdict rather than a
// miss. An agent-TIMEOUT stays a genuine miss (the agent spent its whole budget,
// and the HF competitor columns score timeouts 0 too).
function tbOurResults() {
  var runs = tbRuns();
  var base = {}, lev = {};
  for (const r of runs) {
    const sink = tbArmOf(r) === "levers" ? lev : base;
    for (const pi of (r.perInstance || [])) {
      if (pi.error && pi.error.kind === "agent-crash") continue;
      if (sink[pi.id] === undefined || pi.passed) sink[pi.id] = pi.passed;
    }
  }
  return { base: base, lev: lev };
}

// TB task rows = HF per-task matrix ∪ OUR run task ids (P3-D md-absent fix: with
// the HF md missing — or a harbor task name drifted from the HF name — our runs
// still render as rows instead of silently vanishing; synthesized rows carry no
// competitor data, avg 0 ⇒ never counted winnable).
function tbTaskRows() {
  const tasks = ((DATA.tb && DATA.tb.tasks) || []).slice();
  const known = new Set(tasks.map(function(t){ return t.task; }));
  const our = tbOurResults();
  const ourIds = new Set(Object.keys(our.base).concat(Object.keys(our.lev)));
  for (const id of ourIds) {
    if (!known.has(id)) {
      tasks.push({ task: id, difficulty: "?", category: "(HF 매트릭스에 없음)", avg: 0, scaffolds: {}, hardCeiling: false });
    }
  }
  return { tasks: tasks, our: our };
}

// Terminal-Bench summary cards. The three score cards are PERSISTED totals off
// the artifacts (BFND-03: the dashboard formats metrics, it does not compute
// them); the last two are competitor-gap counts over the task table.
function renderTbCards() {
  const tb = tbTaskRows();
  const tasks = tb.tasks;
  const our = tb.our;
  const solved = function(t){ return our.base[t]===true || our.lev[t]===true; };
  const overall = tbBestRun(null), levRun = tbBestRun("levers"), baseRun = tbBestRun("baseline");
  const winnable = tasks.filter(function(t){return !solved(t.task) && !t.hardCeiling && t.avg>0;}).length;
  const ceil = tasks.filter(function(t){return t.hardCeiling;}).length;
  const cards = [
    ["해결 / 실행", tbScore(overall), overall ? "기록된 공식 지표 · " + overall.preset : "terminal-bench 리포트 없음"],
    ["레버 회복", tbScore(levRun), levRun ? "기록된 공식 지표 · " + levRun.preset : "levers 런 없음"],
    ["베이스라인", tbScore(baseRun), baseRun ? "기록된 공식 지표 · " + baseRun.preset : "baseline 런 없음"],
    ["승산 타겟 남음", winnable, "우리 미해결 ∩ 남들 성공"],
    ["하드천장", ceil, "아무 스캐폴드도 못 푼 것"],
  ];
  document.getElementById("cards").innerHTML = cards.map(function(c){
    return '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
      (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>';
  }).join("");
}

// Terminal-Bench per-task matrix: our baseline vs levers verdict × competitor
// pass-rates, keyed on the TB tasks (DATA.tb). Winnable targets (our miss ∩
// someone solved) float to the top and are tinted; hard ceilings are greyed.
function renderTbMatrix(v) {
  // SHELL (built once — P3-D focus fix): the controls + legend stay in the DOM
  // across keystrokes and background refreshes; only #tbtable's contents redraw.
  v.innerHTML = '<div class="controls">'+
    '<input id="tbsearch" placeholder="task 검색…" value="'+esc(TB_MFILTER.q)+'" />'+
    '<select id="tbfilter">'+
      ['all|전체','winnable|승산 타겟(우리 미스 ∩ 남들 성공)','solved|우리 해결','missed|우리 미스','ceiling|하드천장']
        .map(function(o){var p=o.split("|");return '<option value="'+p[0]+'"'+(TB_MFILTER.f===p[0]?" selected":"")+'>'+esc(p[1])+'</option>';}).join("")+
    '</select> <span class="muted" id="tbcount"></span></div>'+
    // P2-10 metric label: our marks are ANY-PASS (trial×run×arm), competitor % is
    // TRIAL-AVERAGE — different aggregations; ours reads optimistic by construction.
    '<p class="muted">✅/❌ = 우리 결과(any-pass: trial×run 합) · 우측 = 공개 스캐폴드 pass율(HF, trial-평균 — 집계가 달라 우리 쪽이 낙관) · <b>승산 타겟</b>=우리 미스인데 최소 한 곳은 푼 것(파란 배경) · 회색 행=하드천장(아무도 못 푼 것)</p>'+
    '<div id="tbtable"></div>';
  const si = document.getElementById("tbsearch"); if (si) si.oninput = function(){ TB_MFILTER.q = si.value; drawTbMatrix(); };
  const fi = document.getElementById("tbfilter"); if (fi) fi.onchange = function(){ TB_MFILTER.f = fi.value; drawTbMatrix(); };
  drawTbMatrix();
}
// BODY (redraws on filter/search/refresh — never touches the controls above).
function drawTbMatrix() {
  const el = document.getElementById("tbtable");
  if (!el) return;
  const tb = tbTaskRows();
  const tasks = tb.tasks;
  const scaffs = (DATA.tb && DATA.tb.scaffolds) || [];
  const our = tb.our;
  const solved = function(t){ return our.base[t]===true || our.lev[t]===true; };
  const mark = function(res){
    if (res === true) return '<span class="q-ok">✅</span>';
    if (res === false) return '<span class="q-no">❌</span>';
    return '<span class="muted">—</span>';
  };
  const isWinnable = function(t){ return !solved(t.task) && !t.hardCeiling && t.avg>0; };
  const f = TB_MFILTER.f, q = (TB_MFILTER.q||"").toLowerCase();
  let rows = tasks.filter(function(t){
    if (q && t.task.toLowerCase().indexOf(q) < 0) return false;
    if (f === "winnable") return isWinnable(t);
    if (f === "solved") return solved(t.task);
    if (f === "missed") return !solved(t.task);
    if (f === "ceiling") return t.hardCeiling;
    return true;
  });
  // winnable first, then by competitor avg desc (highest-ROI targets on top).
  rows.sort(function(a,b){
    const wa = isWinnable(a)?1:0, wb = isWinnable(b)?1:0;
    if (wa !== wb) return wb - wa;
    return b.avg - a.avg;
  });
  const cnt = document.getElementById("tbcount"); if (cnt) cnt.textContent = rows.length + "개";
  let h = '<table><thead><tr><th class="inst" style="text-align:left">task</th><th>난이도</th><th style="text-align:left">category</th>'+
    '<th title="knob-off">우리<br>base</th><th title="env-owned·maxTurns·verify-gate">우리<br>+레버</th><th>경쟁사<br>평균</th>'+
    scaffs.map(function(s){return '<th title="'+esc(s)+'">'+esc(String(s).slice(0,4))+'</th>';}).join("")+'</tr></thead><tbody>';
  for (const t of rows) {
    const cls = t.hardCeiling ? ' style="opacity:.45"' : (isWinnable(t) ? ' style="background:#12233a"' : '');
    h += '<tr'+cls+'><td class="inst">'+esc(t.task)+(isWinnable(t)?' <span class="fam fam-tb-target">타겟</span>':'')+'</td>'+
      '<td class="muted" style="text-align:center">'+esc(t.difficulty)+'</td>'+
      '<td class="muted">'+esc(t.category)+'</td>'+
      '<td style="text-align:center">'+mark(our.base[t.task])+'</td>'+
      '<td style="text-align:center">'+mark(our.lev[t.task])+'</td>'+
      '<td style="text-align:center"><b>'+esc(t.avg)+'%</b></td>'+
      scaffs.map(function(s){var p=t.scaffolds[s];return '<td class="muted" style="text-align:center">'+(p===undefined?'·':(esc(p)+'%'))+'</td>';}).join("")+
      '</tr>';
  }
  el.innerHTML = h + '</tbody></table>';
}

// Terminal-Bench has its own scaffold set — average per-task pass-rate from the
// TB competitor matrix (DATA.tb), not the SWE scaffold-summary.
function tbScaffolds() {
  const tasks = (DATA.tb && DATA.tb.tasks) || [];
  const scaffs = (DATA.tb && DATA.tb.scaffolds) || [];
  const avg = scaffs.map(function(s){
    let sum=0,n=0; for (const t of tasks){ const p=t.scaffolds[s]; if (p!==undefined){sum+=p;n++;} }
    return { key: s, pct: n? Math.round(sum/n):0, n: n };
  }).sort(function(a,b){return b.pct-a.pct;});
  let th = '<p class="muted">공개 스캐폴드별 TB 태스크 평균 pass율 (HF 리더보드 파싱, n='+tasks.length+' tasks).</p>';
  th += '<table><thead><tr><th class="inst" style="text-align:left">스캐폴드</th><th>평균 pass율</th><th>%</th></tr></thead><tbody>';
  for (const s of avg) th += '<tr><td class="inst">'+esc(s.key)+'</td><td>'+s.pct+'%</td>'+
    '<td><span class="bar"><i style="width:'+s.pct+'%"></i></span> '+s.pct+'%</td></tr>';
  return th + '</tbody></table>';
}

// The registration the shell dispatches on. No page-shell code names this suite.
SUITE_VIEWS["terminal-bench"] = {
  cards: renderTbCards,
  matrix: { tableId: "tbtable", shell: renderTbMatrix, draw: drawTbMatrix },
  scaffolds: tbScaffolds
};`
