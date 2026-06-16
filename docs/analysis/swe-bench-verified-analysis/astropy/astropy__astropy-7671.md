---
instance_id: astropy__astropy-7671
repo: astropy/astropy
base_commit: a7141cd90019b62688d507ae056298507678c058
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: 2018-07-20T19:37:49Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [astropy/utils/introspection.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Gen
flags: [has-repro, overfit-risk]
---

## 문제 요약
PR #7647이 `pkg_resources.parse_version`를 `distutils`의 `LooseVersion`으로 교체하면서, `minversion('numpy', '1.14dev')`처럼 버전 문자열에 `dev`/`rc1` 같은 비숫자 토큰이 섞이면 `TypeError: '<' not supported between instances of 'int' and 'str'`가 발생한다. 이는 알려진 CPython 버그(bpo-30272)로, `LooseVersion('1.14.3') >= LooseVersion('1.14dev')`처럼 한쪽이 숫자 컴포넌트, 다른 쪽이 문자열 컴포넌트로 끝나면 비교 중 혼합 타입 비교가 터지기 때문이다. 이슈와 hints는 "예전에 있던 정규식을 복원하라"고 직접 명시한다.

## 유형 (정형화)
- **L0 (Localization)**: 스택트레이스가 `astropy/utils/introspection.py`의 `minversion` 안 `LooseVersion(...) >= LooseVersion(...)` 라인을 직접 지목. grep 한 방. 후보 탐색 불필요.
- **S2 (Repair Strategy)**: 고칠 위치는 자명하나, 픽스의 핵심은 "비교 전에 버전 문자열에서 dotted-number 접두부만 남긴다"는 **올바른 정규화 식을 추론·합성**하는 것. 단순 None-가드나 상수 변경이 아니라, 어떤 부분을 잘라내야 `LooseVersion` 비교가 안전해지는지 불변식을 따져야 함 → S1이 아니라 S2.
- **K-Gen (Knowledge)**: astropy 도메인 지식 불필요. 표준 라이브러리(`distutils`, `re`)와 PEP440 일반 지식이면 충분. 모델빨 낮음.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 "비교 가능 형태로 만드는 정규식"이라는 의미적 조건 합성(S2)이라, 기계적 Direct-Map보다 한 단계 위인 ConstraintReason이 dominant.

## 난이도 티어
**T3 (중간).** 구조적 피처: 단일 파일·단일 함수, gold diff는 8줄(import 1 + 7줄 블록)로 작다. has-repro(완전한 네이티브 스택트레이스)가 강한 easiness 신호. P2P 3개는 인접한 introspection 테스트(`test_pkg_finder`, `test_find_current_mod`, `test_find_mod_objs`)뿐이라 regression-trap 약함. 그럼에도 T1/T2가 아닌 이유: 픽스가 "체크 추가"가 아니라 **PEP440 정규식을 합성**해 `m.group(0)`로 dotted-number 접두부만 추출하는 의미적 정규화이고, 입력공간(임의 PEP440 버전 문자열)이 넓어 잘못된 정규식이면 조용히 틀리기 때문. 공식 라벨 "15 min - 1 hour"와 정합 — localize는 즉시지만 올바른 정규식 도출에 시간이 든다.

## 골드패치 분석
- **파일·함수**: `astropy/utils/introspection.py`의 `minversion(module, version, inclusive=True, version_path='__version__')`.
- **근본원인**: 비교 인자 `version`이 PEP440 비숫자 suffix(`dev`, `rc1`)를 포함하면 `LooseVersion`이 숫자 컴포넌트와 문자열 컴포넌트를 혼합 비교하다 bpo-30272로 `TypeError`. PR #7647이 이 suffix를 걸러주던 정규식 정규화를 제거한 게 회귀의 직접 원인.
- **수정요지**: 모듈 상단에 `import re` 추가. `inclusive` 분기 직전에 PEP440(Appendix B) 기반 정규식 `expr = '^([1-9]\d*!)?(0|[1-9]\d*)(\.(0|[1-9]\d*))*'`로 `version` 앞부분의 dotted-number(+epoch)만 매치, 매치되면 `version = m.group(0)`로 잘라낸다. 즉 `'1.14dev'` → `'1.14'`로 정규화한 뒤 비교해 혼합타입 비교를 원천 차단.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_minversion`. test_patch가 `good_versions`에 `'0.12dev'`를 추가(`'0.12.0.dev'`는 이미 통과하던 케이스)해, suffix 직결형(`0.12dev`)에서도 `minversion(test_module, version)`이 `TypeError` 없이 `True`를 반환하는지 단언. `bad_versions = ['1', '1.2rc1']`은 여전히 `False`여야 함(정규식이 `1` / `1.2`로 잘라도 0.12.2보다 큰 메이저라 minversion False 유지).
- **픽스 증명**: 정규식 적용 후 `'0.12dev'`→`'0.12'`가 되어 `LooseVersion('0.12.2') >= LooseVersion('0.12')` = True. 픽스 전엔 같은 라인에서 TypeError로 죽음 → 인과 일치.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개, 추가 입력도 `'0.12dev'` 하나뿐이라 **overfit-risk 존재** — 가령 `version.split('dev')[0]` 같은 special-case 핵으로도 이 테스트는 통과하지만 `rc`/`a`/`b`/epoch(`1!2.0`) 등은 못 잡는다. gold의 PEP440 정규식은 이 입력공간 전체를 커버하는 올바른 일반화. P2P 3개는 introspection의 무관한 함수라 정규식 추가가 안 깬다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 스택트레이스가 `introspection.py:146 minversion`의 `LooseVersion(have_version) >= LooseVersion(version)`를 직접 가리킴 → 즉시 해당 함수로 수렴(L0). 이슈가 bpo-30272와 "정규식 복원"까지 적어줘 탐색 0.
2. **픽스**: `version` 인자를 비교 전에 PEP440 dotted-number 접두부로 정규화. `^([1-9]\d*!)?(0|[1-9]\d*)(\.(0|[1-9]\d*))*` 정규식으로 epoch+release 세그먼트만 매치해 `m.group(0)`로 절단. suffix를 통째 떼는 게 아니라 "선두의 숫자/점 구조"만 보존하므로 임의 PEP440 입력에 일반화 → special-case가 아닌 올바른 픽스. `have_version`은 실제 설치버전이라 정상 dotted-number 가정이 합리적이고 정규화 불필요.
3. **regression 안전**: P2P(`test_pkg_finder`/`test_find_current_mod`/`test_find_mod_objs`)는 `minversion`을 안 거치는 introspection 유틸 테스트라 정규식 도입이 무영향. 정상 버전(`'0.12'`, `'0.12.1'`)은 정규식이 전체를 매치해 동작 불변 → 기존 good 케이스 보존.
4. **함정 회피**: (a) `'0.12dev'`만 보고 `rstrip`/`split('dev')` 류로 특정 토큰만 처리하면 `rc1`·epoch에서 재발 → 반드시 PEP440 화이트리스트 정규식으로 풀 것. (b) `have_version`까지 같이 정규화하면 실제 dev 빌드 버전 비교가 어긋날 수 있어 `version`에만 적용. (c) `LooseVersion`을 `packaging.version`으로 바꾸는 큰 리팩터는 의존성/하위호환 리스크라 비교계약을 유지한 채 입력만 정규화하는 최소 수정이 오라클과 일치.
