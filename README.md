# @dsh-external/dsh-evidence

> **一句话**：给 DSH 加一层可复核、防篡改、有有效期的审计证据包——把命令输出、文件哈希、JSON 结果、验证脚本沉淀成"可验证不可抵赖"的快照。

AI 的执行结果默认无法复核、无法证明"当时就是这样"。本插件借鉴 Codex `audit-evidence` 模式，用 **SHA256 清单 + 追加式哈希链收据 + 有效期** 把审计证据固化下来。

## 核心亮点

- **哈希链收据**：每条 create/add 追加一条链式记录，打开即全链校验，损坏拒绝续写。
- **manifestHash 自完整性**：`evidence.json` 被手工篡改会被验出。
- **有效期 `validUntil`**：证据会"过期"，stale/expired 显式分类。
- **诚实能力声明**：明确写出"能证明什么 / 不能证明什么"——哈希不是加密、不是签名。

## 优点与权衡

| 👍 优点 | ⚠️ 权衡 / 边界 |
|---|---|
| 最简单、职责单一，最不易出 bug | 功能面窄：不自动采集，全靠模型主动调用 |
| 防篡改 + 防过期 + 链清单一致性校验 | `verify` 全量重算哈希，大包慢 |
| 诚实声明能/不能证明什么 | 哈希不是签名，防篡改但防不了"整体伪造" |

## 借鉴的优秀项目

| 项目 | 借鉴了什么 |
|---|---|
| openai/codex | 目录式证据包 + 清单 + 可复核快照 |
| 030611/qiushi-dsh-evidence-audit（MIT，直接移植） | canonical JSON、追加式哈希链收据、0700/0600 权限、诚实能力声明 |
| QoderAI/better-harness | evidence-bounded claims、missing/stale evidence 显式化 |
| m0n0x41d/haft | 证据有效期（validUntil）与过期分类 |

---

证据包 / 审计证据 toolkit。借鉴 Codex `audit-evidence` 模式，让 DSH 能把"命令输出、文件 hash、JSON 结果、验证脚本"沉淀成可复核、防篡改、有有效期的证据包。

## 借鉴来源（调研结论）

| 项目 | Star | 借鉴了什么 |
|---|---|---|
| [openai/codex](https://github.com/openai/codex) | 118k | 起源：目录式证据包 + 清单 + 可复核快照；会话级审计轨迹的思路 |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 12.9k | DSH 生态规范：peerDependencies 预发布版本范围必须带显式 prerelease 分支（`>=0.0.1-rc <2` 会静默排除 0.1.0-rc.x，已修复） |
| [QoderAI/better-harness](https://github.com/QoderAI/better-harness) | 1.9k | evidence-bounded claims（每条快照声明其支撑的结论）；missing/stale evidence 显式化，绝不默默变成分数 |
| [m0n0x41d/haft](https://github.com/m0n0x41d/haft) | 1.4k | 证据有效期（validUntil）与过期分类，证据会“过期” |
| [030611/qiushi-dsh-evidence-audit](https://github.com/030611/qiushi-dsh-evidence-audit) | 同类最强 | **直接移植（MIT）**：canonical JSON（递归键排序 + 严格校验）、追加式哈希链收据（打开即全链校验、损坏拒绝续写）、0700/0600 权限、诚实能力声明 |
| [030611/dsh-verification-receipt](https://github.com/030611/dsh-verification-receipt) | 同类 | 被动 bundle 监听事件自动写收据 —— **评估后未采用**（与 DSH 自带会话存储重复、性能/隐私成本大于收益，见下） |

**评估后不采用的：** verification-receipt 的“每 turn 自动收据”会把 prompts/工具参数放进收据文件，与 DSH 自身 session 存储重复且引入持续写盘；dsh-market 的 `dsh.plugin.json` 市场元数据对本地私有插件无收益。两者坏处大于好处，故只取思路不取实现。

## 能力

| 工具 | 作用 |
|---|---|
| `evidence_create` | 创建证据包目录、`evidence.json`（v2 自完整性哈希）与 `receipt.jsonl` 哈希链收据 |
| `evidence_add` | 添加文件/目录快照（SHA256/size/mtime），可选 `claim`（证据结论）、`validUntil`（有效期）、`copy`（复制进包内自包含） |
| `evidence_verify` | 重算哈希，报告 missing / corrupt / **stale**（内容没变但被碰过）/ **expired**（过有效期），并校验清单完整性 + 收据链；**收据链内部合法但绑定旧清单（consistentWithManifest=false）同样判 FAIL** |
| `evidence_list` | 列出所有证据包（含过期计数） |
| `evidence_show` | 查看完整清单（含 claim / validUntil / source / manifestHash） |

## 使用方式

```text
evidence_create name=jhora-audit-20260816 description="JHora 数据提取审计"
evidence_add name=jhora-audit-20260816 paths="<result.json>|<verify.py>" note="A0 结果" claim="A0 任务成功执行且输出符合预期" validUntil=2026-12-31
evidence_add name=jhora-audit-20260816 paths="<output-directory>" copy=true   # 复制进包内，证据包可整体迁移
evidence_verify name=jhora-audit-20260816
evidence_list
evidence_show name=jhora-audit-20260816
```

## 证据包结构

```
~/.dsh/evidence/<name>/
  evidence.json     # 清单（v2：manifestHash 自完整性）
  receipt.jsonl     # 追加式哈希链收据（每条 create/add 记录，防篡改）
  files/            # copy=true 时的自包含副本
```

`evidence.json` 内容：

```json
{
  "version": 2,
  "id": "<name>",
  "createdAt": 0,
  "updatedAt": 0,
  "description": "",
  "metadata": {},
  "files": {
    "<result.json>": {
      "sha256": "UPPERCASE_HEX",
      "size": 123,
      "mtimeMs": 0,
      "claim": "A0 任务成功执行",
      "validUntil": 1798675200000
    }
  },
  "manifestHash": "UPPERCASE_HEX"
}
```

## 能证明什么 / 不能证明什么（诚实声明）

- **能证明**：快照时文件内容是什么；快照后文件是否被改动（corrupt）或被动过（stale）；`evidence.json` 是否被手工篡改（manifestHash）；`receipt.jsonl` 操作轨迹是否被增删改（哈希链）；**清单与收据链是否绑定同一版本**（receipt 存在时必须 `valid` 且 `consistentWithManifest`，链合法但绑旧清单判 FAIL）。
- **不能证明**：文件内容本身是真实的、命令确实成功执行、谁创建了文件、完整后缀是否被删除。哈希不是加密，不是签名，也不是外部信任锚。

## 构建（开发/安装分离）

```bash
node scripts/build.mjs                 # 编译 src → lib
npm run typecheck
npm test                                # 完整性测试矩阵（依赖先 build）
npm run pack:check                      # 发布包内容与解包导入检查
```

发布包只保留部署产物：`lib/`、`package.json`、`README.md` 与运行时解析依赖。

## 注入 / 装配

```bash
dev_inject_plugin  <plugin-directory>
dev_install_package <plugin-directory> --profile web
```

## 已知限制

- 哈希为流式计算（SHA256），不再一次性读入内存；verify 全量重算耗时随证据包大小线性增长。
- `copy=true` 会复制文件内容进证据包（磁盘占用随之增长）；不复制时记录外部路径，外部文件被删除后 verify 会报 missing。
- v1 旧格式证据包仍可读取，下次 add 时自动升级为 v2。
