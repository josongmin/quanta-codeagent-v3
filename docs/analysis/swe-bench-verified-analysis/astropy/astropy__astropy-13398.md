---
instance_id: astropy__astropy-13398
repo: astropy/astropy
base_commit: 6500928dc0e57be8f06d1162eacc3ba5e2eff692
version: "5.0"
difficulty: "1-4 hours"
created_at: 2022-06-24T15:22:11Z
fail_to_pass: 4
pass_to_pass: 68
gold_files: [astropy/coordinates/builtin_frames/__init__.py, astropy/coordinates/builtin_frames/intermediate_rotation_transforms.py, astropy/coordinates/builtin_frames/itrs.py, astropy/coordinates/builtin_frames/itrs_observed_transforms.py]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [underspecified, regression-trap, cross-file-dep]
---

# astropy__astropy-13398

## 문제 요약
ITRS->AltAz/HADec 변환이 지구중심(geocentric) 대 지표(topocentric) 항성수차(aberration) 차이 때문에 위성·근지구 천체 관측에서 부정확하다는 반복 민원이 있다. 이슈는 ITRS 내부에 머무르며 ITRS<->AltAz/HADec를 직접 변환하는 새 경로를 제안하며, 그 전제조건으로 ITRS 프레임에 `location`(`EarthLocation`) 속성을 추가해 topocentric ITRS를 표현 가능하게 한다. 이슈 본문은 설계 토론과 prototype 코드(refraction 미포함)만 제시하고, 최종 API·배선·refraction 처리는 미명세 상태다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 단일 버그 위치가 아니라 4개 파일을 **조율**해서 함께 바꿔야 한다 — 신규 transform 모듈(`itrs_observed_transforms.py`), `ITRS` 프레임에 `location` 속성 추가(`itrs.py`), 기존 ITRS<->TETE/CIRS 변환의 location 전파(`intermediate_rotation_transforms.py`), 등록(`__init__.py`). 어느 하나만 빠져도 동작 안 함.
- **S = S6 Design-Refactor (+S5 Spec-Inference)**: 한 줄 픽스가 아니라 새 프레임 속성 도입 + transform graph 등록이라는 **구조 변경**이다. 또한 이슈가 "어떻게 일반화해 짤지"(refraction 포함 여부, obstime/location no-op 의미)를 미명세로 남겨 docstring·관례·erfa 참조에서 스펙을 재구성해야 한다(S5).
- **K = K-Domain**: ERFA(`refco`/`atioq`/`atoiq`), WGS84 geodetic, ITRS/CIRS/TETE/AltAz/HADec 좌표계 의미, 항성수차, frame_transform_graph 등록 메커니즘 등 astropy.coordinates 내부 지식이 병목.
- **primary_type = T-DesignRefactor**: dominant 축이 "조율된 다파일 구조 변경"이다. 위치 찾기보다 *새 기능을 프레임워크 관례에 맞게 설계해 끼워넣는* 일이 본질이라 S6를 1순위로 본다.
- 왜 이 strategy인가(APR 관점): plausible 후보를 테스트로 수렴(S3/S4)하는 문제가 아니다. 새 모듈의 함수 구조·행렬 정의·등록 순서가 상호의존적이고, 테스트는 수치 round-trip 동치를 요구하므로 임의 패치가 우연히 통과할 여지가 거의 없다. 따라서 reasoning 기반 구조 합성(S6)이 유일 경로다.

## 난이도 티어
**T6 (매우 어려움)**으로 본다(공식 라벨 "1-4 hours"는 *작성자 본인*이 prototype을 이미 가진 상태의 구현시간이라 에이전트 난이도를 과소평가).
- 파일수 4 / 신규파일 1(145줄) — 구조컷상 ">=3파일·>100줄 → solve <10%" 구간.
- localize 직접성: 거의 없음. 이슈는 "버그 위치"가 아니라 신규 기능 요청이고, 에이전트는 어디에 무엇을 추가할지를 관례로부터 추론해야 함(L3).
- repro: 수치 재현 스니펫은 있으나 *prototype*일 뿐, 골드와 다름(prototype은 refraction 없음, 골드는 `add_refraction`/`remove_refraction` 추가). has-repro 신호 약함.
- 도메인: 깊은 K-Domain(ERFA refraction 모델 `A*tan(z)+B*tan^3(z)`, Newton-Raphson 보정).
- P2P trap: 68개. 특히 `test_straight_overhead`, `test_cirs_itrs`, `test_gcrs_itrs` 같은 기존 ITRS 변환이 깨지면 안 됨 → `location` 기본값을 `EARTH_CENTER`로 두어 byte-compatible geocentric 유지가 강제됨.

