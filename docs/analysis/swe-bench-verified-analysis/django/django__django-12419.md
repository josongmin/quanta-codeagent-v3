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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [overfit-risk]
---

# django__django-12419

## 문제 요약
Django 3.0에서 `SECURE_REFERRER_POLICY` 설정으로 `Referrer-Policy` 응답 헤더를 제어할 수 있게 됐지만(#29406), 기본값이 `None`이라 헤더가 전혀 붙지 않았다. 이슈는 secure-by-default 철학에 맞춰 기본값을 `"same-origin"`으로 바꿔, Django 앱이 서드파티 사이트로 referrer 정보를 덜 흘리도록 하자고 제안한다. 기능(미들웨어 소비처)은 이미 존재하므로 변경 대상은 오직 `global_settings.py`의 기본 상수 한 줄이다. core dev(hints_text)가 "secure by default 철학에 맞고 BC만 릴리스 노트에 문서화하면 된다"고 명시적으로 승인한 상태.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 `SECURE_REFERRER_POLICY` 설정명을 verbatim 지목하고 "change the default for this to same-origin"으로 정확한 값까지 명시. `grep SECURE_REFERRER_POLICY`로 `django/conf/global_settings.py`의 정의 한 줄에 즉시 수렴. 탐색 노력 사실상 0.
- **S1 (Direct-Map / template)** — 이슈가 픽스를 사실상 그대로 명세(상수 기본값 변경). 결함클래스가 "기본값/상수 변경"이라는 정형 템플릿에 완전 매칭. 추론으로 식을 합성할 필요 없음(=S2 아님), 후보 패치를 여러 개 시도해 테스트로 수렴할 필요도 없음(=S3/S4 아님). 값 `'same-origin'`이 이슈에 박혀 있으므로 기계적 1-token 치환.
- **K-Domain (Domain-bound)** — 변경 자체는 사소하나, 이 한 줄이 왜 동작하는지 이해하려면 `global_settings.py` 상수 → `django.middleware.security.SecurityMiddleware`가 런타임에 이 설정을 읽어 `Referrer-Policy` 헤더를 주입한다는 django 보안 미들웨어 도메인 지식이 필요. 일반 파이썬 추론(K-Gen)만으로는 "이 상수가 응답 헤더로 흘러간다"는 인과를 알 수 없음. 다만 도메인 지식이 *localize/픽스의 병목은 아니므로* primary는 K-Domain-bound가 아니라 T-DirectMap.
- **primary type = T-DirectMap** — 위치가 L0로 자명하고 픽스가 S1 기계적(상수 변경). T-LocTrivial(S1+L0+K-Gen)에 가깝지만 knowledge가 K-Domain이고 "찾으면 끝나는 자명함"보다 "위치 명확+기계적 상수 픽스"라는 DirectMap 정의에 더 정확히 부합.

왜 S1인가(APR 관점): 이슈 본문이 결함 위치(설정 상수)와 목표 값(`'same-origin'`)을 모두 spec으로 제공하므로 PAR/TBar류 fix-pattern("default-value change") 템플릿이 입력 그대로 적용된다. SemFix식 제약 합성(S2)이나 GenProg식 generate-and-validate(S3) 탐색이 불필요 — 패치 공간이 단일점으로 붕괴.

## 난이도 티어

**T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- 파일 수 1개, 변경 줄 수 1줄(±1 헌크) — ICLR 2024 구조컷의 "1파일·<5줄 ≈ 48% solve" 최상단 구간.
- localize 직접성 최대(L0): 설정명 verbatim + 목표값 명시.
- repair_strategy S1: 픽스가 이슈에 사실상 적혀 있음(T1 전형 프로파일 "이슈가 픽스를 거의 적어줌"에 정확히 부합).
- P2P trap 없음(PASS_TO_PASS = 0개) — regression-trap 플래그 미부여.

공식 라벨(`<15 min fix`)과 **일치**. 다만 공식 라벨은 "개발자 구현시간" 기준이고 여기선 그것이 곧 에이전트 난이도와 수렴함. 유일하게 T1을 살짝 무겁게 만들 수 있는 요소는 knowledge가 K-Gen이 아니라 K-Domain이라는 점(미들웨어 인과 이해 필요)인데, 픽스 자체엔 그 이해가 불필요(상수만 바꿔도 테스트 통과)하므로 티어를 올리지 않음.

## 골드패치 분석
- **건드린 파일/함수**: `django/conf/global_settings.py`, 모듈 레벨 상수 `SECURE_REFERRER_POLICY` (gettext_noop 정의 인근 보안 설정 블록).
- **근본 원인**: 기본값이 `None`이라 `SecurityMiddleware`의 referrer-policy 분기가 비활성 → 신규 프로젝트가 `Referrer-Policy` 헤더 없이 모든 referrer 정보를 서드파티에 노출. 기능은 #29406에서 이미 구현됐으나 opt-in 상태로 남아 있던 것.
- **수정 요지**: 단 한 줄 `SECURE_REFERRER_POLICY = None` → `SECURE_REFERRER_POLICY = 'same-origin'`. 미들웨어가 이 값을 읽어 헤더를 주입하므로 로직 변경 없이 새 프로젝트에 `Referrer-Policy: same-origin`이 자동 적용. BC 위험(referer 검증에 의존하는 linked-site 깨짐)은 릴리스 노트 문서화 전제.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_middleware_headers (project_template.test_settings.TestStartProjectSettings)`.
- **픽스 증명**: 테스트는 `startproject` 템플릿 기본 설정으로 응답을 만들고 보안 미들웨어가 내보내는 헤더 목록을 정렬해 단언한다. 기대 리스트에 `b'Referrer-Policy: same-origin'` 한 줄을 추가 — 기본값 `None`이면 헤더가 없어 단언 실패, `'same-origin'`이면 미들웨어가 헤더를 붙여 통과. 즉 설정 기본값 → `SecurityMiddleware` → 실제 HTTP 헤더의 end-to-end 경로를 검증한다(단순 상수 readback이 아님).
- **overfit 관점 (overfit-risk 플래그)**: FAIL_TO_PASS가 1개뿐이고 그 단언이 기대 헤더 리스트에 정확히 `same-origin` 리터럴을 박아두므로, 에이전트가 테스트만 보고 거꾸로 값을 맞추면 통과한다. 그러나 이 문제는 값 자체가 이슈 spec(`"same-origin"`)이라 overfit과 정답이 동일점으로 수렴 — 실질 위험은 낮음. CEGIS(S4)가 필요 없는 이유이기도 함.
- **regression 관점**: PASS_TO_PASS = 0개라 명시적 regression 게이트는 없음. 단 헤더 단언이 **정렬된 전체 리스트 equality**라, 무관한 헤더의 순서/형식을 건드리면 같은 단언이 깨진다. 골드는 헤더 한 줄만 추가하므로 안전.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 `SECURE_REFERRER_POLICY` 설정명이 강한 L0 신호 → `grep -rn SECURE_REFERRER_POLICY django/`로 (a) 정의부 `django/conf/global_settings.py`와 (b) 소비처 `django/middleware/security.py`를 즉시 발견. "change the **default**"이므로 수정 지점은 정의부 한 줄로 확정.

2. **픽스와 올바른 일반화**: `SECURE_REFERRER_POLICY = None` → `'same-origin'`. 이게 overfit이 아닌 올바른 일반화인 이유 — 값 `'same-origin'`은 테스트에서 역산한 게 아니라 이슈 본문이 직접 제안한 spec이고, core dev가 승인했으며, secure-by-default 의도와 정확히 일치한다. 미들웨어 로직을 건드리지 않고 기본 상수만 바꾸는 것이 최소이자 정확한 변경(기능은 이미 존재).

3. **regression 안전**: 명시적 P2P는 없지만, FAIL_TO_PASS 테스트가 헤더 전체 리스트를 정렬 비교하므로 (a) 다른 보안 헤더(`X-Content-Type-Options`, `X-Frame-Options` 등)의 순서·형식을 건드리지 말 것, (b) 미들웨어에 새 분기/조건을 넣어 헤더 출력 순서를 바꾸지 말 것. 한 줄 상수 변경만이 인접 단언을 보존한다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — "보안 기본값 변경"을 단순 토글이 아니라 미들웨어 검증 로직 추가/조건 분기 신설로 **과대 해석**하는 오버엔지니어링. 기능(`SecurityMiddleware`의 referrer-policy 주입)은 #29406에서 이미 완성돼 있고 바뀌는 건 오직 default 상수임을 인지해야 함. 또 하나는 값을 `'strict-origin'`/`'no-referrer'` 등 다른 정책으로 추측하는 것 — 이슈가 `"same-origin"`을 명시했으므로 spec을 그대로 따라야 통과. 회피법: 픽스 전 `grep`으로 소비처가 이미 존재함을 확인하고, 이슈가 지정한 리터럴 값을 그대로 사용.
