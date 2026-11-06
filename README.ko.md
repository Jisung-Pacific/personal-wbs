[English](README.md) | **한국어** | [简体中文](README.zh-CN.md)

# personal-wbs

여러 해에 걸쳐 한 모든 일을 원장 하나에 모으고, Claude 에이전트가 최신 상태로 관리하며, HTML 파일 하나로 된 대시보드로 보여 줍니다.

![대시보드 보드 화면: 가상 예시 원장으로 본 데모](docs/screenshot-board.ko.png)

## 무엇인가

- **개인 작업 분해 구조(WBS) 원장.** `wbs.csv`에 업무와 생활 행정의 모든 산출물·결정·사건을 모든 연도에 걸쳐 한 파일로 담고, 대분류 → 중분류 → 작업 → 단계(`1.2.3.4`)의 코드 트리로 정리합니다.
- **에이전트가 관리합니다.** Agent Skills 다섯 개로 Claude(Claude Code, Cowork, claude.ai)나 `SKILL.md`를 읽는 어떤 에이전트든 출처에서 원장을 만들고, 작업이 끝날 때마다 조용히 기록하고, 빠진 일을 찾아내고, 오늘 할 일을 1분 안에 보여 주고, 매일·매주 자동 실행을 설정합니다.
- **HTML 파일 하나인 대시보드.** 서버도 계정도 필요 없습니다. 옆에 있는 CSV 파일을 읽어 모든 계산을 브라우저에서 합니다.
  - **보드**: 오늘 열린 작업, 막힌 일, 마감이 지났거나 다가오는 일, 집중 패키지.
  - **검진**: 지표 10개를 혈액검사처럼 기준 범위(일부는 지난 1년의 내 기록)와 비교해 판정, 처방, 재검일을 보여 줍니다.
  - **프로젝트 관리 기법**: 리틀의 법칙(WIP = 처리량 × 사이클 타임), 서비스 수준 기대치(SLE)와 노화 WIP, 열린 작업이 언제 끝날지 보는 몬테카를로 예측, 주간 처리량 XmR 관리도, 작업 내용 주제 군집, 시기별 작업 국면.
  - **상태 확인 모드**: 열린 작업을 하나씩 보며 완료 / 진행 중 / 막힘 / 백로그 / 건너뛰기 버튼으로 정리합니다.
  - 원장 보기와 수집 보기에서 원본 행과 출처별 수집 완전성을 확인합니다.
  - **언어와 접근성**: 지구본 아이콘에서 한국어·영어·중국어(간체)로 바꿉니다. 데모 빌드를 axe-core 4로 WCAG 2.1 A·AA 기준에 맞춰 화면 16개 × 한국어·영어 × 휴대폰·데스크톱 폭 × 라이트·다크 테마로 점검해 위반 0건입니다(2026-11-06).
- **에이전트용 파일.** `summary.json`과 `llms.txt`가 있어 어떤 에이전트든 CSV를 해석하지 않고도 "뭐가 막혀 있어?", "이번 주에 뭘 끝냈어?", "나 요즘 어때?"에 답할 수 있습니다.

- **설계 근거**: 설계 선택마다 검증된 논문 근거를 정리했습니다: [docs/research.md](docs/research.md) (영어).

## 왜: 원자료가 먼저

계획 도구는 일을 하기 전에 설명하라고 하고, 시간이 지나면 현실과 멀어집니다. 이 패키지는 일이 이미 흔적을 남기는 곳(대화, 커밋, 문서, 메일, 캘린더)에서 실제로 일어난 일을 정확한 날짜와 근거와 함께 기록합니다.

- **행은 원자료이고 요약이 아닙니다.** 한 행은 구체적인 산출물·결정·사건 하나이고, 출처의 시각으로 날짜를 적고 근거를 가리킵니다. 날짜 범위는 하나로 이어진 작업에만 쓰고, 따로 날짜가 있는 단계는 하위 행으로 둡니다.
- **모든 보기는 계산됩니다.** 집계, 검진, 주제, 예측은 행에서 계산하므로 분석을 바꿔도 기록을 고칠 필요가 없고, 모든 숫자는 행으로, 모든 행은 출처로 거슬러 올라갈 수 있습니다.
- **기록은 에이전트가 합니다.** 작업마다 기록하고, 매일 수집하고, 매주 점검합니다. 사용자는 확인만 합니다.

