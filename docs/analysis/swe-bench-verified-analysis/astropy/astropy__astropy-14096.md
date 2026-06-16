---
instance_id: astropy__astropy-14096
repo: astropy/astropy
base_commit: 1a4462d72eb03f30dc83a879b1dd57aac8b2c18b
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2022-12-04T17:06:07Z
fail_to_pass: 1
pass_to_pass: 426
gold_files: [astropy/coordinates/sky_coordinate.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`SkyCoord`를 서브클래스화해 커스텀 `@property`를 추가했을 때, 그 property 내부에서 존재하지 않는 속성(`random_attr`)에 접근하면 에러 메시지가 엉뚱하게 property 이름(`prop`)을 가리킨다. property가 내부에서 던진 `AttributeError`가 파이썬 디스크립터 프로토콜에 의해 `__getattr__('prop')` 호출로 흡수되고, `__getattr__`의 마지막 `raise`가 `prop`을 대상으로 메시지를 재작성하기 때문이다. 결과적으로 진짜 누락된 속성이 무엇인지 알 수 없어 디버깅이 거의 불가능하다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈의 스택트레이스가 `sky_coordinate.py`의 `__getattr__`를 직접 지목한다. 파일·함수가 한 방에 결정되고 탐색이 사실상 0이다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 위치는 자명하지만, "어떤 예외를 어떻게 던질지"는 추론으로 합성해야 한다. 단순히 메시지 문자열을 바꾸는 S1로는 안 된다(여전히 `prop`을 보고함). 핵심 통찰은 *현재 `attr`가 가짜이고 진짜 원인은 더 깊은 속성 접근의 `AttributeError`*라는 디스크립터 의미론이며, 올바른 픽스는 `self.__getattribute__(attr)`로 위임해 파이썬이 원래의 정확한 예외를 다시 발생시키게 하는 것이다.
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론을 넘어 디스크립터/`__getattr__` 폴백 프로토콜(property 내부 `AttributeError` → `__getattr__` 트리거)이라는 CPython 데이터모델 지식이 병목이다.
- **primary type = T-ConstraintReason**: 위치는 명확(L0)하나 올바른 픽스가 "메시지 교체"가 아니라 "예외 출처 보존"이라는 비자명한 의미적 추론(S2)이라서 ConstraintReason이 dominant. APR 관점: TBar식 템플릿 매칭(None가드/상수변경)으로는 풀리지 않고, 불변식("던져야 할 예외는 `attr`가 아니라 그 안에서 실패한 속성")을 따져 식을 합성하는 SemFix/Angelix 계열 추론이 필요하다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개, 실효 변경 ~4줄(헌크 1개) — scope는 T1~T2급으로 작다.
- localize 직접성: L0, has-repro 수준의 스택트레이스 존재 — easiness 신호.
- 그러나 픽스의 **의미적 추론 비중이 높다**: 자명한 메시지 변경(S1)은 틀린 답이며, `__getattribute__` 위임이 올바르다는 것을 알려면 디스크립터 프로토콜 도메인 지식이 필요(K-Domain). 이 추론 난점은 시간라벨에 안 잡힌다.
- P2P trap: PASS_TO_PASS 426개로 광범위(`regression-trap`). `__getattr__`는 프레임 alias·transform 위임의 핫패스라, 위임 방식을 잘못 바꾸면 정상 frame attribute 접근이 깨진다.

공식 difficulty 라벨("15 min - 1 hour")과 정합하되, 1줄짜리로 보이는 외형보다 "왜 `__getattribute__`인가"의 추론과 넓은 P2P가 T2가 아닌 T3로 민다.

## 골드패치 분석
- **건드린 파일·함수**: `astropy/coordinates/sky_coordinate.py`의 `SkyCoord.__getattr__`.
- **근본원인**: `__getattr__`는 모든 정상 폴백 분기(frame name, `frame_attributes`, `_sky_coord_frame` 위임, frame transform)를 실패한 뒤 마지막 `raise AttributeError(f"'{self.__class__.__name__}' object has no attribute '{attr}'")`를 무조건 실행한다. 그런데 서브클래스 property가 내부에서 `random_attr`에 접근해 `AttributeError`를 던지면, 파이썬은 그 property 접근을 "속성 없음"으로 간주해 `__getattr__('prop')`를 호출한다. 이 시점에서 `attr`는 `'prop'`이고, 원래의 `random_attr` 정보는 이미 소실된 채 `prop`을 대상으로 메시지가 재작성된다 — 인과가 뒤바뀐 오보.
- **수정요지**: 마지막 `raise AttributeError(...)`를 `return self.__getattribute__(attr)`로 교체. 모든 폴백이 실패했다는 것은 곧 `attr`가 진짜 인스턴스 속성으로도 없다는 뜻이므로, 표준 `object.__getattribute__`를 재호출하면 파이썬이 property 평가를 다시 수행하고 그 안에서 실패한 `random_attr`에 대한 **원래의 정확한 AttributeError**를 발생시킨다. property가 아닌 진짜 누락 attr의 경우엔 `__getattribute__`가 동일한 "has no attribute" 메시지를 그대로 내므로 외부 계약도 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_subclass_property_exception_error`. `SkyCoord` 서브클래스 `custom_coord`에 `random_attr`를 읽는 `prop` property를 정의하고, `c.prop` 접근 시 `pytest.raises(AttributeError, match="random_attr")`를 단언한다. 패치 전에는 메시지가 `"prop"`이라 `match`가 실패, 패치 후 위임으로 `random_attr` 메시지가 전파되어 통과.
- **픽스 증명**: 테스트가 메시지 내용(`match="random_attr"`)을 정확히 검사하므로, 단순 위치 픽스가 아니라 "예외 출처가 보존되는가"라는 정확한 동작을 핀포인트한다.
- **overfit 관점**: F2P가 1개로 얇지만 `match` 기반이라 special-case 통과가 어렵다. 다만 메시지 문자열만 `random_attr`를 포함하게 만드는 꼼수(S1)는 `__getattribute__` 위임 없이 통과 못 함 — 테스트가 일반적 동작을 강제. overfit 위험은 낮다.
- **regression 관점**: P2P 426개가 정상 frame attribute 위임(`.ra`, `.dec`, frame transform alias 등)을 폭넓게 커버. `__getattribute__` 위임은 폴백 *전부 실패 후*에만 도달하므로 정상 경로 동작은 불변, 회귀 안전이 구조적으로 보장된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 스택트레이스가 `sky_coordinate.py`의 `__getattr__` 마지막 `raise`를 직접 지목 → 해당 함수 1개로 즉시 수렴(L0). 추가 탐색 불요.
2. **픽스와 일반화 근거**: 마지막 `raise AttributeError`를 `return self.__getattribute__(attr)`로 교체. 이것이 올바른 일반화인 이유 — 모든 폴백 분기 실패는 "attr가 SkyCoord 의미론으로는 없음"을 의미하고, 이 지점에서 표준 속성 조회를 재실행하면 (a) property 내부의 진짜 누락 attr 예외가 원형 그대로 전파되고 (b) 평범한 누락 attr도 표준 메시지를 그대로 받는다. 메시지 문자열만 바꾸는 처방은 `prop`/`random_attr`를 구별할 정보가 `__getattr__` 안에 없으므로 원리적으로 불가능 — hints에도 "`__getattr__`는 다른 에러를 모른다"고 명시됨.
3. **regression 안전**: 426개 P2P가 검증하는 frame name/`frame_attributes`/`_sky_coord_frame` 위임/transform alias 경로는 모두 `__getattribute__` 위임 *이전*에서 return되므로 건드려지지 않는다. 위임은 오직 "이미 다 실패한" 종착점에서만 일어나 정상 동작을 깨지 않는다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) 메시지 포맷만 손봐 여전히 `prop`을 보고하거나, (b) hints의 첫 제안("property에서 AttributeError를 catch")을 따라 *호출측 property*를 고치려는 것 — 이는 SkyCoord 라이브러리가 아니라 사용자 서브클래스를 고치는 잘못된 위치다. 함정 회피의 핵심은 "`__getattr__`가 던지는 메시지 자체가 거짓 출처"라는 인과를 파악하고, 메시지를 재작성하는 대신 표준 조회로 **위임해 원래 예외를 복원**하는 것. 또한 `raise`를 빈손으로 지우거나 `pass`로 두면 `None`을 반환해 silent 버그가 되므로, 반드시 `return self.__getattribute__(attr)`로 실제 예외 발생 책임을 파이썬에 되돌려야 한다.
