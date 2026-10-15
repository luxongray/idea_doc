use std::env;

use anyhow::Context;

/// 服务运行配置，全部来源于环境变量（可写在 backend/.env 中）
///
/// @author Luxon
/// @date 2026/10/14
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// 服务名称，用于健康检查与日志展示
    pub service_name: String,
    /// 服务版本号，取自 Cargo 包版本
    pub version: String,
    /// HTTP 服务监听地址
    pub server_host: String,
    /// HTTP 服务监听端口
    pub server_port: u16,
    /// MySQL 连接串，格式：mysql://用户名:密码@主机:端口/库名
    pub database_url: String,
    /// 允许跨域访问的前端来源，多个以英文逗号分隔
    pub cors_origins: Vec<String>,
}

impl AppConfig {
    /// 从环境变量读取并组装服务配置，缺项时使用默认值
    ///
    /// @return 组装完成的配置对象；关键配置非法时返回错误
    pub fn from_env() -> anyhow::Result<Self> {
        // 步骤 1：读取数据库连接串，这是唯一没有默认值的必填项
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "mysql://root:root@127.0.0.1:3306/idea_doc".to_string());

        // 步骤 2：读取监听地址与端口，端口非法时直接启动失败而不是静默降级
        let server_host = env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let server_port = env::var("SERVER_PORT")
            .unwrap_or_else(|_| "3000".to_string())
            .parse::<u16>()
            .context("环境变量 SERVER_PORT 必须是 0-65535 之间的整数")?;

        // 步骤 3：读取允许跨域的前端来源，按逗号切分并去掉空白项
        let cors_origins = env::var("CORS_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:5173,http://127.0.0.1:5173".to_string())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(str::to_string)
            .collect();

        Ok(Self {
            service_name: env::var("SERVICE_NAME")
                .unwrap_or_else(|_| "idea-doc-server".to_string()),
            version: env::var("CARGO_PKG_VERSION")
                .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string()),
            server_host,
            server_port,
            database_url,
            cors_origins,
        })
    }

    /// 拼接 HTTP 服务监听地址
    ///
    /// @return 形如 127.0.0.1:3000 的监听地址
    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.server_host, self.server_port)
    }
}
