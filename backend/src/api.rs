use serde::Serialize;

/// 后端统一响应结构：所有接口都以此格式返回，前端按同一套规则解包
///
/// @author Luxon
/// @date 2026/10/14
#[derive(Debug, Serialize)]
pub struct ApiResponse<T> {
    /// 业务状态码：0 表示成功，非 0 表示失败
    pub code: i32,
    /// 提示信息：成功固定为 ok，失败为具体错误描述
    pub message: String,
    /// 业务数据，失败时通常为 null
    pub data: Option<T>,
}

// fail 只被错误响应的构造路径调用，测试构建下同理会判成未使用
#[allow(dead_code)]
impl<T> ApiResponse<T> {
    /// 构造一个成功响应
    ///
    /// @param data 需要返回给前端的业务数据
    /// @return 业务码为 0 的成功响应体
    pub fn ok(data: T) -> Self {
        Self {
            code: 0,
            message: "ok".to_string(),
            data: Some(data),
        }
    }

    /// 构造一个失败响应
    ///
    /// @param code    业务错误码
    /// @param message 面向调用方的错误描述
    /// @return 不含业务数据的失败响应体
    pub fn fail(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}
