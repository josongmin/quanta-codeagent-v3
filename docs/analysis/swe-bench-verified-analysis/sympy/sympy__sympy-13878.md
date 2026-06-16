---
instance_id: sympy__sympy-13878
repo: sympy/sympy
base_commit: 7b127bdf71a36d85216315f80c1b54d22b060818
version: "1.1"
difficulty: ">4 hours"
created_at: 2018-01-10T07:00:58Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [sympy/stats/crv_types.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
연속분포는 PDF만 정의하고 CDF는 적분으로 얻는데, 적분이 어려운 분포들(Arcsin, Dagum, Erlang, Frechet, Gamma, GammaInverse, Kumaraswamy, Laplace, Logistic, Nakagami, StudentT, UniformSum)에서 `cdf(...)` 가 미평가 `Integral` 을 뱉거나, hang 하거나, 부적절한 float을 반환한다. Normal/Uniform 처럼 분포별 `_cdf` 메서드로 닫힌형 CDF를 precompute 하라는 요청이다. 이슈는 각 분포의 구체 입력 예시와 위키 CDF 공식 참조까지 제공한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 "Normal/Uniform 처럼 `_cdf` 추가"라고 메커니즘·파일·메서드명을 직접 지목. 기존 `SingleContinuousDistribution._cdf` 패턴이 동일 파일(`crv_types.py`)에 존재해 grep 한 방. 탐색 비용 사실상 0.
- **S2 Constraint-Reasoning (+S1 Direct-Map)**: 위치는 자명하지만 핵심 난점은 각 분포의 CDF를 **올바른 수학식으로 합성**하는 것 — 어느 SymPy 함수(`lowergamma`/`uppergamma`/`hyper`/`asin`)로 적분을 닫고, 어느 구간에 `Piecewise` support 경계를 거는지를 분포마다 따져야 한다. 한 분포 패턴이 잡히면 나머지는 기계적(S1) 반복이라 dominant=S2, 보조=S1.
- **K-Domain**: 확률분포·특수함수(불완전감마/초기하함수) 도메인 지식이 병목. 일반 파이썬 추론으로는 StudentT CDF가 `hyper`로 닫힌다는 걸 못 낸다.
- **primary = T-DomainBound**: localize는 trivial, 픽스 정답성이 전적으로 "이 분포의 CDF 닫힌형이 뭔가"라는 프레임워크/수학 지식에 달려 있어 K-Domain이 진짜 병목.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개(`crv_types.py`)뿐 → cross-file 조율 없음. localize L0, has-repro(이슈에 실행 가능한 재현 호출 다수).
- 그러나 변경량이 11개 분포 × (`_cdf` 메서드 + 일부 import + docstring) 로 多헌크(이슈가 나열한 12개 중 Erlang은 새 `_cdf` 없이 Gamma로 위임). 각 `_cdf` 의 수식·support 경계가 분포마다 달라 단순 복붙 불가 → S2 추론이 줄마다 반복.
- 채점 FAIL_TO_PASS는 `test_arcsin` 1개로 얇지만, PASS_TO_PASS 19개가 동일 테스트파일의 인접 분포 테스트라 regression-trap 존재.
- 공식 라벨 `>4 hours`(T6급 시간)보다 낮게 본 이유: 개발자 실제 소요는 12분포 수식 12개를 위키 보며 입력하는 **수작업 분량**에서 오지, localize/추론 깊이에서 오지 않는다. 에이전트 관점 난이도(어디인지·어떻게 일반화)는 L0+패턴반복이라 T4가 맞다. 시간라벨은 양(volume)을 재고 우리 축은 구조 복잡도를 잰다.

## 골드패치 분석
- **건드린 파일**: `sympy/stats/crv_types.py` 단일.
- **import 확장**: 상단 sympy import에 `uppergamma, hyper` 추가(이미 있던 `lowergamma, erf, erfc` 옆).
- **근본원인**: 각 `*Distribution` 클래스가 `_cdf` 를 정의하지 않아 베이스의 일반 적분 경로로 떨어지고, 적분기가 닫지 못해 미평가 `Integral`/hang/float이 노출됨.
- **수정요지**: 분포별 `_cdf(self, x)` 메서드를 추가해 닫힌형 CDF를 제공.
  - `ArcsinDistribution._cdf`: `Piecewise((0, x<a), (2*asin(sqrt((x-a)/(b-a)))/pi, x<=b), (1, True))` — 이름값대로 arcsin.
  - `DagumDistribution`/`FrechetDistribution`/`KumaraswamyDistribution`/`LaplaceDistribution`/`LogisticDistribution`: 특수함수 없는 초등 닫힌형 + support `Piecewise`.
  - `GammaDistribution`/`NakagamiDistribution`: `lowergamma(.)/gamma(.)`, `GammaInverseDistribution`: `uppergamma(a,b/x)/gamma(a)`.
  - `StudentTDistribution._cdf`: `1/2 + x*gamma((nu+1)/2)*hyper((1/2,(nu+1)/2),(3/2,),-x**2/nu)/(sqrt(pi*nu)*gamma(nu/2))` — 초기하함수.
  - `UniformSumDistribution._cdf`: PDF와 동형의 `Sum` + `floor(x)` 경계 `Piecewise`.
  - `Erlang` 은 `GammaDistribution(k, S.One/l)` 로 위임되며, 골드에서 `1/l → S.One/l` 로 바꿔 유리수성을 보존(이슈의 "float 나오면 안 된다" 대응). 다수 기존 `x>=0` → `x >= 0` 등은 PEP8 노이즈.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_arcsin`(1개)**: `cdf(X)(x) == Piecewise((0, a>x), (2*asin(sqrt((-a+x)/(-a+b)))/pi, b>=x), (1, True))` 를 단언. `_cdf` 추가 전엔 비수렴 `Integral` 이라 불일치 → 추가 후 정확히 일치하여 RED→GREEN.
- test_patch는 추가로 `test_long_precomputed_cdf` 를 도입해 11개 분포에 대해 `verify_numerically(diff(cdf), pdf)` 로 "CDF 미분=PDF" 를 랜덤점에서 수치검증(이슈가 제안한 검증법). 다만 이 테스트는 채점 FAIL_TO_PASS에 포함되지 않음(수치·속도 변동성). 따라서 **공식 채점은 Arcsin 한 분포의 심볼릭 동등성만** 본다.
- **overfit 관점**: 채점이 단일 분포 심볼릭 표현식 1개라 매우 얇음 → 표현식 형태만 맞추면 통과. 그러나 `_cdf` 가 잘못되면 (오라클 밖이지만) `test_long_precomputed_cdf` 의 diff=pdf 수치체크가 잡으므로 "올바른 일반화"의 기준은 후자다. flags에 `overfit-risk`를 굳이 안 붙인 이유: 정답 형태가 수학적으로 유일에 가깝고, 미분=PDF 라는 강한 oracle이 존재.
- **regression 관점**: PASS_TO_PASS 19개(benini/chi/chi_squared/gompertz/trapezoidal 등) 는 모두 `_cdf` 를 추가하지 않은 인접 분포라, 신규 메서드가 이들 density/표현식을 건드리지 않아야 함. import 추가·docstring 수정이 기존 doctest를 깨지 않는지가 trap.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 문구 "internal `_cdf` method ... as is the case for Normal and Uniform" → `crv_types.py` 에서 `NormalDistribution._cdf`/`UniformDistribution._cdf` 를 grep, 동일 클래스 패턴(`def _cdf(self, x): return Piecewise(...)`)을 본떠 대상 11개 분포 클래스(Arcsin/Dagum/Frechet/Gamma/GammaInverse/Kumaraswamy/Laplace/Logistic/Nakagami/StudentT/UniformSum)에 메서드를 단다. 이슈가 나열한 12개 중 Erlang은 새 `_cdf` 를 받지 않고 `GammaDistribution(k, S.One/l)` 로 위임되어 Gamma의 `_cdf` 를 재사용한다. cross-file 없음.
2. **픽스와 일반화**: 각 분포의 CDF를 위키/도메인 지식으로 닫힌형으로 적고, support 밖은 0/1 로 `Piecewise` 분기. 적분 호출이 아니라 명시 수식이라 hang/미평가가 구조적으로 제거됨. `lowergamma`/`uppergamma`/`hyper`/`asin` 미import면 추가. 이게 overfit이 아닌 이유: CDF는 PDF의 적분으로 유일 결정되며, `diff(_cdf)==pdf` 라는 검증가능한 불변식을 만족하는 한 표현식 형태가 달라도 수학적으로 동치 — 테스트가 요구하는 건 임의 매직값이 아니라 이 불변식.
3. **regression 안전**: 신규 `_cdf` 는 해당 클래스에만 추가하고 `pdf`/`__new__`/density 경로를 변경하지 않아 PASS_TO_PASS 19개(_cdf 미추가 분포)의 density·characteristic_function·sampling 동작이 불변. Erlang은 `1/l→S.One/l` 로 바꿔 유리수 입력에서 float 누출만 막되 값 의미는 보존. docstring에 추가하는 `>>> cdf(X)(z)` doctest 출력은 실제 결과와 글자단위로 맞춰야 doctest 회귀가 안 난다.
4. **함정 회피**: (a) support 경계 부등호 방향(`x<a` vs `x<=b`, Laplace의 `x<mu`/`x>=mu`)을 틀리면 미분=PDF 검증은 통과해도 경계점 값이 어긋남 — 위키 정의대로. (b) GammaInverse는 `lowergamma`가 아니라 `uppergamma` (꼬리방향 반대)라 함수 선택 실수가 흔하다. (c) StudentT를 부정적분 시도로 닫으려 하면 hang — `hyper` 닫힌형을 도메인지식으로 직접 써야 한다. (d) 오라클 없는 에이전트는 채점이 `test_arcsin` 1개임을 모르므로 Arcsin만 고치고 끝낼 위험 vs 12분포 전체를 요구로 오인할 위험 둘 다 있다. 이슈가 12개를 모두 나열하므로 전체 구현이 정답 방향이고, 채점은 그 중 Arcsin만 본다.
