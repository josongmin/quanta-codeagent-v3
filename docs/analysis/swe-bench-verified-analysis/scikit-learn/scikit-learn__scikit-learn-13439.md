---
instance_id: scikit-learn__scikit-learn-13439
repo: scikit-learn/scikit-learn
base_commit: a62775e99f2a5ea3d51db7160fad783f6cd8a4c5
version: "0.21"
difficulty: "<15 min fix"
created_at: 2019-03-12T20:32:50Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [sklearn/pipeline.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약

새로 추가된 인덱싱 지원(`pipe[:len(pipe)]`)을 쓰려는데 `Pipeline`이 `__len__`을 구현하지 않아 `len(pipe)`가 `TypeError`를 던진다. 이슈는 재현 코드(`Pipeline([('anova', ...), ('svc', ...)])` 후 `len(pipe)`)와 함께 제목 자체가 "Pipeline should implement `__len__`"로 픽스를 명세한다. 메인테이너 힌트는 "len만 추가하고 iter 등 다른 시퀀스 프로토콜은 넣지 말라"로 범위까지 좁혀준다.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈 제목이 클래스(`Pipeline`)와 메서드(`__len__`)를 직접 지목. `sklearn/pipeline.py`의 `Pipeline` 클래스를 열면 끝. 탐색 사실상 0.
- **S1 (Direct-Map)** — 누락된 던더 메서드를 추가하는 기계적 픽스. `len(self.steps)`라는 자명한 구현이 도메인 추론 없이 따라 나온다. 후보 합성이나 식 추론(S2) 불필요.
- **K-Gen** — `steps`가 리스트라는 일반 파이썬 지식만으로 충분. sklearn 내부 알고리즘 지식 불요.
- **primary = T-DirectMap** — 위치가 완전히 명확(L0)하고 픽스가 정형 결함클래스(누락 프로토콜 메서드 추가)에 템플릿 매칭되는 S1. T-LocTrivial과 경계지만, 이슈가 픽스를 "거의 적어줄" 정도(T1)는 아니고 구현 선택지(`len(self.steps)` vs `_iter` 카운트)가 한 번의 의미 판단을 요구하므로 T-DirectMap.

APR 관점: 이건 PAR/TBar식 fix-pattern("missing magic method" 템플릿)에 정확히 매칭되는 사례다. 실패테스트가 동작을 명세하고 픽스가 그 동작의 직역이라 generate-&-validate 반복이나 counterexample 일반화가 필요 없다.

## 난이도 티어

**T2 (쉬움).** 구조적 피처:
- 파일수 1, 추가 줄수 6줄(메서드 본문 1줄 + docstring/시그니처). <5줄급에 근접한 최소 패치.
- localize 직접성 = L0(제목이 심볼 지목), `has-repro`(네이티브 재현 코드 + 트리거 호출 `len(pipe)`)로 easiness 신호 최상.
- 도메인 지식 0(K-Gen).
- 다만 **regression-trap**: PASS_TO_PASS 41개로 넓다. `Pipeline`/`FeatureUnion` 슬라이싱·인덱싱(`test_pipeline_slice`, `test_pipeline_index`)이 인접 동작이라, `__len__`을 잘못 구현하면(예: `_iter`로 `passthrough`/`None` 스텝을 제외해 세면) 슬라이스 경계가 어긋날 수 있다. 그래서 T1이 아니라 T2.

공식 라벨 "<15 min fix"와 일치. 시간라벨이 못 잡는 overfit 위험은 없으나(테스트는 정확한 정수 `2`를 검증), regression 면적이 작지 않아 T1로 내리지 않는다.

## 골드패치 분석

- **건드린 파일·함수**: `sklearn/pipeline.py` — `Pipeline` 클래스에 `__len__` 메서드 신규 추가. 위치는 `_iter` 직후, `__getitem__` 바로 앞.
- **근본원인**: 0.21에서 `__getitem__`(슬라이싱/인덱싱) 지원이 추가됐는데 `__len__`이 빠져 있었다. 파이썬에서 `len(obj)`는 `__len__`을 호출하므로 미구현 시 `TypeError: object of type 'Pipeline' has no len()`. `pipe[:len(pipe)]` 같은 관용구가 깨진다.
- **수정요지**: `return len(self.steps)` — 파이프라인의 길이를 (`(name, transform)` 튜플들의 리스트인) `self.steps`의 길이로 정의. `passthrough`/`None`으로 비활성화된 스텝까지 **포함**해 세는 것이 핵심(아래 검증 참고).

## 검증 (test_patch)

- **FAIL_TO_PASS** (`test_make_pipeline_memory`): 기존 테스트 끝에 `assert len(pipeline) == 2` 한 줄 추가. `make_pipeline(DummyTransf(), SVC())`로 만든 2-스텝 파이프라인의 `len`이 정확히 2여야 한다. 패치 전엔 `len()` 호출 자체가 `TypeError`라 FAIL, 패치 후 `len(self.steps)==2`로 PASS.
- **픽스 증명**: 테스트가 구체적 정수 2를 단언하므로 "메서드 존재"만이 아니라 "값 정확성"까지 본다. `self.steps`는 `make_pipeline`이 만든 2개 튜플이라 `len==2`가 정의대로 성립.
- **overfit 관점**: 비활성 스텝이 없는 2-스텝 케이스라 `len(self.steps)`와 `_iter` 카운트가 동일한 값을 내는 구역이다 — 즉 이 테스트만으론 "`steps` 전체 길이" vs "활성 스텝 수"를 **구별 못 한다**. 하지만 골드가 `len(self.steps)`(전체)를 택한 것은 `__getitem__`의 슬라이스 인덱스가 `steps` 위치 기반이라 `pipe[:len(pipe)]`가 전체를 돌려줘야 하기 때문 — 올바른 일반화. overfit-risk 플래그는 달지 않음(픽스 자체가 표준 컨테이너 시맨틱이라 미검증 입력공간이 좁다).
- **regression 관점**: PASS_TO_PASS 41개 중 `test_pipeline_slice`/`test_pipeline_index`가 인접. `__len__`은 순수 추가 메서드라 기존 경로를 건드리지 않아 회귀 면적은 사실상 0.

## 모범답안 (오라클 기반)

1. **localize**: 이슈 제목 "Pipeline should implement `__len__`" + 재현 `len(pipe)` → `sklearn/pipeline.py`의 `Pipeline` 클래스 한 곳. grep `class Pipeline` 한 방. 탐색 비용 없음.
2. **픽스와 일반화 근거**: `Pipeline`에 `def __len__(self): return len(self.steps)` 추가. `steps`(생성자가 받는 `(name, estimator)` 리스트)가 파이프라인 길이의 정본이고, 동일 릴리스의 `__getitem__` 슬라이싱이 `steps` 위치 기반이므로 `len`도 `steps` 길이여야 `pipe[:len(pipe)]`가 일관된다. 이것이 special-case가 아닌 표준 컨테이너 `__len__` 시맨틱과 일치하는 일반화.
3. **regression 안전**: 순수 add-only 메서드라 fit/transform/predict, 슬라이스, named_steps 등 기존 동작을 변경하지 않음. `test_pipeline_slice`·`test_pipeline_index`가 `steps` 위치 인덱싱을 가정하므로 `len`도 같은 기준이어야 깨지지 않는다 — `len(self.steps)`가 정확히 그 기준.
4. **함정 회피**: (a) 메인테이너 힌트대로 `__iter__`/`__contains__` 등 다른 시퀀스 프로토콜까지 끌어들이지 말 것(scope creep). (b) `_iter()`로 `passthrough`/`None` 활성 스텝만 세면 안 됨 — 2-스텝 테스트로는 통과하지만 비활성 스텝이 섞인 파이프라인에서 `pipe[:len(pipe)]` 경계가 어긋나 슬라이스 시맨틱이 깨진다. 전체 `self.steps` 길이를 반환하는 것이 정답. (c) `FeatureUnion`까지 손대지 말 것 — 이슈 범위는 `Pipeline`에 한정.
