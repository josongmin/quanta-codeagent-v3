# 적대 어딧 — methodology-2026-06 종합 vs round3 어딧 정합성

> 작성 2026-07-01. 대상: `methodology-2026-06/{tex-t,lstar,openhands,reproagent,repro-specific,grading-oracle}.md` + `README.md`.
> 대조축: `audit/round3-synthesis.md`(살아남은 lever = S1 loc-targets-gold / S2 vacuous-guard / S3 oracle-loop, "gain modest"),
> `audit/round3-final-adversary.md`("새 lever 짓지 마라, 이미 지은 것 측정하라 / docker-free지만 execution-free 아님").
> 임무: (1) 근거 실재성 스팟체크, (2) 이전 어딧과 모순/보강 판정, (3) final-adversary "plan 변경 0"과 충돌 여부, (4) over-claim 스캔.

---

## 1. 근거 실재성 스팟체크 — 결과: 코드 근거 조작 0, 외부 blog 근거 1건 unverifiable(문서가 이미 표기)

원본 소스를 직접 열어 대조. **조작/hallucination 없음.** 의심 지목된 4개 전부 실재:

| 인용 | 문서 | 검증 | 판정 |
|---|---|---|---|
| ReProAgent post-fix-viability `prompt_template.py:228-238` | reproagent.md | 실파일 `:228` "### 3. POST-FIX VIABILITY CHECK", `:236` lambda serialization 예시 정확 | ✅ **정확** (verbatim) |
| 곱셈게이트 TDD `run_evaluation.py:731-740` | grading-oracle.md/README | 실파일 `:731-732` sympy 분기(`fail_before*pass_after`), `:734` `cov_score*fail_before*pass_after`, `:737-740` resolved 정확 | ✅ **정확** |
| SWT `get_resolution_success` `grading.py:205-222` | grading-oracle.md | `:219` added_p2f, `:220` not_added_x2f, `:222` return — 코드 스니펫 문자 단위 일치 | ✅ **정확** |
| SWT 6-container `run_evaluation.py:178-180` | grading-oracle.md/README | `:178` patch_ids 6개, `:179` test_patches, `:180` code_patches(post에 golden_code_patch) 정확 | ✅ **정확** |
| tex-t sympy-13031 "cross-grid verbatim" 스크립트 | tex-t.md | 실 predictions에 `Matrix.hstack`·`(0,6)=CORRECT/return 0`·`(0,3)=BUG/return 2` 전부 존재. predictions 432줄 일치 | ✅ **정확** |
| ReProAgent `MAX_FEEDBACK_TIMES=20`, KG CALLS dead `in_memory_store.py:119` | reproagent.md | `config.py:34` =20, `:119` `self.calls` 초기화 정확 | ✅ **정확** |
| vacuous-guard `repro-oracle-calibration.ts:107-153`, regression `regression-oracle.ts:141-147` | grading-oracle.md | 실파일 `baseResolved`/`toRegressionGreen` 존재, fail-open 설계 정확 | ✅ **정확** |
| grep-0 negatives: flip/invert(repro-specific), crossValidat/peer(tex-t), cov_score(grading) | 3문서 | src 재grep: flip=무관매치만, crossCandidate=0, cov_score in eval=0 | ✅ **정확** |

**단 하나 unverifiable (그러나 문서가 이미 자백):** L\*Agent "SRI reproduce-alone −13pp / GPT-5-mini 47.5%" (lstar.md §1e, README C, ★★3 근거).
- 이 수치는 **SRI blog(`fixedcode`)에서만** 오고 로컬 캐시/독립 데이터 없음. 검색결과 `60.5→88.5`는 옛 문서(`best-practice-repro-loop.md:354`)에도 있으나, **−13pp/47.5%는 methodology 문서군에만 존재.**
- **면책 근거:** lstar.md는 서두에 "⚠️ 정정 1 — L\*Agent 소스는 **비공개**, blog는 문장 단위만 노출, §1(a)~(f)는 삼각측량이지 소스 재현 아님"을 명시. 즉 조작이 아니라 **표기된 blog-근거**. 다만 ★★3(abstain gate)의 정량 토대 전체가 이 단일 blog 수치에 걸려 있고 우리가 재현 불가 → **confidence를 blog-tier로 낮춰야** (§4 참조).

**스팟체크 총평:** 코드/predictions 근거는 **8/8 정확**, 조작 0. 외부 blog 근거 1건만 unverifiable이나 문서가 이미 "비공개·삼각측량"으로 표기 → **근거 실재성 통과.**

---

## 2. round3 S1/S2/S3와의 정합 — 결과: **보강(모순 아님). 매핑 1:1 성립.**

README §B의 "신규 흡수 3개"(★★1 flip / ★★2 change-coverage / ★★3 abstain)를 round3 S축에 매핑:

### ★★2 change-coverage ΔC 곱셈게이트 → **S2(vacuous-guard)의 강화. 새 축 아님.**
- round3 S2 = "vacuous-guard(base-resolved면 무효) = **곱셈게이트의 절반(fail_before)**, correctness-headroom ~13% 상한, MED."
- grading-oracle.md §3-4가 **정확히 같은 프레이밍**: "우리 vacuous-guard는 fail_before 유사 = **곱셈게이트 절반**, cov 항이 없어 over-narrow를 수치로 못 잼."
- 즉 change-coverage는 round3가 "절반만 있다"고 한 그 게이트의 **나머지 절반(cov_score 항)**이다. **완전 정합 — S2 강화.** 모순 0.
- 교차확인: round3-final-adversary §2도 "(C) change-coverage 게이트의 *출력측*(도달성 판정+reject seam)만 반쪽 신규"라 이미 지목. methodology가 이걸 재확인.

### ★★1 AssertFlip flip → **round3에 존재(테이블 마지막줄), confidence LOW로 이미 격하됨.**
- round3-synthesis §4 confidence table: "**AssertFlip-style flip | causal=partial(repro품질) | confidence=LOW | repro 품질 lever지 fix-수렴 misaligned.**"
- **여기가 유일한 긴장점.** README는 flip을 **★★1(최우선)**로, repro-specific.md는 "**최대 novel 갭**"으로 올렸다. round3는 같은 flip을 **LOW**로 깔았다.
- 모순인가? **부분 모순 — 우선순위 등급이 역방향.** 단 축(axis)은 일치(둘 다 "repro 품질 lever, synthesis 우회"). round3의 LOW 사유("fix-수렴 misaligned")는 **round3-final-adversary §4의 over-fit 논증**(SWT repro≠SWE patch, 전이통로는 (H)뿐)과 같은 뿌리. methodology의 ★★는 **"grep 0=완전 미보유 + ablation −19%p"라는 novelty·효과 크기** 기준이고, round3의 LOW는 **"우리 target(patch) 전이 정합"** 기준. **둘은 다른 척도라 직접 모순은 아니나, README가 round3의 LOW 판정을 인용·반영하지 않고 ★★로 올린 것은 calibration 누락**(§4에서 감점).

### ★★3 abstain gate → **round3에 없던 새 축. 그러나 "gain modest"와 충돌 아님.**
- round3 S1/S2/S3 어디에도 "행동적 abstain(무행동=성공)"이 없다. lstar.md가 SRI blog로 **새로 도입**한 축.
- 충돌 검사: round3 "gain modest"는 **지배드라이버(repo 1차·model+scaffold 2차 12.8pp)가 addressable lever를 dwarf**한다는 것. abstain은 addressable lever의 **개수를 늘릴 뿐**, 지배드라이버 명제를 건드리지 않는다.
- **오히려 abstain은 round3 D3(assertion-strength null)과 정합:** round3는 "강하게 단언=brittle 역효과"를 발견했고, SRI는 "reproduce 강제만=역효과(−13pp), abstain reframe이 진짜 lever"라 함 → **둘 다 '순진한 강제는 역효과'라는 같은 방향.** 모순 없음.
- **단 abstain은 SWT/SWE 공통으로 우리 파이프라인에 구조적 부재**(lstar.md §1e·§2e: 우리 abstain은 전부 declared-expected-**matcher** 문맥, 에이전트 무제출 결정 아님)이고 **효과는 단일 blog 수치뿐** → 새 축이되 **미검증 새 축**.

**§2 판정:** 3개 중 **change-coverage=S2 강화(완전 정합), abstain=새 축이나 gain-modest와 무충돌(D3와 오히려 정합), flip=축 일치하나 우선순위 등급이 round3 LOW와 역방향(calibration 긴장).** **모순으로 round3를 뒤집는 것은 0.** 2/3 보강, 1/3 등급 불일치.

---

## 3. final-adversary "plan 변경 0, 측정레일부터"와의 충돌 — 결과: **README 본문은 정합, 표층 ★★ 프레이밍이 위반 소지.**

final-adversary 핵심: "(H)오라클루프·(C)grounding·acceptance **전부 LANDED·default-OFF·UNMEASURED** → 새 lever 짓지 말고 **측정 rail부터**. docker-free지만 execution-free 아님(6-run)."

