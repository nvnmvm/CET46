-- Extend administrator audit action values for account editing.
ALTER TABLE admin_audit_logs
  MODIFY COLUMN action ENUM('create_user', 'update_user', 'disable_user', 'enable_user', 'reset_password') NOT NULL;
