# idea_doc

创意文档协作平台。前后端分离架构，前端 React + TypeScript + Vite + Tailwind CSS，后端 Rust + Axum，数据库 MySQL。

## 目录结构

```
idea_doc/
├── frontend/          # 前端工程（pnpm + Vite）
│   └── src/
│       ├── api/       # 接口访问层：统一请求封装与各业务模块的接口定义
│       └── App.tsx    # 应用根组件（当前为初始化联调验证页）
└── backend/           # 后端工程（Cargo 单包）
    └── src/
        ├── main.rs    # 服务入口：配置加载、连接池初始化、路由与中间件装配
        ├── config.rs  # 环境变量配置解析
        ├── db.rs      # MySQL 连接池与连通性探测
        ├── api.rs     # 统一响应结构
        ├── error.rs   # 统一错误类型与 HTTP 错误映射
        ├── state.rs   # 全局应用状态
        └── routes/    # 路由定义与 handler
```

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20 及以上 |
| pnpm | 10 及以上 |
| Rust | 1.85 及以上（edition 2024） |
| MySQL | 8.0 及以上 |

## 快速开始

### 1. 准备数据库

数据库 `idea_doc` 已创建，字符集为 `utf8mb4`，排序规则 `utf8mb4_0900_ai_ci`，完整支持中文与 emoji。

说明：MySQL 的 `CREATE DATABASE` 语法不支持 `COMMENT` 关键字，因此库级中文注释以数据的形式记录在库内的 `db_meta` 表中（`meta_key = 'db.comment'`）。

如需在其它环境重建数据库，执行以下语句即可：

```sql
CREATE DATABASE IF NOT EXISTS `idea_doc`
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_0900_ai_ci;
```

### 2. 启动后端

```bash
cd backend
cp .env.example .env   # 修改 DATABASE_URL 为本地实际的账号密码
cargo run
```

服务默认监听 `http://127.0.0.1:3000`。

### 3. 启动前端

```bash
cd frontend
pnpm install
pnpm dev
```

访问 `http://localhost:5173`，页面会自动调用 `/api/health` 显示后端与数据库的连通状态。
开发环境下 Vite 已配置 `/api` 反向代理到后端，无需额外处理跨域。

## 已有接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回服务与数据库状态，数据库异常时仍返回 200 |
| GET | `/api/db/ping` | 数据库连通性探测，数据库不可用时返回 500 |

统一响应结构：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

`code` 为 0 表示成功；错误码约定：1000 服务内部错误、1001 数据库错误、1002 参数错误、1003 资源不存在。

## 环境变量

后端（`backend/.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVICE_NAME` | `idea-doc-server` | 服务名称 |
| `SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `SERVER_PORT` | `3000` | 监听端口 |
| `DATABASE_URL` | `mysql://root:root@127.0.0.1:3306/idea_doc` | MySQL 连接串 |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许跨域的前端来源 |
| `RUST_LOG` | `idea_doc_backend=debug,tower_http=debug,info` | 日志级别 |

前端（`frontend/.env.local`，可省略）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | 接口基地址，生产环境可指向独立的后端域名 |
