#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
BACKUP_ROOT="${BACKUP_ROOT:-$SCRIPT_DIR/backups}"

if [ ! -f "$ENV_FILE" ]; then
  printf '%s\n' "缺少 $ENV_FILE；请先复制 .env.example 并填入服务器秘密。" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"
STAMP="$(date +%Y-%m-%d)"
TARGET="$BACKUP_ROOT/daily/cet46-$STAMP.sql.gz"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T mysql sh -c \
  'export MYSQL_PWD="$MYSQL_PASSWORD"; exec mysqldump --single-transaction --routines --triggers --hex-blob -u"$MYSQL_USER" "$MYSQL_DATABASE"' \
  | gzip -c > "$TARGET"

gzip -t "$TARGET"

# 周备份单独保留，避免日备份轮换时丢失较长时间点。
if [ "$(date +%u)" = "7" ]; then
  WEEK="$(date +%G-W%V)"
  cp "$TARGET" "$BACKUP_ROOT/weekly/cet46-$WEEK.sql.gz"
fi

find "$BACKUP_ROOT/daily" -type f -name 'cet46-*.sql.gz' -mtime +7 -delete
find "$BACKUP_ROOT/weekly" -type f -name 'cet46-*.sql.gz' -mtime +35 -delete
printf '备份完成：%s\n' "$TARGET"
