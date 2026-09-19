-- 001_initial_mysql.sql
--
-- CET 背词站第一批 MySQL 表结构（目标版本 MySQL 8.0+）。
-- InnoDB + utf8mb4；所有时间列都是 DATETIME(3)，由应用层统一写入 UTC 值。
-- 字段命名与 app/src/types.ts 对应；不包含 Supabase / Auth / RLS / PostgreSQL 语法。
--
-- 执行方式：node server/scripts/migrate.ts（由 schema_migrations 记录已应用版本，重复执行安全）。

CREATE TABLE users (
  id            VARCHAR(40)  NOT NULL,
  email         VARCHAR(254) NOT NULL COMMENT '小写规范化后的邮箱',
  password_hash VARCHAR(255) NOT NULL COMMENT 'argon2id 摘要，密码永不明文',
  username      VARCHAR(64)      NULL,
  avatar        VARCHAR(64)      NULL,
  timezone      VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auth_sessions (
  id         VARCHAR(40) NOT NULL,
  user_id    VARCHAR(40) NOT NULL,
  token_hash CHAR(64)    NOT NULL COMMENT '会话 token 的 sha256 十六进制；原文只下发到 HttpOnly Cookie',
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3)     NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_sessions_token_hash (token_hash),
  KEY idx_auth_sessions_user_expires (user_id, expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE words (
  id              VARCHAR(40)   NOT NULL,
  user_id         VARCHAR(40)   NOT NULL,
  normalized_word VARCHAR(190)  NOT NULL COMMENT 'trim + 小写，用于按用户去重',
  word            VARCHAR(190)  NOT NULL,
  phonetic        VARCHAR(190)  NOT NULL DEFAULT '',
  meaning         VARCHAR(2000) NOT NULL DEFAULT '',
  phrase          VARCHAR(1000) NOT NULL DEFAULT '',
  sentence        VARCHAR(2000) NOT NULL DEFAULT '',
  sentence_cn     VARCHAR(2000) NOT NULL DEFAULT '',
  source          VARCHAR(190)  NOT NULL DEFAULT '',
  type            ENUM('marked','added') NOT NULL DEFAULT 'added',
  created_at      DATETIME(3)   NOT NULL,
  updated_at      DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_words_user_normalized (user_id, normalized_word),
  -- 供 word_progress / learning_events 的复合外键引用，保证词条归属一致。
  UNIQUE KEY uq_words_user_id (user_id, id),
  KEY idx_words_user_created (user_id, created_at),
  CONSTRAINT fk_words_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE word_progress (
  id                      VARCHAR(40)      NOT NULL,
  user_id                 VARCHAR(40)      NOT NULL,
  word_id                 VARCHAR(40)      NOT NULL,
  review_stage            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  recognition_score       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  spelling_score          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  first_learned_at        DATETIME(3)          NULL,
  next_review_at          DATETIME(3)      NOT NULL,
  last_review_at          DATETIME(3)          NULL,
  last_recognition_choice ENUM('known','unknown')  NULL,
  last_recognition_result ENUM('correct','wrong')  NULL,
  last_spelling_result    ENUM('correct','wrong')  NULL,
  last_grade              ENUM('again','hard','good','easy') NULL,
  killed_at               DATETIME(3)          NULL,
  last_restored_at        DATETIME(3)          NULL,
  review_count            INT UNSIGNED     NOT NULL DEFAULT 0,
  correct_count           INT UNSIGNED     NOT NULL DEFAULT 0,
  wrong_count             INT UNSIGNED     NOT NULL DEFAULT 0,
  version                 INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT '预留给后续乐观锁',
  created_at              DATETIME(3)      NOT NULL,
  updated_at              DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_word_progress_user_word (user_id, word_id),
  KEY idx_word_progress_user_next_review (user_id, next_review_at),
  KEY idx_word_progress_user_killed (user_id, killed_at),
  -- 复合外键：进度行只能挂在同一用户的词条上，任何跨用户写入都会被数据库拒绝。
  CONSTRAINT fk_word_progress_owner FOREIGN KEY (user_id, word_id)
    REFERENCES words (user_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_word_progress_review_stage CHECK (review_stage BETWEEN 0 AND 6),
  CONSTRAINT chk_word_progress_recognition_score CHECK (recognition_score BETWEEN 0 AND 5),
  CONSTRAINT chk_word_progress_spelling_score CHECK (spelling_score BETWEEN 0 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_events (
  id           VARCHAR(40)      NOT NULL,
  user_id      VARCHAR(40)      NOT NULL,
  word_id      VARCHAR(40)      NOT NULL,
  occurred_at  DATETIME(3)      NOT NULL,
  kind         ENUM('new','review') NOT NULL,
  review_stage TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_learning_events_user_occurred (user_id, occurred_at),
  KEY idx_learning_events_user_word (user_id, word_id),
  CONSTRAINT fk_learning_events_owner FOREIGN KEY (user_id, word_id)
    REFERENCES words (user_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_learning_events_review_stage CHECK (review_stage BETWEEN 0 AND 6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_settings (
  user_id               VARCHAR(40)      NOT NULL,
  daily_target          SMALLINT UNSIGNED NOT NULL DEFAULT 20 COMMENT '沿用现有本地默认值 20，范围 0—100',
  daily_groups          TINYINT UNSIGNED  NOT NULL DEFAULT 2  COMMENT '沿用现有本地默认值 2，范围 1—20',
  daily_group_words     TINYINT UNSIGNED  NOT NULL DEFAULT 10 COMMENT '沿用现有本地默认值 10，范围 1—20',
  timezone              VARCHAR(64)      NOT NULL DEFAULT 'Asia/Shanghai',
  countdown_label       VARCHAR(64)          NULL,
  countdown_target_date DATE                 NULL,
  created_at            DATETIME(3)      NOT NULL,
  updated_at            DATETIME(3)      NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_user_settings_daily_target CHECK (daily_target BETWEEN 0 AND 100),
  CONSTRAINT chk_user_settings_daily_groups CHECK (daily_groups BETWEEN 1 AND 20),
  CONSTRAINT chk_user_settings_daily_group_words CHECK (daily_group_words BETWEEN 1 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
