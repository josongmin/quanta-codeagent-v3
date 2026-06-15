---
instance_id: django__django-12419
repo: django/django
base_commit: 7fa1a93c6c8109010a6ff3f604fda83b604e0e97
version: "3.1"
difficulty: <15 min fix
created_at: 2020-02-05T10:02:56Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [django/conf/global_settings.py]
---

# django__django-12419

## 문제 요약
Django 3.0에서 `SECURE_REFERRER_POLICY` 설정으로 `Referrer-Policy` 응답 헤더를 제어할 수 있게 됐지만(#29406), 기본값이 `None`이라 헤더가 전혀 붙지 않았다. 제안은 secure-by-default 철학에 맞춰 기본값을 `"same-origin"`으로 바꿔, Django 앱이 서드파티 사이트로 정보를 덜 흘리도록 하자는 것이다. 사용자(보안 관점)는 별도 설정 없이도 안전한 referrer 정책이 기본 적용되길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract (보안 기본값 변경 / hardening)
- 서브시스템: django 보안 설정 (django.conf.global_settings + SecurityMiddleware)
- 증상 타입: silent-wrong (헤더가 누락되어 정보 유출, 예외는 없음)
- 로컬라이제이션 신호: problem_statement가 정확히 `SECURE_REFERRER_POLICY` 설정명과 "default for this"를 지목 → `global_settings.py`의 해당 상수 한 줄로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/conf/global_settings.py` (모듈 레벨 상수 `SECURE_REFERRER_POLICY`)
- 근본 원인: 기본값이 `None`이라 `SecurityMiddleware`가 `Referrer-Policy` 헤더를 설정하지 않았다. 기능은 이미 존재했으나 opt-in 상태라 신규 프로젝트가 referrer 정보를 그대로 노출.
- 수정 요지: 단 한 줄 — `SECURE_REFERRER_POLICY = None` → `SECURE_REFERRER_POLICY = 'same-origin'`. 미들웨어(`django.middleware.security.SecurityMiddleware`)는 이 값을 읽어 헤더를 붙이므로, 기본값만 바꾸면 별도 로직 변경 없이 새 프로젝트에 `Referrer-Policy: same-origin`이 자동 적용된다. BC(linked-site referer 검증 깨짐 위험)는 릴리스 노트로 문서화 전제.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_middleware_headers (project_template.test_settings.TestStartProjectSettings)`
- 테스트가 어떻게 픽스를 증명하는지: `startproject` 템플릿 기본 설정으로 응답을 만들고 보안 미들웨어가 내보내는 헤더 목록을 정렬해 단언한다. 기대 헤더 리스트에 `b'Referrer-Policy: same-origin'`을 추가했다 — 기본값이 `None`이면 이 헤더가 없어 단언이 실패하고, `'same-origin'`이면 미들웨어가 헤더를 붙여 통과한다. 즉 설정 기본값 → 미들웨어 → 실제 HTTP 헤더의 end-to-end 경로를 검증.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 설정명이 그대로 박혀 있으므로 `grep SECURE_REFERRER_POLICY`로 `global_settings.py` 정의와 `middleware/security.py` 소비처를 즉시 찾는다. 변경 지점은 정의부 단 한 줄.
- 함정/난이도 메모: 진짜 수정은 1줄이지만, 미들웨어 쪽에 새 로직을 추가하려는 오버엔지니어링 유혹이 있다. 기능은 이미 구현돼 있고 바뀌는 건 "기본값"뿐임을 인지해야 함. 또한 테스트가 헤더를 정렬된 순서로 비교하므로, 무관한 헤더 순서/형식을 건드리면 인접 단언이 깨질 수 있다. 멀티파일 아님(코드 1파일).
- 우리 에이전트 관점: 막힐 지점은 거의 없으나, "보안 기본값 변경"을 단순 설정 토글이 아니라 미들웨어/검증 추가 작업으로 과대 해석하면 불필요한 diff가 생긴다. 정답은 최소 변경이라는 점을 골드와 테스트가 명확히 못박는다.
