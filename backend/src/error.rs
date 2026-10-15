use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::api::ApiResponse;

/// 业务错误类型：把底层异常统一收敛为可返回给前端的错误
///
/// 骨架阶段部分错误变体尚未被业务代码调用，先抑制死代码告警，
/// 后续接入具体业务接口后会自然被使用。
///
/// @author Luxon
/// @date 2026/10/14
#[allow(dead_code)]
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 数据库访问异常，通常由 sqlx 抛出
    #[error("数据库操作失败：{0}")]
    Database(#[from] sqlx::Error),

    /// 请求参数不合法，由业务层主动抛出
    #[error("{0}")]
    BadRequest(String),

    /// 请求的资源不存在
    #[error("{0}")]
    NotFound(String),

    /// 未预期的服务端异常
    #[error("{0}")]
    Internal(String),
}

// 测试构建下不会走到 HTTP 响应转换这条链路，状态码与业务码映射会被判成未使用
#[allow(dead_code)]
impl AppError {
    /// 映射为对应的 HTTP 状态码
    ///
    /// @return 该错误应返回的 HTTP 状态码
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// 映射为对外的业务错误码，便于前端按码分支处理
    ///
    /// @return 业务错误码：1001 数据库、1002 参数、1003 资源不存在、1000 其他
    fn business_code(&self) -> i32 {
        match self {
            AppError::Database(_) => 1001,
            AppError::BadRequest(_) => 1002,
            AppError::NotFound(_) => 1003,
            AppError::Internal(_) => 1000,
        }
    }
}

impl IntoResponse for AppError {
    /// 把业务错误转换为统一的 JSON 响应，同时记录服务端日志
    ///
    /// @return 携带统一响应结构的 HTTP 响应
    fn into_response(self) -> Response {
        // 步骤 1：服务端内部错误需要留下日志，方便排查
        tracing::error!(error = %self, "请求处理失败");

        // 步骤 2：按错误类型映射状态码与业务码，组装统一响应体
        let status = self.status_code();
        let body = ApiResponse::<()>::fail(self.business_code(), self.to_string());

        (status, Json(body)).into_response()
    }
}
