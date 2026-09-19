import type { LearningEventRecord, ProgressRecord, ReviewDraftRecord, UserSettingsRecord, WordWithProgress } from "./repository.ts";

/**
 * 响应序列化。
 *
 * 硬规则：任何用户数据都不回传 `userId`。身份永远来自服务端会话，
 * 客户端不需要、也不应该拿 userId 做判断。
 */

export function serializeProgress(progress: ProgressRecord) {
  return {
    id: progress.id,
    wordId: progress.wordId,
    reviewStage: progress.reviewStage,
    recognitionScore: progress.recognitionScore,
    spellingScore: progress.spellingScore,
    firstLearnedAt: progress.firstLearnedAt,
    nextReviewAt: progress.nextReviewAt,
    lastReviewAt: progress.lastReviewAt,
    lastRecognitionChoice: progress.lastRecognitionChoice,
    lastRecognitionResult: progress.lastRecognitionResult,
    lastSpellingResult: progress.lastSpellingResult,
    lastGrade: progress.lastGrade,
    killedAt: progress.killedAt,
    lastRestoredAt: progress.lastRestoredAt,
    reviewCount: progress.reviewCount,
    correctCount: progress.correctCount,
    wrongCount: progress.wrongCount,
    version: progress.version,
    createdAt: progress.createdAt,
    updatedAt: progress.updatedAt,
  };
}

export function serializeWord(pair: WordWithProgress) {
  return {
    id: pair.word.id,
    word: pair.word.word,
    normalizedWord: pair.word.normalizedWord,
    phonetic: pair.word.phonetic,
    meaning: pair.word.meaning,
    phrase: pair.word.phrase,
    sentence: pair.word.sentence,
    sentenceCn: pair.word.sentenceCn,
    source: pair.word.source,
    type: pair.word.type,
    createdAt: pair.word.createdAt,
    updatedAt: pair.word.updatedAt,
    progress: serializeProgress(pair.progress),
  };
}

export function serializeSettings(settings: UserSettingsRecord) {
  return {
    dailyTarget: settings.dailyTarget,
    dailyGroups: settings.dailyGroups,
    dailyGroupWords: settings.dailyGroupWords,
    dailyPlanConfigured: settings.dailyPlanConfigured,
    timezone: settings.timezone,
    countdown:
      settings.countdownLabel !== null && settings.countdownTargetDate !== null
        ? { label: settings.countdownLabel, targetDate: settings.countdownTargetDate }
        : null,
    updatedAt: settings.updatedAt,
  };
}

export function serializeEvent(event: LearningEventRecord) {
  return {
    id: event.id,
    wordId: event.wordId,
    occurredAt: event.occurredAt,
    kind: event.kind,
    reviewStage: event.reviewStage,
  };
}

export function serializeDraft(draft: ReviewDraftRecord) {
  return {
    key: draft.draftKey,
    revision: draft.revision,
    version: draft.version,
    mode: draft.mode,
    scope: draft.scope,
    phase: draft.phase,
    payload: draft.payload,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}
