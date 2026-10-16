use axum::Router;
use axum::routing::{get, post, put};

use crate::state::AppState;

mod document;
mod document_version;
mod health;

/// 装配全部 HTTP 路由
///
/// @param state 全局应用状态，供各 handler 读取连接池、配置与草稿缓存
/// @return 已注册所有接口、可直接交给 axum::serve 的路由
pub fn router(state: AppState) -> Router {
    Router::new()
        // 健康检查：返回服务与数据库的连通状态
        .route("/api/health", get(health::health_check))
        // 数据库连通性探测：数据库不可用时返回明确错误
        .route("/api/db/ping", get(health::db_ping))
        // 文档列表与新建
        .route(
            "/api/documents",
            get(document::list_documents).post(document::create_document),
        )
        // 拖拽重排：静态路径要写在 {id} 之前，匹配优先级更明确
        .route("/api/documents/order", put(document::reorder_documents))
        // 单篇文档的读取、改名与逻辑删除
        .route(
            "/api/documents/{id}",
            get(document::get_document)
                .patch(document::rename_document)
                .delete(document::delete_document),
        )
        // 编辑期推送全文快照，flush = true 时同时落库
        .route("/api/documents/{id}/snapshot", put(document::save_snapshot))
        // 编辑期心跳，超时未收到则由后台任务落库
        .route("/api/documents/{id}/heartbeat", post(document::heartbeat))
        // 手动版本链、历史内容、当前差异与恢复草稿。
        .route(
            "/api/documents/{id}/versions",
            get(document_version::list).post(document_version::commit),
        )
        .route(
            "/api/documents/{id}/versions/{version}",
            get(document_version::get),
        )
        .route(
            "/api/documents/{id}/versions/{version}/diff",
            post(document_version::diff),
        )
        .route(
            "/api/documents/{id}/versions/{version}/restore",
            post(document_version::restore),
        )
        .with_state(state)
}
