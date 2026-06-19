# 每日站会闭环管理系统

**standup-tracker** — 一键粘贴晨会文本，AI 自动解析并写入飞书多维表格，进度追踪闭环。

## 效果

```
你的晨会文本
    ↓ 粘贴到 Web UI
AI 自动解析 + 去重写入飞书 Bitable
    ↓
各项目 PM 在进度跟踪页查看/更新/闭环
```

## 快速开始

### 方式一：直接运行

```bash
pip install -r requirements.txt
export FEISHU_APP_ID=cli_xxxxx
export FEISHU_APP_SECRET=xxxxx
export FEISHU_APP_TOKEN=OH03xxxxx
export FEISHU_TABLE_ID=tblxxxxx
export LLM_API_KEY=sk-xxxxx
python app.py
```

打开 http://localhost:8899 即可使用。

### 方式二：Docker 部署

```bash
docker run -d --name standup-tracker \
  -p 8899:8899 \
  -e FEISHU_APP_ID=cli_xxxxx \
  -e FEISHU_APP_SECRET=xxxxx \
  -e FEISHU_APP_TOKEN=OH03xxxxx \
  -e FEISHU_TABLE_ID=tblxxxxx \
  -e LLM_API_KEY=sk-xxxxx \
  -e LLM_BASE_URL=https://api.deepseek.com \
  -e LLM_MODEL=deepseek-chat \
  standup-tracker
```

## 环境变量配置

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | ✅ | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书自建应用 App Secret |
| `FEISHU_APP_TOKEN` | ✅ | Bitable 的 app_token（URL 中 /base/ 后的部分） |
| `FEISHU_TABLE_ID` | ✅ | Bitable 的表 ID（URL 中 ?table= 后的部分） |
| `LLM_API_KEY` | ✅ | LLM API Key（DeepSeek / OpenAI） |
| `LLM_BASE_URL` | | API 地址（默认 https://api.deepseek.com） |
| `LLM_MODEL` | | 模型名（默认 deepseek-chat） |
| `PORT` | | 服务端口（默认 8899） |
| `HOST` | | 监听地址（默认 0.0.0.0） |

## 使用流程

### 1. 晨会录入

粘贴晨会文本 → 填写项目名称、站会日期 → 点击 **AI 解析并写入**。

#### 支持的输入格式

推荐三段式结构：

```
昨日完成：
1. 修复登录超时问题，张三，跟进
   ① 确认超时时间为30秒
   ② 已增加到配置项
2. AI模型更新，学文+俊祺，跟进

今日计划：
1. 二级目录创建，懋鲜+黄翔，跟进
   ① 功能仍处开发阶段

阻塞事项：
1. 测试环境不稳定，小勇，跟进
   -- 容器频繁重启，需运维协助
```

**段落标题支持**：
- 昨日完成：`昨日完成` / `昨日工作` / `已完成` / `上周完成` / `完成事项`
- 今日计划：`今日计划` / `今日工作` / `今日安排` / `今日待办` / `明日计划` / `待办事项`
- 阻塞事项：`阻塞事项` / `阻塞` / `风险` / `问题` / `需要帮助` / `卡点` / `需协调`

**事项格式**：
- `序号. 事项名称，负责人，跟进`
- 子项：`① 子任务描述`（每个子项拆成独立记录）
- 补充说明：`-- 补充描述`
- 负责人：单人用姓名，多人用 `A+B`

#### 去重保护

同一项目 + 同一站会日期 + 同一条事项标题 不会重复写入，避免误操作。

### 2. 进度跟踪

在进度跟踪页筛选条件：
- **项目**：下拉选择（从实际记录实时拉取）
- **站会日期**：按日期范围筛选
- **状态**：待处理 / 处理中 / 待验证 / 已闭环
- **事项搜索**：模糊搜索事项标题和子项描述，支持回车触发查询

列表内可直接编辑：今日进展、下一步计划、风险阻塞 → 勾选 → 批量更新。

双击事项标题可进入详情编辑，修改更多字段。

### 3. 多项目使用

站会表格内置「项目」字段，多个项目共享一张表：

1. **各项目隔离**：录入时指定项目名称，筛选时按项目查看
2. **项目下拉实时刷新**：从实际记录中拉取已有项目列表
3. **全局统计**：按项目+日期统计待处理/处理中/已闭环数量

## Bitable 表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| 事项标题 | Text | 主字段 |
| 项目 | SingleSelect | 项目隔离 |
| 站会日期 | DateTime | 所属晨会日期 |
| 站会环节 | SingleSelect | 昨日完成/今日计划/阻塞事项 |
| 编号 | AutoNumber | 自动编号 |
| 子项描述 | Text | 具体任务 |
| 背景说明 | Text | 补充背景 |
| 分类 | SingleSelect | 问题修复/新功能/配置变更/方案评估 |
| 所属模块 | SingleSelect | 自定义 |
| 优先级 | SingleSelect | P0紧急/P1重要/P2一般/P3低优 |
| 负责人 | User | 责任人 |
| 协作者 | User | 协作人 |
| 当前状态 | SingleSelect | 待处理→处理中→待验证→已闭环 |
| 截止日期 | DateTime | Deadline |
| 今日进展 | Text | 每日更新 |
| 下一步计划 | Text | 下一步行动 |
| 风险阻塞 | Text | 卡点 |
| 是否闭环 | Checkbox | 标记完成 |
| 闭环说明 | Text | 验收结论 |

## 获取飞书凭证

1. 打开飞书开发者后台：https://open.feishu.cn/app
2. 创建企业自建应用 → 添加「多维表格」权限
3. 发布应用后获取 App ID / App Secret
4. 在目标 Bitable 中获取 app_token 和 table_id

## AI 解析说明

- 默认使用 DeepSeek API（需自行申请 Key）
- 也兼容 OpenAI API（设置 `LLM_BASE_URL` 即可）
- 无需 AI Key 时自动降级为规则解析（只能解析标准格式文本）

## 技术栈

- **后端**：Python + FastAPI + uvicorn
- **前端**：原生 HTML + JavaScript（无框架依赖）
- **存储**：飞书 Bitable（多维表格）
- **AI**：DeepSeek / OpenAI API
