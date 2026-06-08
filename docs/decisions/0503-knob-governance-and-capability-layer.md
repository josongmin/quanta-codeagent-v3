# ADR-0503: knob 거버넌스 (완전성 ratchet) + Capability 레이어 방향

- **상태**: Accepted (P0 구현 시작; P1~P5 단계적)
- **날짜**: 2026-06-07
- **슬라이스**: 다축 — P0는 NEW 테스트 인프라(런타임 코드 0 변경). 후속 P1~P5는 `@/runner/knobs`·`@/config`·`@/apps/cli` 확장 + NEW `src/config/capabilities/`(유일 신규 슬라이스)
- **게이트**: 거버넌스 ratchet은 무게이트(항상 ON, CI). Capability 레이어(P3+)는 `QUANTA_CAPABILITY_LAYER`(`gateOnStrict`, default-OFF, byte-identical degrade)
- **RFC**: `docs/plans/jun-7-knob-registry-config.md` (rev2, 5-라운드 적대 어딧 수렴)
- **관련**:
  - `tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` (NEW — P0)
  - 기존 자산(재발명 금지): `src/runner/knobs/`(typed knob 프레임워크), `src/shared/runtime-config.ts`(값 knob), `src/config/`(ADR-0497 settings 4-레이어+trust), `tests/unit/knob-default-off-completeness-guard.test.ts`(default-OFF 발견), `src/apps/cli/slash-commands-knobs.ts`(`/knobs` CLI), `src/agent/control-request/`(ADR-0496 런타임 토글), `tools/pm/`(DoD ratchet)
  - 메모리: `knob-config-systems-inventory`

## Context

`QUANTA_*` 설정 knob이 **3개 병렬 시스템**으로 분산돼 있다 — `@/runner/knobs`(AgentConfig 변형, ~49) · `@/shared/runtime-config`(값, ~140) · 슬라이스 직접 read(고아 ~77, 어느 registry에도 없음). 사용자가 "설정을 토글하고 기능 on/off 하려면" 단일 진실원이 필요한데, (1) 고아 ~77은 `--help`/catalog에 없어 발견 불가 + default-OFF 가드 밖, (2) 한 기능의 게이트가 LLM도구(manifest)·슬래시·스킬·훅에 **각자 박혀** drift(이번 세션 split-brain 버그 클래스의 정체).

5-라운드 적대 어딧 결론: **이 분산은 헥사고날 레이어의 산물이라 물리적 병합 불가**(`@/shared`→`@/runner` import는 `biome.json:905`가 금지 → 값 knob을 AgentConfig-knob 프레임워크로 fold 불가). 또한 rev1이 "신축"하려던 registry/resolve/persist/settings는 **이미 다 존재**(재발명 3회 적발). 따라서 통합은 registry 병합이 아니라 **두 지점에서만**: ① 거버넌스 ratchet(어디 등록됐든 누락만 없게) ② Capability 레이어(기능↔surface 단일 선언→파생).

## Decision

1. **3-도메인 분산 유지(불가피)**: 값 knob→`runtime-config`, AgentConfig knob→`@/runner/knobs`, CLI-render knob→NEW `apps/cli` 로컬 registry. 물리 통합(모든 선언을 한 슬라이스로 + `@/shared`가 env 직접read 끊고 주입)은 ROI<비용(173 call-site DI + 140 knob 재작성)이라 보류(P6+, 유지보수 고통 누적 시).

2. **누락-봉인 거버넌스(P0, 본 ADR의 즉시 구현분)**: 모든 `QUANTA_*` read ∈ (runtime-config 발견 ∪ `allKnobs()` ∪ apps/cli-local ∪ 명시적 예외)임을 강제하는 **decreasing-ceiling burn-down ratchet**(gate-vocab/no-raw-nul 라쳇과 동일 패턴). 현재 고아 수를 ceiling으로 박고 오직 감소; 신규 누락은 ceiling 초과로 CI 실패. **non-blocking**(===0 강제 아님). red-on-injection self-test로 vacuous-0 방지.

