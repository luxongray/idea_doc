use axum::Json;
use axum::extract::State;
use chrono::Local;
use serde::Serialize;

use crate::api::ApiResponse;
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

/// 健康检查返回体
#[derive(Debug, Serialize)]
pub struct HealthInfo {
    /// 服务状态，正常时固定为 ok
    service_status: String,
    /// 数据库连通状态：ok 表示连通，error 表示不可用
    database: String,
    /// 服务名称
    service: String,
    /// 服务版本号
    version: String,
    /// 服务器当前时间（RFC3339 格式）
    timestamp: String,
}

/// 健康检查：返回服务自身与数据库的连通状态
///
/// 无论数据库是否可用都返回 200，用 database 字段区分，
/// 便于前端区分"后端没起来"和"后端起来了但数据库不通"。
///
/// @param state 全局应用状态
/// @return 统一响应结构包裹的健康检查信息
pub async fn health_check(State(state): State<AppState>) -> Json<ApiResponse<HealthInfo>> {
    // 步骤 1：探测数据库连通性，失败不中断接口，只把状态标记为 error
    let database = match db::ping(&state.pool).await {
        Ok(()) => "ok".to_string(),
        Err(err) => {
            tracing::warn!(error = %err, "健康检查发现数据库不可用");
            "error".to_string()
        }
    };

    // 步骤 2：组装健康检查信息并返回
    Json(ApiResponse::ok(HealthInfo {
        service_status: "ok".to_string(),
        database,
        service: state.config.service_name.clone(),
        version: state.config.version.clone(),
        timestamp: Local::now().to_rfc3339(),
    }))
}

/// 数据库连通性探测：数据库不可用时直接返回错误
///
/// @param state 全局应用状态
/// @return 数据库正常时返回 ok 标记
/// @throws AppError 数据库不可达时抛出，由统一错误处理转为 500 响应
pub async fn db_ping(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<&'static str>>, AppError> {
    // 执行最轻量的探测语句，验证连接池到 MySQL 的链路
    db::ping(&state.pool).await?;

    Ok(Json(ApiResponse::ok("ok")))
}
