# Round-1 적대 어딧: "existing-file insertion + fixture reuse가 SWT-bench repro 최강 레버"에 대한 반례 사냥

> 가설: **insertion 진영(기존 테스트 파일에 메서드 append + 기존 fixture 재사용)이 repro score의 가장 강한 단일 레버다.**
> Round-1 임무: 확증 금지. insertion 진영 안에서 **반례를 사냥**해 가설을 깨거나 한정(qualify)한다.
> 데이터: `_predictions/eotter_plus_verified.{inference,evaluation}.json` (e-Otter++ 432, 100% insert, per-instance resolved 있음), `_predictions/lstar_agent_verified.json` (L*Agent 500, 84%, per-instance resolved **없음**), `_predictions/assertflip_verified.evaluation.json` (AssertFlip 100% new-file, per-instance resolved 있음 — paired control).
> 모든 id·스니펫은 실제 패치 원문 인용. 분류기: `is_new = ('new file mode' in patch) or ('--- /dev/null' in patch)`; pure-insert = `not is_new and deleted==0 and added>0`.

---

## 헤드라인 (가설을 깨는/한정하는 것)

`[verified]` **insertion은 전혀 sufficient하지 않다.** e-Otter++의 UNRESOLVED 169건 중 **160건(94.7%)이 기존-파일 pure-insertion**이다. 즉 "기존 파일에 꽂았다"는 사실만으로 통과를 전혀 보장 못 함 — fail의 절대 다수가 insert였다. insertion은 점수의 **상한이 아니라 바닥(coverage 깔개)**이고, pass/fail을 가르는 진짜 축은 다른 데 있다.

```
e-Otter++ 432: pure-insert 409 / existing-modify 23 / new-file 0
  RESOLVED 263 → pure-insert 249
  UNRESOLVED 169 → pure-insert 160, existing-modify 9, new-file 0
```

가르는 축은 insertion 여부가 아니라 (a) **assertion/oracle 품질**, (b) **fixture-state 정밀도**, (c) **localization**다. 아래 증거.

---

## 1. Insertion이 FAILED — 기존-파일 insert인데 UNRESOLVED (실패 원인 태깅)

UNRESOLVED pure-insert 160건의 repo 분포: django 78, sympy 25, sphinx 23, matplotlib 8, astropy 7, pydata 5, pytest 5, sklearn 4, mwaskom 2, requests 2, pylint 1.

휴리스틱 태깅(`+`라인 본문만 스캔)으로 잡힌 실패-원인 후보 (37/160에 태그 부착, id·태그 실측):

| 실패 원인 (tag) | 본질 | 대표 id |
|---|---|---|
| `manual-global-state-restore` | fixture가 안 주는 전역상태를 try/finally로 수동 셋업/복원 → fixture under-supply | django-11141, 13837, 13315, 13279, 14122, 15037, 16100, 16502, 16938, psf-requests-6028, pydata-xarray-6721, pylint-7080, sphinx-9658/9673/8475 |
| `weak-substring-assert` | `"x" in msg` / `assertIn` 식 약한 오라클 (오답에도 통과 가능) | astropy-13033/14182, django-10973/11532/14155/14376/14580/14792/15554/17084, sphinx-8593/9258/10449, sympy-15976/20916 |
| `private-attr-mutation` | `obj._private = ...`로 fixture 상태를 강제 조작(취약) | astropy-13033, django-13837, matplotlib-26291, pytest-5787, sphinx-8475 |
| `SKIP-guard(vacuous-pass)` | `skipTest`/`pytest.skip` 분기로 그래더 환경에서 통째 skip→공허 통과 | django-11138, 13363, 13449, 15629, pytest-7324 |
| `or-between-asserts(vacuous)` | `self.assertX(...) or self.assertY(...)` — 첫 assert가 None 반환→`or`가 항상 둘째 평가, 단언이 무력화 | django-11138 |
| `malformed-assert` | `assertNotIn(...) or assertNotIn(...)` — 같은 버그 | django-11138 |