- **정합 지점:** README 마지막 줄 "**전부 measure-first, default-OFF, 우리 SWE f2p로 A/B. graph/tool-guide/insertion은 이미 NULL 확정이라 제외.**" + openhands.md §3-4 "**plan 변경 없음(측정 rail 우선)**" + tex-t.md §2 "SWE f2p로 A/B(SWT 점수 추격은 비추)" + repro-specific.md §2 "전부 measure-first." → **methodology 문서 다수가 final-adversary의 measure-first·over-fit 경계를 명시 계승.** 정합.
- **위반 소지 1 (프레이밍):** README §B가 flip/change-coverage/abstain을 "**진짜 없음 — 흡수 후보 ★★**"로 올리고 요약에 "**가장 뾰족한 신규 흡수 3개**"라 표현. final-adversary는 "**새 lever 짓지 마라, ①NULL에 측정쓰지마 ②측정rail부터**"였다.
  - flip = final-adversary가 confidence-table에서 **LOW**로 깐 것 + §4에서 "(A)(D)(E)flip은 patch로 전이 안 될 수 있다"고 **측정 예산 쓰지 말라 지목**한 바로 그 항목. README ★★1은 이와 **역행.**
  - change-coverage = final-adversary §2가 "(H) 종속, (H) 측정 후로 미뤄도 됨"이라 **후순위**로 깐 것. README ★★2는 이를 **선순위로 승격** → 긴장.
  - abstain = final-adversary에 **아예 없음**(SRI blog 새 도입). "새 lever 짓지 마라"에 **정면 저촉될 수 있는 유일 진짜 신규 축.**
- **위반 소지 2 (측정비용):** methodology 문서 어디에도 final-adversary §3의 **"docker-free지만 execution-free 아님 = per-instance 2~6 run"** 비용 정정이 **재기재되지 않았다.** grading-oracle.md는 6-container를 정확히 서술하나(§1b), "이게 곧 측정 rail 비용"이라는 final-adversary의 **핵심 결론을 연결 안 함**. → methodology가 measure-first를 말하면서 **측정이 싸지 않다는 정정을 누락** = final-adversary의 유일 실질 산출물을 빠뜨림.

**§3 판정:** **본문 measure-first는 정합, 그러나 (a) ★★ 우선순위가 final-adversary의 flip=LOW·change-coverage=후순위 판정을 뒤집고, (b) abstain은 "새 lever 금지"에 저촉될 새 축이며, (c) 6-run 측정비용 정정을 누락.** README를 "카탈로그(조합 설계용 재료)"로 읽으면 정합이나, "★★=지금 흡수하라"로 읽으면 final-adversary 위반. **README가 명시적으로 "measure-first, 지면 knob삭제"라 못박아 위반을 봉합했으나, ★★ 라벨과 "가장 뾰족한 신규 흡수 3개" 표현이 그 봉합을 약화.**

---

## 4. over-claim 스캔 — 결과: **확정 negative 대부분 계승, 그러나 flip ★★와 abstain ★★는 근거 대비 과함.**

확정된 negative를 methodology가 무시했는가:

| 확정 negative (이전 어딧) | methodology 처리 | 판정 |
|---|---|---|
| tool-guide 실측 0/13 | openhands.md §3-5 "(d)desc-fewshot 미측정·저영향·흡수 우선순위 낮음" | ✅ **계승** (0/13 수치 자체는 미인용이나 결론 일치) |
| insertion NULL(p=1.0) | README C·lstar.md §3 "within-system Fisher p=1.0로 반증, 비-lever" | ✅ **계승** |
| graph 반증(SOTA 0개 semantic graph) | README C·repro-specific.md §2 "Echo graph=substring트리, semantica 정당성 못줌" | ✅ **계승** |
| multi-test NULL(1.47=1.47) | (methodology 문서엔 명시 인용 없음, README도 언급 안 함) | ⚠️ **누락**(D축이나 methodology 스코프 밖이라 무해) |
| assertion-strength NULL(53% non-mono) | lstar.md는 assertion-CORRECTNESS만 다룸, strength-null 미인용 | ⚠️ **부분 누락** |
| **flip = round3 confidence LOW** | README ★★1(최우선), repro-specific "최대 novel 갭" | 🔴 **역행 — over-claim** |
| **abstain = 단일 SRI blog 수치, 재현불가** | README ★★3, "L\*Agent 84%의 진짜 lever" | 🔴 **과한 confidence — over-claim** |

**over-claim 2건 적시:**