## 온보딩 흐름

`wbs-bootstrap` 스킬은 원장을 단계적으로 만듭니다. **먼저 맛보기:** 최근 3개월만 수집·정제해(한 세션 안에) 대시보드와 핵심 발견 세 가지를 보여 줍니다. **바로 이어서 묻습니다.** *최대 자원으로 지금*(최근 12개월, 그다음 전체 기록. 지금 쓰는 세션의 모델이 설계를 맡는 리드가 되고, 읽기만 하는 Sonnet 작업자 2~3개가 병렬로 수집), *백그라운드로 조금씩*(백그라운드 에이전트 1~2개가 실행마다 몇 개 창씩 거꾸로 거슬러 올라감) 중에 고릅니다. 어느 쪽이든 잠시 멈출 수는 있어도 수집은 끝까지 가고, 새 작업은 백그라운드에서 계속 모이며, 추가된 내용은 일주일에 한 번 보여 줍니다. 아래 단계는 먼저 3개월에, 나중에 더 오래된 기록에 적용됩니다.

1. **권한부터.** 가진 출처를 모두 연결하고(지난 대화와 메모리, Google Drive, Gmail, Calendar, Slack, Notion, GitHub, ChatGPT 내보내기) 스킬의 도구 권한을 한 번에 허용해 백그라운드 실행이 멈추지 않게 합니다. 첫 수집의 완전성이 원장의 품질을 결정합니다.
2. **분류 체계 승인.** 에이전트가 전체 기록의 제목을 훑고 대분류 4~7개, 연도별 중분류, 짧은 목표 목록을 제안합니다. 승인 전에는 아무것도 쓰지 않습니다. [분류 체계 가이드](docs/taxonomy.ko.md)를 참고하세요.
3. **창 단위 수집.** 출처 × 월을 하나의 창으로 보고, 수집 범위(3개월, 이어서 12개월, 그다음 더 오래된 해) 안에서 오래된 달부터 ID로 빠짐없이 훑으며, 완전성을 `coverage.csv`에 기록합니다.
4. **원자화.** 여러 결과를 묶었거나 오래 이어진 행을 출처에서 다시 읽고 날짜가 있는 단계로 나눕니다.
5. **상태 확인.** 수집된 기록은 현실보다 늦기 때문에, 에이전트가 열린 작업을 10개씩 보여 주며 이미 끝났거나 막혔거나 미뤄 둔 것을 묻고, 근거로 미리 채운 답을 확인받습니다. 대시보드의 상태 확인 모드에서도 할 수 있습니다.
6. **백그라운드 실행.** 매일 수집과 매주 점검을 예약해, 무엇을 추가해 달라고 따로 말할 필요가 없게 합니다.

## 빠른 시작

### Claude Code

```
/plugin marketplace add Jisung-Pacific/personal-wbs
/plugin install personal-wbs@personal-wbs
```

그다음 "내 WBS 원장 만들어 줘"라고 말하거나 `/personal-wbs:wbs-bootstrap`을 실행합니다. 이후에는 스킬이 알아서 쓰입니다. 작업이 기록되고, "나 요즘 어때?"에 답합니다.

### claude.ai

1. 스킬 압축 파일을 만듭니다: `python3 scripts/package_skills.py`가 스킬마다 압축 파일 하나를 `dist/`에 씁니다(`wbs-bootstrap`, `wbs-tracker`, `wbs-sweep`, `wbs-today`, `wbs-schedule`). 업로드한 스킬은 자기 폴더만 볼 수 있으므로, 각 압축 파일에 스킬 폴더와 보조 스크립트를 함께 넣습니다.
2. **Settings → Capabilities → Skills**(최신 버전에서는 **Customize → Skills**)에서 압축 파일을 하나씩 올리고 켭니다. 코드 실행이 켜져 있어야 합니다.
3. "내 WBS 원장 만들어 줘"라고 요청합니다.

스킬 폴더를 직접 압축해도 됩니다(`skills/`에서 `zip -r wbs-tracker.zip wbs-tracker/`; 압축 파일 안에 폴더 자체가 들어 있어야 합니다). 스크립트가 없으면 스킬은 수동 점검으로 대신합니다.

### Agent Skills를 읽는 다른 에이전트

