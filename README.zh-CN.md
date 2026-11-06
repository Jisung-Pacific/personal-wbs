[English](README.md) | [한국어](README.ko.md) | **简体中文**

# personal-wbs

把你多年来做过的所有事情记在同一本台账里，由 Claude 智能体持续更新，并用一个独立的 HTML 仪表盘来查看。

![仪表盘看板视图：使用虚构示例台账的演示](docs/screenshot-board.zh-CN.png)

## 这是什么

- **个人工作分解结构（WBS）台账。** `wbs.csv` 记录你工作和生活事务中的每一个交付物、决定和事件，所有年份放在同一个文件里，按"领域 → 工作包 → 任务 → 步骤"（`1.2.3.4`）的编码树组织。
- **由智能体维护。** 五个 Agent Skills（技能）让 Claude（Claude Code、Cowork、claude.ai）或任何能读取 `SKILL.md` 的智能体从你的数据来源建立台账，在每项工作完成后静默记录，找出遗漏的工作，一分钟内给出今天要做的事，并设置每日和每周的自动运行。
- **只有一个 HTML 文件的仪表盘。** 不需要服务器，也不需要账号：它读取同一文件夹中的 CSV 文件，所有计算都在浏览器中完成。
  - **看板**：今天未完成的工作、被阻塞的事项、已逾期或即将到期的事项、重点工作包。
  - **体检**：像化验单一样，把十项指标与参考范围（部分来自你自己过去一年的记录）比较，给出判定、处方和复查日期。
  - **项目管理方法**：利特尔法则（WIP = 吞吐量 × 周期时间）、服务水平预期（SLE）与在制品老化、预测未完成工作何时完成的蒙特卡洛模拟、每周吞吐量的 XmR 控制图、任务文本的主题聚类，以及不同时期的工作阶段。
  - **状态确认模式**：逐一浏览未完成的任务，用"已完成 / 进行中 / 被阻塞 / 搁置 / 跳过"按钮整理。
  - 台账视图和覆盖情况视图：查看原始行，以及每个来源被清查得有多完整。
  - **语言与无障碍**：通过地球图标切换韩语、英语和简体中文。演示版用 axe-core 4 按 WCAG 2.1 A 与 AA 检查了 16 个视图（韩语和英语、手机和桌面宽度、浅色和深色主题）：0 项违规（2026-11-06）。
- **给智能体用的文件。** 有了 `summary.json` 和 `llms.txt`，任何智能体都不必解析 CSV，就能回答"什么被卡住了？""这周完成了什么？""我最近状态怎么样？"。

- **设计依据**: 每个设计选择背后的研究与已核实的文献: [docs/research.md](docs/research.md)（英文）。

## 为什么：原始数据优先

计划类工具要求你在做事之前先描述工作，时间一长就与现实脱节。本项目从工作本来就会留下痕迹的地方（对话、提交记录、文档、邮件、日历）记录实际发生的事，并附上准确日期和证据。

- **行是原始数据，而不是摘要。** 一行就是一个具体的交付物、决定或事件，日期取自来源的时间戳，并指向它的证据。日期区间只用于一段连续的工作；其中各自有日期的步骤记为子行。
- **所有视图都是计算出来的。** 汇总、体检、主题和预测都由行计算得到，所以分析方法可以改进而不必改写历史；每个数字都能追溯到行，每一行都能追溯到来源。
- **记账交给智能体。** 每项任务后记录，每天收集，每周回顾。你只需确认。

## 上手流程

`wbs-bootstrap` 技能分阶段建立台账。**先看一眼：**只收集并整理最近 3 个月（一次会话内完成），随后展示仪表盘和三条简短的核心发现。**紧接着询问**如何继续：*立即全力推进*（先近 12 个月，再到全部历史；当前会话的模型担任负责规划的主控，另有 2 到 3 个只读的 Sonnet 工作者并行清查）、*在后台慢慢来*（1 到 2 个后台智能体每次运行处理几个窗口，按月份往回推）。两种方式都可以暂停，但收集都会做到最后，新的工作会持续在后台收集，新增内容每周向你展示一次。下面的步骤先用于最近 3 个月，之后再用于更早的历史：

