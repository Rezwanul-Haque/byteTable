# 汉化审计报告（zh-Hans）

本轮把渲染层的全部用户可见文案接入 i18n，并补齐简体中文译文。以下是范围、结果与术语约定。

## 一、结论

**问题根源不是词表缺译，而是文案没接入。** 改造前 `zh-Hans.ts` 对 `en.ts` 的 120 个键是 100% 覆盖的，但 `en.ts` 的注释已经点明真相：

> the coverage bar and this note are commented out in SettingsModal.tsx until enough of the app is keyed for the number to be truthful

即：词表本身完整，但**界面绝大多数文案是硬编码英文**（167 个组件中只有 88 个引用了 `t()`），所以词表再全，界面上仍然是英文。

| 指标                                                     | 改造前 | 改造后                             |
| ------------------------------------------------------ | --- | ------------------------------- |
| i18n 键数（en，事实源）                                        | 120 | **3373**                        |
| zh-Hans 键数                                             | 120 | **3373**（与 en 双向零差异）            |
| 引用 i18n 的文件                                            | 88  | **167**                         |
| 改动文件                                                   | —   | **187**（182 在 `src/`，另 2 个共享词表） |
| 未接入 i18n 且含可见英文的文件                                     | 40+ | **0**                           |
| `pnpm typecheck` / `pnpm test` / `eslint` / `prettier` | —   | 通过 / 340 通过 / 干净 / 干净           |

覆盖率进度条现在可以启用了（见第五节）。

## 二、改造范围与手法

按功能面切成 6 批，逐批"提取 → 建键 → 接线 → 自检 typecheck"，串行执行以避免 `en.ts` / `zh-Hans.ts` 的并发写冲突：

| 批次 | 范围                                                                                                | 新增键                                                         |
| -- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1  | 应用外壳：`workspaces`、`shared/ui`、`console`、`processes`、`updater`、`report_issue`、`settings`、`App.tsx` | ws, shell, uix, console, proc, upd, report, setx            |
| 2  | SQL 浏览面：数据网格、过滤面板、结构视图、导入导出、造数、数据文件、保存的查询                                                         | grid 141、io 129、dfile 129、stv 75、flt 30、dq 27、ins 24、gen 15 |
| 3  | NoSQL 面：Redis / DynamoDB / MongoDB                                                                | redis 409、dyn 361、mongo 272                                 |
| 4a | Cassandra / Typesense                                                                             | cass 356、tsx 235                                            |
| 4b | 结构图、结构对比、连接、内省、对象浏览器                                                                              | conn 126、obj 117、smap 87、sdiff 80、intro 10                  |
| 5  | 收尾：未接线文件、残留漏网点、纯 `.ts` 模块（Explain 模型、内省错误、反馈类型、原生对话框过滤项、进程列头）                                     | expl、bug、don、about、err、bin、term 等                           |

键命名沿用项目既有的点分命名空间（`common.*` / `menu.*` / `connect.*` / `set.*`，新增区域前缀见上表），语义化叶子名，如 `ws.tab.close`、`cass.sidebar.refresh`、`tsx.search.queryBy`。

**非组件模块的取词方式**（这是本轮的主要技术难点）：

- 运行时函数内（错误回退、格式化、原生对话框）→ 直接 `t("key", {…})`，locale 切换后**新产生**的文案即为新语言。
- 模块级常量表（执行计划阶段表、反馈类型表、引擎列头）→ 改为**键 + 渲染期解析**，例如 `EXEC_STEPS` 的 `label/desc` 变为 `labelKey/descKey`、`PROC_SOURCES` 的 `pidLabel/labels` 变为 `pidKey/labelKeys`、`REGIONS` 只留 id 由 `regionKey()` 解析。这样语言切换能即时重绘。
- 含数字的句子一律做成整句模板（`{count}` / `{count, plural, …}`），**不留英文拼接**——中文语序不同，拼接必然错。

## 三、专业术语对照表