`skills/*/SKILL.md`를 가리키면 됩니다. 스크립트는 표준 라이브러리만 쓰는 Python 3이고 원장 폴더를 인자로 받습니다. Gemini CLI, OpenAI Codex, Grok Build 설치 방법은 [docs/ports.md](docs/ports.md)(영어)에 있습니다.

### 선택: 세션 자동 기록(Claude Code)

```
/plugin install personal-wbs-autolog@personal-wbs
```

별도 플러그인입니다. Claude Code 세션이 끝나면 훅이 그 세션의 ID, 시각, 폴더, 기록 파일 경로만 내 컴퓨터에 적어 두고, 동의하면 `wbs-autolog-drain` 스킬이 그 세션들의 일을 원장에 기록합니다. [plugins/personal-wbs-autolog](plugins/personal-wbs-autolog/README.md)(영어)를 보세요.

### 예시 데이터로 해 보기

예시 원장은 전부 가상입니다. 박사 과정에 지원하면서 작은 공부 습관 앱을 운영하는 가상의 석사생이 2025~2026년에 한 일을 영어(`sample/en`)와 한국어(`sample/ko`)로 담았습니다. 기준일은 2026-11-06입니다.

```
python3 scripts/sample_data.py                                # sample/en, sample/ko 생성
python3 scripts/validate.py sample                            # 두 폴더 검증
python3 scripts/make_agent_files.py sample --as-of 2026-11-06 # summary.json, llms.txt
python3 scripts/reconcile.py list sample/ko --as-of 2026-11-06
```

대시보드 페이지는 아직 저장소에 없습니다. 약 0.6 MB로 플러그인 디렉터리의 파일당 256 KiB 기준을 넘어 릴리스 다운로드로 따로 배포합니다([templates/dashboard](templates/dashboard/README.md) 참고). `sample/ko` 같은 폴더의 CSV 파일을 읽습니다.

## 스킬

| 스킬 | 쓰는 때 | 하는 일 |
|---|---|---|
| `wbs-bootstrap` | 원장을 처음 만들거나 다시 만들 때 | 권한 점검표, 출처 목록, 분류 체계 승인, 단계별 과거 수집(3개월 맛보기, 이어서 12개월과 더 오래된 해), 원자화, 이벤트 복원, 사용자와 상태 확인, 대시보드, 매일·매주 예약 실행 |
| `wbs-tracker` | 결과가 나온 작업을 마칠 때마다, 일에 대해 물을 때 | 결과를 근거와 날짜가 있는 원자 행으로 조용히 기록하고, 열린·막힌·마감 지난·끝낸 일에 답하고, 주간 검진을 실행 |
| `wbs-sweep` | 매일 수집, 기록 안 된 일 찾기, 한 해 소급 | 출처 × 월 창 단위로 이어서 하는 전수 수집(완전성 상태, 연쇄 탐색), 기간 행 원자화, 날짜 없는 행 재확인 |
| `wbs-today` | 오늘 할 일을 물을 때, 매일 요약이 실행될 때 | 오늘 할 일 3개, 늦거나 막힌 일, 결정할 것 최대 3개. 답한 결정만 원장에 반영 |
| `wbs-schedule` | 원장이 알아서 갱신되게 하고 싶을 때 | 매일 수집·주간 검토·매일 요약용 프롬프트와 Cowork·Claude 앱·Claude Code 설정 방법. 요청할 때만 예약을 만듦 |

| 스크립트 | 용도 |
|---|---|
| `validate.py <폴더>` | wbs.csv(22열, 키, 상위 작업, 날짜, 값, 선행 작업, 개인정보 점검)와 함께 쓰는 파일을 검사. `--atomize`는 나눌 행 목록 |
| `make_agent_files.py <폴더>` | 검진을 포함한 `summary.json`과 `llms.txt` 생성 |
| `reconcile.py list/apply <폴더>` | 상태 확인: 열린 작업을 묶음으로 보여 주고 답을 원장에 반영 |
| `sample_data.py` | 가상 예시 데이터 다시 생성 |
| `package_skills.py` | 업로드용으로 스킬마다 스크립트를 넣어 압축 |

### 테스트