1. **先授权。** 连接你拥有的所有来源（历史对话与记忆、Google Drive、Gmail、Calendar、Slack、Notion、GitHub、ChatGPT 导出数据），并一次性允许技能所需的工具权限，这样后台运行不会因等待确认而停下。首次导入的完整程度决定台账的质量。
2. **确认分类体系。** 智能体浏览你全部历史记录的标题，提出 4 到 7 个领域、每年的工作包和一份简短的目标清单。在你批准之前，不会写入任何内容。请参阅[分类体系指南](docs/taxonomy.zh-CN.md)。
3. **按窗口导入。** 每个"来源 × 月份"是一个窗口，在当前收集范围内（先 3 个月，再 12 个月，再更早的年份）从最早的月份开始按 ID 逐项清查，覆盖情况记录在 `coverage.csv` 中。
4. **原子化。** 把合并了多个结果或跨越很长时间的行，回到来源重新阅读，拆分成带日期的步骤。
5. **状态核对。** 导入的记录往往落后于现实，因此智能体会每次列出约 10 个未完成的任务，问你哪些其实已经完成、被阻塞或已搁置，并根据证据预先填好可能的答案，你只需确认。也可以在仪表盘的状态确认模式中完成。
6. **后台运行。** 安排每日收集和每周回顾，你不必再要求它补记任何事情。

## 快速开始

### Claude Code

```
/plugin marketplace add Jisung-Pacific/personal-wbs
/plugin install personal-wbs@personal-wbs
```

然后说"帮我建立 WBS 台账"（或运行 `/personal-wbs:wbs-bootstrap`）。之后技能会自动使用：工作会被记录，"我最近状态怎么样？"也会得到回答。

### claude.ai

1. 生成技能压缩包：`python3 scripts/package_skills.py` 会为每个技能在 `dist/` 中写出一个压缩包（`wbs-bootstrap`、`wbs-tracker`、`wbs-sweep`、`wbs-today`、`wbs-schedule`）。上传的技能只能看到自己文件夹里的文件，所以每个压缩包都包含技能文件夹和辅助脚本。
2. 在 **Settings → Capabilities → Skills**（较新版本中为 **Customize → Skills**）逐个上传并启用。需要开启代码执行。
3. 对 Claude 说"帮我建立 WBS 台账"。

也可以手动压缩技能文件夹（在 `skills/` 下运行 `zip -r wbs-tracker.zip wbs-tracker/`；压缩包里必须包含文件夹本身）。没有脚本时，技能会改用手动检查。

### 其他能读取 Agent Skills 的智能体

让它读取 `skills/*/SKILL.md` 即可。脚本只使用 Python 3 标准库，参数是台账所在的文件夹。 Gemini CLI、OpenAI Codex 和 Grok Build 的安装方法见 [docs/ports.md](docs/ports.md)（英文）。

### 可选：自动记录会话（Claude Code）

```
/plugin install personal-wbs-autolog@personal-wbs
```

这是一个单独的插件。Claude Code 会话结束时，钩子只在你的电脑上记下该会话的 ID、时间、文件夹和记录文件路径；你同意后，`wbs-autolog-drain` 技能会把这些会话中的工作记入台账。详见 [plugins/personal-wbs-autolog](plugins/personal-wbs-autolog/README.md)（英文）。

### 用示例数据试一试

示例台账完全是虚构的：一名虚构的硕士生在 2025 到 2026 年间一边申请博士项目，一边经营一个小型学习习惯应用。数据有英文版（`sample/en`）和韩文版（`sample/ko`），基准日期为 2026-11-06。

```
python3 scripts/sample_data.py                                # 生成 sample/en 和 sample/ko
python3 scripts/validate.py sample                            # 检查两个版本
python3 scripts/make_agent_files.py sample --as-of 2026-11-06 # 生成 summary.json 和 llms.txt
python3 scripts/reconcile.py list sample/en --as-of 2026-11-06
```

仪表盘页面暂未放入仓库：它约 0.6 MB，超过插件目录对单个文件 256 KiB 的限制，因此将作为发布版下载单独提供（见 [templates/dashboard](templates/dashboard/README.md)）。它读取 `sample/en` 这类文件夹中的 CSV 文件。

## 技能

| 技能 | 何时使用 | 做什么 |
|---|---|---|
| `wbs-bootstrap` | 第一次建立或重建台账时 | 授权清单、来源盘点、分类体系确认、分阶段历史导入（先 3 个月，再 12 个月和更早的年份）、原子化、事件重建、与你核对状态、仪表盘、安排每日和每周的后台运行 |
| `wbs-tracker` | 每完成一项产生结果的工作后；当你询问自己的工作时 | 把结果静默记录为带日期和证据的原子行；回答未完成、被阻塞、逾期、已完成的问题；执行每周体检 |
| `wbs-sweep` | 每日收集、查找漏记的工作、补录某一年 | 按"来源 × 月份"窗口进行可续跑的穷尽清查（覆盖状态、滚雪球式追查）、区间行原子化、无日期行复查 |
| `wbs-today` | 询问今天做什么时；每日摘要运行时 | 今天最重要的三项任务、逾期或受阻的工作、最多三个待你决定的事项；只把你回答的决定写入台账 |
| `wbs-schedule` | 希望台账自动更新时 | 每日收集、每周回顾和每日摘要的现成提示词，以及在 Cowork、Claude 应用或 Claude Code 中的设置步骤；只有你要求时才创建定时任务 |

