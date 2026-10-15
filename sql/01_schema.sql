-- =============================================================
-- idea_doc 数据库结构
--
-- 用途：从零重建 idea_doc 库的表结构，脚本可重复执行。
-- 执行：mysql -u root -p < sql/01_schema.sql
--
-- 全局约定：
--   1. 统一 utf8mb4，完整支持中文与 emoji；
--   2. 主键统一使用 INT 自增，值由数据库生成，业务侧不指定；
--   3. 表名、字段名一律 snake_case，每张表与每个字段都带中文注释；
--   4. 不使用物理外键，表与表之间的关联由应用层保证；
--   5. 枚举类字段用 TINYINT 表示，取值含义写在该字段的注释里；
--   6. 时间字段不使用数据库的自动机制，统一由应用层写入北京时间
--      （后端连接的会话时区固定为 +08:00，因此 NOW() 取到的就是北京时间）。
-- =============================================================

SET NAMES utf8mb4;

-- 建库。MySQL 的 CREATE DATABASE 不支持 COMMENT 关键字，
-- 因此库级中文说明以数据的形式记录在库内的 db_meta 表（meta_key = 'db.comment'）。
CREATE DATABASE IF NOT EXISTS `idea_doc`
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `idea_doc`;

-- -------------------------------------------------------------
-- db_meta：数据库元信息表
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `db_meta` (
    `meta_key`   VARCHAR(64)  NOT NULL COMMENT '元数据键，如 db.comment 表示库中文注释',
    `meta_value` VARCHAR(512) NOT NULL COMMENT '元数据值，如库的中文名称与用途说明',
    `updated_at` DATETIME     NOT NULL COMMENT '记录更新时间，由应用层写入北京时间',
    PRIMARY KEY (`meta_key`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COMMENT = '数据库元信息表：存放 idea_doc 库自身的中文注释与说明';

-- 库级注释只在不存在时写入，避免覆盖手工维护过的说明
INSERT IGNORE INTO `db_meta` (`meta_key`, `meta_value`, `updated_at`)
VALUES ('db.comment', 'idea_doc —— 创意文档协作平台业务库，统一存放用户、项目、文档等业务数据', NOW());

-- -------------------------------------------------------------
-- doc：文档主表
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `doc` (
    `id`         INT          NOT NULL AUTO_INCREMENT COMMENT '文档主键，自增',
    `title`      VARCHAR(255) NOT NULL COMMENT '文档标题',
    `sort_order` INT          NOT NULL DEFAULT 0 COMMENT '文档在侧边栏中的排列序号，越小越靠前，由拖拽排序维护',
    `is_deleted` TINYINT      NOT NULL DEFAULT 0 COMMENT '逻辑删除：0 未删除，1 已删除',
    `created_at` DATETIME     NOT NULL COMMENT '创建时间，由应用层写入北京时间',
    `updated_at` DATETIME     NOT NULL COMMENT '最近更新时间，由应用层写入北京时间；仅标题或正文变更时刷新',
    PRIMARY KEY (`id`),
    KEY `idx_deleted_sort` (`is_deleted`, `sort_order`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COMMENT = '文档：一篇文档一行，删除采用逻辑删除，展示顺序由 sort_order 决定';

-- -------------------------------------------------------------
-- doc_block：文档块表
--
-- 正文由一个个按顺序排列的块组成，一个块占一行：
--   block_type = 1 标题    -> level、text 有值，segments 为 NULL
--   block_type = 2 普通文字 -> segments、text 有值，level 为 NULL
-- 后续新增图片、代码块、表格等类型时，只需为 block_type 追加取值。
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `doc_block` (
    `id`         INT         NOT NULL AUTO_INCREMENT COMMENT '块主键，自增',
    `doc_id`     INT         NOT NULL COMMENT '所属文档 id，关联 doc.id（不加物理外键，由应用层保证）',
    `sort_index` INT         NOT NULL COMMENT '块在文档中的顺序，从 0 起连续递增',
    `block_type` TINYINT     NOT NULL COMMENT '块类型：1 标题，2 普通文字',
    `level`      TINYINT     NULL COMMENT '标题层级 1~6，仅标题块有值，其余为 NULL',
    `text`       TEXT        NULL COMMENT '块的纯文本内容；标题块必填，普通文字块冗余一份便于检索与生成大纲',
    `segments`   JSON        NULL COMMENT '普通文字块的行内片段数组（含颜色），仅普通文字块有值',
    `created_at` DATETIME    NOT NULL COMMENT '创建时间，由应用层写入北京时间',
    `updated_at` DATETIME    NOT NULL COMMENT '最近更新时间，由应用层写入北京时间',
    PRIMARY KEY (`id`),
    KEY `idx_doc_sort` (`doc_id`, `sort_index`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COMMENT = '文档块：一个块一行，顺序由 sort_index 表达';