## 골드패치 분석
- **`itrs.py` / `ITRS`**: `location = EarthLocationAttribute(default=EARTH_CENTER)` 속성 추가 + `EarthLocationAttribute` import + topocentric ITRS 설명 docstring/`doc_footer`. 근본원인: 기존 ITRS는 location을 가질 수 없어(이슈의 `TypeError: got unexpected keywords: ['location']`) topocentric 표현 자체가 불가능했음.
- **`itrs_observed_transforms.py` (신규)**: `itrs_to_observed`/`observed_to_itrs` 한 쌍을 `ITRS<->AltAz`, `ITRS<->HADec`로 graph 등록. 행렬 빌더 `itrs_to_altaz_mat`/`itrs_to_hadec_mat`/`altaz_to_hadec_mat`(left-handed 프레임 처리), refraction `add_refraction`/`remove_refraction`(erfa `refco` + atioq/atoiq 모델). `itrs_to_observed`는 input/output의 location·obstime이 다르면 CIRS 경유로 ITRS를 재참조해 수차를 처리.
- **`intermediate_rotation_transforms.py`**: `tete_to_itrs`/`cirs_to_itrs`가 `location=EARTH_CENTER`로 강제하던 것을 `location=itrs_frame.location`으로, 역변환 `itrs_to_tete`/`itrs_to_cirs`는 생성하는 TETE/CIRS에 `location=itrs_coo.location`을 전파. 근본원인: location을 잃으면 topocentric ITRS round-trip이 깨짐.
- **`__init__.py`**: `from . import itrs_observed_transforms` 등록(없으면 transform이 graph에 안 붙음).

## 검증 (test_patch)
- **FAIL_TO_PASS (4)**: `test_itrs_topo_to_altaz_with_refraction`, `test_itrs_topo_to_hadec_with_refraction`는 ICRS->(ITRS경유)->AltAz/HADec 결과가 정상 경로(직접) 결과와 0.1 mas / 10 cm 이내 일치 + refraction 추가/제거 + round-trip(`itrs11.x == itrs.x`)을 검증. `test_cirs_itrs_topo`는 topocentric CIRS<->ITRS round-trip(같은 obstime 일치, 다른 obstime 불일치). `test_itrs_straight_overhead`는 관측소 ITRS를 빼서 만든 topocentric ITRS가 정확히 Alt=90°를 주는지(1 uas) 확인.
- **픽스 증명**: 골드의 `location` 속성·transform 등록·location 전파가 모두 있어야 위 동치가 성립. 행렬 정의나 refraction이 틀리면 mas/cm tolerance에서 즉시 실패하므로 테스트가 구조적으로 강함(teeth 충분).
- **overfit 관점**: round-trip + 두 독립 경로(직접 vs ITRS 경유) 동치 + refraction on/off 조합 + straight-overhead 기하 제약을 동시에 요구 → special-case 패치로는 통과 불가. overfit-risk 낮음(그래서 flag 미부여).
- **regression 관점**: 68개 P2P 중 기존 ITRS 경로(`test_cirs_itrs`, `test_gcrs_itrs`, `test_straight_overhead`)가 그대로 통과해야 함. `default=EARTH_CENTER` 덕에 location 미지정 ITRS는 기존 geocentric 동작 보존 → regression-trap을 통과시키는 핵심 설계점.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 직접 import 경로(`from .altaz import AltAz` 등)와 `frame_transform_graph.transform(..., ITRS, AltAz)` 데코레이터를 보여주므로 → `builtin_frames/` 디렉토리, transform 모듈 패턴, `__init__.py`의 `from . import ..._transforms` 등록 관례를 식별. `TypeError ... ['location']` 단서 → `itrs.py`의 `ITRS` 클래스에 frame attribute가 없음을 지목.
2. **픽스와 올바른 일반화**: ITRS에 `EarthLocationAttribute(default=EARTH_CENTER)`를 추가(다른 좌표 프레임의 `location` 관례 그대로) → topocentric ITRS를 1급으로 표현. 신규 transform은 prototype을 넘어 refraction(erfa atioq/atoiq 미러)까지 포함해 "정상 CIRS 경로와 수치 일치"라는 일반 불변식을 만족. 이는 특정 입력만 맞추는 게 아니라 *모든 location·obstime·refraction 조합*에서 round-trip이 닫히도록 한 일반화.
3. **regression 안전**: `default=EARTH_CENTER`로 location 미지정 ITRS는 기존 geocentric 변환과 동일하게 거동 → `test_cirs_itrs`, `test_gcrs_itrs`, `test_straight_overhead` 등 68 P2P 보존. 또 `intermediate_rotation_transforms`에서 location 전파를 추가하되 기본이 EARTH_CENTER라 기존 호출은 의미 불변.
4. **함정 회피**: (a) prototype을 그대로 베끼면 refraction 누락으로 `*_with_refraction` 테스트가 mas 단위로 실패 — 이슈가 "refraction 미포함"이라 명시하므로 erfa 모델을 직접 구현해야 함을 인지해야 한다. (b) `__init__.py` 등록을 빠뜨리면 transform이 graph에 없어 `transform_to`가 경로를 못 찾음(조용한 누락). (c) 역변환에서 `location` 전파를 잊으면 topocentric round-trip(`test_cirs_itrs_topo`)이 깨짐. (d) location 기본값을 EARTH_CENTER가 아닌 None 등으로 두면 광범위 P2P regression. 오라클 없는 에이전트는 (a)(c)에서 가장 자주 틀린다.