| 脚本 | 用途 |
|---|---|
| `validate.py <文件夹>` | 检查 wbs.csv（22 列、键、父任务、日期、取值、前置任务、隐私检查）及配套文件；`--atomize` 列出需要拆分的行 |
| `make_agent_files.py <文件夹>` | 生成包含体检结果的 `summary.json` 和 `llms.txt` |
| `reconcile.py list/apply <文件夹>` | 状态核对：分批列出未完成任务，并把你的回答写回台账 |
| `sample_data.py` | 重新生成虚构示例数据 |
| `package_skills.py` | 把每个技能连同脚本打包，便于上传 |

### 测试

`evals/` 中是供 `claude plugin eval` 使用的行为测试：检查每个技能在合适的请求下启用、在无关请求下不启用，以及三天里的三项成果被记为三行带日期的记录，而不是一行区间记录。详见 [evals/README.md](evals/README.md)（英文）。

## 数据模型

| 文件 | 内容 |
|---|---|
| `wbs.csv` | 台账：22 列，带 BOM 的 UTF-8，包含所有年份 |
| `plan.csv` | 目标、重点工作包、体检日期和设置（`kind,year,target,note,decided,recheck`） |
| `events.csv` | 只追加的日志：创建、状态变化、更正和迁移（事后重建的记录 `estimated` = Y） |
| `coverage.csv` | 每个"年 × 月 × 来源"窗口的清查状态：`not_started`、`partial`、`complete`、`unavailable` |
| `sweep_state.json` | 已判定条目的 ID（不公开） |
| `summary.json`、`llms.txt` | 为智能体生成的文件 |

`wbs.csv` 的 22 列（英文列名；括号内为韩文列名）：

`year`（연도）· `code`（WBS）· `level`（레벨）· `area`（대분류）· `package`（중분류）· `parent`（상위 작업）· `task`（작업·산출물）· `start`（시작일）· `end`（종료일）· `date_text`（일자(원문)）· `start_month`（시작월）· `status`（상태）· `key_result`（핵심성과）· `source`（출처）· `due`（마감일）· `importance`（중요도）· `size`（크기）· `depends_on`（선행）· `blocker`（막힘 사유）· `last_progress`（최근 진행일）· `goal`（목표）· `evidence`（근거）

- 行的键是（year, code）；每年有自己的编码树；编码一经写入就不再改动。
- 状态：`done`（已完成）、`in_progress`（进行中）、`waiting`（等待他人）、`backlog`（主动搁置）。
- 日期是来源中的准确日期；未知日期留空并标记给清查流程处理，绝不猜测。
- `blocker` 写作 `<类别>: <机构或角色>`，`depends_on` 列出前置任务编码，`evidence` 列出 `claude:<对话 id8>`、`gh:<owner/repo>#<PR>`、`drive:<文件标题>`、`cal:<日期>` 等指针。
- 语言：默认使用英文列名，韩文列名和取值同样通用。中文用户请使用英文列名，任务内容可以用中文书写。

## 隐私模型

### 插件读取、写入和发送什么

| | |
|---|---|
| **读取** | 你过去的 Claude 对话（对话搜索）、本机上的 Claude Code 会话记录、你上传的导出文件（ChatGPT、Claude），以及你已连接的应用：Google Drive、Gmail、Google Calendar、Slack、Notion、GitHub。只读。 |
| **写入** | 把台账文件（`wbs.csv` 及配套文件）写到你选择的位置：claude.ai artifact、本地文件夹，或你自己的私有 Git 仓库。 |
| **发送** | 不向作者或任何其他服务发送任何内容：没有服务器、没有遥测、没有分析。唯一离开 Claude 的写入，是在你选择了该位置并提出要求时，提交到你自己的 Git 仓库。 |
| **个人数据** | 只为找到你的工作而通过连接的应用读取，不会保存。每一行只描述工作并写机构和角色，从不写他人的姓名、邮箱或电话号码（`validate.py` 发现时会警告）。 |
| **保留** | 除你自己的文件外，不保留任何内容。 |

