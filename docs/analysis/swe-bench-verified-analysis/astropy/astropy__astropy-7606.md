---
instance_id: astropy__astropy-7606
repo: astropy/astropy
base_commit: 3cedd79e6c121910220f8e6df77c54a0b344ea94
version: "1.3"
difficulty: "15 min - 1 hour"
created_at: 2018-06-29T16:27:46Z
fail_to_pass: 1
pass_to_pass: 241
gold_files: [astropy/units/core.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-API
flags: [has-repro, regression-trap]
---

## 문제 요약
`u.Unit('asdf', parse_strict='silent')`로 만든 `UnrecognizedUnit`을 `None`과 `==`로 비교하면 `False`가 아니라 `TypeError: None is not a valid Unit`가 터진다. 원인은 `UnrecognizedUnit.__eq__`가 무조건 `other`를 `Unit(other, parse_strict='silent')`로 강제 파싱하는데, `None`(혹은 임의 비-unit 객체)은 파싱이 불가능해 예외가 그대로 전파되기 때문이다. 파이썬 데이터모델 상 `==`는 절대 예외를 던지면 안 되고, 비교 불가 시 `NotImplemented`를 돌려줘야 한다.

## 유형 (정형화)
- **L (Localization) = L0**: 스택트레이스가 `core.py`의 `__eq__`(line 1701)와 `__call__`의 `None is not a valid Unit`을 그대로 가리킨다. grep 한 방으로 두 `__eq__`가 잡힌다. 직접 지목.
- **S (Repair) = S2 (+S1)**: 고칠 위치는 자명하나, "예외를 삼킨다"로 끝나면 안 된다. 파이썬 rich-comparison 계약(`NotImplemented` 반환 → 상대편 `__eq__`/identity fallback에 위임)을 이해하고 *올바른 반환값*을 추론해야 한다. `return False`로 막으면 `unit != None`은 통과하지만 계약 위반이고 `in` 동작이 미묘해진다. 정형 결함클래스(예외가드)라는 점에서 S1 보조가 붙지만 dominant는 반환값 의미 합성(S2).
- **K (Knowledge) = K-API**: astropy 도메인 지식이 아니라 파이썬 `==`/`NotImplemented` 데이터모델 계약 지식이 병목. 공개 비교 의미론을 정확히 맞춰야 함.
- **primary_type = T-ConstraintReason**: 위치는 명확(L0)하나 단순 가드가 아니라 비교 프로토콜 불변식을 따져 `NotImplemented`라는 정답값을 추론·합성하는 것이 본질.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일(`core.py`)·2헌크·실질 4줄 변경, has-repro(IPython 트레이스백 + 라인번호), 단일 클래스 메서드. localize 직접성이 매우 높다(L0). 다만 T1이 아닌 이유는 픽스가 이슈에 그대로 적혀있지 않고 `NotImplemented` vs `False`라는 의미론적 판단이 필요(S2)하며, P2P 231개라는 넓은 regression 면(`test_comparison`, `test_compare_with_none`, `test_invalid_compare`, `test_self_compose` 등 비교 경로 다수)을 안 깨야 하기 때문. 공식 라벨 "15분-1시간"과 정합(소규모지만 자명하지 않은 의미 판단). T3까지 올리지 않는 건 추론 깊이가 얕고 cross-module 추적이 없기 때문.

## 골드패치 분석
건드린 파일: `astropy/units/core.py`, 두 메서드의 `__eq__`.
1. **`_UnitMetaClass`/`UnitBase.__eq__` (line ~728)**: 기존 `except (...)` 블록이 `return False`였던 것을 `return NotImplemented`로 교체. 비교 불가 타입이면 거짓 단정 대신 파이썬에 위임.
2. **`UnrecognizedUnit.__eq__` (line ~1710)**: 근본원인 메서드. 기존엔 `other = Unit(other, parse_strict='silent')`를 try 없이 호출 → `None`에서 `TypeError` 폭발. 패치는 이를 `try/except (ValueError, UnitsError, TypeError)`로 감싸 실패 시 `return NotImplemented`. 또한 반환 비교를 `isinstance(other, UnrecognizedUnit)`에서 `isinstance(other, type(self))`로 바꿔 서브클래스 안전성을 확보.

근본원인: `__eq__`가 입력 정규화(`Unit(...)`)를 무방비로 수행해 비교 프로토콜이 "총체적(total)"이지 못함. 수정요지: 정규화 실패를 비교 실패로 격하(`NotImplemented`)하여 `==`가 절대 throw하지 않고, 상대편/identity fallback이 동작하게 함.

## 검증 (test_patch)
FAIL_TO_PASS = `test_unknown_unit3` 1개. 추가된 단언:
- `unit == "FOO"` (이름 동일 unrecognized면 True),
- `unit != u.m` (다른 타입과 비교는 False),
- `unit != None` (gh-7603: 더 이상 TypeError 아님),
- `unit not in (None, u.m)` (`in`이 내부적으로 `==`를 돌리며 None을 만나도 안전).

픽스 증명: `unit != None`은 `__ne__ → not (self == other)`를 거치고, `self == None`이 `NotImplemented`를 돌리면 파이썬이 reflected/identity로 폴백해 `False` → `not False` = `True`. `in` 튜플 멤버십도 각 원소에 `==`를 적용하므로 None에서 throw가 사라져야 통과.

overfit 관점: `return False`로도 이 4개 단언은 모두 통과한다(overfit-risk 존재). 그러나 골드는 `NotImplemented`를 택해 비교 프로토콜 계약까지 만족시켜 더 일반적이다. regression 관점: P2P 231개에 `test_comparison`·`test_compare_with_none`·`test_invalid_compare`·`test_self_compose` 등 비교 의존 테스트가 다수라 반환 의미를 잘못 바꾸면 동치/멤버십이 깨진다(regression-trap).

## 모범답안 (오라클 기반)
1. **Localize**: 트레이스백이 `core.py __eq__` line 1701과 `__call__`의 `raise TypeError("None is not a valid Unit")`을 직접 지목. `__eq__` 정의들을 grep → `UnrecognizedUnit.__eq__`가 try 없이 `Unit(other, ...)`를 호출함을 확인. 상위 `UnitBase.__eq__`도 동일 패턴(다만 거긴 try가 있고 `return False`)임을 발견.
2. **픽스 & 일반화 근거**: 단순히 `if other is None: return False`로 None만 막는 건 과소명세(임의 비-unit 객체도 같은 TypeError를 냄). 올바른 일반화는 정규화 예외를 잡아 `NotImplemented`를 돌리는 것 — 이는 None뿐 아니라 모든 비교 불가 타입을 한 번에 덮고, 파이썬 데이터모델 계약(상대편 `__eq__`에 위임)을 지킨다. `type(self)`로의 교체는 향후 서브클래싱에서도 동치가 깨지지 않게 한다.
3. **regression 안전**: 정상 unit 간 비교(`test_comparison`, `test_self_compose`, `test_compose_roundtrip[*]`)는 정규화가 성공하는 경로라 except에 들어가지 않으므로 영향 없음. `NotImplemented`는 비교 *실패* 경로에서만 반환되어 기존 True/False 결과를 보존한다. `UnitBase.__eq__`도 같은 `False→NotImplemented` 전환을 함께 해야 두 클래스 비교 의미론이 일관되어 `test_compare_with_none`이 양쪽에서 통과.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a) `return False`로 막아 테스트는 통과하나 프로토콜 위반/`in` 의미 미묘화, (b) None만 특수처리해 다른 비-unit 입력에서 재발, (c) `UnrecognizedUnit.__eq__`만 고치고 상위 `UnitBase.__eq__`의 `False`를 그대로 둬 비교 비대칭 잔존. 이를 피하려면 "==는 throw 금지 + NotImplemented가 정답" 원칙을 두 `__eq__`에 모두 적용해야 한다.
