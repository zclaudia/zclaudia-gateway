# Architecture Decision Records

重要设计决策的记录目录。每个决策一个文件，命名 `NNNN-短横线标题.md`，按 [template.md](template.md) 撰写。决策一经 Accepted 不修改正文；被推翻时新增一篇 ADR 并在旧篇标注 Superseded。

## 索引

| # | 标题 | 状态 |
| --- | --- | --- |
| — | （尚无正式 ADR） | |

## 待定决策

以下决策必须在对应阶段开工前落纸（完整清单见 [ROADMAP.md](../../ROADMAP.md) 第 8 节）：

- **Phase 1 前**：用户身份签发（接 IdP vs Gateway 最小认证）；TLS/WSS 终止方案与部署形态。
- **Phase 2 前**：Channel 传输承载（每 Channel 一条 WS 连接【倾向】vs 单连接自研多路复用）；凭证签发与撤销模型；Backend 标识唯一性规则。
