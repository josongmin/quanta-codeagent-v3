---
instance_id: django__django-14493
repo: django/django
base_commit: 7272e1963ffdf39c1d4fe225d5425a45dd095d11
version: 4.0
difficulty: <15 min fix
created_at: 2021-06-05T12:50:25Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/staticfiles/storage.py]
---

# django__django-14493

## 문제 요약
`ManifestStaticFilesStorage`를 상속해 `max_post_process_passes = 0`으로 설정하면 `collectstatic` 실행 시 크래시가 난다. `post_process()` 내부에서 `for i in range(self.max_post_process_passes)` 루프가 한 번도 돌지 않으면 루프 안에서만 초기화되는 `substitutions` 변수가 정의되지 않은 채 루프 뒤의 `if substitutions:`에서 참조되어 `UnboundLocalError: local variable 'substitutions' referenced before assignment`가 발생한다. 사용자는 (잘못된 CSS 생성을 막기 위해) pass를 0으로 끄더라도 collectstatic이 정상 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (루프가 0회 실행되는 경계에서 변수 미초기화)
- 서브시스템: django contrib staticfiles (정적파일 post-processing / 해시 매니페스트 스토리지)
- 증상 타입: 예외 (UnboundLocalError → collectstatic 크래시)
- 로컬라이제이션 신호: problem_statement의 트레이스백이 파일·라인·변수명을 그대로 명시한다 — `django/contrib/staticfiles/storage.py:251`의 `if substitutions:`, 그리고 "substitutions is only set if the loop is entered at least once"라는 직접 설명까지 들어있어 골드 파일 지목이 거의 무료.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/staticfiles/storage.py` : `HashedFilesMixin.post_process()`
- 근본 원인: `substitutions`가 `for i in range(self.max_post_process_passes):` 루프 본문 첫 줄에서만 `substitutions = False`로 초기화된다. `max_post_process_passes = 0`이면 루프가 0회 실행되어 변수가 바인딩되지 않은 채 루프 종료 후 `if substitutions:` 분기(최대 패스 초과 yield 처리)에 도달해 `UnboundLocalError`가 난다.
- 수정 요지: 루프에 진입하기 직전, `paths = {...}` 재구성 줄 다음에 `substitutions = False`를 한 줄 추가해 루프 실행 횟수와 무관하게 변수가 항상 정의되도록 보장한다. 동작은 그대로(0 pass면 치환이 없으므로 False가 맞는 기본값)이고, 루프가 한 번 이상 돌면 본문 내 재할당이 덮어쓴다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_collectstatistic_no_post_process_replaced_paths` — `max_post_process_passes = 0`인 스토리지(`NoPostProcessReplacedPathStorage`, `tests/staticfiles_tests/storage.py` 신규)로 collectstatic이 크래시 없이 완주하는지 확인.
- 증명 방식: `TestCollectionNoPostProcessReplacedPaths`가 `run_collectstatic_in_setUp = False`로 두고 테스트 본문에서 직접 `run_collectstatic(verbosity=1)`을 호출, stdout에 `'post-processed'` 문자열이 포함됨을 단언한다. 픽스 전에는 `run_collectstatic` 호출 자체가 UnboundLocalError로 터지므로 이 단언에 도달조차 못 한다 → 패치가 예외를 제거해야 통과. PASS_TO_PASS 36개(기존 ManifestStorage 동작 전반)는 회귀 방지.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: 트레이스백이 파일·라인·변수까지 다 알려주므로 `storage.py`의 `post_process`만 열어 `substitutions` 라이프사이클을 추적하면 끝. 단일 파일, 단일 변수 초기화 누락.
- 함정/난이도 메모: 초기화 위치를 잘못 잡으면 안 된다 — 반드시 루프 "밖, 진입 전"에 둬야 하고, 루프 본문 안의 기존 `substitutions = False`는 매 패스 리셋 용도이므로 건드리거나 제거하면 멀티패스 로직이 깨진다. 또한 `post_process`에는 `if substitutions:`로 끝나는 다른 분기/yield가 섞여 있어 의미를 오해하기 쉬움(이건 "최대 패스를 다 써도 치환이 남았다"는 경고 yield 경로). 진짜 픽스는 한 줄 추가뿐.
- 우리 에이전트 관점: 난이도 매우 낮음(<15분). 막힐 여지는 거의 없으나, 과잉수정 위험 — 루프 구조를 리팩터하거나 `max_post_process_passes == 0` 특수분기를 추가하는 식으로 오버엔지니어링하면 PASS_TO_PASS 회귀 가능. 골드처럼 최소 1줄 초기화로 끝내는 게 정답.