1. **flip ★★1 over-claim.** repro-specific.md·README가 flip을 "최우선 ★★/최대 novel 갭"으로 올린 근거는 **"grep 0(완전 미보유) + AssertFlip ablation −19%p".** 그러나:
   - −19%p는 **AssertFlip 자기 시스템의 SWT 43.6% 내부 ablation**이지 우리 파이프라인·우리 SWE-patch task에서의 효과 아님. round3-final-adversary §4가 명시: "(E)flip은 patch로 전이 안 될 수 있다."
   - AssertFlip 자체가 **SWT 43.6%**로 이 문서군 스캐폴드 중 **최하위**(TEX 87·L\* 84·OpenHands 79.8·ReProAgent 69.7·Echo 66.28 대비). 최하위 시스템의 간판 기술을 "최우선 흡수"로 올리는 것은 **effect-size 논증의 절반(그 시스템의 절대 점수)을 무시.**
   - repro-specific.md 자신이 flip prediction의 "mock 남용 resolve 33%·하드코딩 brittle·coverage 0.703(<e-Otter 0.857)"을 적어놓고도 ★★로 올림 → **자기 문서 내 반증 데이터와 등급 불일치.**
   - **calibrate: flip은 ★(측정후보)이지 ★★(최우선) 아님.** round3 LOW가 옳다.

2. **abstain ★★3 over-claim(confidence).** "L\*Agent 84%의 진짜 lever"라는 강주장의 **유일 근거가 SRI blog −13pp/47.5% 단일 수치**이고 로컬 재현 불가. 게다가 그 수치는 **SWE-fix task**(lstar.md 자신이 "정정 2 — SWT 84%의 lever 아님"이라 명시)인데, README 요약은 "abstain gate(L\*Agent 진짜 lever)"로 **SWT/SWE 구분을 뭉갬.** → **문서 내부 모순**(§1e는 "SWT lever 아님", README는 "L\*Agent 진짜 lever"). calibrate: abstain은 **blog-tier confidence의 실험 후보**이지 "진짜 lever" 확정 아님.

---

## 최종 판정

**round3 결론(측정레일부터·gain modest)을 이번 종합이 뒤집을 근거 = 없다.**

1. **근거 조작 없음.** 코드/predictions 인용 8/8 정확(post-fix-viability 228-238·곱셈게이트 731-740·get_resolution_success 205-222·6-container 178-180·tex-t verbatim·grep-0 전부 실재). 외부 blog 1건(SRI −13pp)만 재현불가이나 문서가 "비공개·삼각측량"으로 이미 표기 → 조작 아님, confidence만 낮추면 됨.

2. **round3 S1/S2/S3와 모순 아니라 보강.** change-coverage=S2(vacuous-guard)의 나머지 절반(완전 정합), abstain=새 축이나 "gain modest"와 무충돌·오히려 D3(강제=역효과)와 정합, flip=축은 일치하나 등급만 역방향.

3. **gain-modest·지배드라이버(repo 1차·model 12.8pp 2차) 명제는 그대로 유효.** methodology 어디에도 이를 반증하는 새 정량 없음. abstain의 SRI 수치조차 SWE-**fix** task라 우리 SWT 종합에 직접 안 붙음.

4. **final-adversary "plan 변경 0·측정레일부터"와 본문은 정합, 표층 ★★ 프레이밍이 긴장.** README를 "재료 카탈로그"로 읽으면 정합(measure-first·지면삭제 명시). 그러나 (a) flip ★★1은 final-adversary의 LOW·"전이 안 됨" 판정을 역행, (b) change-coverage ★★2는 "(H) 후순위"를 승격, (c) abstain은 "새 lever 금지"에 저촉될 새 축, (d) **6-run 측정비용 정정을 누락**(final-adversary 유일 실질 산출물).

5. **over-claim 2건: flip ★★1(최하위 43.6% 시스템 기술·전이 미검증·자기문서 brittle 데이터 무시 → ★로 강등), abstain ★★3(단일 blog·SWT/SWE task 뭉갬·문서내부 모순 → blog-tier로 강등).** 나머지 확정 negative(tool-guide·insertion·graph)는 전부 정확히 계승.

**교정 권고(수정 아님, 판정만):**
- README ★★ 등급을 round3 confidence-table에 맞춰 재정렬: **change-coverage=유일하게 ★★ 유지 가능(S2 정합)**, flip→★, abstain→★(blog-tier).
- README에 final-adversary §3 "**측정=docker-free지만 execution-free 아님(per-instance 2~6 run)**" 한 줄 추가해 measure-first를 정직하게.
- lstar.md README 인용에서 abstain을 "L\*Agent **SWT** 진짜 lever"가 아니라 "**SRI SWE-fix** 실험 수치(우리 재현불가)"로 격하.

**결론 한 줄:** 이번 종합은 round3를 **뒤집지 않고 재확인**한다 — 근거는 실재하고(코드 8/8), 신규 3축 중 2개(change-coverage·abstain)는 round3와 정합·무충돌이며, 유일 긴장은 **flip을 최우선으로 올린 등급 인플레와 6-run 비용 누락**뿐. **round3 정본("측정레일부터·gain modest")이 여전히 맞고, methodology는 조합용 재료 카탈로그로서 유효하되 ★★ calibration 2건만 과하다.**
