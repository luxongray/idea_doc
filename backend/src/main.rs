use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::http::{HeaderValue, Method, header};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::AppConfig;
use crate::drafts::DraftStore;
use crate::state::AppState;

mod api;
mod config;
mod db;
mod document;
mod drafts;
mod error;
mod routes;
mod state;

/// 草稿空闲超时：超过这段时间没有收到前端心跳，就认为前端已经关闭
const DRAFT_IDLE_TIMEOUT: Duration = Duration::from_secs(8);

/// 后台扫描草稿的间隔，略小于超时时间，保证断开后能较快落库
const DRAFT_SWEEP_INTERVAL: Duration = Duration::from_secs(2);

/// 服务入口：加载配置、初始化连接池、装配路由并启动 HTTP 服务
///
/// @return 进程正常退出时返回 Ok，启动或运行期失败时返回错误
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 步骤 1：加载 .env 环境变量并初始化日志输出
    dotenvy::dotenv().ok();
    init_tracing();

    // 步骤 2：读取服务配置，配置非法时在启动阶段就暴露问题
    let app_config = AppConfig::from_env()?;
    let bind_address = app_config.bind_address();

    // 步骤 3：建立 MySQL 连接池，失败则直接退出，避免带病启动
    let pool = db::init_pool(&app_config.database_url).await?;
    tracing::info!("MySQL 连接池初始化完成");

    // 步骤 4：组装全局状态，使用 Arc 共享配置与草稿缓存
    let state = AppState {
        pool,
        config: Arc::new(app_config.clone()),
        drafts: Arc::new(DraftStore::new()),
    };

    // 步骤 5：启动后台任务，负责把心跳超时的草稿落库
    spawn_draft_sweeper(state.clone());

    // 步骤 6：装配路由，并附加请求日志与跨域中间件
    // 注意：CorsLayer 最后添加，保证处于最外层，能正确处理浏览器的预检请求
    let app = routes::router(state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(build_cors_layer(&app_config)?);

    // 步骤 7：绑定端口并启动服务，收到退出信号后先关服务再处理残留草稿
    let listener = tokio::net::TcpListener::bind(&bind_address)
        .await
        .with_context(|| format!("端口绑定失败，请确认 {bind_address} 未被占用"))?;
    tracing::info!(
        service = %app_config.service_name,
        version = %app_config.version,
        "服务已启动，监听地址 http://{bind_address}"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP 服务异常退出")?;

    // 步骤 8：退出前把还留在内存里的草稿落库，避免重启丢数据
    flush_pending_drafts(&state).await;

    Ok(())
}

/// 初始化日志订阅器
///
/// 优先读取 RUST_LOG 环境变量，未设置时使用适合本地开发的默认级别。
fn init_tracing() {
    // 默认只打开本项目与 HTTP 中间件的调试日志，避免第三方库日志刷屏
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("idea_doc_backend=debug,tower_http=debug,info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

/// 根据配置构建跨域中间件
///
/// @param config 服务配置，其中 cors_origins 为允许访问的前端来源
/// @return 配置完成的跨域中间件
/// @throws anyhow::Error 来源地址格式非法时抛出
fn build_cors_layer(config: &AppConfig) -> anyhow::Result<CorsLayer> {
    // 步骤 1：把配置中的来源字符串解析为合法的请求头取值，非法配置直接启动失败
    let origins = config
        .cors_origins
        .iter()
        .map(|origin| {
            origin
                .parse::<HeaderValue>()
                .with_context(|| format!("跨域来源非法：{origin}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    // 步骤 2：放行配置的来源与常用方法与请求头，并允许携带凭证
    Ok(CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
        ])
        .allow_credentials(true))
}

/// 启动草稿落库后台任务
///
/// 每隔 DRAFT_SWEEP_INTERVAL 检查一次缓存：若某份草稿已有 DRAFT_IDLE_TIMEOUT
/// 没有收到心跳，说明前端已经关闭或异常断开，此时把快照整体写回数据库。
///
/// @param state 全局应用状态
fn spawn_draft_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(DRAFT_SWEEP_INTERVAL);

        loop {
            ticker.tick().await;

            let Some(draft) = state.drafts.take_stale(DRAFT_IDLE_TIMEOUT) else {
                continue;
            };

            tracing::info!(
                doc_id = draft.doc_id,
                "前端心跳已超时，开始把草稿落库"
            );

            if let Err(err) = document::persist(&state.pool, &draft).await {
                tracing::error!(
                    doc_id = draft.doc_id,
                    error = %err,
                    "心跳超时草稿落库失败"
                );
            }
        }
    });
}

/// 等待进程退出信号
///
/// 目前只监听 Ctrl+C，收到后停止接收新请求，进入收尾流程。
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("收到退出信号，准备关闭服务");
}

/// 把内存中尚未落库的草稿全部写回数据库
///
/// @param state 全局应用状态
async fn flush_pending_drafts(state: &AppState) {
    while let Some(draft) = state.drafts.take_any() {
        match document::persist(&state.pool, &draft).await {
            Ok(()) => tracing::info!(doc_id = draft.doc_id, "退出前草稿已落库"),
            Err(err) => {
                tracing::error!(doc_id = draft.doc_id, error = %err, "退出前草稿落库失败")
            }
        }
    }
}
