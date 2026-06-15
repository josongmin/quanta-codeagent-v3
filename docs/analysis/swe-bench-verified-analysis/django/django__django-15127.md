---
instance_id: django__django-15127
repo: django/django
base_commit: 9a6e2df3a8f01ea761529bec48e5a8dc0ea9575b
version: "4.1"
difficulty: <15 min fix
created_at: 2021-11-25T13:14:38Z
fail_to_pass: 1
pass_to_pass: 1
gold_files: [django/contrib/messages/apps.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15127

## 문제 요약
`@override_settings(MESSAGE_TAGS=...)`로 메시지 태그를 바꿔도 `django.contrib.messages.storage.base.LEVEL_TAGS` 모듈 상수가 갱신되지 않는다. 그 결과 `Message.level_tag` 프로퍼티가 새 태그를 모른 채 빈 문자열을 반환한다. `LEVEL_TAGS`는 `storage.base` 모듈 import 시점에 `get_level_tags()`로 한 번 계산되어 박히는 모듈 전역 상수라, 런타임에 `MESSAGE_TAGS` 설정이 변경돼도 stale 상태로 남는다. hints_text는 "`setting_changed` receiver를 추가해 LEVEL_TAGS를 갱신하라"는 정답 방향을 거의 명시한다.

## 유형 (정형화)
- **L = L1 (Traceable).** problem_statement가 `LEVEL_TAGS` / `storage.base` 모듈 / `Message.level_tag`를 직접 호명하지만, 정작 골드 수정 위치는 그 모듈이 아니라 `apps.py`의 `AppConfig.ready()`다. 즉 이슈가 가리키는 심볼(L0 후보)과 실제 픽스 사이트가 어긋나 있어, 후보 모듈에서 시작해 "왜 상수가 안 바뀌나 → 어디서 한 번만 계산되나 → 설정변경 신호를 누가 받아야 하나"로 한 단계 추적이 필요하다. grep 한 방(L0)은 아니지만 단일 contrib 패키지 안에서 수렴하므로 L1.
- **S = S6 (Design-Refactor) + S2 (Constraint-Reasoning).** 한 줄 값 변경이나 None 가드가 아니라, Django의 signal 라이프사이클을 도입하는 작은 구조 변경이다: 새 receiver 함수 `update_level_tags`를 정의하고 `MessagesConfig.ready()`에서 `setting_changed.connect()`로 배선한다. S2 보조인 이유는 receiver 내부에서 `if setting == 'MESSAGE_TAGS'` 조건과 "상수를 재대입한다(`base.LEVEL_TAGS = ...`)"는 올바른 의미식을 추론해야 하기 때문 — 모듈 import-time 캐싱이라는 불변식 위반을 정확히 겨냥해야 한다.
- **K = K-Domain.** 일반 파이썬 추론으로는 안 풀린다. `setting_changed` 시그널의 존재, receiver를 `AppConfig.ready()`에 connect하는 관용, 그리고 모듈 전역 상수를 시그널로 재계산한다는 Django 내부 패턴 지식이 병목이다(hints가 #16574 선례를 언급).
- **primary type = T-DomainBound.** dominant 병목이 "Django signal/AppConfig 라이프사이클 지식"이다. 위치는 L1로 비교적 명확하고 픽스 코드량도 작아 T-DiffuseLoc/T-DesignRefactor 둘 다 약하지만, 정답 패턴(`ready()`에 `setting_changed.connect`)을 떠올리는 것이 도메인지식 의존이라 T-DomainBound가 가장 방어 가능하다.

이 repair strategy인 이유(APR 관점): 단순 직접매핑(S1)으로 풀려는 에이전트는 `storage/base.py`에서 `LEVEL_TAGS`를 lazy property/함수호출로 바꾸려 들지만, 이는 공개 모듈 상수의 형태를 깨고 import-site들을 모두 손봐야 하는 광역 변경으로 번진다. 골드는 대신 "상수 형태는 유지하되 설정변경 이벤트에 hook을 걸어 재계산"하는 collect-then-react식 구조 도입(S6)으로, 기존 인터페이스를 보존하면서 stale 불변식만 교정한다 — 이것이 PAR/TBar식 템플릿이 아니라 의도된 라이프사이클 재배치라서 S6이 dominant다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(개발자 구현시간 기준 T1~T2급)지만, 에이전트 난이도로는 한 단계 올린다.
- **위로 미는 피처:** localize 우회(L1) — 이슈가 지목한 `storage.base.LEVEL_TAGS`는 픽스 사이트가 아니다. 정답은 `apps.py::ready()`로, "상수가 어디서 한 번만 계산되는가 → 설정변경을 어디서 받아야 하는가"라는 도메인 추론을 거쳐야 도달한다. K-Domain 의존(signal + AppConfig.ready 관용)이 실질 병목이고, 잘못된 사이트(base 모듈 동적화)로 가면 부분 픽스/회귀로 빠진다.
- **아래로 누르는 피처:** 단일 파일(`apps.py`) ~12줄, 헌크 1개, has-repro(이슈+테스트가 동작을 명확히 기술), hints_text가 정답 패턴을 거의 적어줌. 그래서 T4까지는 안 간다.
- **공식 라벨과 다른 이유:** `<15 min fix`는 *Django 내부에 익숙한 코어 개발자*가 정답 패턴을 이미 알 때의 구현시간이다. 오라클 없는 에이전트에게는 "이슈가 가리킨 모듈≠픽스 사이트"라는 미스디렉션 + signal 관용 환기가 비용이라 T3가 정직하다.

## 골드패치 분석
- **건드린 파일·함수:** `django/contrib/messages/apps.py` — 모듈 레벨 신규 함수 `update_level_tags(setting, **kwargs)`, 그리고 `MessagesConfig`에 신규 메서드 `ready(self)`. import 3개 추가(`storage.base`, `messages.utils.get_level_tags`, `test.signals.setting_changed`).
- **근본 원인:** `LEVEL_TAGS`는 `django.contrib.messages.storage.base`가 import될 때 `get_level_tags()`로 한 번 평가되어 모듈 전역에 고정되는 상수다. `override_settings`(또는 임의의 런타임 `MESSAGE_TAGS` 변경)가 settings를 바꿔도 이 상수는 재평가되지 않아 stale → `Message.level_tag`가 새 태그를 못 찾고 빈 문자열을 반환한다. 기존에는 테스트 전용 `override_settings_tags` 서브클래스가 `enable/disable`에서 수동으로 `base.LEVEL_TAGS`를 갈아끼워 가렸을 뿐, 프레임워크 자체는 동기화하지 않았다.
- **수정 요지:** `setting == 'MESSAGE_TAGS'`일 때 `base.LEVEL_TAGS = get_level_tags()`로 재계산하는 receiver `update_level_tags`를 정의하고, `MessagesConfig.ready()`에서 `setting_changed.connect(update_level_tags)`로 배선한다. `override_settings`는 진입·이탈 시 `setting_changed`를 emit하므로, 이제 모든 설정변경에서 모듈 상수가 자동 동기화된다. 상수의 *형태*(모듈 전역 dict)는 그대로 두어 모든 import-site와 호환된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_override_settings_level_tags (messages_tests.tests.TestLevelTags)`. 커스텀 레벨 `12: 'custom'`을 포함한 `message_tags`로 `@override_settings(MESSAGE_TAGS=message_tags)`를 건 뒤 `assertEqual(base.LEVEL_TAGS, self.message_tags)`를 단언한다. 픽스 전: `setting_changed` 수신자가 없어 `base.LEVEL_TAGS`가 stale → 불일치로 FAIL. 픽스 후: override 진입 시 emit된 신호가 `update_level_tags`를 호출해 상수를 재계산 → PASS.
- **PASS_TO_PASS (1개):** `test_eq (messages_tests.tests.MessageTests)` — `Message` 동치성. receiver는 `MESSAGE_TAGS` 변경에만 반응하므로 무관 동작은 불변.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 표면상 overfit-risk가 보이지만, 골드는 special-case(예: 이 테스트의 dict만 반환)가 아니라 `get_level_tags()` 정식 재계산을 통째로 호출하는 일반해라 overfit 아님. 또한 test_patch가 `base.py`/`tests.py`에서 임시방편 `override_settings_tags` 서브클래스를 **삭제**하고 평범한 `override_settings`로 교체한 점이, 동기화가 테스트 헬퍼가 아니라 프레임워크 레벨에서 작동함을 강하게 입증한다(generalization 증거).
- **regression 관점:** `override_settings_tags`를 쓰던 기존 메시지 테스트들(`test_level_tag` 등)이 전부 평범한 `override_settings`로 재작성됐고, 이들이 계속 통과해야 한다 → 골드 receiver가 기존 수동 동기화와 동치 이상으로 동작함을 보장. flag `regression-trap`은 messages 테스트군 전반의 태그 의존 동작이 이 자동 동기화에 묶여 있기 때문.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 `LEVEL_TAGS` / `storage.base` / `Message.level_tag` 키워드로 `django/contrib/messages/`에 진입. `storage/base.py`에서 `LEVEL_TAGS = get_level_tags()`가 *모듈 import 시점 1회 평가*임을 확인 → "런타임 `MESSAGE_TAGS` 변경이 반영 안 되는 이유"가 캐싱임을 파악. hints_text의 "`setting_changed` receiver" 언급으로 픽스 사이트를 `storage.base`(증상지)에서 `apps.py::AppConfig.ready()`(원인 배선지)로 옮긴다.
2. **픽스와 올바른 일반화:** `update_level_tags(setting, **kwargs)`에서 `setting == 'MESSAGE_TAGS'`일 때만 `base.LEVEL_TAGS = get_level_tags()`로 재계산하고, `MessagesConfig.ready()`에서 `setting_changed.connect()`. `get_level_tags()`를 그대로 재호출하므로 모든 입력 태그 dict에 일반화된다(테스트 dict 하드코딩이 아님). 상수 형태를 유지해 외부 import 호환.
3. **regression 안전:** `test_eq`(P2P)를 비롯해 `MESSAGE_TAGS`와 무관한 동작은 receiver가 `if setting == 'MESSAGE_TAGS'` 가드로 건드리지 않아 안전. 기존 `override_settings_tags`로 보호되던 `test_level_tag` 류가 평범한 `override_settings`로도 통과해야 하므로, receiver는 override 진입과 **이탈** 양쪽 신호에서 모두 재계산되어 상태가 새지 않아야 한다(매 신호 재평가라 자동 보장).
4. **함정 회피:** 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) 증상지 직격: `storage/base.py`에서 `LEVEL_TAGS`를 함수/`property`/`SimpleLazyObject`로 바꾸려다 공개 모듈 상수 형태를 깨고 다수 import-site를 회귀시킴. (b) 부분 픽스: receiver는 정의했지만 `AppConfig.ready()`에 `connect`를 안 해 자동 등록이 누락 → 테스트만 통과하고 실런타임 미동작. 회피법: 픽스 사이트를 "상수 정의지"가 아니라 "설정변경 이벤트 수신지(`ready`)"로 잡고, Django의 signal 관용(import-time 상수는 `setting_changed`로 재계산)을 따른다 — hints가 가리킨 #16574/`override_settings_tags` 선례가 바로 이 방향의 강한 신호다.
