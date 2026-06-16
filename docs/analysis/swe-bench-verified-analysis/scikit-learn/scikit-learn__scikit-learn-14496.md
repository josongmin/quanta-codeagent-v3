---
instance_id: scikit-learn__scikit-learn-14496
repo: scikit-learn/scikit-learn
base_commit: d49a6f13af2f22228d430ac64ac2b518937800d0
version: "0.22"
difficulty: "<15 min fix"
created_at: 2019-07-28T13:47:05Z
fail_to_pass: 1
pass_to_pass: 39
gold_files: [sklearn/cluster/optics_.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약

`OPTICS(min_samples=0.1)`처럼 `min_samples`를 0~1 사이 float로 넘기면, 내부에서 `min_samples = max(2, min_samples * n_samples)`로 절대 개수로 환산하지만 결과가 여전히 float다. 이 float가 나중에 `NearestNeighbors(n_neighbors=...)`로 전달되며 `TypeError: n_neighbors does not take <class 'numpy.float64'> value`로 터진다. 이슈 본문이 결함 위치(l439·l440)와 픽스(`int(...)` 캐스팅)까지 직접 명시한다.

## 유형 (정형화)

- **L(Localization) = L0**: 이슈가 파일(`optics_.py`), 라인(l439/l440/l448), 함수(`compute_optics_graph`), 결함식(`max(2, min_samples * n_samples)`)을 직접 지목. 스택트레이스까지 첨부 → grep 한 방.
- **S(Strategy) = S1 (Direct-Map)**: 정형 결함클래스(float→int 타입강제 누락). 이슈가 사실상 픽스를 적어줌(`int(...)`로 감싸라). 추론 합성 불필요, 기계적 캐스팅 추가.
- **K(Knowledge) = K-Gen**: float를 int로 캐스팅하면 된다는 건 일반 파이썬 지식. OPTICS/클러스터링 도메인 내부지식 불필요(왜 NN이 정수를 요구하는지는 이미 에러가 알려줌).
- **primary = T-DirectMap**: 위치 명확 + S1 기계적 타입강제. T-LocTrivial이 아닌 이유는 동일 결함클래스가 3개 호출지점(`compute_optics_graph` 1곳 + `cluster_optics_xi`의 `min_samples`/`min_cluster_size` 2곳)에 반복되어 "유사 결함 전파"를 추가로 잡아야 하기 때문 — 자명 1줄을 살짝 넘어선다.

APR 관점: 이슈 본문이 결함식과 수정식을 둘 다 제시하므로 SemFix류 제약합성(S2)이 아니라 PAR/TBar식 템플릿 매칭(누락된 타입강제 삽입)이 dominant.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일 수 1개(`optics_.py`), 코드 변경 3줄(+docstring 정리), 단일 슬라이스.
- localize 직접성 최고(L0, has-repro): 스택트레이스가 `compute_optics_graph` → `nbrs.fit` 경로를 그대로 보여줌.
- repro 존재 = 가장 강한 easiness 신호.
- 도메인 지식 거의 0(K-Gen).

T1이 아닌 이유: 단일 라인 자명픽스를 넘어 **결함 전파(cluster_optics_xi의 2개 추가 사이트)**를 함께 고쳐야 FAIL_TO_PASS가 통과한다(아래 검증 참고). 38개의 넓은 PASS_TO_PASS가 약한 regression-trap을 형성. 공식 라벨 "<15 min fix"와 부합 — 다만 "유사 호출지점 누락" 함정 때문에 T1까지 내리지 않고 T2로 둔다.

## 골드패치 분석

- **건드린 파일**: `sklearn/cluster/optics_.py` (단일).
- **함수/근본원인**:
  - `compute_optics_graph` (l437~): `if min_samples <= 1: min_samples = max(2, min_samples * n_samples)` — float `min_samples`×`n_samples`가 float를 유지, 이후 `NearestNeighbors(n_neighbors=...)`가 정수만 받아 `TypeError`.
  - `cluster_optics_xi` (l619~): 동일 패턴이 `min_samples`와 `min_cluster_size` 두 군데 반복(유사 결함).
- **수정요지**: 세 곳 모두 `max(2, min_samples * n_samples)` → `max(2, int(min_samples * n_samples))`로 정수 캐스팅 삽입. `int(round(...))` 대신 `int(...)`만 쓴 이유는 hints대로 OPTICS가 0.21에서 도입되어 Python2 round 시맨틱(`round: T→T`) 호환을 고려할 필요가 없기 때문.
- 나머지 변경은 docstring 정리: `default=None`/`default=5` 표기 불일치 교정, `_xi_cluster`의 `min_samples`/`min_cluster_size`를 `int > 1`로 정정(float 환산은 상위 `cluster_optics_xi`에서 이미 끝나므로 이 시점엔 항상 정수).

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_extract_xi`** (1개). 추가된 블록이 핵심:
  ```python
  clust = OPTICS(min_samples=0.1, min_cluster_size=0.08,
                 max_eps=20, cluster_method='xi', xi=0.4).fit(X)
  assert_array_equal(clust.labels_, expected_labels)
  ```
  float `min_samples=0.1` **그리고** float `min_cluster_size=0.08`를 동시에 준다 → `cluster_optics_xi`의 두 캐스팅 사이트를 모두 강제 실행. 패치 전엔 NN 인스턴스화에서 `TypeError`, 패치 후엔 정상 라벨이 정수 파라미터 케이스와 동일(`expected_labels`)함을 검증.
- **픽스 증명**: float 경로를 정수 경로와 같은 `expected_labels`로 비교 → 단순 "안 터짐"이 아니라 **환산 의미론(0.1×n_samples를 내림한 정수가 올바른 절대개수)**까지 고정.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, float×2 파라미터 동시 검증 + 정수 케이스와의 라벨 동치 비교라 special-case 통과가 어렵다 → overfit-risk 낮음(플래그 미부여).
- **regression 관점**: 38개 PASS_TO_PASS(dbscan parity, min_cluster_size invalid, edge_case 등 정수 경로 전반). `int(...)`는 정수 입력엔 무영향(이미 정수)이라 P2P를 깰 수 없음 → regression-trap 존재하나 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 스택트레이스 마지막 프레임(`compute_optics_graph` → `nbrs.fit` → `n_neighbors does not take float`)을 따라 `optics_.py`의 `if min_samples <= 1:` 블록으로 직행. 이슈가 라인까지 지목하므로 탐색 0.
2. **픽스와 일반화**: `max(2, min_samples * n_samples)`를 `max(2, int(min_samples * n_samples))`로 감싼다. float min_samples는 "비율"이고 NN은 정수 이웃 수를 요구하므로 정수화가 타입계약상 올바른 일반화 — 특정 입력 0.1에 맞춘 미봉이 아니라 0<float≤1 전 구간에 유효.
3. **regression 안전**: 정수 `min_samples`는 `min_samples <= 1` 분기를 타지 않거나(이미 정수) `int()`가 무영향이라 dbscan parity·edge_case 등 38개 P2P 불변. docstring을 `int > 1`로 정정해도 런타임 무관.
4. **함정 회피**: 가장 흔한 실수는 `compute_optics_graph` 한 곳만 고치고 `cluster_optics_xi`의 `min_samples`/`min_cluster_size` 두 사이트를 빠뜨리는 것 — 그러면 `test_extract_xi`가 `min_cluster_size=0.08`에서 다시 터진다. hints (2) "fix similar issues in cluster_optics_xi"가 이를 명시. 또 `int(round(...))`로 과하게 가는 함정은 Python2 미고려로 불필요(hints (1)). 결함클래스(float 환산 후 캐스팅 누락)를 호출지점 전수로 grep해 일괄 적용하는 것이 정답 궤적.