`evals/`에는 `claude plugin eval`용 동작 시험이 있습니다. 스킬이 맞는 요청에 켜지고 상관없는 요청에는 켜지지 않는지, 사흘에 걸친 결과 세 개가 기간 행 하나가 아니라 날짜가 있는 행 세 개로 기록되는지 확인합니다. [evals/README.md](evals/README.md)(영어)를 보세요.

## 데이터 모델

| 파일 | 내용 |
|---|---|
| `wbs.csv` | 원장: 22열, BOM 포함 UTF-8, 모든 연도 |
| `plan.csv` | 목표, 집중 패키지, 검진일, 설정(`종류,연도,대상,내용,결정일,재검일`) |
| `events.csv` | 생성·상태 변경·정정·이동을 덧붙이기만 하는 기록(나중에 복원한 것은 `추정` = Y) |
| `coverage.csv` | 연도 × 월 × 출처 창별 수집 상태: `미착수`, `부분`, `완료`, `불가` |
| `sweep_state.json` | 이미 판정한 항목 ID(비공개) |
| `summary.json`, `llms.txt` | 에이전트용 생성 파일 |

`wbs.csv`의 22열(한국어 헤더, 괄호 안은 영어 헤더):

연도(year) · WBS(code) · 레벨(level) · 대분류(area) · 중분류(package) · 상위 작업(parent) · 작업·산출물(task) · 시작일(start) · 종료일(end) · 일자(원문)(date_text) · 시작월(start_month) · 상태(status) · 핵심성과(key_result) · 출처(source) · 마감일(due) · 중요도(importance) · 크기(size) · 선행(depends_on) · 막힘 사유(blocker) · 최근 진행일(last_progress) · 목표(goal) · 근거(evidence)

- 행의 키는 (연도, WBS)이고, 연도마다 트리가 따로 있으며, 코드는 바꾸지 않습니다.
- 상태: `완료`, `진행 중`, `대기·심사`(다른 사람을 기다림), `백로그`(일부러 미룸).
- 날짜는 출처의 정확한 날짜입니다. 모르는 날짜는 비워 두고 수집 때 찾도록 표시하며, 추측하지 않습니다.
- `막힘 사유`는 `<분류>: <기관 또는 역할>`, `선행`은 선행 작업 코드, `근거`는 `claude:<대화 id8>`, `gh:<owner/repo>#<PR>`, `drive:<파일 제목>`, `cal:<날짜>` 같은 포인터입니다.
- 언어: 기본은 영어 헤더이고, 한국어 헤더와 값도 어디서나 작동합니다. 중국어 사용자는 영어 헤더를 쓰고 작업 내용은 중국어로 적어도 됩니다.

## 개인정보 모델

### 플러그인이 읽고, 쓰고, 보내는 것

| | |
|---|---|
| **읽기** | 지난 Claude 대화(대화 검색), 내 컴퓨터의 Claude Code 세션 기록, 직접 올린 내보내기 파일(ChatGPT·Claude), 연결해 둔 앱(Google Drive, Gmail, Google Calendar, Slack, Notion, GitHub). 읽기만 합니다. |
| **쓰기** | 원장 파일(`wbs.csv`와 딸린 파일)을 내가 고른 곳에 씁니다: claude.ai 아티팩트, 로컬 폴더, 또는 내 비공개 Git 저장소. |
| **보내기** | 만든 사람이나 다른 서비스로는 아무것도 보내지 않습니다. 서버·텔레메트리·분석 도구가 없습니다. Claude 밖으로 나가는 쓰기는 내 Git 저장소에 하는 커밋뿐이고, 그 위치를 고르고 요청했을 때만 합니다. |
| **개인정보** | 내 일을 찾으려고 연결된 앱에서 읽을 뿐 저장하지 않습니다. 행에는 일과 기관·역할만 적고, 다른 사람의 이름·이메일·전화번호는 적지 않습니다(`validate.py`가 섞여 들어가면 경고). |
| **보관** | 내 파일 밖에는 아무것도 남지 않습니다. |
| **선택: 자동 기록** | 별도 플러그인 `personal-wbs-autolog`는 끝난 Claude Code 세션마다 ID, 시각, 폴더, 기록 파일 경로만 내 컴퓨터의 플러그인 데이터 폴더에 적습니다. 대화 기록은 내가 기록을 승인할 때만 읽습니다. |

