export type WordType = "marked" | "added";
export type ReviewGrade = "again" | "hard" | "good" | "easy";
export type ThemeMode = "system" | "light" | "dark";

export type WordInput = {
  word: string;
  phonetic: string;
  meaning: string;
  phrase: string;
  sentence: string;
  sentenceCn: string;
  source: string;
  type: WordType;
};

export type Word = WordInput & {
  id: string;
  userId: string;
  createdAt: string;
  /** 服务端下发的规范化单词；本地存储不提供该字段，因此可选。 */
  normalizedWord?: string;
  /** 服务端下发的词条更新时间；本地存储不提供该字段，因此可选。 */
  updatedAt?: string;
};

export type Progress = {
  firstLearnedAt?: string;
  id: string;
  userId: string;
  wordId: string;
  reviewStage: number;
  recognitionScore: number;
  spellingScore: number;
  nextReviewAt: string;
  lastReviewAt: string | null;
  lastRecognitionChoice: "known" | "unknown" | null;
  lastRecognitionResult: "correct" | "wrong" | null;
  lastSpellingResult: "correct" | "wrong" | null;
  lastGrade: ReviewGrade | null;
  killedAt: string | null;
  lastRestoredAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 累计复习与答题表现，供统计页使用；旧数据会在读取时补为 0。 */
  reviewCount?: number;
  correctCount?: number;
  wrongCount?: number;
};

/** 每次新学或完成复习时写入的轻量快照，用于真实的学习趋势统计。 */
export type LearningEvent = {
  id: string;
  userId: string;
  wordId: string;
  occurredAt: string;
  kind: "new" | "review";
  reviewStage: number;
};

export type WordWithProgress = Word & { progress: Progress };

export type LocalUser = {
  id: string;
  email: string;
  username?: string;
  avatar?: string;
};

export type LocalProfile = {
  username: string;
  avatar: string;
};

/** A personal milestone is kept separately from learning progress and backups. */
export type CountdownSettings = {
  label: string;
  targetDate: string;
};

export type LocalDatabase = {
  version: 1;
  session: LocalUser | null;
  words: Word[];
  progress: Progress[];
  learningEvents?: LearningEvent[];
};

export type RecognitionResponse = {
  firstChoice: "known" | "unknown";
  result: "correct" | "wrong";
  hadError: boolean;
  attempts: number;
};

export type SpellingResponse = {
  input: string;
  correct: boolean;
  /** 本轮首次或中间尝试是否拼错；即使最终订正，也用于保留学习信号。 */
  hadError: boolean;
};

export type ReviewCompletion = {
  completed: number;
  earliestNextReviewAt: string | null;
  grades: Record<ReviewGrade, number>;
};

export type ReviewDraft = {
  version: 1;
  userId: string;
  /** 新学/复习入口标记；旧草稿没有此字段时仍按兼容入口恢复。 */
  mode?: "all" | "new" | "review" | "spell";
  /** 拼写草稿的来源；缺失时按旧版“每日拼写”兼容。 */
  scope?: "daily" | "library";
  itemIds: string[];
  recognitionQueueIds: string[];
  /** `learning` 只用于新词首次学习；认词、错词回炉与拼写只属于复习流程。 */
  phase: "learning" | "recognition" | "summary" | "spelling";
  index: number;
  recognition: Record<string, RecognitionResponse>;
  spelling: Record<string, SpellingResponse>;
  hadSpellingError: boolean;
  /** 正在作答的词；恢复时以 ID 定位，避免词库变化后按旧下标跳词。 */
  currentWordId: string | null;
  /** 认词“第一反应”已选但尚未核对时，也必须能恢复。 */
  firstChoice: "known" | "unknown" | null;
  /** 拼写输入和本次核对结果，刷新后不泄露或遗失当前状态。 */
  answer: string;
  spellingChecked: SpellingResponse | null;
  updatedAt: string;
};

export type LocalStorageStatus = {
  kind: "corrupt" | "unavailable";
  message: string;
};
