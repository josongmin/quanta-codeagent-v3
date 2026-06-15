---
instance_id: django__django-11119
repo: django/django
base_commit: d4df5e1b0b1c643fe0fc521add0236764ec8e92a
version: "3.0"
difficulty: <15 min fix
created_at: 2019-03-24T21:17:05Z
fail_to_pass: 1
pass_to_pass: 7
gold_files: [django/template/engine.py]
---

# django__django-11119

## 문제 요약
`Engine`을 `autoescape=False`로 생성한 뒤 `render_to_string()`을 호출해도 결과가 항상 자동 이스케이프된다. 즉 엔진의 `autoescape` 속성이 무시되어, 사용자가 끈 설정과 무관하게 `<script>` 같은 값이 `&lt;script&gt;`로 변환된다. 사용자는 엔진 설정대로 이스케이프가 꺼진 raw 출력을 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (옵션/속성을 하위 호출로 전달하지 않음)
- 서브시스템: django template engine (`django.template.engine.Engine`)
- 증상 타입: silent-wrong (예외 없이 잘못된 출력 — 의도와 반대로 이스케이프됨)
- 로컬라이제이션 신호: problem_statement가 함수명(`render_to_string`)·클래스(`Context`)·속성(`autoescape`)을 직접 명시하고, 회귀를 일으킨 커밋 해시(`19a5f6da329d58653bcda85`)까지 지목 → 단일 메서드로 곧장 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/template/engine.py:Engine.render_to_string`
- 근본 원인: 비-`Context` 입력을 받았을 때 `Context(context)`로 새 컨텍스트를 만드는데, `Context`의 기본 `autoescape`는 `True`다. 엔진의 `self.autoescape`를 넘기지 않아 엔진 설정이 통째로 누락됐다.
- 수정 요지: `t.render(Context(context))`를 `t.render(Context(context, autoescape=self.autoescape))`로 변경. 딕셔너리/None 입력 경로에서 엔진의 `autoescape` 속성을 새 `Context`에 전파한다. 이미 `Context` 인스턴스가 넘어온 경우는 그 인스턴스의 autoescape를 그대로 존중하므로 변경 없음.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_autoescape_off (template_tests.test_engine.RenderToStringTest)`
- 테스트가 어떻게 픽스를 증명하는지: `Engine(dirs=[TEMPLATE_DIR], autoescape=False)`로 엔진을 만들고 `render_to_string('test_context.html', {'obj': '<script>'})`를 호출. 픽스 전에는 `obj:&lt;script&gt;\n`이 나와 실패하고, 픽스 후엔 이스케이프가 꺼져 기대값 `obj:<script>\n`이 그대로 출력되어 통과한다. 기존 `test_basic_context`(기본 autoescape=True 경로)는 PASS_TO_PASS로 유지되어 회귀가 없음을 보장한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `Engine.render_to_string` 한 메서드. `Context(...)` 생성 지점에서 엔진 속성 전파 누락을 찾으면 끝. 단일 파일·단일 라인 수정.
- 함정/난이도 메모: 두 분기(`isinstance(context, Context)` vs else) 중 else 분기만 고쳐야 한다. Context 인스턴스 분기까지 강제로 autoescape를 덮으면 호출자가 명시한 Context 설정을 깨뜨려 다른 테스트가 깨질 수 있다. `Context` 생성자의 인자 이름(`autoescape`)을 정확히 알아야 한다.
- 우리 에이전트 관점: 난이도 매우 낮음. problem_statement가 파일·함수·속성을 다 짚어줘서 localization 비용이 거의 0. 막힐 만한 지점은 거의 없으나, 두 분기 중 어느 쪽을 고칠지 분별하지 못하고 양쪽을 모두 수정하면 PASS_TO_PASS 회귀 위험. 단일 인자 추가로 최소 수정하는 절제가 핵심.
