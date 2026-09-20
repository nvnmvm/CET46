import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { newId } from "./ids.ts";
import { mergeWordFields } from "./schemas.ts";
import type { NormalizedWordInput, ReviewGrade, UpdateWordPatch } from "./schemas.ts";
import { nowUtc, toIsoRequired, toMysqlUtc, withTransaction } from "./db.ts";
import type { MysqlPool, SqlParameter } from "./db.ts";
import {
  decideNewStudyEntry,
  decideReviewEntry,
  decideSpellingEntry,
  earliestIso,
  isSpellingAnswerCorrect,
} from "./learningRules.ts";
import type { EntryDecision, ProgressRuleSnapshot } from "./learningRules.ts";
import {
  RepositoryConflictError,
  RepositoryForbiddenError,
  RepositorySessionRejectedError,
} from "./repository.ts";
import type {
  CompletionEntryInput,
  CompletionInput,
  CompletionOutcome,
  EntryOutcome,
  ImportResult,
  LearningEventRecord,
  ListWordsOptions,
  NewSessionInput,
  NewUserInput,
  ProgressRecord,
  ReviewDraftRecord,
  SaveDraftInput,
  SaveDraftOutcome,
  SessionRecord,
  SessionWithUser,
  SubmissionKind,
  UpdateSettingsPatch,
  UpdateUserProfilePatch,
  UserSettingsRecord,
  UserRecord,
  WordRecord,
  WordRepository,
  WordWithProgress,
} from "./repository.ts";

/**
 * MySQL 实现。所有语句都使用占位符 + 参数数组，绝不拼接用户输入。
 * 分页（LIMIT/OFFSET）用 pool.query 而不是 execute：mysql2 的预处理语句对 LIMIT 参数支持不一致，
 * query 同样走占位符转义，值仍是参数化的。
 */

const WORD_COLUMNS =
  "w.id, w.user_id, w.normalized_word, w.word, w.phonetic, w.meaning, w.phrase, w.sentence, w.sentence_cn, w.source, w.type, w.created_at, w.updated_at";

const PROGRESS_PLAIN_COLUMNS =
  "id, user_id, word_id, review_stage, recognition_score, spelling_score, first_learned_at, next_review_at, last_review_at, last_recognition_choice, last_recognition_result, last_spelling_result, last_grade, killed_at, last_restored_at, review_count, correct_count, wrong_count, version, created_at, updated_at";

const URL_ENUM_VALUES = new Set(["known", "unknown"]);
const RESULT_ENUM_VALUES = new Set(["correct", "wrong"]);
const GRADE_ENUM_VALUES = new Set(["again", "hard", "good", "easy"]);

