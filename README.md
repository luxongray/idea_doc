<div align="center">

<img src="docs/images/editor-overview.png" alt="idea_doc 文档页：正文与右侧大纲" width="880" />

<h1>idea_doc</h1>

<p><b>内里是一套系统，外面看起来是一份文档。</b></p>

<p>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vite.dev"><img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-2024_edition-000000?logo=rust&logoColor=white" alt="Rust" /></a>
  <a href="https://github.com/tokio-rs/axum"><img src="https://img.shields.io/badge/Axum-0.8-DEA584" alt="Axum" /></a>
  <a href="https://www.mysql.com"><img src="https://img.shields.io/badge/MySQL-8-4479A1?logo=mysql&logoColor=white" alt="MySQL" /></a>
  <a href="#当前状态"><img src="https://img.shields.io/badge/status-early_stage-orange" alt="Status: early stage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT" /></a>
</p>

<p>
  <a href="#这是一个什么项目">项目定位</a> ·
  <a href="#文档能做什么">文档能力</a> ·
  <a href="#当前状态">当前状态</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#已有接口">接口</a>
</p>

</div>

## 这是一个什么项目

idea_doc 不是通用的文档工具，也不是多人协作平台，而是我**个人自用**的一套系统。

它比较特别的地方在于：**内部是一套系统，对外呈现却是一份文档。**

- 系统由若干「程序」组成，每个程序负责自己那一块数据的采集与维护（目前这些程序都计划放在同一个后端工程里）；
- 这些程序产出的数据，最终被组织成**一份可以随时编辑的文档**呈现出来。

所以可以简单地理解为：**程序负责「算」，文档负责「呈现」。**

之所以选择用文档而不是一堆报表或面板，是因为分开看每一块信息都很清楚，合起来却很难建立整体感。一篇能从头读到尾、又能随手补两笔的文档，既能让人看到全局，也容得下那些还没有被程序覆盖的临时想法。

使用者只有我一个人，因此不存在账号与权限体系。

## 文档能做什么

正文是一整块可编辑区域，内容按「块」组织。目前支持两类块：**标题**（1 ~ 6 级，自动进入大纲）与**普通文字**（一行文字，可以只给其中某一段染色）。

- **标题与大纲** — 右侧大纲按层级自动生成，可逐级折叠 / 展开，滚动时高亮当前所在位置，点击可直接跳到对应标题，标题会精确对齐到视口顶部
- **行内染色** — 一行之内可以只给某一小段染色（红 / 蓝 / 绿 / 黄），同色再按一次即恢复成普通颜色，改按别的颜色即换色；标题不参与染色
- **块级编辑** — 回车在光标处拆出一行、行首退格并入上一行、行尾删除并入下一行，跨块选中与跨块删除同样支持
- **富文本粘贴** — 从其它网页复制来的标题与彩色文字，粘贴进来会保留原来的层级与颜色
- **撤销 / 重做** — 标题级别调整、染色、换行等操作都在撤销范围内，连续打字则会合并成一步撤销

<img src="docs/images/editor-headings.png" alt="一到六级标题与大纲的层级关系" width="880" />

常用快捷键：

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl` + `Alt` + `1` ~ `6` | 把当前行设为对应级别的标题；已在同级标题上再按一次则退回普通文字；选区跨多行时，所有被选中的行统一设为该级别 |
| `Ctrl` + `Alt` + `R` / `B` / `G` / `Y` | 把选中文字染成红 / 蓝 / 绿 / 黄 |
| `Ctrl` + `Z` / `Ctrl` + `Shift` + `Z` | 撤销 / 重做 |
| `Enter` | 在光标处拆成新的一行 |
| `Backspace` / `Delete` | 行首退格并入上一行 / 行尾删除并入下一行 |

## 当前状态

项目还处在早期，目前完成的是**文档这一层**，也就是前面说的「呈现」部分。

| 状态 | 内容 |
| --- | --- |
| ✅ | 前端文档页的全部编辑与呈现能力（见上一节） |
| ✅ | 后端服务骨架：配置加载、MySQL 连接池、统一响应与错误结构、跨域与请求日志 |
| ✅ | 数据库 `idea_doc` 已建好，字符集为 `utf8mb4` |
| 🚧 | 文档内容**还没有落库**，页面读的是本地示例数据，刷新后会回到初始内容 |
| 🚧 | 文档相关的读写接口（后端目前只有健康检查与数据库连通性两个接口） |
| 🚧 | 「程序」层本身，也就是前面说的那套数据来源 |

README 会随着代码的提交逐步补充，这里描述的只是当下的样子。

## 技术构成

| 部分 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS v4（包管理用 pnpm） |
| 后端 | Rust + Axum + sqlx（tokio 运行时） |
| 数据库 | MySQL 8（`utf8mb4`） |

前后端分离。开发期由 Vite 把 `/api` 开头的请求反向代理到后端，因此无需额外处理跨域。

## 目录结构

```
idea_doc/
├── docs/
│   └── images/                   # README 引用的截图
├── frontend/                     # 前端工程（pnpm + Vite）
│   └── src/
│       ├── api/                  # 接口访问层：统一请求封装与各业务模块的接口定义
│       ├── components/           # 页面组件：文档编辑器、右侧大纲
│       ├── data/                 # 示例文档数据（接口接通前的占位）
│       ├── hooks/                # 编辑器相关 Hook：块状态与撤销栈、各类快捷键
│       ├── pages/                # 页面：文档页（正文 + 大纲的整体布局）
│       ├── types/                # 文档领域类型：块、文字片段、颜色、标题层级
│       ├── utils/                # 纯逻辑工具：块模型、选区换算、剪切板解析、大纲构建
│       ├── App.tsx               # 应用根组件
│       └── main.tsx              # 前端入口
└── backend/                      # 后端工程（Cargo 单包）
    └── src/
        ├── main.rs               # 服务入口：配置加载、连接池初始化、路由与中间件装配
        ├── config.rs             # 环境变量配置解析
        ├── db.rs                 # MySQL 连接池与连通性探测
        ├── api.rs                # 统一响应结构
        ├── error.rs              # 统一错误类型与 HTTP 错误映射
        ├── state.rs              # 全局应用状态
        └── routes/               # 路由定义与 handler
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

启动后会自动打开浏览器并进入文档页面（`http://localhost:5173`）。页面当前读的是本地示例数据，因此后端没有启动也能正常浏览，只是接口相关的功能不可用。

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

前端已封装好统一的请求层（`frontend/src/api/`），会自动解包上面的结构并在失败时抛出 `ApiError`，新增接口时只需按模块补充调用函数。

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

## License

[MIT](LICENSE) © 2026 luxongray