| 英文                                  | 中文               | 说明                                                          |
| ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| schema                              | 结构               | 项目既定（Schema Map = 结构图，Compare schemas = 比较结构）；指命名空间时用"模式"   |
| workspace / tab                     | 工作区 / 标签页        |                                                             |
| data grid                           | 数据表格             |                                                             |
| query / run / execute               | 查询 / 运行 / 执行     |                                                             |
| explain / execution plan            | 执行计划             | 节点名（HashAggregate 等）保留                                      |
| filter / sort                       | 筛选 / 排序          | asc/desc → 升序/降序                                            |
| truncate / drop                     | 清空 / 删除          |                                                             |
| inline editing / staged / apply     | 行内编辑 / 暂存 / 应用   |                                                             |
| connection / credentials            | 连接 / 凭据          |                                                             |
| host / port                         | 主机 / 端口          | SSL/TLS 保留                                                  |
| SSH tunnel / bastion                | SSH 隧道 / 堡垒机     |                                                             |
| process / session                   | 进程 / 会话          | kill → 终止                                                   |
| terminal                            | 终端               |                                                             |
| index / foreign key / referenced by | 索引 / 外键 / 被引用    |                                                             |
| view / materialized view            | 视图 / 物化视图        |                                                             |
| function / procedure / trigger      | 函数 / 存储过程 / 触发器  |                                                             |
| keyspace（Cassandra）                 | 键空间              | partition key → 分区键，clustering key → 聚簇键，ALLOW FILTERING 保留 |
| consistency level                   | 一致性级别            |                                                             |
| collection / document（Mongo）        | 集合 / 文档          | namespace → 命名空间                                            |
| aggregation pipeline / projection   | 聚合管道 / 投影        | 操作符 `$lookup` 等保留                                           |
| validation                          | 校验               | `$jsonSchema` 保留                                            |
| table / item / attribute（DynamoDB）  | 表 / 条目 / 属性      | partition key → 分区键，sort key → 排序键，GSI/LSI/PartiQL 保留       |
| key / TTL / encoding（Redis）         | 键 / TTL / 编码     | hash → 哈希，zset → 有序集合，stream → 流                            |
| relevance / typo tolerance          | 相关性 / 容错         | typo budget → 容错预算                                          |
| facet / curation / synonym          | 分面 / 策展 / 同义词    | pinned → 置顶，hidden → 隐藏                                     |
| cluster / node                      | 集群 / 节点          | raft 保留                                                     |
| migration                           | 迁移               |                                                             |
| spill / filesort / hash join        | 溢写 / 文件排序 / 哈希连接 |                                                             |

## 四、有意保留英文的类别

以下是**刻意不翻译**的，不是漏网：

1. **服务器/引擎自身术语**：`PID`、`SPID`、`OpId`、`Id`、`Addr`、`DB`、`Flags`（进程列表列头，服务器原样输出）；MySQL 的 `Using where` / `Using temporary` / `Using filesort` / `Using join buffer`；执行计划 detail 里的 `Filter:` / `Sort Key:`（代码有 `startsWith("Filter:")` 逻辑依赖）。
2. **引擎原样输出与命令行**：`SHOW FULL PROCESSLIST`、`pg_stat_activity`、`CLIENT LIST` 等 source 标签；psql/mysql/redis-cli/mongosh/cqlsh 的真实终端输出与 banner；`CLUSTER NODES` 等命令名。
3. **语法与格式名**：SQL/CQL 关键字、`JSON`/`CSV`/`SVG`/`PNG`/`UUID`/`BSON`/`ISODate`、`CRLF`、`null`、`ALLOW FILTERING`、`filter_by`/`query_by`。
4. **示例值与占位符**：`localhost`、连接串（`postgres://…`、`mongodb+srv://…`）、`AKIA…`、示例表名/键空间名（`orders`、`byteshop`）、SQL 片段、`{ name: 1 }`。
5. **品牌与键位**：`{app}`、引擎名、`⌘K`/`⇧⌥F` 等快捷键记号；语言名称用本族语（`English`/`简体中文`/`العربية`，即 `LOCALES` 的 endonym）。
6. **`data-screen-label` 等测试/自动化标注**，以及 `src/dev/**` 开发沙盒。

## 五、后续建议

1. **启用覆盖率进度条**（一行改动）：`SettingsModal.tsx` 里 `coverage` 的 import 与 Language pane 的 `set.lang.coverage` + `set.lang.machine` 提示目前仍是注释状态，注释写明"等应用接入够了再打开"——现在条件已满足，zh-Hans 为 100%，其余语言会显示真实占比（约 3%，因为它们仍是部分翻译表，缺失键回落英文，属设计内行为）。这是产品决策，故未擅自启用。
2. **zh-Hant（繁體中文）**：目前同其他语言一样回落英文。既有的 `zh-Hant.ts` 是独立表（本项目有意不复用简繁）。若要一并汉化，可复用本轮的 `en.ts` 键集直接产出译文。
3. **其余语言**：`de` / `es` / `ja` / `ar` / `bn` 现为部分表，界面将大量回落英文。本轮未扩这些语言（用户目标是汉化）。
4. **Rust 侧文案**：后端错误/提示仍为英文，经 `appErrorMessage(err, t("…"))` 时回退文案已汉化，但 `err` 自身文本来自 Rust。若要全链路汉化，需在 `src-tauri` 侧建立错误码 → 文案的映射，再由前端渲染。
5. **`docs/TRANSLATING.md`**：可补一句"键已按区域命名空间分组，新增文案请就近追加"，方便社区贡献者定位。

## 六、附：改动分布（按目录）

```
16  src/features/workspaces/components      13  src/features/browse/cassandra/components
14  src/features/browse/mongo/components    13  src/features/browse/redis/components
12  src/features/browse/dynamo/components   11  src/shared/ui
10  src/features/browse/sql/components       9  src/features/browse/typesense/components
 8  src/features/workspaces                  7  src/features/export/components
 7  src/features/data_file (+7 顶层)         5  src/features/db_objects/components
 4  src/features/browse/shared/components    3  src/features/schema_map/components
 3  src/features/console/components          3  src/features/connections
 2  src/shared/i18n/strings                  2  src/features/updater/components
 2  src/features/schema_diff/components      2  src/features/import/components
```

