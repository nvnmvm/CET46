-- 002_learning_workflow_mysql.sql
-- 第二批学习业务：草稿与完成提交幂等记录。
-- 仅使用 MySQL 8 / InnoDB / utf8mb4；时间由应用写入 UTC DATETIME(3)。
-- 不修改或删除 001，不包含 DROP/TRUNCATE，不连接真实数据。

CREATE TABLE IF NOT EXISTS review_drafts (
  id            VARCHAR(40)  NOT NULL,
  user_id       VARCHAR(40)  NOT NULL,
  draft_key     VARCHAR(64)  NOT NULL,
  version       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  mode          ENUM('all','new','review','spell') NULL,
  scope         ENUM('daily','library') NULL,
  phase         ENUM('learning','recognition','summary','spelling') NULL,
  payload_json  JSON         NOT NULL,
  revision      INT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_drafts_user_key (user_id, draft_key),
  KEY idx_review_drafts_user_updated (user_id, updated_at),
  CONSTRAINT fk_review_drafts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS review_submissions (
  id              VARCHAR(40)  NOT NULL,
  user_id         VARCHAR(40)  NOT NULL,
  submission_key  VARCHAR(64)  NOT NULL,
  kind            ENUM('new','review','spelling') NOT NULL,
  result_json     JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_submissions_user_key (user_id, submission_key),
  KEY idx_review_submissions_user_created (user_id, created_at),
  CONSTRAINT fk_review_submissions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 为忠实复现 localStore：只有显式设置 dailyGroups/dailyGroupWords 后，
-- 每日新词上限才切换为“组数 × 每组词数”；默认仍使用 dailyTarget。
-- 该 ALTER 使用 information_schema 守卫，可安全重复执行。
SET @has_daily_plan_configured := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'user_settings'
    AND column_name = 'daily_plan_configured'
);
SET @add_daily_plan_configured_sql := IF(
  @has_daily_plan_configured = 0,
  'ALTER TABLE user_settings ADD COLUMN daily_plan_configured TINYINT(1) NOT NULL DEFAULT 0 AFTER daily_group_words',
  'SELECT 1'
);
PREPARE add_daily_plan_configured_stmt FROM @add_daily_plan_configured_sql;
EXECUTE add_daily_plan_configured_stmt;
DEALLOCATE PREPARE add_daily_plan_configured_stmt;
