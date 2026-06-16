---
instance_id: scikit-learn__scikit-learn-11310
repo: scikit-learn/scikit-learn
base_commit: 553b5fb8f84ba05c8397f26dd079deece2b05029
version: "0.20"
difficulty: "<15 min fix"
created_at: 2018-06-18T12:10:19Z
fail_to_pass: 1
pass_to_pass: 50
gold_files: [sklearn/model_selection/_search.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`GridSearchCV`/`RandomizedSearchCV`로 하이퍼파라미터 탐색 후 best model을 전체 데이터에 **refit하는 데 걸린 시간**을 알 방법이 없다. `cv_results_['mean_fit_time']` 등 폴드별 fit 시간은 노출되지만 최종 refit 시간은 아니다. `n_jobs=1`이면 전체 시간을 재서 빼볼 수 있으나 `n_jobs != 1`이면 그 트릭이 깨진다. 따라서 refit에 소요된 초를 담는 `refit_time_` 속성을 추가해 달라는 명확한 feature request다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 `BaseSearchCV`와 refit 동작을 직접 지목한다. refit은 `_search.py`의 `fit()` 내부 `if self.refit:` 분기 한 곳뿐 — grep 한 방으로 수렴. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 이슈가 픽스를 거의 명세한다("attribute `refit_time_` which is simply the time it took to refit"). refit 호출을 `time.time()`으로 감싸 차이를 저장하는 기계적 계측 패턴. 추론할 불변식·엣지케이스 없음.
- **K-Domain**: 일반 파이썬 추론으로 코드 자체는 쉽지만, scikit-learn의 estimator attribute 관례(`_` 접미사 = fit 후 설정 속성), `cv_results_`/`refit` 의미, docstring `Attributes` 섹션 규약을 알아야 "올바른 위치·명명"이 나온다.
- **primary = T-DirectMap**: 위치 명확(L0) + S1 기계적 추가. 추론 합성이 아니라 정형 패턴(타이밍 계측 + 속성 노출)이라 ConstraintReason이 아니다. APR 관점에서 PAR/TBar식 "삽입 템플릿"(측정 구간 wrap + 결과 store)에 정확히 매칭된다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`_search.py`), 실효 코드 변경 4줄(import 1 + 계측 3) + docstring 2블록. <5줄 컷에 근접.
- localize 직접성 최상(L0): `if self.refit:` 단일 분기.
- repro 없음(스택트레이스 불필요 — 동작 추가형이라 has-repro 무의미). 그래도 의도는 완전 명세.
- 도메인지식이 trivial→T2로 끌어올리는 유일 요인: 속성 명명/배치 관례를 틀리면 테스트의 `hasattr(search, "refit_time_")`를 못 맞춘다.
- **P2P trap = 51개**: regression-trap. refit 분기는 score 저장·multimetric·`best_estimator_` 설정 직전 경로라, 잘못 끼우면 `test_refit`/`test_no_refit`/타이밍 테스트군이 깨질 수 있다.

공식 라벨 "<15 min fix"와 일치(T1~T2). T1로 안 내린 이유: 순수 K-Gen이 아니라 sklearn 속성 관례(K-Domain) + 넓은 P2P가 약한 마찰을 준다.

## 골드패치 분석
- **파일/심볼**: `sklearn/model_selection/_search.py`, `BaseSearchCV.fit()` 내부 `_store` 클로저 뒤의 `if self.refit:` 블록. 추가로 `GridSearchCV`/`RandomizedSearchCV`의 `Attributes` docstring.
- **근본원인**: refit 호출(`self.best_estimator_.fit(...)`)이 계측 없이 실행돼 소요 시간을 어디에도 보존하지 않음. 결함이 아니라 **누락된 관측치(missing observability)**.
- **수정요지**: 모듈 상단에 `import time` 추가. `if self.refit:` 분기에서 `best_estimator_` clone/`set_params` 후 fit 호출을 `refit_start_time = time.time()` / `refit_end_time = time.time()`로 감싸고 `self.refit_time_ = refit_end_time - refit_start_time` 저장. `refit=False`이면 분기 자체가 실행 안 되므로 속성이 설정되지 않는다 — docstring에 "present only if ``refit`` is not False" 명시.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_search_cv_timing`에 3줄 추가 — `assert_true(hasattr(search, "refit_time_"))`, `isinstance(search.refit_time_, float)`, `assert_greater_equal(search.refit_time_, 0)`. 기존 타이밍 테스트(refit이 도는 search 객체) 안에 끼워, 속성 존재·타입·비음수만 검증.
- **픽스 증명**: `time.time()` 차이는 항상 float이고 단조 증가라 ≥0 보장 → 세 단언 모두 충족. 분기가 실제로 실행되는 경로(refit 기본 True인 search)에서만 테스트하므로 wiring이 곧바로 드러난다.
- **overfit 관점**: 테스트가 값의 의미(실제 refit 시간과 일치하는지)는 검증 안 함 — float·비음수면 통과. 그러나 픽스가 기계적(측정 구간 wrap)이라 special-case로 통과시킬 더 단순한 오답이 없어 overfit-risk는 낮게 본다(`refit_time_ = 0.0` 하드코딩이 통과하지만 그건 정상 구현보다 오히려 더 작위적).
- **regression 관점**: 51개 P2P 중 `test_no_refit`(refit=False시 속성 미설정 기대), `test_refit`, 타이밍/결과 테스트군이 핵심. 계측을 fit 호출 양옆에만 두고 분기 밖으로 빼지 않았기에 refit=False 경로는 byte-동일 → 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 키워드 "refit", "BaseSearchCV"로 `_search.py`를 열고 `if self.refit:` 분기를 찾는다. `cv_results_`에 이미 `mean_fit_time`이 있으므로 동일 클래스의 fit 경로를 따라가면 refit 지점이 단번에 나온다(L0).
2. **픽스와 일반화**: refit fit 호출 직전/직후에 `time.time()`을 찍어 차를 `self.refit_time_`에 저장. 이게 올바른 일반화인 이유 — (a) `n_jobs`와 무관하게 refit은 메인 프로세스에서 순차 실행되므로 wall-clock 차가 정확, (b) `_` 접미사 + fit-time 설정으로 sklearn 속성 관례 준수, (c) `refit=False`시 미설정이 자연스럽게 명세에 부합. 특정 입력에 맞춘 게 아니라 모든 search/estimator에 보편 적용.
3. **regression 안전**: 계측을 반드시 `if self.refit:` **분기 내부**에 둘 것. refit=False 경로(`test_no_refit`)와 score 저장·multimetric 경로를 건드리지 않아야 51개 P2P 보존. clone/`set_params` 자체는 측정 밖에 둬 "refit 순수 시간"만 잡는다(골드는 clone 후, fit만 감쌈).
4. **함정 회피**: (a) 분기 밖에 `refit_time_`을 무조건 설정하면 refit=False에서도 속성이 생겨 docstring 계약과 `test_no_refit` 의도를 깨뜨림 — 반드시 분기 안. (b) `time.process_time`이나 `timeit`로 과설계하지 말 것; 이슈는 wall-clock("얼마나 걸리나")을 원하고 테스트도 비음수 float만 본다. (c) docstring `Attributes` 갱신을 빠뜨리면 기능은 통과해도 sklearn 문서 규약 위반 — 두 클래스 모두 추가.