3. **Capability 레이어(P3, 유일 신규)**: `src/config/capabilities/` — `CapabilityDescriptor{id, gate(knob|composite), surfaces{llmTool/slash/skill/hook/thinClient}, perSurface}` + `resolveExposure(cap, surface, config)`. 각 surface 게이트 reader가 env 직접read를 멈추고 resolveExposure를 자기 시점(슬래시=load, 도구=registration, 훅=wiring)에 호출 → split-brain 구조적 불가. `QUANTA_CAPABILITY_LAYER` OFF면 기존 게이트 그대로(byte-identical degrade).

4. **재사용/확장(신축 아님)**: settings 레이어=`src/config`(ADR-0497, security/benign trust-gate에 knobs sub-band SPLIT 추가) · 런타임 토글=`control-request`(ADR-0496)에 `set_config` variant · discoverability=기존 `/knobs` 확장(diff+값knob)+`--help` allKnobs 파생 · hook=NEW `hooks-registry.ts`(이벤트는 `src/agent/hooks.ts` HookEvent union 참조) · PR 게이트=`tools/pm/check.ts`.

## 단계

- **P0 (now)**: 완전성 ratchet 테스트(런타임 코드 0). TDD red-first: ceiling=0 → RED(고아 N) → honest ceiling 기록 → green. 회귀 그물 가동.
- **P1**: 고아 burn-down(3 버킷 분류 → 배치, ceiling↓0) + knobs.json untyped→registry 검증.
- **P2**: `/knobs diff` + `--help` allKnobs 파생.
- **P3**: Capability 레이어(`QUANTA_CAPABILITY_LAYER` 뒤) + hooks-registry + cross-surface ratchet.
- **P4**: no-raw-env-read ratchet 활성(read 일원화 후).
- **P5(opt)**: web/embedded 설정 GUI.

## Default posture / 안전성

P0는 **순수 측정 테스트** — 런타임 동작 0 변경, byte-identical. Capability(P3)는 strict default-OFF로 OFF시 기존 surface 게이트 보존. 설정 민감도 고려: 각 단계 독립 PR, 회귀 게이트, 보안 carve-out(code-mode strict `=`"1" / tls-mitm dual-signal / fs-jail strict "off")는 P0 추출/마이그레이션서 normal로 강등 금지. settings.json knobs band은 security-knob(trust-gated LayerSecurity) vs benign 분리(untrusted repo가 code-mode 켜는 구멍 차단).

## 대안 (기각)

- **rev1 `src/config/registry` 신축**: `@/runner/knobs`가 이미 그것 → 4번째 시스템=파편화 악화. DROP.
- **3-도메인 물리 병합**: 레이어상 불가(or 173 call-site DI 대공사) — 논리 통합(ratchet+capability)이 동일 UX를 훨씬 싸게 제공.
- **type-union 컴파일-에러 강제를 P0로**: `gateOn(name:string)`이라 173 call-site 변환 필요 = P4급. P0는 source-scan ratchet으로.

## 구현 현황 (2026-06-08 갱신 — 위 결정의 실제 빌드 상태)

P0~P3 대부분 LANDED + 2라운드 적대어딧으로 경화. 실제 구조(원 §2의 "3-도메인 read-home"은 유지되, 그 위에 **선언 registry 4개**가 얹힘):

