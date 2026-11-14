# HTTP API

所有端点挂在 `/api/smart-marketing` 前缀下，由 `routes/smart-marketing-api.js` 的 `handleSmartMarketingApi()` 分发。完整实现以该文件为准，本文是索引。

## 通用约定

| 项 | 值 |
|---|---|
| 前缀 | `/api/smart-marketing`（`/` 与 `/health` 等价） |
| 编码 | 请求/响应 JSON，UTF-8 |
| 请求体上限 | 256 KB（`BODY_LIMIT`），超限返回 413 |
| 成功 | HTTP 200 + `{ "ok": true, ... }` |
| 失败 | `{ "ok": false, "code": "错误码", "error": "描述", ... }` |
| 预检 | `OPTIONS` 返回 204；`Allow: GET, POST, PUT, OPTIONS` —— **注意不含 DELETE**，见文末已知问题 |
| 持久化 | 写操作经 200 ms 防抖后原子替换 `data/smart-marketing/state.json` |

浏览器端通过 `api(path, options)` 封装调用，`API_BASE = '/api/smart-marketing'`；前端实际发起的路径共 40 条。

## 端点索引

### 健康检查与元数据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health`、`/` | 引擎版本、数据种子、客户/线索数、状态分布、审计条数、`simulated` 标记 |
| GET | `/metrics` | 聚合指标（漏斗、组转化率、`inc`、`incCI`、成本、实验数据） |
| GET | `/fields` | 可用客户字段白名单 |
| GET | `/operators` | 算子资产 |
| GET | `/compliance` | 闸门统计与合规信息 |
| GET | `/audit?limit=50` | 审计记录（最多保留 500 条） |
| POST | `/demo/reset` | 复位演示链路到初始状态 |

`/health` 实测响应：

```json
{
  "ok": true, "service": "smart-marketing", "engine_version": "1.0.0",
  "data_seed": 20261104, "customers": 6000, "leads": 240,
  "status_counts": {"已触达": 167, "已下发": 51, "待指认": 13, "已响应": 5, "已转化": 4},
  "definitions": 35, "audit_events": 500, "persisted": true,
  "uptime_s": 6, "simulated": true
}
```

### 线索定义 DSL 与客群

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/dsl/compile` | 编译 `lead_def:` 文本并返回解析结果/错误位置 |
| GET / POST | `/definitions` | 列出 / 保存定义 |
| POST | `/definitions/preview` | 试算人群规模 |
| POST | `/definitions/import-list` | 从名单导入客群 |
| POST | `/definitions/combine` | 组合客群 |
| GET / DELETE | `/definitions/:id` | 读取 / 删除定义 |
| POST | `/definitions/:id/refresh`、`/refresh-mode`、`/materialize` | 重算 / 切刷新模式 / 实例化为线索 |

`lead_def:` 主要字段：`id, name, version, owner, scope{segment,universe_filter}, trigger{mode,schedule}, filters[], scoring[{feature,weight}], threshold, cooldown_days, action{type,channel_priority,template_id}, guardrail{max_daily_volume,frequency_cap,quiet_hours}`。评分特征为 `dropRatio / value / tenure / channelMatch`。

### 线索、客户与标签

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/leads`、`/leads/:id` | 线索列表 / 单条详情 |
| POST | `/leads/:id/actions` | 状态动作：`dispatch` / `contact` / `respond` / `convert` / `close`；下发前过闸门 |
| GET | `/customers`、`/customers/:id/profile` | 客户列表 / 六维画像 |
| GET | `/tags`、`/tags/:id` | 标签字典 |

线索字段：`id, xid, name, tier, limit, txn30, txnPrev, amt30, days, value, tenure, channel, inApp30, score, drop, prio, group('C'/'T'), status, contacted, responded, converted, risk[], blocked[], defId, defVer, opVer, modelVer, expValue, cost`。

### 方案、任务单、回执与结果

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/campaigns` | 列出 / 创建方案 |
| POST | `/campaigns/generate` | 由定义生成方案草稿（可走 Agent） |
| GET / PUT | `/campaigns/:id` | 读取 / 更新方案 |
| POST | `/campaigns/:id/actions`、`/:id/tasks` | 审批动作 / 拆任务单 |
| GET | `/campaigns/:id/ab-test` | A/B 实验对照数据 |
| GET | `/tasks`、`/tasks/overview` | 任务单列表 / 执行概览 |
| GET | `/tasks/:id`、`/:id/audience` | 任务单详情 / 受众名单 |
| POST | `/tasks/:id/actions`、`/:id/receipts` | 状态动作 / 回执回流 |
| GET / POST | `/outcomes` | 结果回采 |
| GET | `/assets`、`/assets/selectable` | 营销资产 / 可选资产（权益、素材、资源位、活动模板、费用分摊协议） |

### 话术与模拟会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/scripts` | 列出 / 保存话术脚本 |
| GET / POST | `/scripts/meta`、`/scripts/cases`、`/scripts/compare` | 元数据 / 试跑案例 / 三引擎对比 |
| GET / PUT / DELETE | `/scripts/:id` | 读取 / 更新 / 删除脚本 |
| GET / POST | `/scripts/:id/validate` | 校验脚本 |
| POST | `/scripts/:id/sessions` | 新建模拟会话 |
| POST | `/scripts/sessions/:id/turn`、`/close` | 推进一轮对话 / 关闭会话 |

三引擎：`rule`（规则流程）、`llm`（模型生成）、`agent`（模型主导命令）。会话 `trace` 记录 `real: true/false`，可审计每一轮是否用了真模型。

### 数据集与 Agent

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/datasets` | 列出 / 上传数据集 |
| POST | `/datasets/preview`、`/datasets/:id/activate` | 预览 / 激活 |
| GET | `/datasets/:id` | 数据集详情 |
| GET | `/agents` | Agent 登记信息 |
| POST | `/agents/explain-lead` | 线索解释（工具函数输出） |
| POST | `/agents/review-call` | 通话质检 |

## 快速验证

```bash
# 服务端是否接管
curl http://127.0.0.1:3000/api/smart-marketing/health

# 编译一段线索定义（返回解析结果与错误位置）
curl -X POST http://127.0.0.1:3000/api/smart-marketing/dsl/compile \
  -H 'Content-Type: application/json' -d '{"dsl":"lead_def:\n  id: demo\n  threshold: 0.6\n"}'

# 线索池前 5 条（分页参数是 page / size，不是 limit）
curl 'http://127.0.0.1:3000/api/smart-marketing/leads?page=1&size=5'

# 复位演示链路
curl -X POST http://127.0.0.1:3000/api/smart-marketing/demo/reset
```

## 已知问题

- `OPTIONS` 的 `Allow` / `Access-Control-Allow-Methods` 只列出 `GET, POST, PUT, OPTIONS`，但后端确实实现了 `DELETE /definitions/:id` 与 `DELETE /scripts/:id`。同源 iframe 不触发预检所以一直未暴露；跨域部署需要补齐 `DELETE`。
- 前端 `tools/smart-marketing/index.html:7295` 调用了不存在的 `/cases`，`catch` 吞掉 404，导致试跑记录列表不更新。正确端点是 `/scripts/cases`。
- 未匹配的请求统一落到路由末尾的 `404 未匹配的接口`。