`[verified]` **반례 A — django-11138 (vacuous assertion, insert인데 fail):**
```python
self.assertNotIn("CONVERT_TZ(", sql) or self.assertNotIn("'UTC', 'Europe/Paris'", sql)
```
`assertNotIn`은 `None`을 반환하므로 `None or self.assertNotIn(...)` → 항상 둘째만 평가, 게다가 위에 `if connection.queries:` 가드와 `self.skipTest(...)`까지 있어 비-MySQL 환경에선 **통째 skip**. 기존 `tests/timezones/tests.py`의 `NewDatabaseTests`에 정확히 append됐지만(insertion은 완벽) fail-to-pass가 성립 안 함. → insertion 메커니즘은 흠 없는데 **오라클 설계가 공허**해서 UNRESOLVED.

`[verified]` **반례 B — astropy-13033 (private-attr + weak-substring, insert인데 fail):**
```python
ts._required_columns = ["time", "flux"]          # private 속성 강제 조작
with pytest.raises(ValueError) as exc:
    ts.remove_column("flux")
assert "required column" in exc.value.args[0]    # 약한 substring
assert "flux" in exc.value.args[0]
```
기존 `test_sampled.py` `test_required_columns` 바로 뒤에 append(insert OK). 그러나 `_required_columns` 내부 상태를 손으로 세팅하는 가정이 실제 API 동작과 어긋나 fail-to-pass 미성립.

`[verified]` **반례 C — pytest-5787 (insert인데 깊은 내부 repr 체인 가정으로 fail):**
```python
formatted = excinfo.getrepr().chain[0][0].reprtraceback.reprentries[0].reprfileloc.message
...
assert len(chain) == 3, "Exception chain should have 3 elements"
```
`testing/code/test_excinfo.py` 끝에 append(insert OK)했지만 `.chain[0][0].reprtraceback...` 같은 내부 객체 그래프 형태를 추측으로 가정 → localization은 맞아도 oracle이 실제 구조와 불일치.

→ **결론 1:** 실패의 압도적 다수가 insert다. insert는 fail을 막지 못한다. 실패 원인은 거의 항상 **assertion 공허/취약(weak-substring·or-vacuous·skip-vacuous) 또는 fixture-state 가정 오류(private-attr, 수동 전역상태)**다. insertion ≠ sufficient.

---

## 2. L*Agent의 NEW-FILE 29% — insertion-friendly repo에서도 new-file을 고른다

`[verified]` L*Agent 전수 분류: **INSERT 262 / NEW 159(31.8%) / MODIFY 79**. new-file repo 분포:
```
django 42, matplotlib 24, sphinx 17, sympy 16, astropy 15, pydata 13, pytest 11, sklearn 7, pylint 6, psf 6, ...
```
가설 옹호론("new-file은 matplotlib/astropy 같은 함수형·insertion-hostile repo에서만")은 **부분적으로만 맞다.** matplotlib는 71% new-file로 hostile 신호가 맞지만, **class-based·TestCase 컨벤션이 강한 django에서 42건, sympy 16건, sklearn 7건**이 new-file이다. 즉 #1 에이전트(84%)는 insertion이 자연스러운 곳에서도 상당수 new-file을 택한다.

`[verified]` **L*Agent의 new-file은 ReProAgent의 순진한 new-file과 다르다 — "repo-aware standalone"이다.** pure-new 149건 중 **144건이 test_*.py 테스트 모듈을 포함**(fixture-only 5건은 migration dir/__init__.py/conf.py 같은 동반 픽스처). 그리고 hybrid 10건은 new-file + 기존 파일 동시 편집(예 django-13820: 새 `test_migrations_no_file/0001_initial.py`+`__init__.py`를 만들면서 기존 `tests/migrations/test_loader.py`도 수정; django-7530: 새 파일 + 기존 `routers.py`/`test_commands.py` 수정). prior review(lstar.md §2)도 new-file이 `SphinxTestApp`/`Pytester`/`_basic_auth_str` 등 **repo 하네스를 import**함을 인용. ReProAgent식 isolated-mock new-file과 달리 repo 픽스처에 의존.