전체 방침은 [PRIVACY.md](PRIVACY.md)에, 데이터 흐름도는 [docs/data-flow.md](docs/data-flow.md)에, 보안 문제 신고 방법은 [SECURITY.md](SECURITY.md)에 있습니다(영어).


- **데이터는 사용자가 둔 곳에 머뭅니다**: 로컬 폴더, 비공개 저장소, 비공개 아티팩트. 서버가 없고 대시보드는 브라우저에서 계산합니다.
- **출처는 읽기만 합니다.** 스킬은 연결된 앱에서 무엇도 보내거나 고치거나 공유하거나 지우지 않습니다.
- **복사가 아니라 포인터.** 행에는 짧은 설명과 근거 ID만 있고 메시지 내용은 없습니다.
- **바꿀 수 있는 기본 개인정보 규칙**: 건강, 연애·관계, 금융 계좌 번호, 다른 사람의 개인 계정 이름은 기록하지 않고(기관이나 역할로 적음), 개인 소득 같은 금액은 빼며, 사업 비용·공개 가격·기술 지표는 남깁니다.
- `sweep_state.json`에는 검토한 모든 항목의 ID가 있으니 공개하지 마세요.
- `validate.py`는 원장에 있는 이메일 주소, @계정, 전화번호, 계좌처럼 긴 숫자를 경고합니다.
- 예시 데이터는 가상이며 실제 사람·기관·기록을 담고 있지 않습니다.

## 저장소 구성

```
personal-wbs/
├── .claude-plugin/          marketplace.json, plugin.json, icon.png (Claude 플러그인 마켓플레이스)
├── skills/
│   ├── wbs-bootstrap/SKILL.md
│   ├── wbs-tracker/SKILL.md
│   ├── wbs-sweep/SKILL.md
│   ├── wbs-today/SKILL.md
│   └── wbs-schedule/SKILL.md
├── scripts/                 validate.py, make_agent_files.py, reconcile.py, sample_data.py,
│                            package_skills.py, wbs_schema.py (Python 3, 표준 라이브러리)
├── evals/                   claude plugin eval용 동작 시험
├── plugins/personal-wbs-autolog/   선택 설치 Claude Code 플러그인: 세션 종료 훅, 수집 에이전트, 기록 스킬
├── sample/en, sample/ko     가상 예시 원장과 생성된 에이전트용 파일
├── templates/dashboard/     대시보드 페이지 안내
├── docs/                    분류 체계 가이드(영어·한국어·간체 중국어), 근거, 데이터 흐름, 다른 에이전트
├── gemini-extension.json    Gemini CLI 확장 매니페스트
├── README.md, README.ko.md, README.zh-CN.md, PRIVACY.md, SECURITY.md
└── LICENSE
```

## 로드맵

- 대시보드: 페이지를 256 KiB보다 작은 파일들로 나눠 플러그인 안에 넣기. 화면 언어(영어·한국어·간체 중국어)는 이미 실행 중에 바꿀 수 있습니다.
- 원장 헤더 언어 확대(현재 영어와 한국어).
- 더 많은 출처의 수집 방법(이슈 트래커, 다른 메일·캘린더, 노트 앱).
- 스크립트 자동 테스트와 CI, 기계가 읽는 스키마 파일.

## 기여

이슈와 풀 리퀘스트를 환영합니다.

- 스크립트는 Python 3.8 이상과 표준 라이브러리만, 스킬은 그 자체로 완결되게 영어로 씁니다.
- 사용자 문서는 세 언어(영어, 한국어, 간체 중국어)를 함께 고칩니다.
- 실제 개인 데이터를 넣지 마세요. 예시 데이터는 가상이어야 하며, `scripts/sample_data.py`를 고쳐 다시 생성합니다.
- 풀 리퀘스트 전에 실행하세요:

```
python3 scripts/sample_data.py
python3 scripts/validate.py sample --strict
python3 scripts/make_agent_files.py sample --as-of 2026-11-06
claude plugin validate --strict .
claude plugin validate --strict plugins/personal-wbs-autolog
```

동작 시험은 모델을 호출하므로 사용량에 포함됩니다: `claude plugin eval . --scaffold --allow-tools Write Edit "Bash(python3 *)"`.

## 라이선스

MIT. Copyright (c) 2026 Jisung Park. 만든 사람: Jisung Park.
