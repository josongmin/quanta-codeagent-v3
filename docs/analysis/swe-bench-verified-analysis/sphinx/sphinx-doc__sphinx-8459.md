---
instance_id: sphinx-doc__sphinx-8459
repo: sphinx-doc/sphinx
base_commit: 68aa4fb29e7dfe521749e1e14f750d7afabb3481
version: "3.4"
difficulty: "<15 min fix"
created_at: 2020-11-20T16:44:10Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [sphinx/ext/autodoc/typehints.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`autodoc_type_aliases` (타입 별칭 매핑)는 `autodoc_typehints`가 기본값(`signature`)일 때는 동작하지만, `'description'`으로 설정하면 무시되어 별칭 대신 원본 타입(`Dict[str, Any]`)이 그대로 렌더된다. 이슈는 두 모드의 출력 차이를 명확한 before/after 재현 코드와 함께 제시한다. 기대 동작은 두 모드 모두에서 별칭(`types.JSONObject`)을 표시하는 것이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 파일을 직접 지목하진 않지만 `autodoc_typehints='description'`이라는 키워드로 후보가 좁다. 이 모드 전용 코드 경로는 `sphinx/ext/autodoc/typehints.py`이고, 그 안의 `record_typehints`가 어노테이션을 추출하는 유일한 지점이라 약간의 grep으로 수렴한다.
- **S2 (Constraint-Reasoning) +S1**: 픽스 자체는 한 줄(`inspect.signature(obj)` → `inspect.signature(obj, type_aliases=app.config.autodoc_type_aliases)`)이라 기계적(S1)으로 보이지만, "왜 별칭이 누락되는가"는 **두 코드 경로가 같은 시그니처 추출을 공유하지 않는다**는 불변식을 추론해야 도달한다. description 모드만 `record_typehints`를 거치고, 이 호출만 `type_aliases`를 빠뜨렸다 — 이 비대칭을 짚는 것이 핵심이라 S2가 dominant.
- **K-Domain**: `autodoc_type_aliases`, `autodoc_typehints` 두 config의 의미, signature/description 모드가 별개 파이프라인이라는 점, `inspect.signature`가 sphinx 래퍼라 `type_aliases` 인자를 받는다는 사실 — 전부 sphinx autodoc 내부 지식이다.
- **primary type = T-DomainBound**: 병목이 일반 파이썬 추론이 아니라 autodoc의 모드별 파이프라인 구조 지식에 있다. localize·픽스 모두 도메인 지식에 게이팅된다.

## 난이도 티어

**T3 (중간)** — 구조 피처: 1파일·1줄·1헌크로 patch scope는 최소(T1~T2급)지만, 다음이 티어를 위로 민다. (1) localize가 자명하지 않다 — 이슈는 *signature 모드는 되는데 description 모드는 안 됨*이라는 모드 대비만 줄 뿐, `record_typehints`라는 함수명을 주지 않는다. (2) 픽스의 정당성이 "왜 한쪽 경로만 인자를 빠뜨렸나"를 이해해야 나온다(S2). (3) `record_typehints`는 description 모드 어노테이션의 단일 진입점이라 잘못 건드리면 광범위한 P2P(17개)를 깬다 → regression-trap. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 이는 *오라클을 본 개발자의 구현시간*이고 모드별 파이프라인을 모르는 에이전트의 localize/추론 비용은 잡지 못하므로 T3로 상향한다.

## 골드패치 분석

- **파일·함수**: `sphinx/ext/autodoc/typehints.py`의 `record_typehints(app, objtype, name, obj, options, args, retann)`.
- **근본원인**: `autodoc_typehints='description'`일 때 타입힌트는 시그니처가 아니라 본문(Parameters/Return type)으로 옮겨진다. 이 모드는 `record_typehints`가 `inspect.signature(obj)`로 어노테이션을 따로 추출해 `env.temp_data['annotations']`에 저장한 뒤 `merge_typehints`가 본문에 주입하는 별도 경로를 탄다. 그런데 이 `inspect.signature` 호출만 `type_aliases` 인자를 누락했다 — signature 모드 경로(`sphinx/ext/autodoc/__init__.py`의 `format_signature` 계열, 1252·1314·1446 등)는 이미 `type_aliases=self.config.autodoc_type_aliases`를 전부 넘기고 있었다.
- **수정요지**: 그 한 호출을 `inspect.signature(obj, type_aliases=app.config.autodoc_type_aliases)`로 바꿔 description 경로도 별칭 치환을 적용. sphinx 래퍼 `inspect.signature`가 이미 `type_aliases` 파라미터를 받으므로 추가 배선 없이 한 줄로 두 경로의 동작을 정렬한다.

## 검증 (test_patch)

- **FAIL_TO_PASS** (`test_autodoc_typehints_description_and_type_aliases`): `confoverrides={'autodoc_typehints': "description", 'autodoc_type_aliases': {'myint': 'myint'}}`로 `target.annotations.sum`을 text 빌드한 뒤, Parameters의 `**x** (*myint*)`·`**y** (*myint*)`와 `Return type: myint`가 그대로 별칭으로 나오는지 정확 문자열 비교한다. base에서는 원본 타입이 나와 실패, 패치 후 별칭이 description 본문에 반영되어 통과.
- **픽스 증명**: 테스트가 description 모드 + 별칭의 조합을 정확히 타겟해 누락된 인자가 메워졌음을 직접 관찰한다. 파라미터와 리턴 타입 둘 다 검사하므로 `sig.parameters`와 `sig.return_annotation` 양쪽 경로를 커버.
- **overfit·regression**: 별칭 식별자(`myint`)를 그 자체로 매핑해 치환이 *발생함*만 보이지 별칭 형태 변형(점 표기 등)은 안 본다는 점에서 검증은 얇은 편이나, 픽스가 sphinx의 기존 `type_aliases` 메커니즘을 재사용할 뿐 신규 로직이 없어 special-case overfit 여지는 낮다. 17개 PASS_TO_PASS(특히 `test_autodoc_typehints_description`, `test_autodoc_type_aliases`, `test_autodoc_typehints_signature/none`)가 별칭 미사용·signature 모드 동작이 안 깨졌음을 보증한다 — `record_typehints`가 모든 description 어노테이션의 단일 진입점이라 이 광범위 P2P가 regression-trap 가드 역할을 한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "signature 모드는 되는데 `autodoc_typehints='description'`이면 안 됨"이 핵심 신호. description 모드 전용 코드를 grep(`autodoc_typehints != 'description'`)하면 `sphinx/ext/autodoc/typehints.py`로 수렴하고, 그 안에서 시그니처를 다시 추출하는 `record_typehints`의 `inspect.signature(obj)` 호출을 발견한다. 동시에 signature 경로(`__init__.py`)가 `type_aliases=...`를 넘기는 것을 대조하면 누락이 즉시 드러난다.
2. **픽스와 일반화**: `type_aliases=app.config.autodoc_type_aliases`를 추가. 이는 새 동작을 발명하는 게 아니라 *이미 존재하는 별칭 치환을 누락된 경로에 동일 적용*하는 것이라 올바른 일반화다 — 모든 별칭 매핑에 대해 두 모드가 일관되게 동작하게 만들 뿐, 특정 테스트 입력에 맞춘 분기가 아니다.
3. **regression 안전**: signature 모드(`test_autodoc_typehints_signature`), 별칭 없는 description(`test_autodoc_typehints_description`), `none` 모드를 안 깨야 한다. 빈 dict 기본값(`autodoc_type_aliases={}`)이면 `type_aliases`가 no-op이라 기존 동작이 보존되므로 안전.
4. **함정 회피**: 오라클 없는 에이전트는 (a) description 본문을 만드는 `merge_typehints`나 napoleon 쪽을 잘못 의심해 출력 렌더에 손대거나, (b) `typing.stringify` 결과를 후처리해 문자열 치환하는 식의 우회 패치를 짜기 쉽다 — 둘 다 overfit이고 P2P를 깬다. 정답은 *어노테이션이 추출되는 시점*인 `inspect.signature` 호출에서 별칭을 적용하는 것이며, 이를 위해 sphinx 래퍼가 `type_aliases`를 받는다는 도메인 사실을 알아야 한다.
