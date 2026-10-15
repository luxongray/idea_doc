<div align="center">

<img src="docs/images/editor-overview.png" alt="idea_doc 文档页：左侧文档栏、中间正文与右侧大纲" width="880" />

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
  <a href="#它能做什么">功能</a> ·
  <a href="#当前状态">当前状态</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#接口一览">接口</a>
</p>

</div>

## 这是一个什么项目

idea_doc 不是通用的文档工具，也不是多人协作平台，而是我**个人自用**的一套系统。

它想解决的问题很具体：手上的信息散在好几处——有的来自程序跑出来的结果，有的只是自己随手记下的一句话。分开看每一块都很清楚，合起来却很难看出整体是什么样。

所以这套系统的形态是：**内部是一套系统，对外呈现却是一份文档。**

- 各种「程序」负责把各自那部分数据算出来、存进数据库（这些程序都规划在同一个后端工程里，目前还没有开始写）；
- 数据库里的数据被组织成**一篇篇可以随时编辑的文档**，供我随时翻阅与补充。

一句话概括：**程序负责「算」，文档负责「呈现」。**

之所以选文档而不是一堆报表或看板，是因为报表擅长回答「某个数字是多少」，却很难回答「现在整体是什么情况」。而且文档是活的：程序还没覆盖到的部分，我可以随手补两笔；程序算出来的结果，我也可以直接在旁边写一句说明。

使用者只有我一个人，因此没有账号、权限与协作，一切都按「一个人用着顺手」来设计。

## 它能做什么

**多篇文档**：左侧是文档栏，用来新建、改名、删除，也可以直接拖拽调整顺序。每篇文档的内容相互独立，打开哪篇就编辑哪篇。

**正文编辑**：正文就是可以直接打字的地方，所见即所得，不需要记语法。标题分 1 ~ 6 级，右侧会自动生成大纲。

- **标题与大纲** — 大纲按标题层级生成，可逐级折叠展开；滚动时高亮当前读到的位置，点一下就能跳过去
- **行内染色** — 一行里可以只给某一小段文字染色（红 / 蓝 / 绿 / 黄），用来标重点；标题不参与染色
- **块级编辑** — 回车在光标处拆出一行，行首退格并入上一行，行尾删除并入下一行，跨行选中与跨行删除同样支持
- **富文本粘贴** — 从网页复制来的标题与彩色文字，粘进来会保留原来的层级与颜色
- **撤销 / 重做** — 标题级别、染色、换行等操作都能撤销，连续打字会合并成一步

**自动保存**：改完不用点保存，内容会自己存进数据库，右下角有「正在保存 / 已保存 / 保存失败」的提示。切换文档、关闭页面都会把最后的内容落实——即使直接关掉标签页，后端也会在心跳超时后把内容落库，不会丢。

<img src="docs/images/editor-headings.png" alt="一到六级标题与右侧大纲的层级关系" width="880" />

常用快捷键：

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl` + `Alt` + `1` ~ `6` | 把当前行设为对应级别的标题；已在同级标题上再按一次则退回普通文字；选区跨多行时，所有被选中的行统一设为该级别 |
| `Ctrl` + `Alt` + `R` / `B` / `G` / `Y` | 把选中文字染成红 / 蓝 / 绿 / 黄 |
| `Ctrl` + `Z` / `Ctrl` + `Shift` + `Z` | 撤销 / 重做 |
| `Enter` | 在光标处拆成新的一行 |
| `Backspace` / `Delete` | 行首退格并入上一行 / 行尾删除并入下一行 |

## 当前状态

项目还在早期，但**文档这一层已经可以真正用起来了**：多篇文档、正文编辑、自动保存、数据落库都已经打通，建好库打开页面就能写。

| 状态 | 内容 |
| --- | --- |
| ✅ | 多篇文档：新建、改名、删除（逻辑删除，内容仍保留）、拖拽排序 |
| ✅ | 正文编辑与呈现：标题与大纲、行内染色、撤销重做、富文本粘贴 |
| ✅ | 自动保存：编辑期定时同步，切换文档 / 关闭页面立即落库，服务退出前兜底 |
| ✅ | 数据落库：文档与正文块存进 MySQL，建表与示例数据脚本在 `sql/` |
| 🚧 | 「程序」层：目前内容只能靠手写，还没有来自程序的数据 |
| 🚧 | 更多块类型：现在只有标题与普通文字两类，图片、代码块、表格都还没有 |

README 会随着代码的提交逐步补充，这里描述的只是当下的样子。

## 技术构成

| 部分 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS v4（包管理用 pnpm） |
| 后端 | Rust + Axum + sqlx（tokio 运行时） |
| 数据库 | MySQL 8（`utf8mb4`） |

前后端分离。开发期由 Vite 把 `/api` 开头的请求反向代理到后端，因此本地不需要额外处理跨域。

## 目录结构

```
idea_doc/
├── docs/images/   # README 引用的截图
├── sql/           # 建表脚本与示例数据
├── frontend/      # 前端：React + TypeScript + Vite + Tailwind CSS
└── backend/       # 后端：Rust + Axum，接口与后续的「程序」都放在这里
```

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20 及以上 |
| pnpm | 10 及以上 |
| Rust | 1.85 及以上（edition 2024） |
| MySQL | 8.0 及以上 |

## 快速开始

### 1. 建库并导入脚本

```bash
mysql -u root -p < sql/01_schema.sql
mysql -u root -p < sql/02_sample_data.sql   # 可选：导入一份示例文档
```

脚本会创建 `idea_doc` 库和所需的表，字符集为 `utf8mb4`，完整支持中文与 emoji。

### 2. 启动后端

```bash
cd backend
cp .env.example .env   # 把 DATABASE_URL 改成自己的账号密码
cargo run
```

服务默认监听 `http://127.0.0.1:3000`，其余可配置项见 `backend/.env.example`。

### 3. 启动前端

```bash
cd frontend
pnpm install
pnpm dev
```

前端启动后会自动打开浏览器进入 `http://localhost:5173`。文档列表与内容都来自数据库，所以需要后端已经跑起来。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务与数据库的健康状态 |
| GET | `/api/db/ping` | 数据库连通性探测 |
| GET | `/api/documents` | 文档列表 |
| POST | `/api/documents` | 新建文档 |
| PUT | `/api/documents/order` | 按提交的顺序重排文档 |
| GET | `/api/documents/{id}` | 读取单篇文档（含全部内容块） |
| PATCH | `/api/documents/{id}` | 修改文档标题 |
| DELETE | `/api/documents/{id}` | 逻辑删除文档 |
| PUT | `/api/documents/{id}/snapshot` | 推送全文快照，可要求立即落库 |
| POST | `/api/documents/{id}/heartbeat` | 编辑期心跳，超时后由后端落库 |

所有接口统一返回 `{ code, message, data }`，`code` 为 `0` 表示成功。

> 没有单独的「保存」接口：编辑期间的内容先同步到后端，切换文档或离开页面时才真正写进数据库。

## License

[MIT](LICENSE) © 2026 luxongray
