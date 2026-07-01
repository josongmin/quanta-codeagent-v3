# Round-2 적대 어딧: insertion 구조(rescue) — Round-1 "insertion은 인과 레버 아님" 결론을 적대적으로 공격

> 작성일 2026-07-01. 3-라운드 적대 어딧의 Round-2.
> 임무: Round-1 결론("insertion은 repo/model/assertion에 교락된 비-인과 변수")을 **공격**해 insertion을 **구조(rescue)**한다. devil's advocate.
> 데이터: `.extracted_source/repro-scaffolds/_predictions/*`, `reproagent/outputs_gpt_5_mini/*`, ETH SRI 서버 `https://files.sri.inf.ethz.ch/swt-bench/`.
> **벤치마크 = SWT-bench Verified** (테스트 재현). resolved = harness가 매긴 fail-to-pass + 회귀무변동 라벨.

---

## 헤드라인 (10줄 요약 — L*Agent within-system 숫자 회수 여부 먼저)

1. **회수 성공.** L*Agent run_instance 로그(`lstar_agent_verified.zip`, 17MB, 500 인스턴스)를 ETH 서버에서 재페치했고, zip 안에 **공식 SWT-bench가 이미 채점한 per-instance `report.json`(resolved 불린 포함)이 embedded**돼 있었다. 재채점 불필요 — `logic_star_ai/<id>/report.json`을 그대로 읽어 500/500 resolved 라벨 확보(applied=500/500). 패치는 `_predictions/lstar_agent_verified.json`과 50/50 byte-identical 검증.
2. **결정적 within-system 숫자 (이 어딧 전체에서 가장 가치 있는 수치):** L*Agent 한 model+scaffold 안에서 **insert 81.7% (214/262) vs new-file 79.2% (126/159), delta = +2.4pp.** existing-file(insert+modify) vs new-file = 79.5% vs 79.2%, **Fisher p=1.0, OR=1.014.** style은 사실상 null.
3. **within-repo 통제 후에도 null.** 두 스타일을 모두 쓴 repo로 풀링: insert 82.0% vs new-file 80.1%, **delta +1.9pp.** repo별 delta는 **부호가 뒤집힘**(astropy +19, scikit +14 vs sphinx −26, pylint −50, pytest −7.6, sympy −4). **단 하나의 repo도 Fisher p<0.05 아님**(전부 p≥0.158, 대부분 ~1.0). 노이즈.
4. **Resolved-bias 공격 (Task 2): 무효.** e-Otter/AssertFlip/OpenHands `evaluation.json`은 `resolved_ids` **와** `unresolved_ids`를 **둘 다** 담고, `total = resolved+unresolved(+error)`로 전수 attempted set이다(disjoint 검증). Round-1 McNemar contingency 재현 성공(eOtter vs AssertFlip net +32, vs OpenHands net −4). **denominator 편향 없음.**
5. **Steelman 1차 (Task 3): fixture 상속으로 통과한 insert 5건 확보** (django-16255 `self.client`+URLconf, 15103 `self.engine`, 15957 `self.book1/author1/2` setUpTestData, 15022 `self.factory/superuser`, 14752 `self.factory/url/opts/as_view_args`). 전부 patch에 setUp 미정의=순수 상속 검증.
6. **그러나 steelman 자기-반증:** 이 5건은 **전부 순수 new-file 시스템(ReProAgent)도 resolved**했다(5/5). 즉 fixture 상속은 **편의지 인과적 필요조건이 아님** — new-file 스캐폴드가 동등 상태를 재구축해 같은 인스턴스를 풀었다.
7. **진짜 인과 insertion win은 전 데이터셋에 2건뿐.** "insert-fixture가 resolved & 그걸 시도한 모든 new-file 시스템이 fail"인 케이스: **django-12143**(OH만 시도·실패, n=1, 약함), **django-16950**(OH+RA 둘 다 실패). 후자가 유일한 강한 케이스: 공유 fixture 파일(`admin_inlines/models.py`+`admin.py`)에 신규 모델·admin 등록을 **편집**해 모듈 전역 DB/라우팅에 주입 → 순수 new-file이 깔기 어려운 advantage.
8. **Verdict:** insertion은 인과 레버로 **부활하지 못한다.** within-system·within-repo 양쪽에서 통계적으로 null(p=1.0). 살아남는 건 **repo×시나리오-조건부 micro-effect**뿐 — "shared test-infra 파일을 편집해야 하는 소수(~2/500=0.4%) 케이스에서 insert가 new-file보다 셋업이 싸다." 이건 약한·조건부·거의-null 레버다.
9. Round-1은 **over-corrected 아님.** 오히려 within-system 데이터가 없어 "분리 불가"라 했던 칸을 Round-2가 메웠고, 결과는 Round-1 방향을 **강화**한다(교란이 아니라 style 자체가 거의 무신호).
10. 단 하나 Round-1 정정: "within-system 측정 자체가 불가능"(round1 line 130)은 **틀렸다** — L*Agent embedded report로 가능했고, 측정하니 null이었다.

