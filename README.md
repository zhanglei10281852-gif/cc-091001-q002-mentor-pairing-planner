# 新教师导师结对编排

教师发展中心用它管理新入职教师与导师的结对：正式发布前可以反复试排多版草案、锁定人工安排后继续求解；发布后把邀请、双方确认、拒绝、候补、定稿、换导师、退出与停带串成一致流程，并全程留痕。

- **硬约束**：学科兼容、导师容量、同校回避、登记回避，以及运行期的导师停带 / 教师退出 / 人工排除。任何路径（求解器、人工锁定、换导师）都不能突破。
- **偏好**：仅在同等可行的方案之间排序，不会放宽硬约束。
- **可解释**：每位未匹配教师对每位导师的不可行原因逐条给出；两版草案可对比未匹配原因。
- **并发安全**：计划与邀请各自带版本号，写入须带 `If-Match`；两位管理员同时调整时后提交者收到 `409`，而不是悄悄覆盖。
- **承诺不丢失**：导师与教师的确认结果分字段独立存储，任一方的写入不会覆盖另一方；改答保留历史。培养记录只追加 / 终结，不删除；换导师、退出、停带都不破坏已完成的培养记录。
- **可追溯**：所有状态变化写只追加审计；培养记录与邀请都带有发布版本号（`releaseVersion`），任何调换都能回溯到发布版本与确认过程。

## 运行

Node.js ≥ 20。

```bash
npm test          # 30 个测试：匹配引擎、业务流程、HTTP、持久化
npm run demo      # 用 fixtures 跑通 试排→对比→发布→确认→拒绝→候补→换导师
npm start         # HTTP 服务（默认 :3000，DATA_FILE 指向状态文件）
```

环境变量：`ADMIN_TOKEN`（管理端令牌）、`DATA_FILE`（默认 `./data/planner-state.json`）、`INVITATION_TTL_DAYS`（默认 14）、`PORT`。敏感配置写入 `.env`（已在 `.gitignore`）。

## 资料格式

`fixtures/matching-context.json` 给出脱敏样例：

- `teachers[]`：`{id, name, subject, school, token}`
- `mentors[]`：`{id, name, subjects[], school, capacity, token}`
- `compatibility`：学科兼容表，如 `{"general-science": ["physics", "chemistry"]}`（按对称关系处理）
- `avoidances[]`：`{teacherId, mentorId, reason}`
- `preferences[]`：`{teacherId, mentorId, kind}`，`kind ∈ preferred-school | preferred-subject | prior-collaboration`

## 流程与状态

```
draft ──publish──▶ collecting-confirmations ──finalize──▶ published
  │                      │
  └─(未被选中发布的其他草案自动 superseded)
```

- 草案期所有求解即时进行、不落库；发布时固化匹配结果与未匹配原因。
- 发布即向匹配教师发邀请（带有效期）；未匹配教师（人工排除的除外）自动进入候补。
- 邀请状态由双方独立结果推导：双 `accepted` 才 `accepted`，任一方 `declined` 即终结并转候补。
- 接受后生成**培养记录**（enrollment），记录发布版本与邀请 id。
- 换导师：必须填写理由 → 旧培养记录以 `reassignment` 终结保留 → 向新导师发邀请（同样双方确认）。
- 教师退出：取消待处理邀请、以 `teacher-exit` 终结在培记录，历史记录保留。
- 导师临时停带：取消其待处理邀请（教师回候补），**在培记录不动**；恢复后可继续接收。
- 候补补排同样校验容量与硬约束；其邀请若被拒绝 / 取消 / 过期，候补自动回到 `waiting`。

## HTTP 接口摘要

管理端所有 `/api/admin/*` 请求需带头 `X-Admin-Token`。可变资源返回 `ETag: W/"<version>"`，写入时带 `If-Match`。

| 方法 & 路径 | 说明 |
|---|---|
| `POST /api/admin/data` | 导入 / 替换教师、导师、兼容、回避、偏好资料 |
| `POST /api/admin/plans` | 新建草案 `{name?, strategy?}` |
| `GET  /api/admin/plans/:id` | 草案：返回配置 + 即时求解结果；已发布：返回固化结果 |
| `GET  /api/admin/plans/:id/candidates/:teacherId` | 该教师对每位导师的可行性与原因 |
| `GET  /api/admin/plans/:id/compare?other=:id2` | 两版草案未匹配原因对比 |
| `PUT  /api/admin/plans/:id/strategy` | 切换 `max-match` / `preference-first` |
| `POST /api/admin/plans/:id/locks` | 锁定人工安排 `{teacherId, mentorId}`（校验硬约束+容量） |
| `DELETE /api/admin/plans/:id/locks/:teacherId` | 解除锁定 |
| `PUT  /api/admin/plans/:id/exclusions` | 人工排除 `{teacherIds?, mentorIds?}` |
| `POST /api/admin/plans/:id/publish` | 固化求解、进入确认中、发邀请、未匹配进候补 |
| `POST /api/admin/plans/:id/finalize` | 所有邀请有结果后定稿为 published |
| `POST /api/admin/reassign` | 换导师 `{teacherId, mentorId, reason}`（理由必填） |
| `POST /api/admin/teachers/:id/exit` | 教师退出 |
| `POST /api/admin/mentors/:id/pause` / `resume` | 导师停带 / 恢复 |
| `GET  /api/admin/waitlist` | 候补名单 |
| `POST /api/admin/waitlist/:id/assign` | 候补补排 `{mentorId}` |
| `GET  /api/admin/audit?entity=&plan=` | 审计链查询 |

教师 / 导师端用个人 token：`Authorization: Bearer <token>`。

| 方法 & 路径 | 说明 |
|---|---|
| `GET /api/me` | 只返回与本人有关的结对、邀请、候补、培养记录 |
| `POST /api/invitations/:id/respond` | `{response: "accepted"|"declined"}`（需 `If-Match`；只能答自己作为一方的邀请） |

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/domain.js` | 状态枚举、双方确认状态推导、原因文案 |
| `src/store.js` | JSON 原子写盘、写操作串行化、只追加审计 |
| `src/matching.js` | 硬约束判定、候选解释、最小费用流最大匹配（锁定/容量/偏好）、草案对比 |
| `src/service.js` | 草案、发布、确认、候补、换导师、退出、停带与版本冲突控制 |
| `src/server.js` | HTTP 路由、管理端/个人端鉴权、ETag 乐观锁 |