### 会发送数据的可选部分：hub 与浏览器扩展

- [`hub/`](hub/) 是由你（或你的组织）自行运行的服务器：每个账户一本台账，置于 OAuth 之后，以 MCP 服务器和 REST API 提供给所有智能体。台账行、历史和收件箱条目用每个账户自己的密钥封存，该密钥由 Cloud KMS 包裹；删除账户时先删除密钥。
- [`extension/`](extension/) 是浏览器扩展：只有在你点击时，才把 AI 聊天网站当前标签页的对话（以及仅在你开启后，你的 Google 搜索词）发送到该 hub 上你自己的账户。
| **可选：自动记录** | 单独的 `personal-wbs-autolog` 插件只在你的电脑上、在它自己的数据文件夹中记下每个结束的 Claude Code 会话的 ID、时间、文件夹和记录文件路径；只有你同意记录时才读取会话记录。 |

完整政策见 [PRIVACY.md](PRIVACY.md)；数据流向图见 [docs/data-flow.md](docs/data-flow.md)，安全问题报告方式见 [SECURITY.md](SECURITY.md)（英文）。


- **数据留在你放置的地方**：本地文件夹、私有仓库或私有 artifact。没有服务器，仪表盘在你的浏览器中计算。
- **来源只读。** 技能不会在任何已连接的应用中发送、修改、共享或删除内容。
- **存指针，不存副本。** 行里只有简短描述和证据 ID，没有消息正文。
- **可修改的默认隐私规则**：不记录健康、恋爱与人际关系、金融账号以及他人的个人账号（改写为机构或角色）；不写个人收入等金额；保留业务成本、公开价格和技术指标。
- `sweep_state.json` 列出了所有已检查条目的 ID，请勿公开。
- `validate.py` 会对台账中的邮箱地址、@账号、电话号码和类似账号的长数字发出警告。
- 示例数据是虚构的，不描述任何真实的个人、机构或记录。

## 仓库结构

```
personal-wbs/
├── .claude-plugin/          marketplace.json、plugin.json、icon.png（Claude 插件市场）
├── skills/
│   ├── wbs-bootstrap/SKILL.md
│   ├── wbs-tracker/SKILL.md
│   ├── wbs-sweep/SKILL.md
│   ├── wbs-today/SKILL.md
│   └── wbs-schedule/SKILL.md
├── scripts/                 validate.py、make_agent_files.py、reconcile.py、sample_data.py、
│                            package_skills.py、wbs_schema.py（Python 3，仅标准库）
├── evals/                   供 claude plugin eval 使用的行为测试
├── plugins/personal-wbs-autolog/   可选的 Claude Code 插件：会话结束钩子、收集智能体、记录技能
├── sample/en、sample/ko     虚构示例台账及生成的智能体文件
├── templates/dashboard/     仪表盘页面说明
├── docs/                    分类体系指南（英文、韩文、简体中文）、研究依据、数据流向、其他智能体
├── gemini-extension.json    Gemini CLI 扩展清单
├── README.md、README.ko.md、README.zh-CN.md、PRIVACY.md、SECURITY.md
└── LICENSE
```

## 路线图

- 仪表盘：把页面拆成小于 256 KiB 的文件，以便放入插件；界面语言（英文、韩文、简体中文）已可在运行时切换。
- 台账列名支持更多语言（目前为英文和韩文）。
- 更多来源的收集方法（问题跟踪工具、其他邮件和日历服务、笔记应用）。
- 脚本的自动化测试与 CI，以及机器可读的数据结构定义文件。

## 参与贡献

欢迎提交 issue 和 pull request。

- 脚本保持 Python 3.8 及以上、仅使用标准库；技能文件保持自包含，并用英文书写。
- 面向用户的文档请三种语言（英文、韩文、简体中文）一起更新。
- 不要加入任何真实的个人数据。示例数据必须保持虚构；请修改 `scripts/sample_data.py` 后重新生成。
- 提交 pull request 之前请运行：

```
python3 scripts/sample_data.py
python3 scripts/validate.py sample --strict
python3 scripts/make_agent_files.py sample --as-of 2026-11-06
claude plugin validate --strict .
claude plugin validate --strict plugins/personal-wbs-autolog
```

行为测试会调用模型，计入你的用量：`claude plugin eval . --scaffold --allow-tools Write Edit "Bash(python3 *)"`。

## 许可证

MIT。Copyright (c) 2026 Jisung Park。作者：Jisung Park。
