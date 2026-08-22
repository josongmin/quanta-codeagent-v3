/**
 * PMX-05 — the ProMax dataset-family VIEW. Presentation only.
 *
 * ProMax is a `datasetFamily` under the `swe-bench` suite, never a suite of its
 * own, and it is a SEPARATE campaign partition from `pro`: different corpus
 * schema, different prediction contract, different evaluator, different result
 * semantics. Nothing here may merge the two.
 *
 * ## This module owns no arithmetic
 *
 * Every number it renders arrives pre-aggregated AND pre-formatted on
 * `run.officialGrade` — `totals` from the report's one aggregation owner,
 * `display` from that owner's one formatter. There is no denominator, no
 * percentage and no fold in this file. That is deliberate: the dashboard has
 * historically been where a filtered row set quietly became a second score, and a
 * view that cannot divide cannot do that.
 *
 * The reason drilldown DOES filter — but only the drilldown table. The headline
 * cards read `officialGrade.display`, which no filter can reach, so a display bug
 * cannot drop invalid or missing rows out of `assigned`.
 *
 * Everything below is a plain-JS string shipped inside the page's `<script>`.
 * Every value that reaches innerHTML goes through the page's `esc` helper.
 */
import type { SweFamilyView } from "./registry"

const PROMAX_CLIENT_STYLE = `
  /* ProMax: the measurement-coverage chips. */
  .fam-promax { background: #2a1f3d; color: #d2a8ff; border-color: #8957e5; }
  .og-invalid { color: #f0883e; }
  .og-missing { color: #f85149; }`

