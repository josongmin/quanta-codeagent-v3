---
instance_id: django__django-11095
repo: django/django
base_commit: 7d49ad76562e8c0597a0eb66046ab423b12888d8
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-03-19T15:17:28Z
fail_to_pass: 1
pass_to_pass: 19
gold_files: [django/contrib/admin/options.py]
---

# django__django-11095

## 문제 요약
`ModelAdmin`에서 request나 모델 인스턴스에 따라 인라인을 동적으로 바꾸려면 현재는 `get_inline_instances()` 전체를 오버라이드해야 하고, 그 안의 for 루프까지 복붙해야 한다. 사용자는 인라인 "인스턴스"가 아니라 인라인 "클래스 목록"만 동적으로 정하고 싶어한다. 그래서 `get_inlines(request, obj=None)` 훅을 새로 추가해 달라는 기능 요청이다.

## 유형 분류
- 버그 카테고리: 누락처리 (확장 훅 부재 — feature/API-contract 성격)
- 서브시스템: django admin (`ModelAdmin` 인라인 처리)
- 증상 타입: silent-wrong 아님 — 확장성 결여(보일러플레이트 강제)
- 로컬라이제이션 신호: problem_statement가 `get_inline_instances`와 `get_inlines(request, obj=None)`를 명시적으로 지목 → `django/contrib/admin/options.py`의 `ModelAdmin` 클래스로 바로 연결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py`:`ModelAdmin.get_inlines` (신규), `ModelAdmin.get_inline_instances`
- 근본 원인: `get_inline_instances`가 `self.inlines`를 직접 순회하도록 하드코딩되어 있어, 인라인 클래스 목록을 가로챌 확장 지점이 없었다.
- 수정 요지:
  1. `get_fieldsets` 바로 아래에 신규 훅 `get_inlines(self, request, obj)`를 추가하고 기본 구현은 `return self.inlines`.
  2. `get_inline_instances`의 루프를 `for inline_class in self.inlines:` → `for inline_class in self.get_inlines(request, obj):`로 변경.
  3. 이로써 서브클래스는 for 루프 복붙 없이 `get_inlines`만 오버라이드하면 동적 인라인이 가능. 기존 기본 동작은 완전 동일(byte-compatible).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_get_inline_instances_override_get_inlines` (generic_inline_admin.tests.GenericInlineModelAdminTest)
- 테스트는 `EpisodeAdmin`에서 `get_inlines(request, obj)`를 오버라이드해 `request.name`에 따라 `inlines[:1]` / `inlines[1:2]` / `[]`를 반환하게 한다.
  - request에 `name`이 없으면 `get_inlines() == []` 이고 `get_inline_instances() == []` 임을 단언 → 훅이 실제로 루프 소스로 쓰임을 증명.
  - `request.name='alternate'`면 `get_inlines`가 `(AlternateInline,)`, `get_inline_instances()[0]` 타입이 `AlternateInline`; `'media'`면 `MediaInline`. 즉 동적 선택이 인스턴스 생성까지 전파됨을 확인.

## 공략 포인트 (뭘 조져야)
- localization 전략: `options.py`에서 `get_inline_instances` 정의를 찾고, 그 안에서 `self.inlines`를 순회하는 줄을 새 훅 호출로 교체. 동시에 `get_*` 훅 컨벤션(`get_fieldsets`, `get_ordering`)을 따라 신규 메서드를 인접 위치에 배치.
- 함정/난이도 메모: 단일 파일·2-hunk 소규모 변경. 함정은 (a) 훅 시그니처를 `get_inlines(request, obj)`로 정확히 맞추기 — 테스트가 `(request, None)`으로 호출, (b) 기본 반환값을 `self.inlines` 그대로 유지해 기존 19개 PASS_TO_PASS 회귀 방지, (c) `get_inline_instances`의 `obj` 인자를 그대로 새 훅에 전달.
- 우리 에이전트 관점: 기능 추가형(false-gap 아님, 진짜 신규 훅)이라 난이도 낮음. 막힐 지점은 "get_inline_instances 전체를 재작성"하려는 과잉수정 충동 — 골드는 루프 소스 한 줄만 바꿈. 최소 침습으로 끝내는 절제가 관건.
