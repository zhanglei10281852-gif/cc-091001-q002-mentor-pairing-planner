# 新教师导师结对编排

教师发展中心用本项目编排新入职教师的导师结对：发布前可以反复试排并比较草案，发布后每一次换导师都有依据、保留原承诺，且全程可追溯。

## 快速开始

要求 Node.js 20 或更高版本，无第三方依赖。

```bash
npm test          # 运行全部测试
npm run demo      # 演示完整流程（试排→发布→调换→追溯）
npm start         # 启动 HTTP 服务（默认 :3000）
```

本地敏感配置写入 `.env`（已在 .gitignore 中）。可用环境变量：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `3000` |
| `DATASET` | 基础资料（教师/导师/回避）JSON 路径 | `fixtures/dataset.json` |
| `DATA_FILE` | 状态持久化文件；存在则启动时恢复 | 不持久化 |
| `PLANNER_TOKENS` | 令牌到身份的 JSON 映射 | 开发默认值见下 |

默认开发令牌：`admin-token`（管理员），`t-<教师ID>`（如 `t-T-101`，对应教师本人）。

## 领域规则

- **硬约束**（`src/domain.js` 的 `hardConstraintKinds`）：学科兼容、导师容量、同校回避、登记回避。任何求解、锁定、提升、调换都必须满足；管理员锁定时可显式覆盖，覆盖会留痕。
- **偏好**（`preferenceKinds`）：偏好学校、偏好科目、既往合作，仅用于同等可行方案之间的取舍，权重见 `preferenceWeights`。
- **求解**（`src/solver.js`）：在保证匹配人数最多的方案中取偏好权重最大者（最小费用最大流），结果确定；每位教师都带候选导师逐条解释，未匹配者给出按约束种类统计的原因。
- **方案状态机**：`draft → collecting-confirmations → published → superseded`。草案阶段可反复求解；新方案发布时旧方案自动作废，历史确认记录保留。
- **确认状态机**（`responseStates`）：`pending → accepted / declined / expired`。邀请来源分初始邀请、候补提升、发布后调换三种。

## 并发与一致性

- 每个方案携带单调递增的 `version`。所有修改操作要求 `If-Match: <version>` 头（或请求体 `expectedVersion`）；版本不符返回 **409** 并附上当前版本，两位管理员同时调整时后到者必须刷新重试，不会悄悄覆盖对方。
- 调换导师采用两阶段：新邀请被教师接受后原确认才被取代（`supersededBy`），拒绝或过期则原承诺继续生效。
- 教师退出、导师暂停只把待回应邀请作废、把生效安排标记结束；**已完成的培养记录（trainingRecords）不受影响**。
- 所有关键动作写入审计事件（`GET /plans/:id/audit`），任何调换都能追溯到发布版本号与确认过程（`GET /teachers/:id/trace`）。

## HTTP API

管理员接口（需管理员令牌）：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /plans` | 新建草案 |
| `GET /plans` / `GET /plans/:id` | 列表 / 详情（含生效安排、候补、解释） |
| `POST /plans/:id/solve` | 求解（可反复试排） |
| `POST /plans/:id/locks` / `DELETE /plans/:id/locks/:teacherId` | 锁定 / 解锁人工安排 |
| `GET /plans/:id/compare/:otherId` | 比较两个草案的未匹配原因 |
| `POST /plans/:id/invitations` | 按求解结果发起邀请 |
| `POST /plans/:id/publish` | 发布（无待回应邀请时才允许） |
| `POST /plans/:id/promotions` | 候补提升 `{teacherId, mentorId}` |
| `POST /plans/:id/changes` | 调换导师 `{teacherId, newMentorId, reason}` |
| `POST /confirmations/:id/expire` | 作废待回应邀请 |
| `POST /teachers/:id/withdraw` | 教师退出 |
| `POST /mentors/:id/pause` / `resume` | 导师暂停 / 恢复带教 |
| `POST /mentorships/complete` | 完成培养，生成培养记录 |
| `GET /plans/:id/audit` | 方案审计轨迹 |
| `GET /teachers/:id/trace` | 教师全链路追溯 |

教师接口（令牌身份即教师本人，只能看到与自己有关的结果）：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /confirmations/:id/respond` | 回应邀请 `{accept: true|false}` |
| `GET /me/result` | 我的结对结果（生效导师、待回应邀请、候补位次） |

## 目录结构

```
fixtures/dataset.json   示例基础资料（教师/导师/回避/偏好）
src/domain.js           状态机与约束/偏好常量
src/solver.js           硬约束求值、偏好打分、可解释求解
src/planner.js          草案、邀请、发布、候补、调换、退出/暂停、审计
src/server.js           HTTP API 与令牌鉴权
scripts/demo.js         端到端流程演示
test/                   node:test 测试（求解器 / 服务流程 / HTTP API）
```
