/**
 * The pro/live FAMILY shell's client script, extracted out of `page.ts`.
 *
 * `page.ts` is size-pinned (see `projectors/structural.test.ts` — the dashboard's
 * no-amnesty local god-module floor), so the shell pays for every line it gains
 * by extracting one. C-D needed a SHARED "best 캠페인" card builder — the defect
 * was precisely that the card was spelled twice and the coverage fix reached one
 * copy — so the family cards, the family matrix and that shared builder moved
 * here together. They are one cohesive unit: the family view's rendering.
 *
 * It is a SCRIPT STRING rather than a module because the browser receives the
 * dashboard as a single self-contained document (no bundler, no network fetches);
 * the suite projectors contribute their client code the same way. `page.ts`
 * interpolates it verbatim, so the shipped bytes are unchanged by the move and a
 * test that brace-matches a function out of the rendered page still finds it.
 */
export const FAMILY_CARDS_SCRIPT = /* js */ `
// Any-pass fold over ONE SWE family view's runs (the pro/live view scope), unsplit
// (no arm semantics here). Pure over DATA.runs. Measurement-hole EXCLUSION mirrors the
// sibling folds so pro/live stays consistent with them: a re-runnable throttle/infra
// hole (FLAG-B fail.reRunnable, like the verified view) or an agent-crash (D1) is NOT a
// capability miss — skip it (else the jun-20 throttle/miss confound re-opens here).
function famOurResults(fam) {
  const out = {};
  for (const r of (DATA.runs || []).filter(r => r.viewId === fam)) {
    for (const pi of (r.perInstance || [])) {
      if (pi.error && pi.error.kind === "agent-crash") continue;
      if (!pi.passed && pi.fail && pi.fail.reRunnable) continue;
      if (out[pi.id] === undefined || pi.passed) out[pi.id] = pi.passed;
    }
  }
  return out;
}

// The ONE "best 캠페인" card. C-D: this card is rendered by BOTH the verified shell
// and the pro/live family shell, and it was spelled out twice — so the C1 fix that
// put coverage beside the rate reached one copy and the family cards kept quoting a
// bare resolved/assigned pair. A rate and its coverage now leave the same function,
// which is what makes "every surface that prints a rate prints coverage" structural
// rather than a convention two surfaces have to remember.
function bestCampaignCard(camps, emptyNote) {
  const ranked = (camps || []).slice().sort((a,b)=> (b.resolved/Math.max(1,b.total)) - (a.resolved/Math.max(1,a.total)))[0];
  if (!ranked) return ["best 캠페인", "—", emptyNote];
  return ["best 캠페인", ranked.resolved + "/" + ranked.total,
          ranked.key + (ranked.coverage ? " · 커버리지 " + ranked.coverage : "")];
}

// A REFUSED artifact contributes no run, no campaign and no score — so it leaves the
// campaign's membership AND its denominator, which is the same shrunken-denominator
// defect C-C closed for ungraded members, arriving through the REFUSAL channel instead.
// C-B widened that channel: a section that cannot be reconciled against its own run rows
// is now refused at decode. So the loss is rendered NEXT TO THE RATE, on the same card
// row, in ONE spelling every card surface appends (the C-D lesson).
//
// Scoped by the shell's own suite dispatch, never a hardcoded suite id: a view shows the
// refusals its own suite claimed. Appends NOTHING when nothing was refused, so a healthy
// dashboard is byte-identical.
function withRefusedCard(cards) {
  var mine = ((DATA && DATA.quarantine) || []).filter(function(x){ return x.suite === suiteOfView(BENCH); });
  if (!mine.length) return cards;
  var name = String(mine[0].file || "").split("/").pop();
  return cards.concat([["거부된 리포트", mine.length,
    "점수·분모 미포함 — " + name + ": " + String(mine[0].reason || "").slice(0, 120)]]);
}

// pro/live summary cards — FAMILY-scoped (P3-D: a pro/live title must never sit over verified
// numbers). any-pass across the family's runs; campaign best from the same family only.
function renderFamCards() {
  const fold = famOurResults(BENCH);
  const ids = Object.keys(fold);
  const solved = ids.filter(function(i){ return fold[i] === true; }).length;
  const camps = (DATA.campaigns || []).filter(c => c.viewId === BENCH);
  const runCount = (DATA.runs || []).filter(r => r.viewId === BENCH).length;
  const cards = withRefusedCard([
    ["해결 / 실행", solved + " / " + ids.length, "family=" + BENCH + " · any-pass(런 합산)"],
    bestCampaignCard(camps, "이 family 캠페인 없음"),
    ["리포트 파일", runCount, camps.length + " 캠페인"],
  ]);
  document.getElementById("cards").innerHTML = cards.map(c =>
    '<div class="card"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div>'+
    (c[2]? '<div class="muted" style="font-size:10px">'+esc(c[2])+'</div>':'')+'</div>').join("");
}

// pro/live per-instance matrix — the family's own rows (misses first), never verified data.
function renderFamMatrix(v) {
  const fold = famOurResults(BENCH);
  const ids = Object.keys(fold).sort(function(a,b){
    if (fold[a] !== fold[b]) return fold[a] ? 1 : -1; // misses first
    return a.localeCompare(b);
  });
  const runCount = (DATA.runs || []).filter(r => r.viewId === BENCH).length;
  let h = '<p class="muted">family='+esc(BENCH)+' · '+ids.length+' instances · ✅=any-pass across '+runCount+' run(s)</p>';
  h += '<table><thead><tr><th class="inst" style="text-align:left">instance</th><th>결과</th></tr></thead><tbody>';
  for (const id of ids) {
    h += '<tr><td class="inst">'+esc(id)+'</td><td style="text-align:center">'+
      (fold[id] ? '<span class="q-ok">✅</span>' : '<span class="q-no">❌</span>')+'</td></tr>';
  }
  v.innerHTML = h + (ids.length ? '' : '<tr><td colspan="2" class="muted">이 family 리포트 없음</td></tr>') + '</tbody></table>';
}
`
