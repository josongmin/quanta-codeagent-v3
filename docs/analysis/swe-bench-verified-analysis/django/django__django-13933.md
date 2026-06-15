---
instance_id: django__django-13933
repo: django/django
base_commit: 42e8cf47c7ee2db238bf91197ea398126c546741
version: 4.0
difficulty: <15 min fix
created_at: 2021-01-26T03:58:23Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [django/forms/models.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-13933

## 문제 요약
`ModelChoiceField`는 `ChoiceField` 같은 다른 필드와 달리, 유효하지 않은 선택값으로 `ValidationError`를 던질 때 그 값(invalid choice)을 에러 메시지에 노출하지 않는다. 사용자가 `error_messages`의 `invalid_choice`를 `%(value)s` 플레이스홀더로 커스터마이즈해도, 정작 `params`로 값이 전달되지 않아 placeholder가 채워지지 않는다. 즉 메시지 텍스트를 바꿀 수는 있어도 "어떤 값이 거부됐는지"를 표시할 방법이 원천 봉쇄돼 있다. problem_statement는 `ModelChoiceField`/`ModelMultipleChoiceField`의 `default_error_messages` 소스를 직접 인용하며 "ModelChoiceField does not pass the value to the validation error"라고 근본 원인까지 짚어준다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 클래스명(`ModelChoiceField`)·메시지 키(`invalid_choice`)·증상("does not pass the value")을 직접 지목한다. `grep -n "invalid_choice" django/forms/models.py` 한 방으로 `to_python`의 except 핸들러가 잡힌다. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference 보조)**: 정형 결함클래스(누락된 `params` 인자 추가)에 템플릿 매칭되는 기계적 수정 — 동일 `ValidationError` 호출에 `params={'value': value}` 한 인자 추가. S5가 보조로 붙는 이유: "메시지 텍스트를 고친다 vs `params`를 넘긴다"는 의도 판단이 필요하고, 그 의도는 코드만으론 결정 안 되고 형제 클래스 `ChoiceField`의 관례·이슈 본문에서 스펙을 재구성해야 확정된다. 다만 그 추론은 가볍고 픽스 형태 자체는 자명하므로 dominant는 S1.
- **K (Knowledge) = K-Domain**: django forms 내부 계약 — `ValidationError(message, code, params)`에서 `params`가 `%(...)s` 보간을 채운다는 메커니즘, 그리고 `error_messages` 오버라이드와의 상호작용을 알아야 정답을 짚는다. 일반 파이썬 추론(K-Gen)만으로는 "왜 텍스트를 안 고치고 params를 넘기나"에 도달하기 어렵다. 공개 API 시그니처 변경은 없어 K-API는 아님.
- **Primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 인자 추가(S1)다. 진짜 난점이 localize에 있지 않고(→T-DiffuseLoc 아님), 복잡한 식 합성도 아니며(→T-ConstraintReason 아님), 스펙 재구성이 본질을 지배하지도 않는다(보조 S5에 그침 → T-SpecInference 아님). "위치 명확 + 기계적 픽스"의 정의에 정확히 부합.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`django/forms/models.py`) · 단일 함수(`to_python`) · 1헌크 · 실질 +4줄(인자 한 개를 멀티라인으로 분해한 것뿐, 의미상 1줄 추가)이고 localize 직접성이 L0이다. 다만 has-repro는 없고(네이티브 스택트레이스 아님, 텍스트 인용만), 정답 도출에 "텍스트 vs params" 의도 판단(약한 S5) + django `ValidationError` params 메커니즘(K-Domain)이 끼므로 순수 T1(이슈가 픽스를 거의 적어주는 구간)보다 한 단계 위다. 또 P2P 19개가 같은 `test_error_messages` 스위트 전반의 필드별 에러메시지 동작이라 약한 regression-trap이 있다.

공식 라벨은 `<15 min fix`(시간상 최하 난이도)인데, 우리 tier(T2)는 그 prior와 사실상 정합한다. T1로 더 내리지 않은 이유: 공식 라벨은 "개발자 구현시간"만 재서, 오라클 없는 에이전트가 빠질 수 있는 "default_error_messages 텍스트를 고치면 된다"는 오답 분기(아래 함정 회피 참조)와 django params 도메인지식 요구를 시간라벨이 잡지 못하기 때문. 그 한 끗 때문에 T2.