---

## TASK 1 — L*Agent within-system insert vs new-file (회수 성공, 결정적)

### 어떻게 회수했나 (재채점 불필요)

Round-1은 "L*Agent eval JSON이 서버에 없다 → resolved 라벨 얻으려면 harness 재구현 필요 → 미수행"이라 비교를 포기했다. **이게 과소평가였다.** 실제로:

- `run_instance_swt_logs/swt-verified/lstar_agent_verified.zip`을 받으니 안에 3개 디렉토리: `pred_pre__logic_star_ai/`, `pred_post__logic_star_ai/`, 그리고 **`logic_star_ai/`**.
- `logic_star_ai/<instance>/report.json`은 **공식 grading이 이미 산출한 per-instance 리포트**다 — `resolved`(불린), `tests_base/tests_pred/tests_gold`(FAIL_TO_PASS 세트), coverage까지 전부 포함. 즉 `grading.py:get_resolution_success`의 출력이 그대로 직렬화돼 있다.
- 따라서 **재채점(docker·log 파싱) 불필요.** 500개 report.json을 읽어 resolved 라벨을 그대로 회수: **resolved=397/500 (79.4%)**, applied=500/500.
- (참고: Round-1이 인용한 aggregate "84%"는 다른 집계/버전. 이 embedded report 기준은 79.4%. 어느 쪽이든 within-system **상대** 비교엔 영향 없음 — 같은 라벨 소스로 insert/new를 가르므로.)
- 패치 SSOT는 Round-1과 동일하게 `_predictions/lstar_agent_verified.json` 사용. zip의 `model_patch.diff`와 50/50 byte-identical → 분류 일관성 보장.
- 분류기는 Round-1과 동일: `is_new = ('new file mode' in patch) or ('--- /dev/null' in patch)`; pure-insert = `not is_new and deleted==0 and added>0`; 나머지 existing-modify.

### 결정적 결과 — style은 within-system에서 null

```
L*Agent (logic_star_ai, n=500, single model+scaffold)
  insert  : 214/262 = 81.7%
  new     : 126/159 = 79.2%
  modify  :  57/79  = 72.2%

  INSERT   rate = 214/262 = 81.7%
  NEW-FILE rate = 126/159 = 79.2%
  DELTA (insert − newfile) = +2.4 pp

  EXISTING-FILE (insert+modify) = 271/341 = 79.5%
  NEW-FILE                      = 126/159 = 79.2%
  2x2: existing[res=271,unres=70] new[res=126,unres=33]
  Fisher exact two-sided p = 1.0,  odds ratio = 1.014
```

**한 model·한 scaffold 안에서 insert와 new-file의 resolved율이 통계적으로 구별 불가(p=1.0, OR≈1).** Round-1이 "교란 때문에 못 본다"던 그 신호는, 교란을 제거하고 보니 **존재하지 않았다.** insert 우위 +2.4pp는 n=262/159 규모에서 완전히 노이즈 범위.

### within-repo 통제 (repo까지 fix해도 null)

두 스타일을 모두 쓴 repo만 풀링하면 repo 난이도까지 통제된다:

| repo | insert | new-file | delta_pp | Fisher p |
|---|---|---|---|---|
| astropy | 6/7 (86%) | 10/15 (67%) | +19.0 | 0.616 |
| django | 121/144 (84%) | 34/42 (81%) | +3.1 | 0.642 |
| matplotlib | 9/10 (90%) | 21/24 (88%) | +2.5 | 1.000 |
| pydata/xarray | 9/9 (100%) | 12/13 (92%) | +7.7 | 1.000 |
| pylint | 1/3 (33%) | 5/6 (83%) | **−50.0** | 0.226 |
| pytest | 5/6 (83%) | 10/11 (91%) | −7.6 | 1.000 |
| scikit-learn | 24/24 (100%) | 6/7 (86%) | +14.3 | 0.226 |
| sphinx | 4/19 (21%) | 8/17 (47%) | **−26.0** | 0.158 |
| sympy | 35/39 (90%) | 15/16 (94%) | −4.0 | 1.000 |
| **POOLED** | **214/261 (82.0%)** | **121/151 (80.1%)** | **+1.9** | — |

**핵심:** (a) 풀링 delta +1.9pp — 무의미. (b) repo별 delta **부호가 양쪽으로 뒤집힘** (astropy/scikit는 insert가, sphinx/pylint/pytest/sympy는 new-file이 더 높음). (c) **9개 repo 중 Fisher p<0.05가 단 하나도 없음** (최소 p=0.158, sphinx). astropy +19pp·sphinx −26pp는 n≈7~19의 small-sample 노이즈다.

→ **insertion은 어떤 단일 repo에서도 통계적으로 유의한 우위를 만들지 못한다.** repo-conditional rescue 시도도 실패.

---

## TASK 2 — Resolved-bias 공격 (denominator 검증): Round-1 무효화 못 함

가설: e-Otter/AssertFlip `evaluation.json`이 resolved-only를 담아 McNemar contingency가 편향됐다면 Round-1이 무너진다.

검증 결과 — **편향 없음.** 각 파일 top-level 구조:

```
e-Otter++ : total=432  resolved=263  unresolved=169  error=0   → 263+169 = 432 ✓
AssertFlip: total=326  resolved=188  unresolved=138  error=0   → 188+138 = 326 ✓
OpenHands : total=475  resolved=267  unresolved=197  error=11  → 267+197+11 = 475 ✓
```

- `resolved_ids`(263/188/267)와 `unresolved_ids`(169/138/197)가 **둘 다 명시**돼 있고, 교집합 = 0 (disjoint 검증).
- denominator = 전수 attempted set (resolved-only 아님).
- Round-1 McNemar 재현: **eOtter(insert) vs AssertFlip(nf) common=325, Aonly=65, Bonly=33, net=+32** / **eOtter vs OpenHands common=400, Aonly=58, Bonly=62, net=−4** — Round-1 테이블과 정확히 일치.

→ Round-1의 contingency는 full instance set에 기반했고 resolved-bias가 없다. **이 공격선은 Round-1을 흔들지 못함.**

---

## TASK 3 — Steelman insertion (가장 강한 인과 케이스 + 자기-반증)

### 1차 steelman: fixture 상속으로 통과한 insert 5+건 (메커니즘 인용)

L*Agent resolved-insert 중 **setUp/setUpTestData를 patch에 정의하지 않고** 클래스 상속 fixture를 읽는 케이스 66건. 가장 강한 5건(상속 attr이 patch 내 미할당 검증 완료):

**(S1) django-16255** — `HTTPSitemapTests(SitemapTestsBase)`에 메서드 append, 상속 `self.client` + 공유 URLconf 사용:
```python
def test_callable_sitemod_empty(self):
    index_response = self.client.get("/callable-lastmod-empty/index.xml")   # self.client 상속
    self.assertFalse(index_response.has_header("Last-Modified"))
    self.assertXMLEqual(index_response.content.decode(), expected_content_index)
```
(동반으로 `urls/http.py`에 `CallableLastmodEmptySitemap` 등록.) 메커니즘: Django test client + URL routing fixture를 base가 제공 → 메서드만 꽂으면 작동.

**(S2) django-15103** — `JsonScriptTests(SimpleTestCase)`에 `@setup(...)` 데코 메서드 append, 상속 `self.engine` 사용:
```python
@setup({'json-tag02': '{{ value|json_script }}'})
def test_without_id(self):
    output = self.engine.render_to_string('json-tag02', {...})   # self.engine 상속
```
메커니즘: 템플릿 테스트 base의 `self.engine` + `@setup` 머신을 상속 — standalone이면 template engine 부트스트랩 필요.

