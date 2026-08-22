/**
 * TB21-05 — the Terminal-Bench **2.1** CLIENT render layer.
 *
 * The page shell does not know Terminal-Bench exists: this bundle registers
 * itself into the shell's `SUITE_VIEWS` table under its suite id, and the shell
 * dispatches by looking the ACTIVE view's suite up in that table.
 *
 * ## What changed at the cutover, and why
 *
 * The pre-2.1 bundle rendered an ANY-PASS fold: a task's trials collapsed into
 * one ✅/❌ across runs AND arms, three `해결 / 실행` cards that mixed a baseline
 * with a levers run, and a competitor column parsed out of a Terminal-Bench
 * **2.0** markdown matrix. Every one of those is a different benchmark, a
 * different aggregation, or both — an optimistic union presented as a score.
 *
 * This bundle displays RECEIPTS:
 *
 *  - **Cards** read the PERSISTED `metrics`/`admission`/`outcomes` that TB21-04's
 *    scorer wrote into the artifact, for ONE run at a time. The browser performs
 *    no scoring division at all; `displayAccuracy` is the scorer's own string.
 *  - **The per-task matrix** shows the selected run's trial DISTRIBUTION —
 *    `1/2 (50%)`, the outcome classes, the averages. An error trial stays in the
 *    task's denominator, because TB21-04 keeps it in the official one.
 *  - **Any-pass** survives only as a clearly-labelled secondary diagnostic
 *    column. It is never a score and never a headline.
 *  - **The competitor table** is the OFFICIAL 2.1 leaderboard submission set,
 *    pinned to an upstream commit by `importers/terminal-bench-official.ts`.
 *    There is no per-task external column: the official submission JSON carries
 *    trial ids with no task mapping, so that column renders `—` rather than a
 *    carried-forward 2.0 rate.
 *
 * Everything here is a plain-JS string shipped inside the page's `<script>`.
 * Every value that reaches innerHTML goes through the page's `esc` helper, and
 * every URL is re-checked for an `https:` scheme before it becomes an `href`
 * (escaping does not neutralise `javascript:` inside an attribute).
 */

export const TERMINAL_BENCH_CLIENT_STYLE = `
  /* Terminal-Bench 2.1 */
  .tb-prov { background: #11161d; border: 1px solid #21262d; border-radius: 8px;
             padding: 8px 12px; font-size: 11px; line-height: 1.9; width: 100%; }
  .tb-prov b { color: #adbac7; font-weight: 600; }
  .tb-run { cursor: pointer; }
  .tb-run.tb-on { border-color: #2f81f7; }
  .tb-warn { background: #2b1a1a; border: 1px solid #6b2222; color: #ffb4ab;
             border-radius: 8px; padding: 8px 12px; font-size: 11px; width: 100%; }
  .tb-rate-ok { color: #3fb950; font-weight: 700; }
  .tb-rate-mid { color: #d29922; font-weight: 700; }
  .tb-rate-no { color: #f85149; font-weight: 700; }
  .tb-diag { color: #768390; font-size: 10px; }`