const PROMAX_CLIENT_SCRIPT = `
// ── ProMax family view (owned by projectors/swe-bench/promax.ts) ─────────────
var PMX_FILTER = { state: "all" };

// Runs of THIS view that carry a persisted official-grade section. Selection is
// by viewId (the family the projector assigned), so a report is only ProMax
// because its identity says so.
function pmxRuns() {
  return (DATA.runs || []).filter(function(r){ return r.viewId === "promax" && r.officialGrade; });
}
// The authoritative run: most recent first (server sorts DATA.runs by mtime desc).
// One artifact's persisted totals — never a union across runs, which would be a
// second aggregation with a different denominator.
function pmxSection() { var rs = pmxRuns(); return rs.length ? rs[0] : null; }

// ProMax summary cards. Score sits BESIDE assigned and coverage so a shrinking
// valid denominator is never quotable on its own (PMX-05 score contract).
function renderPromaxCards() {
  var run = pmxSection();
  var el = document.getElementById("cards");
  if (!run) {
    el.innerHTML = '<div class="card"><div class="n">—</div><div class="l">해결 / 유효채점</div>' +
      '<div class="muted" style="font-size:10px">promax 공식채점 리포트 없음</div></div>';
    return;
  }
  var d = run.officialGrade.display;
  // withRefusedCard: this card set quotes ONE artifact's persisted totals, so an
  // artifact REFUSED at decode does not merely leave the denominator — it can leave
  // this view quoting an OLDER run as if it were current. The shared shell builder
  // appends the refusal count beside the rate; it appends nothing when there is none.
  var cards = withRefusedCard([
    ["해결 / 유효채점", d.score, "공식 채점 유효분모 · " + run.preset],
    ["assigned", d.assigned, "캠페인 분모(무효·미채점 포함)"]
  ].concat(ogRateCards(d)).concat([
    ["무효/모호", d.infra_invalid + " / " + d.ambiguous, "채점 자체가 신뢰불가 · 판단보류"],
    ["미채점", d.missing, "assigned 인데 채점 결과 없음"]
  ]));
  el.innerHTML = cards.map(function(c){
    return '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
      (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>';
  }).join("");
}

// SHELL built once (so the filter keeps focus across background refreshes); the
// body redraws on every poll and on every filter change.
function renderPromaxMatrix(v) {
  if (document.getElementById("pmxtable")) { drawPromaxMatrix(); return; }
  v.innerHTML = '<div class="controls">'+
    '<select id="pmxfilter">'+
      ['all|전체 reason','resolved|resolved','model_miss|model_miss','infra_invalid|infra_invalid(무효)','ambiguous|ambiguous(사람검토)']
        .map(function(o){var p=o.split("|");return '<option value="'+esc(p[0])+'"'+(PMX_FILTER.state===p[0]?" selected":"")+'>'+esc(p[1])+'</option>';}).join("")+
    '</select> <span class="muted" id="pmxcount"></span></div>'+
    '<p class="muted">숫자는 전부 리포트에 <b>기록된 공식 집계</b>를 그대로 표시 — 이 화면은 분모를 계산하지 않는다. '+
    '아래 필터는 reason 표에만 걸리며 상단 카드의 assigned/커버리지는 바뀌지 않는다.</p>'+
    '<div id="pmxtable"></div>';
  var fi = document.getElementById("pmxfilter");
  if (fi) fi.onchange = function(){ PMX_FILTER.state = fi.value; drawPromaxMatrix(); };
  drawPromaxMatrix();
}

// BODY: the reason drilldown + the per-language table. The language table walks
// the SAME assigned manifest as the cards — invalid and missing rows included —
// so a language can never look clean by having its broken instances hidden.
function drawPromaxMatrix() {
  var el = document.getElementById("pmxtable");
  if (!el) return;
  var run = pmxSection();
  if (!run) { el.innerHTML = '<p class="muted">promax 공식채점 리포트 없음</p>'; return; }
  var d = run.officialGrade.display;
  var reasons = d.reasons.filter(function(x){ return PMX_FILTER.state === "all" || x.state === PMX_FILTER.state; });
  var cnt = document.getElementById("pmxcount");
  if (cnt) cnt.textContent = reasons.length + " reason";
  var h = '<h3>reason 드릴다운</h3><table><thead><tr><th class="inst" style="text-align:left">state</th>'+
    '<th style="text-align:left">reason</th><th>건수</th></tr></thead><tbody>';
  for (var i = 0; i < reasons.length; i++) {
    var r = reasons[i];
    var cls = r.state === "infra_invalid" ? ' class="og-invalid"' : (r.state === "ambiguous" ? ' class="og-missing"' : '');
    h += '<tr><td'+cls+'>'+esc(r.state)+'</td><td class="inst">'+esc(r.reason)+'</td>'+
      '<td style="text-align:center">'+esc(r.count)+'</td></tr>';
  }
  h += '</tbody></table><h3>언어별 (assigned 전량 · 무효/미채점 포함)</h3>'+
    '<table><thead><tr><th class="inst" style="text-align:left">언어</th><th>assigned</th><th>resolved</th>'+
    '<th>model_miss</th><th>무효</th><th>모호</th><th>미채점</th><th style="text-align:left">커버리지</th></tr></thead><tbody>';
  for (var j = 0; j < d.languages.length; j++) {
    var g = d.languages[j];
    h += '<tr><td class="inst">'+esc(g.language)+'</td>'+
      '<td style="text-align:center"><b>'+esc(g.assigned)+'</b></td>'+
      '<td style="text-align:center">'+esc(g.resolved)+'</td>'+
      '<td style="text-align:center">'+esc(g.model_miss)+'</td>'+
      '<td style="text-align:center" class="og-invalid">'+esc(g.infra_invalid)+'</td>'+
      '<td style="text-align:center">'+esc(g.ambiguous)+'</td>'+
      '<td style="text-align:center" class="og-missing">'+esc(g.missing)+'</td>'+
      '<td class="muted">'+esc(g.coverage)+'</td></tr>';
  }
  el.innerHTML = h + '</tbody></table>';
}

SWE_FAMILY_VIEWS["promax"] = { cards: renderPromaxCards, matrix: renderPromaxMatrix };`

/**
 * THE ProMax registration. One entry in the UI family-view registry — label plus
 * client bundle — and nothing else anywhere in the dashboard changes.
 */
export const PROMAX_FAMILY_VIEW: SweFamilyView = {
  family: "promax",
  label: "SWE-bench ProMax",
  client: { style: PROMAX_CLIENT_STYLE, script: PROMAX_CLIENT_SCRIPT },
}