`[caveat]` **L*Agent는 per-instance resolved 신호가 없다** (`record keys = instance_id, model_name_or_path, model_patch`; aggregate 84%만 공개). 따라서 "new-file일 때 통과했는가"를 L*Agent 단독으론 증명 불가. **하지만 paired control로 우회 가능** (아래 §4 반례 D/E).

`[verified]` **반례 D — L*new-file ∩ eOtter-insert-resolved = 70건.** L*Agent가 new-file을 택한 70개 인스턴스를, e-Otter++는 **insert로 RESOLVED**했다 (django 18, matplotlib 17, astropy 7, sympy 6, ...). 즉 insert로 풀 수 있는 케이스를 84% 에이전트가 굳이 new-file로 갔다 — insertion이 "최강 레버"라면 #1 에이전트가 이렇게 자주 벗어날 이유가 약하다. (역으로 L*Agent가 전체 84%이므로 이 70개 중 다수도 new-file로 통과했을 개연성이 높다 — insertion 없이도 풀린다는 정황.)

---

## 3. Fixture-state 정밀도 — "fixture 재사용"이 종종 UNDER-specify한다

`[verified]` insert이면서 **기존 fixture로 부족해 추가 셋업을 손으로 깔아야** 했던 케이스가 UNRESOLVED에 집중. `manual-global-state-restore` 태그 16건이 전부 이 부류.

**django-11141 (insert인데 fixture가 namespace-package 시나리오를 안 줘서 통째로 손으로 구축):**
```python
temp_dir = tempfile.mkdtemp()
try:
    os.makedirs(migrations_dir)                       # 디렉토리 직접 생성
    with open(os.path.join(migrations_dir,'0001_initial.py'),'w') as f: ...
    sys.path.insert(0, temp_dir)                       # sys.path 직접 조작
    apps.get_app_config = get_app_config_stub          # 앱 레지스트리 몽키패치
    ...
finally:
    apps.get_app_config = original_get_app_config       # 수동 복원
    shutil.rmtree(temp_dir)
```
기존 `LoaderTests`에 append(insert)했지만, 이 클래스 fixture는 namespace-package(`__init__.py` 없는 migration dir)를 제공하지 않는다. 그래서 임시 디렉토리·sys.path·app registry를 전부 손으로 깔았고 그 셋업이 미묘하게 어긋나 UNRESOLVED. → **"기존 fixture 재사용" = 정답이 아니라, fixture가 못 주는 상태는 insert로도 못 메운다.**

**django-13837 (insert인데 `sys.modules`를 통째 복사/복원):**
```python
orig_modules = sys.modules.copy()
sys.modules['__main__'] = mock_main
try: ...
finally: sys.modules = orig_modules
```
**sphinx-8475 (insert인데 HTTP 서버·redirect 핸들러를 손으로 기동):** 기존 `test_build_linkcheck.py`의 `app` fixture로는 too-many-redirects 시나리오를 못 만들어 `http.server.HTTPServer`를 스레드로 직접 띄움 → fixture under-supply의 전형.

`[verified]` **prior review(otter-assertflip.md §4)도 동일 자백:** sphinx-8551에서 e-Otter++가 repo `app` fixture + `temp_data` 조작으로 시나리오를 깔다가 **fail-to-pass 성립 실패**, 반면 AssertFlip은 self-contained 빌드로 성공. "픽스처 상태 셋업이 미묘할 때 단일-pass가 못 맞춘다"고 명시. → **"reuse fixture"는 시나리오가 기존 fixture 범위를 벗어나면 under-specify하고, 이때 insert는 오히려 self-contained new-file보다 불리할 수 있다.**

---

## 4. 적대 종합 — insertion이 전부가 아니라는/교란됐다는 최강 증거 3-5

