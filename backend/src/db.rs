use std::time::Duration;

use anyhow::Context;
use sqlx::MySqlPool;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};

/// 数据库会话时区
///
/// sqlx 默认把会话时区设成 UTC，于是数据库写出的 CURRENT_TIMESTAMP 是 UTC 时间，
/// 与日常看到的墙上时间差 8 小时（下午 3 点会被存成早上 7 点）。
/// 这里显式改成本地时区，让 created_at / updated_at 存的就是本地时间。
const DB_TIMEZONE: &str = "+08:00";

/// 创建 MySQL 连接池
///
/// 在服务启动阶段调用，连接失败会让进程直接退出，避免带病运行。
///
/// @param database_url MySQL 连接串，格式：mysql://用户名:密码@主机:端口/库名
/// @return 可复用的 MySQL 连接池
/// @throws anyhow::Error 连接串非法或数据库不可达时抛出
pub async fn init_pool(database_url: &str) -> anyhow::Result<MySqlPool> {
    // 步骤 1：解析连接串并覆盖会话时区，避免库里存下 UTC 时间
    let options = database_url
        .parse::<MySqlConnectOptions>()
        .context("DATABASE_URL 格式非法，请检查 backend/.env")?
        .timezone(Some(DB_TIMEZONE.to_string()));

    // 步骤 2：按业务预期配置连接池容量与超时，避免请求堆积时无限等待
    let pool = MySqlPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(600))
        .connect_with(options)
        .await
        .context("连接 MySQL 失败，请检查 backend/.env 中的 DATABASE_URL 是否正确")?;

    Ok(pool)
}

/// 探测数据库是否可用
///
/// 执行一条最轻量的 SQL，仅用于健康检查。
///
/// @param pool MySQL 连接池
/// @return 数据库可正常响应时返回 Ok
/// @throws sqlx::Error 连接不可用或查询失败时抛出
pub async fn ping(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    // SELECT 1 不触碰任何业务表，只验证连接链路是否通畅
    sqlx::query("SELECT 1").execute(pool).await?;
    Ok(())
}
