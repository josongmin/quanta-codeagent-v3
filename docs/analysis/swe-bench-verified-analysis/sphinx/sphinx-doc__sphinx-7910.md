---
instance_id: sphinx-doc__sphinx-7910
repo: sphinx-doc/sphinx
base_commit: 27ac10de04697e2372d31db5548e56a7c6d9265d
version: "3.2"
difficulty: "<15 min fix"
created_at: 2020-07-04T01:08:20Z
fail_to_pass: 1
pass_to_pass: 16
gold_files: [sphinx/ext/napoleon/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`napoleon_include_init_with_doc = True`인데도 데코레이트된 `__init__`(또는 special method)이 문서에 나오지 않는다.
이슈 작성자가 직접 근본 원인 라인 `cls = obj.__globals__[cls_path]`까지 짚어줬다.
`functools.wraps`로 감싸면 `obj`가 원본 메서드가 아니라 wrapper 함수가 되어 그 `__globals__`에 클래스가 없고,
그 결과 `cls_is_owner=False`로 판정되어 napoleon이 메서드를 멤버로 취급하지 못한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·함수·라인까지 직접 지목. `_skip_member`의 `obj.__globals__[cls_path]` 한 줄. grep 한 방으로 끝. 근거: problem_statement에 root-cause 코드 라인 명시.
- **S1 (Direct-Map) +S2**: 픽스는 "wrapper를 벗겨 원본 함수의 `__globals__`를 읽어라"로 기계적으로 매핑된다 — `obj` → `inspect.unwrap(obj)`. 다만 "wraps된 객체는 `__wrapped__` 체인을 풀어야 진짜 함수에 닿는다"는 작은 불변식 추론(S2)이 보조로 들어간다.
- **K-Domain**: `sphinx.util.inspect.unwrap`이라는 sphinx 내부 유틸과 `functools.wraps`/`__wrapped__` 데코레이터 셈안틱을 알아야 한다. 일반 파이썬 추론만으로도 `functools.unwrap`을 떠올릴 수 있으나, 프로젝트 관례상 `sphinx.util.inspect`를 쓰는 게 정답이라 도메인 바운드.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 정형 결함클래스(데코레이터 unwrap 가드)에 템플릿 매칭(S1). overfit-guided도 아니고 spec 재구성도 아님.

APR 관점: 이슈가 사실상 fix를 명세(작성자가 원인 라인 특정)하므로 generate-&-validate 탐색이 불필요. "원본 객체 복원 후 동일 연산"이라는 PAR/TBar 류 unwrap 템플릿의 직접 적용이라 S1이 dominant.

## 난이도 티어
**T2 (쉬움)** — 공식 라벨 "<15 min fix"와 일치.
구조적 피처: 1파일·1함수·실질 1줄(+import 1줄), localize 직접성 최상(L0, 이슈가 라인 지목), `has-repro`(데코레이트된 메서드 재현 절차 명확).
T1이 아닌 이유: 픽스가 `obj.__globals__`라는 wrapper 셈안틱과 `inspect.unwrap` 도메인 유틸 인지를 요구해 완전 자명(K-Gen)은 아니다.
T3 이상이 아닌 이유: cross-file 조율 없음, 추론량 미미, P2P trap도 napoleon `_skip_member` 같은 모듈 내부에 국한.

## 골드패치 분석
- **파일/함수**: `sphinx/ext/napoleon/__init__.py`의 `_skip_member`.
- **근본 원인**: bbfd0d05 커밋이 도입한 owner-class 판정 분기에서 `cls = obj.__globals__[cls_path]`로 클래스를 역추적한다. `obj`가 `functools.wraps` wrapper이면 그 `__globals__`는 데코레이터 정의 모듈의 전역이라 `cls_path` 키가 없어 `KeyError` → `except`로 `cls_is_owner = False` 처리되어 멤버가 스킵된다.
- **수정 요지**: 두 줄.
  1. `from sphinx.util import inspect` import 추가.
  2. `cls = obj.__globals__[cls_path]` → `cls = inspect.unwrap(obj).__globals__[cls_path]`.
  `inspect.unwrap`이 `__wrapped__` 체인을 따라 원본 함수까지 벗겨내, 그 `__globals__`에서 실제 정의 모듈의 클래스를 찾게 한다.

## 검증 (test_patch)
- **FAIL_TO_PASS** = `SkipMemberTest::test_class_decorated_doc` 1개. 테스트 픽스처에 `@simple_decorator`(=`functools.wraps` 통과형 no-op 데코레이터, `sphinx/testing/util.py`에 신설)로 감싼 `__decorated_func__`를 추가하고, `_skip_member(..., '__decorated_func__', ...)`가 `False`(스킵 안 함)를 반환해야 통과.
- **픽스 증명**: 패치 전엔 wrapper의 `__globals__`에 클래스 없어 `cls_is_owner=False` → 스킵(`None` 또는 skip 반환). unwrap 후엔 원본 함수 `__globals__`에서 owner 클래스 발견 → `cls_is_owner=True` → `False` 반환. 테스트가 정확히 이 분기를 친다.
- **overfit 관점**: FAIL_TO_PASS 1개로 얇지만, 픽스가 special-case 분기가 아니라 입력 객체를 정규화(unwrap)하는 일반 변환이라 overfit 위험 낮음. 다만 `assertIs(..., False)`로 강화한 건 `None`/falsy 구분 회피용 — 약테스트를 의식한 좋은 변경.
- **regression 관점**: PASS_TO_PASS 16개(private/special/module/exception/namedtuple 스킵 케이스 전부). `regression-trap`로 표기 — unwrap이 비데코레이트 객체엔 no-op(`__wrapped__` 없으면 그대로 반환)이라야 이들이 안 깨진다. `inspect.unwrap`은 정확히 그 셈안틱이라 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `obj.__globals__[cls_path]`와 bbfd0d05 커밋을 직접 지목 → `sphinx/ext/napoleon/__init__.py`의 `_skip_member` owner-class 분기로 즉시 수렴. grep `__globals__` 한 방.
2. **픽스와 일반화 근거**: `obj`가 데코레이터 wrapper일 수 있음을 인지하고, owner 판정 전에 `inspect.unwrap(obj)`로 원본 함수 복원. "데코레이트 여부와 무관하게 실제 정의 객체의 `__globals__`를 본다"는 정규화라 모든 wraps-호환 데코레이터에 일반화됨(특정 데코레이터 하드코딩 아님). 프로젝트 관례인 `sphinx.util.inspect.unwrap` 사용이 정답.
3. **regression 안전**: PASS_TO_PASS의 비데코레이트 special/private 케이스 16개는 `unwrap`이 `__wrapped__` 없는 객체에 no-op이어야 보존됨 — `functools.unwrap` 동등 셈안틱 확인 필수. owner 분기 외 코드 경로는 불변.
4. **함정 회피**: (a) wrapper의 `__doc__`은 정상이라 docstring 기반 디버깅으론 원인이 안 잡힘 — `__globals__` 출처가 핵심이라는 점을 놓치면 엉뚱한 곳을 고친다. (b) `try/except`가 `KeyError`를 삼켜 `cls_is_owner=False`로 조용히 흘러가므로 증상(스킵)만 보고 except 블록을 만지면 오진. (c) `functools.unwrap` 직접 호출 대신 `sphinx.util.inspect.unwrap`을 써야 sphinx의 unwrap 가드(순환/깊이) 정책과 일관됨.
