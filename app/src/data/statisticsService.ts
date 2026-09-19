import type { LearningEvent, WordWithProgress } from "../types";

export const MASTERY_STAGES = ["initial", "strengthening", "consolidating", "familiar", "mastered"] as const;
export type MasteryStage = typeof MASTERY_STAGES[number];
export type ScheduleStage = Exclude<MasteryStage, "mastered"> | "overdue";

export type StageTotals = Record<MasteryStage, number>;
export type ScheduleTotals = Record<ScheduleStage, number>;

export type ScheduleDay = {
  date: Date;
  label: string;
  total: number;
  stages: ScheduleTotals;
};

export type TrendDay = {
  date: Date;
  label: string;
  stages: StageTotals;
  total: number;
};

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const sameDay = (a: Date, b: Date) => dayStart(a).getTime() === dayStart(b).getTime();
const emptyStages = (): StageTotals => ({ initial: 0, strengthening: 0, consolidating: 0, familiar: 0, mastered: 0 });
const emptyScheduleStages = (): ScheduleTotals => ({ initial: 0, strengthening: 0, consolidating: 0, familiar: 0, overdue: 0 });

export function getMasteryStage(item: WordWithProgress): MasteryStage | null {
  // Old local profiles did not store `firstLearnedAt`. A completed review is
  // still reliable evidence that the word was learned, so retain those users'
  // existing history instead of rendering a misleading empty chart.
  if (item.progress.killedAt || !(item.progress.firstLearnedAt ?? item.progress.lastReviewAt)) return null;
  const { reviewStage } = item.progress;
  if (reviewStage >= 6) return "mastered";
  if (reviewStage >= 5) return "familiar";
  if (reviewStage >= 3) return "consolidating";
  if (reviewStage >= 1) return "strengthening";
  return "initial";
}

function scheduleStage(item: WordWithProgress): Exclude<ScheduleStage, "overdue"> | null {
  const mastery = getMasteryStage(item);
  return mastery === "mastered" ? "familiar" : mastery;
}

function dayLabel(day: number, date: Date) {
  if (day === 0) return "今天";
  if (day === 1) return "明天";
  if (day === 2) return "后天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function buildLearningStatistics(words: WordWithProgress[], events: LearningEvent[], now = new Date()) {
  const today = dayStart(now);
  const reviewCandidates = words.filter((item) => !item.progress.killedAt && Boolean(item.progress.lastReviewAt));
  const reviewDueWords = reviewCandidates.filter((item) => new Date(item.progress.nextReviewAt).getTime() <= now.getTime());

  const schedule: ScheduleDay[] = Array.from({ length: 11 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return { date, label: dayLabel(index, date), total: 0, stages: emptyScheduleStages() };
  });

  reviewCandidates.forEach((item) => {
    const nextReview = new Date(item.progress.nextReviewAt);
    const difference = Math.floor((dayStart(nextReview).getTime() - today.getTime()) / 86_400_000);
    const stage = scheduleStage(item);
    if (!stage) return;
    if (difference < 0) {
      schedule[0].stages.overdue += 1;
      schedule[0].total += 1;
    } else if (difference <= 10) {
      schedule[difference].stages[stage] += 1;
      schedule[difference].total += 1;
    }
  });

  const mastery = emptyStages();
  words.forEach((item) => {
    const stage = getMasteryStage(item);
    if (stage) mastery[stage] += 1;
  });
  const learnedCount = Object.values(mastery).reduce((sum, value) => sum + value, 0);

  const trendStart = new Date(today);
  trendStart.setDate(today.getDate() - 9);
  const meaningfulEvents = events
    .filter((event) => !Number.isNaN(Date.parse(event.occurredAt)))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const currentStageByWord = new Map<string, MasteryStage>();
  const trend: TrendDay[] = Array.from({ length: 10 }, (_, index) => {
    const date = new Date(trendStart);
    date.setDate(trendStart.getDate() + index);
    meaningfulEvents
      .filter((event) => sameDay(new Date(event.occurredAt), date))
      .forEach((event) => {
        const stage = event.reviewStage >= 6 ? "mastered" : event.reviewStage >= 5 ? "familiar" : event.reviewStage >= 3 ? "consolidating" : event.reviewStage >= 1 ? "strengthening" : "initial";
        currentStageByWord.set(event.wordId, stage);
      });
    const stages = emptyStages();
    currentStageByWord.forEach((stage) => { stages[stage] += 1; });
    return {
      date,
      label: index === 9 ? "今天" : `${date.getMonth() + 1}/${date.getDate()}`,
      stages,
      total: Object.values(stages).reduce((sum, value) => sum + value, 0),
    };
  });

  return {
    mastery,
    learnedCount,
    completionRate: words.length === 0 ? 0 : learnedCount / words.length,
    schedule,
    reviewDueCount: reviewDueWords.length,
    tomorrowCount: schedule[1].total,
    trend,
    hasTrend: meaningfulEvents.some((event) => Date.parse(event.occurredAt) >= trendStart.getTime()),
  };
}
