use std::sync::Arc;

use sqlx::MySqlPool;

use crate::config::AppConfig;

/// 全局应用状态：由 axum 在请求处理时注入到各个 handler
///
/// @author Luxon
/// @date 2026/10/14
#[derive(Clone)]
pub struct AppState {
    /// MySQL 连接池，所有数据库访问都通过它进行
    pub pool: MySqlPool,
    /// 服务配置，使用 Arc 共享避免每次克隆完整配置
    pub config: Arc<AppConfig>,
}
