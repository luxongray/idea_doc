use axum::Router;
use axum::routing::get;

use crate::state::AppState;

mod health;

/// 装配全部 HTTP 路由
///
/// @param state 全局应用状态，供各 handler 读取连接池与配置
/// @return 已注册所有接口、可直接交给 axum::serve 的路由
pub fn router(state: AppState) -> Router {
    Router::new()
        // 健康检查：返回服务与数据库的连通状态
        .route("/api/health", get(health::health_check))
        // 数据库连通性探测：数据库不可用时返回明确错误
        .route("/api/db/ping", get(health::db_ping))
        .with_state(state)
}