**(S3) django-15957** — `PrefetchRelatedObjectsTests(TestCase)`에 append, 상속 `setUpTestData` DB 객체 사용:
```python
book1 = Book.objects.get(id=self.book1.id)               # self.book1 = setUpTestData 픽스처
with self.assertNumQueries(1):
    prefetch_related_objects([book1], Prefetch("authors", ...))
self.assertEqual(book1.limited_authors, [self.author1, self.author2])  # 상속
```
메커니즘: `self.book1/author1/author2`는 클래스 `setUpTestData`가 만든 DB row. new-file이면 동일 데이터 재생성 필요.

**(S4) django-15022** — `ChangeListTests(TestCase)`에 append, 상속 `self.factory`·`self.superuser`:
```python
request = self.factory.get('/concert/', data={SEARCH_VAR: 'alpha beta'})  # self.factory 상속
request.user = self.superuser                                              # self.superuser 상속
m.get_changelist_instance(request)
```

**(S5) django-14752** — `AutocompleteJsonViewTests(AdminViewBasicTestCase)`에 append, 상속 `self.factory/url/opts/superuser/as_view_args` 5개:
```python
request = self.factory.get(self.url, {'term': 'is', **self.opts})
request.user = self.superuser
response = CustomAutocompleteJsonView.as_view(**self.as_view_args)(request)
```

5건 모두 `defines_own_fixture=False & reads_inherited≠∅ & locally_assigned=∅` 자동 검증 통과 → **fixture를 진짜로 상속**한다.

### 그러나 steelman 붕괴 — 같은 인스턴스를 new-file이 똑같이 푼다

치명적 반증: 위 5건을 순수 new-file 시스템이 풀었는가?

```
django-16255: AssertFlip(nf)=RESOLVED  ReProAgent(nf)=RESOLVED  OpenHands(nf)=RESOLVED
django-15103: AssertFlip(nf)=RESOLVED  ReProAgent(nf)=RESOLVED  OpenHands(nf)=RESOLVED
django-15957: AssertFlip=not-attempted ReProAgent(nf)=RESOLVED  OpenHands(nf)=RESOLVED
django-15022: AssertFlip=not-attempted ReProAgent(nf)=RESOLVED  OpenHands(nf)=unresolved
django-14752: AssertFlip(nf)=RESOLVED  ReProAgent(nf)=RESOLVED  OpenHands(nf)=RESOLVED
```

**5건 전부 ReProAgent(100% new-file)가 resolved.** 즉 fixture 상속은 insert의 편의였을 뿐, new-file 스캐폴드가 동등 상태를 self-contained로 재구축해 같은 인스턴스를 통과시켰다. **"insert였기 때문에 풀렸다"는 반증된다** — style을 바꿔도 풀린다.

### 진짜 인과 insertion win 사냥 (all attempting new-file FAIL)

엄격 기준 — insert-fixture resolved **& 그걸 시도한 모든 new-file 시스템이 fail**:

```
전 데이터셋에서 2건뿐:
  django-12143: inherits=[self.factory]  nf_attempts=[(OH, fail)]            ← n=1, 약함
  django-16950: inherits=[self.client]   nf_attempts=[(OH, fail),(RA, fail)] ← 유일 강한 케이스
```

**(W1, 유일한 강한 인과 케이스) django-16950** — 공유 test-infra 파일을 **편집**:
```python
# tests/admin_inlines/models.py 에 신규 모델 주입
class UUIDThing(models.Model):
    uid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    ...
class UUIDSubThing(models.Model):
    thing = models.ForeignKey(UUIDThing, to_field="uid", ...)
# tests/admin_inlines/admin.py 에 admin 등록
site.register(UUIDThing, UUIDThingAdmin)
# 그 뒤 test 본문이 상속 self.client + 새 admin route 소비
```
메커니즘: 모듈 전역 모델 그래프·admin site에 모델을 **등록**해 DB/라우팅을 모듈 차원에서 확장. OpenHands·ReProAgent(둘 다 new-file) 모두 실패 — 순수 신규 파일로는 기존 `admin_inlines` 앱의 migration/admin-site 그래프에 모델을 깔끔히 끼워넣기 어렵다. **이게 insertion이 인과적으로 작동한 유일하게 견고한 사례다.** 단, 이건 "기존 메서드에 append"가 아니라 **shared fixture 파일 편집**이라는 더 좁은 패턴이고, 빈도는 2/500=0.4%.