export const TERMINAL_BENCH_CLIENT_SCRIPT = `
// ── Terminal-Bench 2.1 view (owned by tools/leaderboard-dashboard/projectors) ─
var TB_FILTER = { q: "", f: "all", run: "" };

// Runs of THIS SUITE. Selection is by benchmarkSuite — never by a dataset
// family: Terminal-Bench stopped riding the family axis in BFND-02, so a report
// that merely CLAIMS the old family string is not a Terminal run.
function tbRuns() {
  return (DATA && DATA.runs || []).filter(function(r){ return r.benchmarkSuite === "terminal-bench"; });
}
// The suite-owned per-run payload the projector attached (provenance, the
// persisted admission and the persisted official metrics). Never recomputed.
function tbView(r) { return (r && r.suiteView) || {}; }

// The VERSIONED dashboard payload. A payload of any other version is refused
// outright: a pre-cutover (2.0) competitor blob must never render as 2.1.
function tbPayload() {
  var tb = DATA && DATA.tb;
  return (tb && tb.schemaVersion === "terminal-bench-dashboard/v2") ? tb : null;
}
function tbOfficial() { var p = tbPayload(); return (p && p.official) || null; }

// Artifacts REFUSED at the identity boundary and claimed by this suite. They
// contribute no run, no campaign and no score — only a visible diagnostic.
function tbQuarantine() {
  return ((DATA && DATA.quarantine) || []).filter(function(q){ return q.suite === "terminal-bench"; });
}

// The FOCUSED run: an explicit pick, else the most recent. Runs are NEVER
// merged — a profile, a model, an effort, a sandbox, a k or a dataset ref that
// differs is a different experiment, and the projector already gave each its own
// campaign identity.
function tbSelectedRun() {
  var runs = tbRuns();
  if (!runs.length) return null;
  for (var i = 0; i < runs.length; i++) if (runs[i].label === TB_FILTER.run) return runs[i];
  var best = runs[0];
  for (var j = 1; j < runs.length; j++) if ((runs[j].mtime||0) > (best.mtime||0)) best = runs[j];
  return best;
}

// Never fabricate a number out of a missing receipt — say so.
function tbOr(v) { return (v === undefined || v === null || v === "") ? "—" : v; }
function tbInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
}
function tbMoney(n) { return (typeof n === "number" && isFinite(n)) ? ("$" + n.toFixed(2)) : "—"; }
// Only an https URL may become an href: esc() escapes the characters, but it
// leaves \`javascript:alert(1)\` a perfectly functional link.
function tbLink(url, label) {
  if (typeof url !== "string" || url.indexOf("https://") !== 0) return esc(label);
  return '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(label) + '</a>';
}

// The eight-class tally, split the way the cards read it: graded verdicts vs
// everything that failed to produce one. An error trial is still a scored zero.
var TB_GRADED = ["graded_pass", "graded_fail"];
function tbErrorTrials(outcomes) {
  var n = 0;
  for (var kind in (outcomes||{})) {
    if (TB_GRADED.indexOf(kind) < 0) n += (outcomes[kind] || 0);
  }
  return n;
}

// ── summary cards (ONE run at a time — no union, ever) ──────────────────────
function tbCardsFor(run) {
  var v = tbView(run), m = v.metrics || null, a = v.admission || {}, o = v.outcomes || {};
  var passAt = (m && v.k >= 2 && m.passAtK)
    ? [2,3,4,5].map(function(k){ return k + ":" + m.passAtK[k]; }).join("  ")
    : "—";
  return [
    ["정확도", m ? m.displayAccuracy : "—",
      m ? ("공식 지표 · " + v.profile + " · " + v.arm) : "지표 없음(rejected 런은 숫자를 내지 않음)"],
    ["trial 수집", tbInt(a.admittedTrials) + " / " + tbInt(a.expectedTrials), "수집 / 기대(89×k)"],
    ["task 커버리지", tbInt(a.observedTaskCount) + " / " + tbInt(a.expectedTaskCount), "관측 task / 89"],
    // The persisted pass@k is shown VERBATIM (never recomputed, never hidden),
    // but an INCOMPLETE run's pass@5 is 0 simply because five trials do not
    // exist — labelling that "official" would be the misreading. Reads the
    // persisted \`complete\` flag; computes nothing.
    ["pass@2..5", passAt,
      v.k >= 2 ? (a.complete ? "공식 pass@k" : "미완 런 — 공식 pass@k 아님(참고용)") : "k=1 — pass@k 없음"],
    ["graded pass / fail", tbInt(o.graded_pass) + " / " + tbInt(o.graded_fail), "채점된 trial"],
    ["에러 trial", tbInt(tbErrorTrials(o)), "timeout/crash/env/verifier/missing/malformed"],
    ["총 비용", m ? m.displayTotalCostUsd : "—",
      m ? (tbInt((m.uncachedInputTokens||0) + (m.cachedInputTokens||0) + (m.outputTokens||0)) + " tok") : ""],
    ["평균 trial 시간", m ? (tbInt(m.avgTrialDurationSec) + "s") : "—", "trial 평균 wall-clock"],
    ["상태", tbOr(a.verdict),
      [a.complete ? "complete" : "incomplete", a.standardConfig ? "standard" : "nonstandard",
       a.promotable ? "promotable" : "not-promotable"].join(" · ")],
  ];
}

// The provenance strip: exactly what produced this number.
function tbProvenance(run) {
  var v = tbView(run);
  var bits = [
    ["dataset", v.dataset + "@" + v.datasetRef],
    ["harbor", v.harborVersion],
    ["quanta", v.quantaSha + (v.dirty ? " (dirty)" : "")],
    ["agent", v.agentVersion],
    ["model", v.provider + "/" + v.model],
    ["effort", v.reasoningEffort],
    ["profile", v.profile],
    ["sandbox", v.sandbox],
    ["k", v.k],
    ["arm", v.arm],
    ["tasks", v.taskSelection],
    ["job", (v.harborJobIds||[]).join(", ")],
    ["run", v.timestamp],
  ];
  return '<div class="tb-prov">' + bits.map(function(b){
    return '<b>' + esc(b[0]) + '</b> ' + esc(tbOr(b[1]));
  }).join(' &nbsp;·&nbsp; ') + '</div>';
}

// One selectable row PER RUN, each carrying its OWN persisted accuracy. This is
// what "two profiles remain two scored rows" looks like on the page.
function tbRunPicker(runs, selected) {
  return runs.map(function(r){
    var v = tbView(r), m = v.metrics || null;
    var on = (selected && r.label === selected.label) ? " tb-on" : "";
    return '<div class="card tb-run' + on + '" data-run="' + esc(r.label) + '">' +
      '<div class="n" style="font-size:14px">' + esc(m ? m.displayAccuracy : "—") + '</div>' +
      '<div class="l">' + esc(tbOr(v.profile)) + '</div>' +
      '<div class="muted" style="font-size:10px">' + esc(tbOr(v.datasetRef)) +
      ' · k=' + esc(tbOr(v.k)) + ' · ' + esc(tbOr(v.reasoningEffort)) + '</div></div>';
  }).join("");
}

function tbQuarantineHtml() {
  var q = tbQuarantine();
  if (!q.length) return "";
  return '<div class="tb-warn"><b>격리된 리포트 ' + q.length + '건</b> — 식별에 실패해 점수에 전혀 반영되지 않음.<br>' +
    q.map(function(x){ return esc(x.file) + ' — ' + esc(x.reason); }).join('<br>') + '</div>';
}

function renderTbCards() {
  var runs = tbRuns(), run = tbSelectedRun();
  var html = tbCardsFor(run).map(function(c){
    return '<div class="card"><div class="n">' + esc(c[1]) + '</div><div class="l">' + esc(c[0]) + '</div>' +
      (c[2] ? '<div class="muted" style="font-size:10px">' + esc(c[2]) + '</div>' : '') + '</div>';
  }).join("");
  html += runs.length
    ? tbRunPicker(runs, run) + tbProvenance(run)
    : '<div class="tb-prov">terminal-bench 리포트 없음 — 2.1 런을 돌리면 여기 채워진다.</div>';
  html += tbQuarantineHtml();
  document.getElementById("cards").innerHTML = html;
  document.querySelectorAll(".tb-run").forEach(function(el){
    el.onclick = function(){ TB_FILTER.run = el.dataset.run; renderTbCards(); drawTbMatrix(); };
  });
}

// ── per-task matrix (the selected run's TRIAL DISTRIBUTION) ─────────────────
//
// A task's row is a tally of its OWN receipts — never a verdict folded across
// runs or arms. Every trial counts, including an errored one: TB21-04 keeps it
// in the official denominator (no reward ⇒ a zero), so the table must too.
function tbTaskRows(run) {
  var v = tbView(run), k = v.k || 0;
  var byTask = {}, order = [];
  var rows = (run && run.perInstance) || [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var t = byTask[row.taskId];
    if (!t) {
      t = byTask[row.taskId] = { taskId: row.taskId, taskName: row.taskName || row.taskId,
        trials: 0, passes: 0, errors: 0, durMs: 0, cost: 0, costN: 0, outcomes: {}, jobs: {}, traj: "" };
      order.push(t);
    }
    t.trials++;
    if (row.passed) t.passes++;
    if (TB_GRADED.indexOf(row.outcome) < 0) t.errors++;
    t.durMs += (row.durationMs || 0);
    if (typeof row.costUsd === "number") { t.cost += row.costUsd; t.costN++; }
    t.outcomes[row.outcome] = (t.outcomes[row.outcome] || 0) + 1;
    if (row.harborJobId) t.jobs[row.harborJobId] = 1;
    if (row.trajectoryPath) t.traj = row.trajectoryPath;
  }
  var q = (TB_FILTER.q || "").toLowerCase(), f = TB_FILTER.f;
  var out = order.filter(function(t){
    if (q && t.taskId.toLowerCase().indexOf(q) < 0) return false;
    // "perfect" means every INTENDED trial passed — a task short of k is
    // incomplete coverage, not a clean sweep.
    if (f === "perfect") return t.trials > 0 && t.passes === t.trials && (k === 0 || t.trials >= k);
    if (f === "partial") return t.passes > 0 && t.passes < t.trials;
    if (f === "zero") return t.passes === 0;
    if (f === "errors") return t.errors > 0;
    if (f === "missing") return k > 0 && t.trials < k;
    return true;
  });
  // Worst pass-rate first — the highest-ROI rows on top.
  out.sort(function(a, b){
    var ra = a.trials ? a.passes / a.trials : 0, rb = b.trials ? b.passes / b.trials : 0;
    if (ra !== rb) return ra - rb;
    return a.taskId < b.taskId ? -1 : (a.taskId > b.taskId ? 1 : 0);
  });
  return out;
}

function tbRateCell(t) {
  var pct = t.trials ? Math.round(100 * t.passes / t.trials) : 0;
  var cls = t.passes === t.trials ? "tb-rate-ok" : (t.passes > 0 ? "tb-rate-mid" : "tb-rate-no");
  return '<span class="' + cls + '">' + t.passes + '/' + t.trials + '</span> ' +
    '<span class="muted">(' + pct + '%)</span>';
}

function tbOutcomeCell(t) {
  var bits = [];
  for (var kind in t.outcomes) {
    if (TB_GRADED.indexOf(kind) >= 0) continue;
    bits.push(kind + "×" + t.outcomes[kind]);
  }
  return bits.length ? esc(bits.join(" ")) : '<span class="muted">·</span>';
}

// SHELL (built once): the controls + legend stay in the DOM across keystrokes
// and background refreshes; only #tbtable's contents redraw, so the search box
// keeps focus and the cursor.
function renderTbMatrix(v) {
  v.innerHTML = '<div class="controls">' +
    '<input id="tbsearch" placeholder="task 검색…" value="' + esc(TB_FILTER.q) + '" />' +
    '<select id="tbfilter">' +
      ['all|전체','perfect|전 trial 통과','partial|부분 통과','zero|전 trial 실패','errors|에러 있음','missing|trial 부족(<k)']
        .map(function(o){ var p = o.split("|");
          return '<option value="' + p[0] + '"' + (TB_FILTER.f === p[0] ? " selected" : "") + '>' + esc(p[1]) + '</option>'; }).join("") +
    '</select> <span class="muted" id="tbcount"></span></div>' +
    '<p class="muted">점수 = 이 런의 <b>trial 통과율</b>(예: 1/2 = 50%). 에러 trial도 분모에 남는다(보상 없음 = 0점) — ' +
    'TB21-04 공식 채점과 같은 분모다. <b>any-pass</b>는 참고용 진단 열일 뿐 점수가 아니다. ' +
    '경쟁사 per-task 열은 공식 제출 JSON에 task 매핑이 없어 <b>—</b>로 남는다(2.0 수치를 끌어오지 않는다).</p>' +
    '<div id="tbtable"></div>';
  var si = document.getElementById("tbsearch");
  if (si) si.oninput = function(){ TB_FILTER.q = si.value; drawTbMatrix(); };
  var fi = document.getElementById("tbfilter");
  if (fi) fi.onchange = function(){ TB_FILTER.f = fi.value; drawTbMatrix(); };
  drawTbMatrix();
}

// BODY (redraws on filter/search/refresh — never touches the controls above).
function drawTbMatrix() {
  var el = document.getElementById("tbtable");
  if (!el) return;
  var run = tbSelectedRun();
  if (!run) {
    el.innerHTML = '<p class="muted">terminal-bench 리포트 없음.</p>';
    return;
  }
  var v = tbView(run), rows = tbTaskRows(run);
  var cnt = document.getElementById("tbcount");
  if (cnt) cnt.textContent = rows.length + "개 task";
  var h = '<table><thead><tr>' +
    '<th class="inst" style="text-align:left">task</th>' +
    '<th title="이 런에서 보상=통과한 trial 수 / 총 trial 수">통과 trial</th>' +
    '<th title="채점되지 않은 trial(에러 클래스별)">에러</th>' +
    '<th title="이 task trial들의 평균 wall-clock">평균 시간</th>' +
    '<th title="이 task trial들의 평균 비용">평균 비용</th>' +
    '<th title="harbor job / trajectory">기록</th>' +
    '<th title="공식 제출 JSON은 trial id만 담아 per-task 경쟁사 비율을 만들 수 없다">경쟁사<br>per-task</th>' +
    '<th class="tb-diag" title="진단용 보조 열 — 점수가 아니다">any-pass</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i];
    var jobs = Object.keys(t.jobs);
    h += '<tr><td class="inst" title="' + esc(t.taskId) + '">' + esc(t.taskName) +
      (t.trials < (v.k || 0) ? ' <span class="pill" title="k보다 적게 돌았다">trial ' + t.trials + '/' + esc(v.k) + '</span>' : '') + '</td>' +
      '<td>' + tbRateCell(t) + '</td>' +
      '<td class="muted" style="font-size:10px">' + tbOutcomeCell(t) + '</td>' +
      '<td class="muted">' + (t.trials ? (Math.round(t.durMs / t.trials / 1000) + "s") : "—") + '</td>' +
      '<td class="muted">' + (t.costN ? tbMoney(t.cost / t.costN) : "—") + '</td>' +
      '<td class="muted" style="font-size:10px">' + (jobs.length ? esc(jobs.join(",")) : "·") +
        (t.traj ? ' · ' + esc(t.traj.split("/").pop()) : '') + '</td>' +
      '<td class="muted">—</td>' +
      '<td class="tb-diag">' + (t.passes > 0 ? '✓' : '·') + '</td></tr>';
  }
  el.innerHTML = h + '</tbody></table>';
}

// ── official 2.1 competitor comparison (source-pinned, offline) ─────────────
function tbScaffolds() {
  var off = tbOfficial();
  if (!off || !off.submissions || !off.submissions.length) {
    return '<p class="muted">공식 Terminal-Bench 2.1 비교 데이터 <b>—</b> (없음). ' +
      '새로고침: <code>bun run tools/leaderboard-dashboard/importers/terminal-bench-official.ts ' +
      '--upstream-ref &lt;commit&gt; --submissions &lt;dir&gt; --out tools/leaderboard-dashboard/rawdata/terminal-bench-official.json</code>' +
      '</p><p class="muted">2.0 리더보드 수치는 의도적으로 폐기했다 — 다른 벤치마크의 숫자를 2.1 옆에 두지 않는다.</p>';
  }
  var h = '<p class="muted">공식 <b>Terminal-Bench 2.1</b> 리더보드 제출 (' + off.submissions.length + '건). ' +
    'upstream <code>' + esc(off.upstreamRepo) + '@' + esc(off.upstreamRef) + '</code> · dataset <code>' +
    esc(off.datasetRef) + '</code> · 새로고침 ' + esc(off.refreshedAt) + ' · ' +
    tbLink(off.upstreamUrl, "제출 디렉터리") + '</p>';
  h += '<p class="muted">per-task 경쟁사 비율은 제공하지 않는다 — ' + esc(off.perTaskOmittedReason) + '</p>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">agent / model</th>' +
    '<th>effort</th><th>정확도 ± SE</th><th>pass@2</th><th>pass@3</th><th>pass@4</th><th>pass@5</th>' +
    '<th>trial</th><th>총 비용</th><th>평균 시간</th><th title="상위 리워드-해킹 판정 + 실격 trial 수">리워드해킹</th>' +
    '<th>출처</th></tr></thead><tbody>';
  for (var i = 0; i < off.submissions.length; i++) {
    var s = off.submissions[i];
    var pk = s.passAtK || {};
    h += '<tr><td class="inst">' + tbLink(s.agentUrl, s.agentLabel) +
      (s.agentVersion ? ' <span class="muted" style="font-size:10px">' + esc(s.agentVersion) + '</span>' : '') +
      '<br><span class="muted" style="font-size:10px">' + tbLink(s.modelUrl, s.modelLabel) + '</span></td>' +
      '<td class="muted">' + esc(tbOr(s.reasoningEffort)) + '</td>' +
      '<td><b>' + esc(tbOr(s.displayAccuracy)) + '</b></td>' +
      '<td class="muted">' + esc(tbOr(pk[2])) + '</td>' +
      '<td class="muted">' + esc(tbOr(pk[3])) + '</td>' +
      '<td class="muted">' + esc(tbOr(pk[4])) + '</td>' +
      '<td class="muted">' + esc(tbOr(pk[5])) + '</td>' +
      '<td class="muted">' + tbInt(s.nTrials) + '</td>' +
      '<td class="muted">' + esc(tbOr(s.displayTotalCostUsd)) + '</td>' +
      '<td class="muted">' + tbInt(s.avgTrialDurationSec) + 's</td>' +
      '<td class="muted">' + tbLink(s.rewardHacksUrl, tbOr(s.displayRewardHacks)) +
        ' <span style="font-size:10px">(실격 ' + tbInt(s.disqualifiedTrials) + ')</span></td>' +
      '<td class="muted" style="font-size:10px">' + tbLink(s.submissionUrl, s.sourceFile) + '</td></tr>';
  }
  return h + '</tbody></table>';
}

// The registration the shell dispatches on. No page-shell code names this suite.
SUITE_VIEWS["terminal-bench"] = {
  cards: renderTbCards,
  matrix: { tableId: "tbtable", shell: renderTbMatrix, draw: drawTbMatrix },
  scaffolds: tbScaffolds
};`