## 골드패치 분석
- **건드린 파일·함수**: `django/forms/models.py` → `ModelChoiceField.to_python`
- **근본 원인**: `to_python`의 `except (ValueError, TypeError, self.queryset.model.DoesNotExist)` 핸들러가 `ValidationError(self.error_messages['invalid_choice'], code='invalid_choice')`를 던지면서 `params`를 넘기지 않았다. django의 `ValidationError`는 `params` 딕셔너리로만 메시지의 `%(value)s` 등 플레이스홀더를 보간하므로, params가 없으면 사용자가 `%(value)s` 메시지를 오버라이드해도 채울 데이터가 없어 invalid 값이 영영 표시되지 않는다. 형제인 `ChoiceField`는 이미 value를 넘겨주는데 `ModelChoiceField`만 누락 — 일관성 결함.
- **수정 요지**: 동일 `ValidationError` 호출에 `params={'value': value}`를 추가한다. 여기서 `value`는 쿼리셋 조회에 실패한 입력값이며, 이로써 `%(value)s` 플레이스홀더가 실제 invalid choice로 보간된다. default 메시지 텍스트는 건드리지 않는다(하위호환 유지) — 능력만 열어주고 표시 여부는 사용자 메시지 오버라이드에 위임.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_modelchoicefield_value_placeholder` — `ModelChoiceField`를 `error_messages={'invalid_choice': '"%(value)s" is not one of the available choices.'}`로 생성하고 `f.clean('invalid')`를 호출. 쿼리셋에 없는 값이라 `to_python`이 except 경로를 타며 `ValidationError`를 던진다. 기대 출력 `'"invalid" is not one of the available choices.'`은 **오직** `params={'value': value}`가 전달되어야만 `%(value)s`가 `invalid`로 보간되어 일치한다. 픽스 전에는 params 부재로 보간 불가 → 메시지 불일치로 FAIL.
- **픽스 증명**: 테스트가 일부러 메시지를 오버라이드하므로, default 텍스트만 고치는 오답으로는 통과 불가 — params 전달이 진짜 wiring임을 핀포인트로 강제한다.
- **overfit 관점**: 테스트는 1개로 얇지만, 픽스가 special-case가 아닌 "params에 value를 항상 실어주는" 일반 동작이라 overfit-risk 플래그는 없음. 단일 입력으로도 올바른 일반화가 강제된다.
- **regression 관점**: P2P 19개가 `test_error_messages` 스위트의 필드별(boolean/char/choice/date/decimal/email/...) 에러메시지 동작 전반을 커버한다. 특히 `test_modelchoicefield`(기존 ModelChoiceField 에러메시지)와 `test_multiplechoicefield`를 깨면 안 됨 → 약한 regression-trap. params 추가는 메시지 텍스트·코드·예외타입을 바꾸지 않으므로 기존 동작 보존이 자연스럽다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 인용한 `ModelChoiceField` + `invalid_choice` + "does not pass the value to the validation error" 신호 → `grep -n "invalid_choice" django/forms/models.py`로 `ModelChoiceField.to_python`의 `except` 블록 내 `ValidationError(..., code='invalid_choice')` 발생 지점을 직격. (L0이므로 탐색 거의 불필요.)
2. **픽스와 올바른 일반화인 이유**: 그 `ValidationError` 호출에 `params={'value': value}` 추가. `ChoiceField`가 이미 value를 넘기는 관례에 맞추는 것이라 일관성·하위호환 둘 다 만족. default 메시지를 안 바꾸고 params만 채우는 게 핵심 — 메시지 텍스트 변경은 i18n·하위호환을 흔들지만, params 추가는 사용자에게 `%(value)s` 사용 능력을 부여할 뿐 기존 출력은 그대로다. 따라서 단일 테스트만 보고도 special-case가 아닌 보편 픽스가 된다.
3. **regression 안전**: P2P의 `test_modelchoicefield`(기존 ModelChoiceField 에러메시지 동작)와 나머지 18개 필드 에러메시지 테스트를 안 깨야 한다. params는 추가 키일 뿐 메시지/코드/예외타입을 안 바꾸므로 보간 데이터가 없던 기존 메시지(`%(value)s` 미포함)는 영향 없음 — 안전.
4. **함정 회피**: 오라클 없는 에이전트가 가장 빠지기 쉬운 오답은 `default_error_messages`의 메시지 **텍스트**를 `%(value)s` 포함 문구로 고치는 것. 그러나 (a) 테스트가 메시지를 오버라이드하므로 default 텍스트 수정으로는 통과 불가하고, (b) 텍스트 변경은 하위호환을 깬다. 진짜 원인은 "params 누락"임을 짚어야 한다. 또 인접한 `validate` 메서드 등 다른 `ValidationError` 호출과 혼동하지 말고 `to_python`의 `invalid_choice` 분기만 정확히 수정할 것. `ModelMultipleChoiceField`는 이미 `%(value)s` 메시지를 갖지만 이번 범위가 아니며, 단일 파일·단일 호출 지점으로 끝난다(멀티파일 아님).