type UserRow = RowDataPacket & {
  id: string;
  email: string;
  password_hash: string;
  username: string | null;
  avatar: string | null;
  timezone: string;
  role: "admin" | "learner";
  disabled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type SessionRow = RowDataPacket & {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

type WordRow = RowDataPacket & {
  id: string;
  user_id: string;
  normalized_word: string;
  word: string;
  phonetic: string;
  meaning: string;
  phrase: string;
  sentence: string;
  sentence_cn: string;
  source: string;
  type: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ProgressRow = RowDataPacket & {
  id: string;
  user_id: string;
  word_id: string;
  review_stage: number;
  recognition_score: number;
  spelling_score: number;
  first_learned_at: Date | string | null;
  next_review_at: Date | string;
  last_review_at: Date | string | null;
  last_recognition_choice: string | null;
  last_recognition_result: string | null;
  last_spelling_result: string | null;
  last_grade: string | null;
  killed_at: Date | string | null;
  last_restored_at: Date | string | null;
  review_count: number;
  correct_count: number;
  wrong_count: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type JoinedRow = WordRow & {
  progress_id: string;
  review_stage: number;
  recognition_score: number;
  spelling_score: number;
  first_learned_at: Date | string | null;
  next_review_at: Date | string;
  last_review_at: Date | string | null;
  last_recognition_choice: string | null;
  last_recognition_result: string | null;
  last_spelling_result: string | null;
  last_grade: string | null;
  killed_at: Date | string | null;
  last_restored_at: Date | string | null;
  review_count: number;
  correct_count: number;
  wrong_count: number;
  version: number;
  progress_created_at: Date | string;
  progress_updated_at: Date | string;
};

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    username: row.username,
    avatar: row.avatar,
    timezone: row.timezone,
    role: row.role === "admin" ? "admin" : "learner",
    disabledAt: row.disabled_at ? toIsoRequired(row.disabled_at) : null,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

function mapWord(row: WordRow): WordRecord {
  return {
    id: row.id,
    userId: row.user_id,
    normalizedWord: row.normalized_word,
    word: row.word,
    phonetic: row.phonetic,
    meaning: row.meaning,
    phrase: row.phrase,
    sentence: row.sentence,
    sentenceCn: row.sentence_cn,
    source: row.source,
    type: row.type === "marked" ? "marked" : "added",
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

function pickEnum<T extends string>(value: string | null, allowed: Set<string>): T | null {
  return value !== null && allowed.has(value) ? (value as T) : null;
}

function mapProgressFields(
  row: ProgressRow | JoinedRow,
): Omit<ProgressRecord, "id" | "createdAt" | "updatedAt"> {
  const plain = row as ProgressRow;
  return {
    userId: plain.user_id,
    wordId: plain.word_id,
    reviewStage: Number(row.review_stage),
    recognitionScore: Number(row.recognition_score),
    spellingScore: Number(row.spelling_score),
    firstLearnedAt: row.first_learned_at ? toIsoRequired(row.first_learned_at) : null,
    nextReviewAt: toIsoRequired(row.next_review_at),
    lastReviewAt: row.last_review_at ? toIsoRequired(row.last_review_at) : null,
    lastRecognitionChoice: pickEnum<"known" | "unknown">(row.last_recognition_choice, URL_ENUM_VALUES),
    lastRecognitionResult: pickEnum<"correct" | "wrong">(row.last_recognition_result, RESULT_ENUM_VALUES),
    lastSpellingResult: pickEnum<"correct" | "wrong">(row.last_spelling_result, RESULT_ENUM_VALUES),
    lastGrade: pickEnum<"again" | "hard" | "good" | "easy">(row.last_grade, GRADE_ENUM_VALUES),
    killedAt: row.killed_at ? toIsoRequired(row.killed_at) : null,
    lastRestoredAt: row.last_restored_at ? toIsoRequired(row.last_restored_at) : null,
    reviewCount: Number(row.review_count),
    correctCount: Number(row.correct_count),
    wrongCount: Number(row.wrong_count),
    version: Number(row.version),
  };
}

function mapProgress(row: ProgressRow): ProgressRecord {
  return {
    id: row.id,
    ...mapProgressFields(row),
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

function mapJoinedProgress(row: JoinedRow): ProgressRecord {
  return {
    id: row.progress_id,
    ...mapProgressFields(row),
    createdAt: toIsoRequired(row.progress_created_at),
    updatedAt: toIsoRequired(row.progress_updated_at),
  };
}

export function createMysqlRepository(pool: MysqlPool): WordRepository {
  const userColumns = "id, email, password_hash, username, avatar, timezone, role, disabled_at, created_at, updated_at";

  const selectUserById = async (id: string, connection: MysqlPool | PoolConnection = pool): Promise<UserRecord | null> => {
    const [rows] = await connection.execute<UserRow[]>(
      `SELECT ${userColumns} FROM users WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  };

  const assertAdminActor = async (connection: PoolConnection, actorUserId: string): Promise<void> => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT role, disabled_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
      [actorUserId],
    );
    const actor = rows[0];
    if (!actor || actor.role !== "admin" || actor.disabled_at !== null) {
      throw new RepositoryForbiddenError("admin_required");
    }
  };

  const insertAdminAudit = async (
    connection: PoolConnection,
    actorUserId: string,
    targetUserId: string,
    action: "create_user" | "update_user" | "disable_user" | "enable_user" | "reset_password",
  ): Promise<void> => {
    await connection.execute(
      "INSERT INTO admin_audit_logs (id, actor_user_id, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?)",
      [newId("audit"), actorUserId, targetUserId, action, nowUtc()],
    );
  };

  const selectWordById = async (
    userId: string,
    wordId: string,
    connection: MysqlPool | PoolConnection = pool,
  ): Promise<WordRecord | null> => {
    const [rows] = await connection.execute<WordRow[]>(
      `SELECT ${WORD_COLUMNS} FROM words w WHERE w.user_id = ? AND w.id = ? LIMIT 1`,
      [userId, wordId],
    );
    const row = rows[0];
    return row ? mapWord(row) : null;
  };

  const selectProgress = async (
    userId: string,
    wordId: string,
    connection: MysqlPool | PoolConnection = pool,
  ): Promise<ProgressRecord | null> => {
    const [rows] = await connection.execute<ProgressRow[]>(
      `SELECT ${PROGRESS_PLAIN_COLUMNS} FROM word_progress WHERE user_id = ? AND word_id = ? LIMIT 1`,
      [userId, wordId],
    );
    const row = rows[0];
    return row ? mapProgress(row) : null;
  };

  const updateProgress = async (
    userId: string,
    wordId: string,
    statement: string,
    params: SqlParameter[],
  ): Promise<ProgressRecord | null> => {
    return withTransaction(pool, async (connection) => {
      const existing = await selectProgress(userId, wordId, connection);
      if (!existing) return null;
      await connection.execute(statement, params);
      return selectProgress(userId, wordId, connection);
    });
  };

  const mapCalendarDate = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value.slice(0, 10);
  };

  const mapSettings = (row: RowDataPacket): UserSettingsRecord => ({
    userId: String(row.user_id),
    dailyTarget: Number(row.daily_target),
    dailyGroups: Number(row.daily_groups),
    dailyGroupWords: Number(row.daily_group_words),
    dailyPlanConfigured: Boolean(Number(row.daily_plan_configured)),
    timezone: String(row.timezone),
    countdownLabel: (row.countdown_label as string | null) ?? null,
    countdownTargetDate: mapCalendarDate(row.countdown_target_date as Date | string | null),
    createdAt: toIsoRequired(row.created_at as Date | string),
    updatedAt: toIsoRequired(row.updated_at as Date | string),
  });

  const toRuleSnapshot = (record: ProgressRecord): ProgressRuleSnapshot => ({
    reviewStage: record.reviewStage,
    recognitionScore: record.recognitionScore,
    spellingScore: record.spellingScore,
    firstLearnedAt: record.firstLearnedAt,
    lastReviewAt: record.lastReviewAt,
    nextReviewAt: record.nextReviewAt,
    lastRecognitionChoice: record.lastRecognitionChoice,
    lastRecognitionResult: record.lastRecognitionResult,
    lastSpellingResult: record.lastSpellingResult,
    lastGrade: record.lastGrade,
    reviewCount: record.reviewCount,
    correctCount: record.correctCount,
    wrongCount: record.wrongCount,
    updatedAt: record.updatedAt,
    killedAt: record.killedAt,
  });

  const duplicateKey = (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY";

  const completeMysql = async (kind: SubmissionKind, userId: string, input: CompletionInput): Promise<CompletionOutcome> => {
    const work = async (connection: PoolConnection): Promise<CompletionOutcome> => {
      const [oldRows] = await connection.execute<RowDataPacket[]>("SELECT result_json FROM review_submissions WHERE user_id = ? AND submission_key = ? LIMIT 1 FOR UPDATE", [userId, input.submissionKey]);
      if (oldRows[0]) return { ...(typeof oldRows[0].result_json === "string" ? JSON.parse(oldRows[0].result_json) : oldRows[0].result_json) as CompletionOutcome, duplicate: true };
      const at = new Date(); const results: EntryOutcome[] = []; const dates: string[] = [];
      const grades: Record<ReviewGrade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
      let completed = 0; let conflicts = 0; let skipped = 0; let corrected = 0;
      for (const entry of input.entries) {
        const [rows] = await connection.execute<ProgressRow[]>(`SELECT ${PROGRESS_PLAIN_COLUMNS} FROM word_progress WHERE user_id = ? AND word_id = ? LIMIT 1 FOR UPDATE`, [userId, entry.wordId]);
        const current = rows[0] ? mapProgress(rows[0]) : null;
        const word = await selectWordById(userId, entry.wordId, connection);
        const normalizedEntry = entry.spelling && word
          ? {
              ...entry,
              spelling: {
                ...entry.spelling,
                // 客户端的 correct 只为兼容协议；服务端按当前词条重新计算。
                correct: isSpellingAnswerCorrect(entry.spelling.input, word.word),
              },
            }
          : entry;
        const decision = kind === "new" ? decideNewStudyEntry(current ? toRuleSnapshot(current) : null, normalizedEntry, at) : kind === "review" ? decideReviewEntry(current ? toRuleSnapshot(current) : null, normalizedEntry, at) : decideSpellingEntry(current ? toRuleSnapshot(current) : null, normalizedEntry, at);
        if (decision.status !== "completed") { if (decision.status === "conflict") conflicts++; else skipped++; results.push({ wordId: entry.wordId, status: decision.status, reason: decision.reason }); continue; }
        if (!current) throw new Error("缺少进度行");
        const s = decision.state;
        const [updated] = await connection.execute<ResultSetHeader>(`UPDATE word_progress SET review_stage=?, recognition_score=?, spelling_score=?, first_learned_at=?, next_review_at=?, last_review_at=?, last_recognition_choice=?, last_recognition_result=?, last_spelling_result=?, last_grade=?, review_count=?, correct_count=?, wrong_count=?, version=version+1, updated_at=? WHERE user_id=? AND word_id=? AND updated_at=? AND next_review_at=?`, [s.reviewStage,s.recognitionScore,s.spellingScore,s.firstLearnedAt?toMysqlUtc(new Date(s.firstLearnedAt)):null,toMysqlUtc(new Date(s.nextReviewAt)),s.lastReviewAt?toMysqlUtc(new Date(s.lastReviewAt)):null,s.lastRecognitionChoice,s.lastRecognitionResult,s.lastSpellingResult,s.lastGrade,s.reviewCount,s.correctCount,s.wrongCount,toMysqlUtc(new Date(s.updatedAt)),userId,entry.wordId,toMysqlUtc(new Date(current.updatedAt)),toMysqlUtc(new Date(current.nextReviewAt))]);
        if (updated.affectedRows !== 1) { conflicts++; results.push({ wordId: entry.wordId, status: "conflict", reason: "version_mismatch" }); continue; }
        completed++; dates.push(s.nextReviewAt); if (decision.grade) grades[decision.grade]++; if (decision.corrected) corrected++; results.push({ wordId: entry.wordId, status: "completed", reason: null });
        if (decision.eventKind) { const t = toMysqlUtc(at); await connection.execute("INSERT INTO learning_events (id,user_id,word_id,occurred_at,kind,review_stage,created_at) VALUES (?,?,?,?,?,?,?)", [newId("event"),userId,entry.wordId,t,decision.eventKind,decision.eventStage,t]); }
      }
      const result: CompletionOutcome = { submissionKey: input.submissionKey, duplicate: false, completed, conflicts, skipped, earliestNextReviewAt: earliestIso(dates), results, ...(kind === "review" ? { grades } : {}), ...(kind === "spelling" ? { corrected } : {}) };
      await connection.execute("INSERT INTO review_submissions (id,user_id,submission_key,kind,result_json,created_at) VALUES (?,?,?,?,?,?)", [newId("submission"),userId,input.submissionKey,kind,JSON.stringify(result),toMysqlUtc(at)]);
      return result;
    };
    try { return await withTransaction(pool, work); } catch (error) {
      if (!duplicateKey(error)) throw error;
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT result_json FROM review_submissions WHERE user_id=? AND submission_key=? LIMIT 1", [userId,input.submissionKey]);
      if (!rows[0]) throw error;
      return { ...(typeof rows[0].result_json === "string" ? JSON.parse(rows[0].result_json) : rows[0].result_json) as CompletionOutcome, duplicate: true };
    }
  };

  return {
    async checkReadiness() {
      await pool.execute("SELECT 1");
    },

    async findUserByEmail(email) {
      const [rows] = await pool.execute<UserRow[]>(
        `SELECT ${userColumns} FROM users WHERE email = ? LIMIT 1`,
        [email],
      );
      const row = rows[0];
      return row ? mapUser(row) : null;
    },

    async findUserById(id) {
      return selectUserById(id);
    },

    async createUser(input: NewUserInput) {
      const now = nowUtc();
      await pool.execute(
        `INSERT INTO users (id, email, password_hash, username, avatar, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.email,
          input.passwordHash,
          input.username ?? null,
          input.avatar ?? null,
          input.timezone ?? "Asia/Shanghai",
          now,
          now,
        ],
      );
      const created = await this.findUserById(input.id);
      if (!created) throw new Error("创建用户后无法读回记录。");
      return created;
    },

    async updateUserProfile(userId: string, patch: UpdateUserProfilePatch) {
      const [result] = await pool.execute<ResultSetHeader>(
        "UPDATE users SET username = ?, avatar = ?, updated_at = ? WHERE id = ?",
        [patch.username, patch.avatar, nowUtc(), userId],
      );
      if (result.affectedRows === 0) return null;
      return this.findUserById(userId);
    },

    async adminListUsers(options) {
      const [countRows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM users");
      const [rows] = await pool.query<UserRow[]>(
        `SELECT ${userColumns} FROM users ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
        [options.limit, options.offset],
      );
      return { total: Number(countRows[0]?.total ?? 0), users: rows.map(mapUser) };
    },

    async adminCreateUser(actorUserId, input) {
      return withTransaction(pool, async (connection) => {
        await assertAdminActor(connection, actorUserId);
        const now = nowUtc();
        try {
          await connection.execute(
            `INSERT INTO users (id, email, password_hash, username, avatar, timezone, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [input.id, input.email, input.passwordHash, input.username ?? null, input.avatar ?? null, input.timezone ?? "Asia/Shanghai", now, now],
          );
        } catch (error) {
          if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY") {
            throw new RepositoryConflictError("email_exists");
          }
          throw error;
        }
        const created = await selectUserById(input.id, connection);
        if (!created) throw new Error("创建用户后无法读回记录。");
        await insertAdminAudit(connection, actorUserId, created.id, "create_user");
        return created;
      });
    },

    async adminUpdateUser(actorUserId, targetUserId, patch) {
      return withTransaction(pool, async (connection) => {
        await assertAdminActor(connection, actorUserId);
        const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE", [targetUserId]);
        if (!rows[0]) return null;
        try {
          await connection.execute("UPDATE users SET email = COALESCE(?, email), username = COALESCE(?, username), updated_at = ? WHERE id = ?", [patch.email ?? null, patch.username ?? null, nowUtc(), targetUserId]);
        } catch (error) {
          if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY") throw new RepositoryConflictError("email_exists");
          throw error;
        }
        await insertAdminAudit(connection, actorUserId, targetUserId, "update_user");
        return selectUserById(targetUserId, connection);
      });
    },

    async adminDeleteUser(actorUserId, targetUserId) {
      return withTransaction(pool, async (connection) => {
        await assertAdminActor(connection, actorUserId);
        const [rows] = await connection.execute<RowDataPacket[]>("SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE", [targetUserId]);
        if (!rows[0]) return false;
        if (targetUserId === actorUserId) throw new RepositoryForbiddenError("cannot_delete_self");
        if (rows[0].role === "admin") throw new RepositoryForbiddenError("cannot_delete_admin");
        await connection.execute("DELETE FROM admin_audit_logs WHERE target_user_id = ?", [targetUserId]);
        const [result] = await connection.execute<ResultSetHeader>("DELETE FROM users WHERE id = ?", [targetUserId]);
        return result.affectedRows > 0;
      });
    },

    async adminSetUserDisabled(actorUserId, targetUserId, disabled) {
      return withTransaction(pool, async (connection) => {
        await assertAdminActor(connection, actorUserId);
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT id, role, disabled_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
          [targetUserId],
        );
        const target = rows[0];
        if (!target) return null;
        if (disabled && targetUserId === actorUserId) {
          throw new RepositoryForbiddenError("cannot_disable_self");
        }
        if (disabled && target.role === "admin") {
          throw new RepositoryForbiddenError("cannot_disable_admin");
        }
        const now = nowUtc();
        await connection.execute(
          "UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?",
          [disabled ? now : null, now, targetUserId],
        );
        if (disabled) {
          await connection.execute(
            "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            [now, targetUserId],
          );
        }
        await insertAdminAudit(connection, actorUserId, targetUserId, disabled ? "disable_user" : "enable_user");
        return selectUserById(targetUserId, connection);
      });
    },

    async adminResetUserPassword(actorUserId, targetUserId, passwordHash) {
      return withTransaction(pool, async (connection) => {
        await assertAdminActor(connection, actorUserId);
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
          [targetUserId],
        );
        if (!rows[0]) return null;
        const now = nowUtc();
        await connection.execute(
          "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
          [passwordHash, now, targetUserId],
        );
        await connection.execute(
          "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          [now, targetUserId],
        );
        await insertAdminAudit(connection, actorUserId, targetUserId, "reset_password");
        return selectUserById(targetUserId, connection);
      });
    },

    async promoteUserToAdmin(userId) {
      const [result] = await pool.execute<ResultSetHeader>(
        "UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?",
        [nowUtc(), userId],
      );
      return result.affectedRows > 0 ? selectUserById(userId) : null;
    },

    async createSession(input: NewSessionInput) {
      return withTransaction(pool, async (connection) => {
        if (input.expectedPasswordHash !== undefined) {
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT password_hash, disabled_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
            [input.userId],
          );
          const row = rows[0];
          if (!row || row.disabled_at !== null || row.password_hash !== input.expectedPasswordHash) {
            throw new RepositorySessionRejectedError();
          }
        }
        const createdAt = nowUtc();
        await connection.execute(
          `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          [input.id, input.userId, input.tokenHash, toMysqlUtc(new Date(input.expiresAt)), createdAt],
        );
        return {
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: new Date(input.expiresAt).toISOString(),
          revokedAt: null,
          createdAt: new Date(createdAt.replace(" ", "T") + "Z").toISOString(),
        };
      });
    },

    async findActiveSessionByTokenHash(tokenHash, now) {
      const [rows] = await pool.execute<(SessionRow & UserRow)[]>(
        `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at, s.created_at,
                u.email, u.password_hash, u.username, u.avatar, u.timezone, u.role,
                u.disabled_at,
                u.created_at AS user_created_at, u.updated_at AS user_updated_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND u.disabled_at IS NULL
         LIMIT 1`,
        [tokenHash, toMysqlUtc(new Date(now))],
      );
      const row = rows[0];
      if (!row) return null;
      const session: SessionRecord = {
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: toIsoRequired(row.expires_at),
        revokedAt: row.revoked_at ? toIsoRequired(row.revoked_at) : null,
        createdAt: toIsoRequired(row.created_at),
      };
      const user: UserRecord = {
        id: row.user_id,
        email: row.email,
        passwordHash: row.password_hash,
        username: row.username,
        avatar: row.avatar,
        timezone: row.timezone,
        role: row.role === "admin" ? "admin" : "learner",
        disabledAt: row.disabled_at ? toIsoRequired(row.disabled_at) : null,
        createdAt: toIsoRequired(row.user_created_at),
        updatedAt: toIsoRequired(row.user_updated_at),
      };
      const result: SessionWithUser = { session, user };
      return result;
    },

    async revokeSession(tokenHash, revokedAt) {
      const [result] = await pool.execute<ResultSetHeader>(
        "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        [toMysqlUtc(new Date(revokedAt)), tokenHash],
      );
      return result.affectedRows > 0;
    },

    async countWords(userId) {
      const [rows] = await pool.execute<(RowDataPacket & { total: number })[]>(
        "SELECT COUNT(*) AS total FROM words WHERE user_id = ?",
        [userId],
      );
      return Number(rows[0]?.total ?? 0);
    },

    async listWords(userId, options: ListWordsOptions): Promise<WordWithProgress[]> {
      const [rows] = await pool.query<JoinedRow[]>(
        `SELECT ${WORD_COLUMNS},
                p.id AS progress_id, p.review_stage, p.recognition_score, p.spelling_score,
                p.first_learned_at, p.next_review_at, p.last_review_at,
                p.last_recognition_choice, p.last_recognition_result, p.last_spelling_result,
                p.last_grade, p.killed_at, p.last_restored_at,
                p.review_count, p.correct_count, p.wrong_count, p.version,
                p.created_at AS progress_created_at, p.updated_at AS progress_updated_at
         FROM words w
         JOIN word_progress p ON p.word_id = w.id AND p.user_id = w.user_id
         WHERE w.user_id = ?
         ORDER BY w.normalized_word ASC, w.id ASC
         LIMIT ? OFFSET ?`,
        [userId, options.limit, options.offset],
      );
      return rows.map((row) => ({ word: mapWord(row), progress: mapJoinedProgress(row) }));
    },

    async getWord(userId, wordId): Promise<WordWithProgress | null> {
      const [rows] = await pool.execute<JoinedRow[]>(
        `SELECT ${WORD_COLUMNS},
                p.id AS progress_id, p.review_stage, p.recognition_score, p.spelling_score,
                p.first_learned_at, p.next_review_at, p.last_review_at,
                p.last_recognition_choice, p.last_recognition_result, p.last_spelling_result,
                p.last_grade, p.killed_at, p.last_restored_at,
                p.review_count, p.correct_count, p.wrong_count, p.version,
                p.created_at AS progress_created_at, p.updated_at AS progress_updated_at
         FROM words w
         JOIN word_progress p ON p.word_id = w.id AND p.user_id = w.user_id
         WHERE w.user_id = ? AND w.id = ?
         LIMIT 1`,
        [userId, wordId],
      );
      const row = rows[0];
      return row ? { word: mapWord(row), progress: mapJoinedProgress(row) } : null;
    },

    async importWords(userId, inputs: NormalizedWordInput[]): Promise<ImportResult> {
      const uniqueWords = Array.from(new Set(inputs.map((input) => input.normalizedWord)));
      if (uniqueWords.length === 0) return { added: 0, existing: 0 };
      return withTransaction(pool, async (connection) => {
        const placeholders = uniqueWords.map(() => "?").join(", ");
        const [rows] = await connection.query<WordRow[]>(
          `SELECT ${WORD_COLUMNS} FROM words w WHERE w.user_id = ? AND w.normalized_word IN (${placeholders})`,
          [userId, ...uniqueWords],
        );
        const stored = new Map<string, WordRecord>();
        for (const row of rows) {
          const word = mapWord(row);
          stored.set(word.normalizedWord, word);
        }

        let added = 0;
        let existing = 0;
        for (const input of inputs) {
          const current = stored.get(input.normalizedWord);
          const now = nowUtc();
          if (current) {
            existing += 1;
            const merged = mergeWordFields(current, input);
            await connection.execute(
              `UPDATE words SET phonetic = ?, meaning = ?, phrase = ?, sentence = ?, sentence_cn = ?,
                                 source = ?, type = ?, updated_at = ?
               WHERE id = ? AND user_id = ?`,
              [
                merged.phonetic,
                merged.meaning,
                merged.phrase,
                merged.sentence,
                merged.sentenceCn,
                merged.source,
                merged.type,
                now,
                current.id,
                userId,
              ],
            );
            stored.set(input.normalizedWord, { ...current, ...merged, updatedAt: new Date(now.replace(" ", "T") + "Z").toISOString() });
            continue;
          }

          added += 1;
          const wordId = newId("word");
          await connection.execute(
            `INSERT INTO words (id, user_id, normalized_word, word, phonetic, meaning, phrase, sentence,
                                sentence_cn, source, type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              wordId,
              userId,
              input.normalizedWord,
              input.word,
              input.phonetic,
              input.meaning,
              input.phrase,
              input.sentence,
              input.sentenceCn,
              input.source,
              input.type,
              now,
              now,
            ],
          );
          await connection.execute(
            `INSERT INTO word_progress (id, user_id, word_id, review_stage, recognition_score, spelling_score,
                                        first_learned_at, next_review_at, last_review_at, last_recognition_choice,
                                        last_recognition_result, last_spelling_result, last_grade, killed_at,
                                        last_restored_at, review_count, correct_count, wrong_count, version,
                                        created_at, updated_at)
             VALUES (?, ?, ?, 0, 0, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, ?, ?)`,
            [newId("progress"), userId, wordId, now, now, now],
          );
          stored.set(input.normalizedWord, {
            id: wordId,
            userId,
            normalizedWord: input.normalizedWord,
            word: input.word,
            phonetic: input.phonetic,
            meaning: input.meaning,
            phrase: input.phrase,
            sentence: input.sentence,
            sentenceCn: input.sentenceCn,
            source: input.source,
            type: input.type,
            createdAt: new Date(now.replace(" ", "T") + "Z").toISOString(),
            updatedAt: new Date(now.replace(" ", "T") + "Z").toISOString(),
          });
        }
        return { added, existing };
      });
    },

    async updateWord(userId, wordId, patch: UpdateWordPatch) {
      return withTransaction(pool, async (connection) => {
        const [rows] = await connection.execute<WordRow[]>(
          `SELECT ${WORD_COLUMNS} FROM words w WHERE w.user_id = ? AND w.id = ? LIMIT 1`,
          [userId, wordId],
        );
        const row = rows[0];
        if (!row) return null;
        const current = mapWord(row);
        await connection.execute(
          "UPDATE words SET phonetic = ?, meaning = ?, updated_at = ? WHERE id = ? AND user_id = ?",
          [
            patch.phonetic ?? current.phonetic,
            patch.meaning ?? current.meaning,
            nowUtc(),
            wordId,
            userId,
          ],
        );
        const updated = await selectWordById(userId, wordId, connection);
        return updated;
      });
    },

    async deleteWord(userId, wordId) {
      return withTransaction(pool, async (connection) => {
        const [result] = await connection.execute<ResultSetHeader>(
          "DELETE FROM words WHERE id = ? AND user_id = ?",
          [wordId, userId],
        );
        return result.affectedRows > 0;
      });
    },

    killWord(userId, wordId) {
      const now = nowUtc();
      return updateProgress(
        userId,
        wordId,
        "UPDATE word_progress SET killed_at = ?, updated_at = ? WHERE user_id = ? AND word_id = ?",
        [now, now, userId, wordId],
      );
    },

    restoreWord(userId, wordId) {
      const now = nowUtc();
      return updateProgress(
        userId,
        wordId,
        `UPDATE word_progress
         SET killed_at = NULL, last_restored_at = ?, review_stage = LEAST(review_stage, 2),
             next_review_at = ?, updated_at = ?
         WHERE user_id = ? AND word_id = ?`,
        [now, now, now, userId, wordId],
      );
    },

    undoKillWord(userId, wordId) {
      const now = nowUtc();
      return updateProgress(
        userId,
        wordId,
        "UPDATE word_progress SET killed_at = NULL, updated_at = ? WHERE user_id = ? AND word_id = ?",
        [now, userId, wordId],
      );
    },

    async ensureUserSettings(userId) {
      const now = nowUtc();
      await pool.execute(
        `INSERT INTO user_settings (user_id, daily_target, daily_groups, daily_group_words,
          daily_plan_configured, timezone, countdown_label, countdown_target_date, created_at, updated_at)
         SELECT id, 20, 2, 10, 0, timezone, NULL, NULL, ?, ? FROM users WHERE id = ?
         ON DUPLICATE KEY UPDATE user_id = user_id`,
        [now, now, userId],
      );
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT user_id, daily_target, daily_groups, daily_group_words, daily_plan_configured,
          timezone, countdown_label, countdown_target_date, created_at, updated_at
         FROM user_settings WHERE user_id = ? LIMIT 1`, [userId],
      );
      if (!rows[0]) throw new Error("创建用户设置后无法读回记录。");
      return mapSettings(rows[0]);
    },

    async updateUserSettings(userId, patch) {
      await this.ensureUserSettings(userId);
      return withTransaction(pool, async (connection) => {
        const now = nowUtc();
        const sets: string[] = ["updated_at = ?"];
        const params: SqlParameter[] = [now];
        if (patch.dailyTarget !== undefined) { sets.push("daily_target = ?"); params.push(patch.dailyTarget); }
        if (patch.dailyGroups !== undefined) { sets.push("daily_groups = ?", "daily_plan_configured = 1"); params.push(patch.dailyGroups); }
        if (patch.dailyGroupWords !== undefined) { sets.push("daily_group_words = ?", "daily_plan_configured = 1"); params.push(patch.dailyGroupWords); }
        if (patch.timezone !== undefined) { sets.push("timezone = ?"); params.push(patch.timezone); }
        if (patch.countdownLabel !== undefined) { sets.push("countdown_label = ?"); params.push(patch.countdownLabel); }
        if (patch.countdownTargetDate !== undefined) { sets.push("countdown_target_date = ?"); params.push(patch.countdownTargetDate); }
        params.push(userId);
        await connection.execute(`UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = ?`, params);
        if (patch.timezone !== undefined) await connection.execute("UPDATE users SET timezone = ?, updated_at = ? WHERE id = ?", [patch.timezone, now, userId]);
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT user_id, daily_target, daily_groups, daily_group_words, daily_plan_configured, timezone, countdown_label, countdown_target_date, created_at, updated_at FROM user_settings WHERE user_id = ? LIMIT 1`, [userId]);
        if (!rows[0]) throw new Error("更新用户设置后无法读回记录。");
        return mapSettings(rows[0]);
      });
    },

    async countEvents(userId) {
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM learning_events WHERE user_id = ?", [userId]);
      return Number(rows[0]?.total ?? 0);
    },

    async listEvents(userId, options) {
      const [rows] = await pool.query<(RowDataPacket & { id: string; user_id: string; word_id: string; occurred_at: Date|string; kind: "new"|"review"; review_stage: number })[]>(
        "SELECT id,user_id,word_id,occurred_at,kind,review_stage FROM learning_events WHERE user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?",
        [userId, options.limit, options.offset],
      );
      return rows.map((row): LearningEventRecord => ({ id: row.id, userId: row.user_id, wordId: row.word_id, occurredAt: toIsoRequired(row.occurred_at), kind: row.kind, reviewStage: Number(row.review_stage) }));
    },

    async listDueCandidates(userId, now, limit) {
      const [rows] = await pool.query<JoinedRow[]>(
        `SELECT ${WORD_COLUMNS}, p.id AS progress_id, p.review_stage, p.recognition_score, p.spelling_score,
          p.first_learned_at, p.next_review_at, p.last_review_at, p.last_recognition_choice,
          p.last_recognition_result, p.last_spelling_result, p.last_grade, p.killed_at,
          p.last_restored_at, p.review_count, p.correct_count, p.wrong_count, p.version,
          p.created_at AS progress_created_at, p.updated_at AS progress_updated_at
         FROM words w JOIN word_progress p ON p.word_id=w.id AND p.user_id=w.user_id
         WHERE w.user_id=? AND p.killed_at IS NULL AND p.next_review_at <= ?
         ORDER BY (p.last_review_at IS NULL) ASC, p.next_review_at ASC, w.id ASC LIMIT ?`,
        [userId, toMysqlUtc(new Date(now)), limit],
      );
      return rows.map((row) => ({ word: mapWord(row), progress: mapJoinedProgress(row) }));
    },

    async countWordsLearnedBetween(userId, start, end) {
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM word_progress WHERE user_id=? AND first_learned_at >= ? AND first_learned_at < ?", [userId, toMysqlUtc(new Date(start)), toMysqlUtc(new Date(end))]);
      return Number(rows[0]?.total ?? 0);
    },

    async listWordsLearnedBetween(userId, start, end, limit) {
      const [rows] = await pool.query<JoinedRow[]>(
        `SELECT ${WORD_COLUMNS}, p.id AS progress_id, p.review_stage, p.recognition_score, p.spelling_score,
          p.first_learned_at, p.next_review_at, p.last_review_at, p.last_recognition_choice,
          p.last_recognition_result, p.last_spelling_result, p.last_grade, p.killed_at,
          p.last_restored_at, p.review_count, p.correct_count, p.wrong_count, p.version,
          p.created_at AS progress_created_at, p.updated_at AS progress_updated_at
         FROM words w JOIN word_progress p ON p.word_id=w.id AND p.user_id=w.user_id
         WHERE w.user_id=? AND p.killed_at IS NULL AND p.first_learned_at >= ? AND p.first_learned_at < ?
         ORDER BY p.first_learned_at DESC, p.updated_at DESC, w.id DESC LIMIT ?`,
        [userId, toMysqlUtc(new Date(start)), toMysqlUtc(new Date(end)), limit],
      );
      return rows.map((row) => ({ word: mapWord(row), progress: mapJoinedProgress(row) }));
    },

    async listLibraryWords(userId, options) {
      const filter = options.filter;
      const like = filter === null ? null : `%${filter}%`;
      const [rows] = await pool.query<JoinedRow[]>(
        `SELECT ${WORD_COLUMNS}, p.id AS progress_id, p.review_stage, p.recognition_score, p.spelling_score,
          p.first_learned_at, p.next_review_at, p.last_review_at, p.last_recognition_choice,
          p.last_recognition_result, p.last_spelling_result, p.last_grade, p.killed_at,
          p.last_restored_at, p.review_count, p.correct_count, p.wrong_count, p.version,
          p.created_at AS progress_created_at, p.updated_at AS progress_updated_at
         FROM words w JOIN word_progress p ON p.word_id=w.id AND p.user_id=w.user_id
         WHERE w.user_id=? AND p.killed_at IS NULL AND (? IS NULL OR LOWER(w.word) LIKE LOWER(?))
         ORDER BY w.normalized_word ASC, w.id ASC LIMIT ?`,
        [userId, like, like, options.limit],
      );
      return rows.map((row) => ({ word: mapWord(row), progress: mapJoinedProgress(row) }));
    },

    async getReviewDraft(userId, draftKey) {
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT id,user_id,draft_key,version,mode,scope,phase,payload_json,revision,created_at,updated_at FROM review_drafts WHERE user_id=? AND draft_key=? LIMIT 1", [userId, draftKey]);
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, userId: row.user_id, draftKey: row.draft_key, version: Number(row.version), mode: row.mode ?? null, scope: row.scope ?? null, phase: row.phase ?? null, payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json, revision: Number(row.revision), createdAt: toIsoRequired(row.created_at), updatedAt: toIsoRequired(row.updated_at) } as ReviewDraftRecord;
    },

    async saveReviewDraft(userId, input) {
      return withTransaction(pool, async (connection): Promise<SaveDraftOutcome> => {
        const [rows] = await connection.execute<RowDataPacket[]>("SELECT id,user_id,draft_key,version,mode,scope,phase,payload_json,revision,created_at,updated_at FROM review_drafts WHERE user_id=? AND draft_key=? LIMIT 1 FOR UPDATE", [userId, input.draftKey]);
        const current = rows[0];
        if (!current && input.revision !== 0) return { status: "conflict", currentRevision: null };
        if (current && Number(current.revision) !== input.revision) return { status: "conflict", currentRevision: Number(current.revision) };
        const now = nowUtc();
        if (current) {
          await connection.execute("UPDATE review_drafts SET mode=?,scope=?,phase=?,payload_json=?,revision=revision+1,updated_at=? WHERE user_id=? AND draft_key=?", [input.mode,input.scope,input.phase,JSON.stringify(input.payload),now,userId,input.draftKey]);
        } else {
          await connection.execute("INSERT INTO review_drafts (id,user_id,draft_key,version,mode,scope,phase,payload_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [newId("draft"),userId,input.draftKey,1,input.mode,input.scope,input.phase,JSON.stringify(input.payload),1,now,now]);
        }
        const [saved] = await connection.execute<RowDataPacket[]>("SELECT id,user_id,draft_key,version,mode,scope,phase,payload_json,revision,created_at,updated_at FROM review_drafts WHERE user_id=? AND draft_key=? LIMIT 1", [userId,input.draftKey]);
        const row = saved[0]; if (!row) throw new Error("保存草稿后无法读回记录。");
        return { status: "saved", draft: { id: row.id,userId: row.user_id,draftKey: row.draft_key,version:Number(row.version),mode:row.mode??null,scope:row.scope??null,phase:row.phase??null,payload:typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json,revision:Number(row.revision),createdAt:toIsoRequired(row.created_at),updatedAt:toIsoRequired(row.updated_at) } };
      });
    },

    async deleteReviewDraft(userId, draftKey) {
      const [result] = await pool.execute<ResultSetHeader>("DELETE FROM review_drafts WHERE user_id=? AND draft_key=?", [userId,draftKey]);
      return result.affectedRows > 0;
    },

    completeNewStudy(userId, input) { return completeMysql("new", userId, input); },
    completeReview(userId, input) { return completeMysql("review", userId, input); },
    completeSpelling(userId, input) { return completeMysql("spelling", userId, input); },

    async close() {
      await pool.end();
    },
  };
}
