-- 003_admin_accounts_mysql.sql
-- 最小管理员账号管理：角色、禁用状态与不含密码/学习内容的操作审计。
-- 仅使用 MySQL 8 / InnoDB / utf8mb4；由 server/scripts/migrate.ts 记录一次应用。

ALTER TABLE users
  ADD COLUMN role ENUM('admin', 'learner') NOT NULL DEFAULT 'learner' AFTER avatar,
  ADD COLUMN disabled_at DATETIME(3) NULL AFTER role,
  ADD KEY idx_users_role_disabled (role, disabled_at);

CREATE TABLE admin_audit_logs (
  id              VARCHAR(40) NOT NULL,
  actor_user_id   VARCHAR(40) NOT NULL,
  target_user_id  VARCHAR(40) NOT NULL,
  action          ENUM('create_user', 'update_user', 'disable_user', 'enable_user', 'reset_password') NOT NULL,
  created_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_admin_audit_actor_created (actor_user_id, created_at),
  KEY idx_admin_audit_target_created (target_user_id, created_at),
  CONSTRAINT fk_admin_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_admin_audit_target FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