- **선언 registry 4**: `apps/cli/cli-knobs.ts`(CLI-render ~89) · `@/config/knob-inventory.ts`(daemon/agent orphan ~142) · `@/shared/runtime-config-knobs.ts`(typed runtime-config 142, 신규) · `@/runner/knobs`(~49). 3개(cli/inventory/runtime-config-knobs)는 **pairwise disjoint** 강제(`knob-registry-disjoint-hellgate`).
- **통합 catalog**: `@/config/knob-catalog.ts`(순수 merge/search/resolve/`displaySafeValue`) → `buildKnobCatalog()` **388 knob 단일 SSOT**(cli wire 4소스 / web wire 3소스 cli제외). precedence cli<inventory<runtime-config<runner.
- **표면**: `/knobs all`·`/knobs find`(slash-commands-knobs, LIVE) · `--help`는 ENV_TABLE(41) 유지 + `/knobs all/find` **포인터**(전체 catalog 파생은 미완, 포인터로 대체) · web `GET /api/knobs`(auth-gated, LIVE).
- **라이브 컨트롤 플레인(P4 R0~R5, LIVE)**: 핵심 통찰 = read-site 380개 말고 **accessor를 session-aware로**. R0 단일 override store(`@/shared/knob-overrides`) → R1 `runtimeConfig()`가 override를 process.env에 merge+version캐시 → **runtime-config 145 knob이 read-site 0수정으로 `/knobs set` 라이브토글**(override 없으면 byte-identical). R2 `readBool` 통합 bool-vocab SSOT(""quirk제거 lenient, gateOn·parseEnvFlag 양쪽 byte-identical). R3/R4 CLI bool 15+int 3 클러스터 `readCliKnob` 라우팅. **보안 carve-out** `SESSION_FORBIDDEN_KNOBS`(code-mode/fs-jail/tls-mitm/central-config/llm-cred-trusted)는 setKnobOverride가 거부(session으로 strict-gate 활성화 차단). **R5 e2e 헬게이트**(set→runtimeConfig+readCliKnob 양채널→reset)로 잠금. 라이브토글 0→~163.
- **7 ratchet**: completeness(orphan 0) · disjoint · parity(runtime-config-knobs≡loadFromEnv) · no-raw-process-env(ceiling 53=production-slice 잔여; bench/eval 하네스 exempt) · no-raw-nul · default-off · api-knobs-no-leak. 4개(completeness/parity/no-raw-env/default-off)는 destructure·template-bracket evasion까지 봉인(R3 mutation-test).
- **보안**(R2/R3 어딧): web `/api/knobs`는 `displaySafeValue`로 custom string값(경로/credential-helper 명령/정책JSON) redact(default·bool/int/enum은 노출). CLI `/knobs all`도 동일 redact. secret 4종은 registry 자체서 제외. strict-gate(code-mode/tls-mitm/fs-jail/central-config)는 readCliKnob 미경유 → 약화 없음.
- **2차 빌드 LANDED (2026-06-08 후속 wave)**: ① **Capability 레이어(P3)** — `src/capability/{descriptor,registry,resolve,probe-all}.ts`, `QUANTA_CAPABILITY_LAYER`(gateOnStrict, runtime-config-knobs 선언+loadFromEnv) **선언됨**. descriptor에 composite `requires`(default-aware; workflow=QUANTA_SUBAGENT). resolveExposure = surface AND own-gate AND requires(every readBool). image-gen/artifact-store/office-authoring은 pure-env(provider-key는 call-time `no_key`라 노출 안 좁힘 — runtimeConditioned 모델은 틀려서 제거). **observe-only**(bootstrap-session seam에서 split-brain probe, OFF시 byte-identical no-op, try/catch non-fatal) — **enforce(실 게이트 대체)는 아직 미배선**(다음 단계). 3-axis 일관성 ratchet(capability↔manifest↔fc) + **reality 헬게이트**(resolveExposure vs 실 buildSubagentConfig assembly, WORKFLOW=1+SUBAGENT=0 split-brain 검출). ② **/capabilities`(+/caps)` CLI** + web SlashPalette 등록. ③ **web 프론트 settings UI**(KnobsPanel, `/api/knobs`+`/config` POST, redaction). ④ **enum 검증**(`KNOB_ENUM_VALUES`/`knobEnumValues`, doSet+web). ⑤ **--help drift-guard**(`auditEnvTableDrift` — 전체파생 대신 ENV_TABLE↔catalog drift 봉인, degrade 0). ⑥ **read-routing** 53→51(byte-identical 2 마이그레이션). ⑦ **fc 등록**: `capability?` 필드 + 4 cap 링크 + 3 신규 fc 엔트리(/capabilities·/knobs-live·web-settings, ADR-0503 인용). ⑧ **보안 defense-in-depth**: web `/config` POST에 `isSessionForbidden`→403 + `CONFIG_ALLOWED∩SESSION_FORBIDDEN=∅` ratchet.
- **미구현(backlog)**: Capability **enforce**(resolveExposure가 실 surface 게이트 대체 — 현재는 observe-probe만; 멀티-surface cap 필요) · `--help` 전체 catalog 파생(현 drift-guard로 대체) · settings.json knobs band · read-routing 51 production-slice 잔여(string live-settings + 비CLI; launch-param/literal-toggle은 정당 raw — ratchet 점진 강제).
