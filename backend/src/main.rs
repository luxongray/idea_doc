use std::sync::Arc;

use anyhow::Context;
use axum::http::{HeaderValue, Method, header};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::AppConfig;
use crate::state::AppState;

mod api;
mod config;
mod db;
mod error;
mod routes;
mod state;

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

    // 步骤 4：组装全局状态，使用 Arc 共享配置避免每个请求重复克隆
    let state = AppState {
        pool,
        config: Arc::new(app_config.clone()),
    };

    // 步骤 5：装配路由，并附加请求日志与跨域中间件
    // 注意：CorsLayer 最后添加，保证处于最外层，能正确处理浏览器的预检请求
    let app = routes::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(build_cors_layer(&app_config)?);

    // 步骤 6：绑定端口并启动服务
    let listener = tokio::net::TcpListener::bind(&bind_address)
        .await
        .with_context(|| format!("端口绑定失败，请确认 {bind_address} 未被占用"))?;
    tracing::info!(
        service = %app_config.service_name,
        version = %app_config.version,
        "服务已启动，监听地址 http://{bind_address}"
    );

    axum::serve(listener, app).await.context("HTTP 服务异常退出")?;

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
                .with_context(|| format!("跨域来源配置非法：{origin}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    // 步骤 2：放行配置的来源与常用方法与请求头，并允许携带凭证
    Ok(CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
        ])
        .allow_credentials(true))
}