`[verified]` **(D1) 실패의 94.7%가 insert.** UNRESOLVED 169 중 160이 pure-insert. insert는 fail을 막지 못한다. 가설이 "최강 레버"라면 fail 진영이 이렇게까지 insert로 도배될 수 없다 — insert는 pass/fail의 판별축이 아니다.

`[verified]` **(D2) assertion 품질이 진짜 판별축 (insertion이 아님).** insert로 한정한 뒤 weak-assert-only(약한 substring/`in`만 쓰고 `==`/assertEqual 없음) 비율: RESOLVED 31/249 = **12.4%** vs UNRESOLVED 30/160 = **18.8%**. insert를 고정해도 약한 오라클이 fail 쪽에 ~1.5x 더 몰린다. → 점수를 가르는 건 insert 여부가 아니라 **오라클 강도**.

`[verified]` **(D3) multi-test는 insertion 진영 안에서 판별축이 아니다 (confound 제거).** insert RESOLVED와 UNRESOLVED의 평균 test-fn 개수가 **둘 다 1.47로 동일**(resolved single-fn 135/249, unresolved 87/160). multi-test로 점수가 갈린다는 대안가설은 적어도 insert 내부에선 성립 안 함 — 남는 건 oracle/fixture/localization 품질.

`[verified]` **(D4) new-file이 insert를 이긴 paired head-to-head.** AssertFlip(100% new-file)이 RESOLVED인데 e-Otter++(100% insert)가 UNRESOLVED인 인스턴스 **33건** (django 13, sympy 6, astropy 4, sphinx 4, matplotlib 2, ...). **insertion-friendly한 django/sympy class repo에서도** new-file이 이겼다. (대칭으로 insert가 이긴 건 65건이라 insert 평균이 더 높긴 함 — 그러나 "최강 단일 레버"는 33건의 반례로 한정된다: 적어도 1/3 비율로 new-file이 더 낫다.)

`[verified]` **(D5) #1 에이전트가 insert를 자주 떠난다.** L*Agent(84%, 최고점)는 159/500 = 31.8% new-file이고, 그중 70건은 eOtter가 insert로 풀어낸 케이스다. 최강 레버가 insertion이면 최강 에이전트가 insertion-가능 케이스의 거의 1/3을 new-file로 버릴 이유가 약하다. → insertion은 L*Agent 84%의 **충분조건도 필요조건도 아니고**, prior review가 84%의 원인으로 지목한 "in-place 통합력"은 **localization+oracle robustness(lstar.md §4)와 교락(confound)**돼 있다.

### 한정된 결론 (Round-1)
insertion은 **coverage 바닥을 높이는 값싼 깔개**이지 "최강 레버"가 아니다. 실제 pass/fail은 **(1) oracle 강도(약한 substring/vacuous-or/skip 회피), (2) fixture-state 충족(시나리오가 기존 fixture 범위를 넘으면 insert도 무력), (3) localization·내부구조 정확도**가 가른다. insertion이라는 변수는 이 셋과 강하게 교락돼 단독 레버로 분리되지 않으며, insertion-friendly repo에서조차 new-file이 1/3 비율로 더 낫다.

---

## 검토 인스턴스 (실측 인용)
- eOtter UNRESOLVED insert: django-11138, 11141, 13837, 13315, 13279, 14122, 15037, 16100, 16502, 16938 / astropy-13033, 14182 / pytest-5787 / sphinx-8475, 9658, 9673 / psf-requests-6028 / pydata-xarray-6721 / pylint-7080 / matplotlib-26291 / sympy-15976, 20916 (+그 외 태그된 37건)
- L*Agent new-file: django-13820(hybrid), 13109, 15315, 7530(hybrid), 11149 / matplotlib-24570, 24970 / sphinx-9711 / astropy-14508 / pytest-10081 / pydata-xarray-4094 / sympy-20590, 18763
- paired head-to-head(new-file 승): astropy-13236/14182/14309/14365, django-11179/11433/11749/11815/13449/14155/14539/15161/15315/15916/15930, sympy(6), sphinx(4) ...
- 분포·교집합은 432/500 전수 집계.