---

## TASK 4 — Verdict (적대 공격 후 insertion이 레버로 살아남는가)

**살아남지 못한다 — 인과 레버로서 부활 실패.** 단, 정밀하게:

| 주장 | Round-2 데이터 판정 |
|---|---|
| insertion이 점수의 **인과 레버** | **반증.** within-system Fisher p=1.0, OR=1.014. within-repo 9/9 repo 모두 p≥0.158. 신호 없음. |
| insertion이 **repo-conditional** 레버 | **반증.** 어떤 단일 repo도 유의(p<0.05) 아님. 부호조차 뒤집힘(astropy +19 vs sphinx −26, 둘 다 노이즈). |
| insertion이 **null** 레버 | **지지.** within-system 78~82% plateau, style 무관. |
| insertion이 **micro-conditional** advantage | **약하게 지지.** 전 데이터셋 2/500(0.4%)에서만 "insert였어야 풀렸다"(django-16950 강함, 12143 n=1 약함). 그것도 "메서드 append"가 아니라 **shared test-infra 파일 편집**일 때만. |

**정밀 결론:** 데이터가 지금 지지하는 것은 — insertion은 (1) coverage 바닥을 높이는 값싼 깔개이며(Round-1 D1: fail의 94.7%가 insert), (2) pass/fail의 **인과 판별축이 아니다**(within-system p=1.0), (3) 유일하게 인과적으로 작동하는 좁은 틈은 **공유 test-infra(models/admin/urls/conf) 파일을 편집해 모듈 전역 상태를 확장해야 하는 ~0.4% 케이스**뿐이고, 일반적 "기존 클래스에 테스트 메서드 append"는 self-contained new-file 대비 측정 가능한 우위가 없다.

**Round-1 over-corrected 아님 — 오히려 강화됨.** Round-1이 "측정 불가"로 비워둔 within-system 칸(round1 line 130: "순수 integration-style 인과 효과는 within-system 케이스가 0건이라 측정 자체가 불가능")을 Round-2가 L*Agent embedded report로 메웠고, 측정 결과 **null**이었다. 이는 Round-1의 "style은 잔차 신호를 못 남긴다"(line 126) 결론을 cross-system 추론이 아닌 **단일-system 직접 측정**으로 확정한 것이다. 유일한 Round-1 사실 오류는 "측정 불가능" 자체였다(가능했고, 했고, null이었다).

진짜 레버는 Round-1대로 **(1) repo 난이도, (2) scaffold/model, (3) oracle 강도·fixture-state 충족·localization**이며, insert/new-file 축은 이 위에 독립 신호를 거의 남기지 않는다.

---

## 재현 메모 (데이터·코드 경로)

- L*Agent embedded 라벨: `https://files.sri.inf.ethz.ch/swt-bench/run_instance_swt_logs/swt-verified/lstar_agent_verified.zip` → `lstar_agent_verified/logic_star_ai/<id>/report.json`의 `resolved` 필드 (500/500, 재채점 불필요). 로컬 캐시: `/tmp/lstar_logs/`.
- 패치 SSOT: `_predictions/lstar_agent_verified.json` (zip 패치와 byte-identical).
- 분류기: `is_new = ('new file mode' in patch) or ('--- /dev/null' in patch)`; pure-insert = `not is_new and deleted==0 and added>0`.
- denominator 검증: `_predictions/{eotter_plus,assertflip,openhands_gpt5mini}_verified.evaluation.json`의 `resolved_ids`/`unresolved_ids` (disjoint, sum=total).
- grading 로직 확인: `swt-bench/src/grading.py:get_resolution_success` (line 205) — resolved는 `report_pred` f2p ⊇ `report_base` f2p & 신규 f2p>0 & 회귀 무변동. **coverage·docker 불필요, log+gold만.** embedded report가 이 출력을 이미 담음.
- new-file 교차-solve: `reproagent/.../ReProAgent.repro_agent_gpt_5_mini_verified.json` (resolved 303).
