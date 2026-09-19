import { useMemo, useState, type KeyboardEvent } from "react";
import { buildLearningStatistics, MASTERY_STAGES, type MasteryStage, type ScheduleDay, type TrendDay } from "../data/statisticsService";
import type { LearningEvent, WordWithProgress } from "../types";

const stageLabels: Record<MasteryStage, string> = {
  initial: "初记",
  strengthening: "强化",
  consolidating: "巩固",
  familiar: "熟悉",
  mastered: "已掌握",
};

const stageColors: Record<MasteryStage, string> = {
  initial: "#bfdbfe",
  strengthening: "#93c5fd",
  consolidating: "#60a5fa",
  familiar: "#2563eb",
  mastered: "#173d8f",
};

const scheduleKeys = ["initial", "strengthening", "consolidating", "familiar", "overdue"] as const;
const scheduleLabels = { initial: "初记", strengthening: "强化", consolidating: "巩固", familiar: "熟悉", overdue: "逾期" };
const scheduleColors = { initial: "#bfdbfe", strengthening: "#93c5fd", consolidating: "#60a5fa", familiar: "#2563eb", overdue: "#d97755" };

function formatChartDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

function StageLegend() {
  return <div className="statistics-legend" aria-label="图例">{MASTERY_STAGES.map((stage) => <span key={stage}><i style={{ backgroundColor: stageColors[stage] }} />{stageLabels[stage]}</span>)}</div>;
}

function ReviewReminderCard({ count }: { count: number }) {
  if (count === 0) {
    return <section className="statistics-reminder statistics-reminder--complete"><div><p className="statistics-kicker">今日复习</p><h2>今天的复习任务已经完成</h2><p>继续保持节奏，下一批词会按计划到来。</p></div></section>;
  }
  return (
    <section className="statistics-reminder">
      <div><p className="statistics-kicker">今日复习</p><h2>有 {count} 个单词正处于最佳复习时间</h2><p>及时复习可以有效降低遗忘。</p></div>
      <a href="#/review/review" className="button-primary statistics-review-button">立即复习</a>
    </section>
  );
}

function ReviewScheduleChart({ days }: { days: ScheduleDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.total));
  const selected = active === null ? null : days[active];
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") { event.preventDefault(); setActive(Math.min(days.length - 1, index + 1)); }
    if (event.key === "ArrowLeft") { event.preventDefault(); setActive(Math.max(0, index - 1)); }
  };
  return (
    <section className="statistics-card">
      <div className="statistics-card-heading"><div><p className="statistics-kicker">未来 10 天</p><h2>我的复习计划</h2></div><p>按下方柱子查看详情</p></div>
      <div className="schedule-chart" role="group" aria-label="未来十天复习计划">
        {days.map((day, index) => <button type="button" key={day.date.toISOString()} className={`schedule-column ${index === 0 ? "is-today" : ""} ${active === index ? "is-active" : ""}`} onClick={() => setActive(index)} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onKeyDown={(event) => handleKey(event, index)} aria-label={`${formatChartDate(day.date)}，需复习 ${day.total} 词`}>
          <span className="schedule-total">{day.total || ""}</span>
          <span className="schedule-bar" style={{ height: `${Math.max(day.total ? 16 : 3, (day.total / max) * 100)}%` }}>
            {scheduleKeys.map((stage) => day.stages[stage] > 0 && <i key={stage} className={`schedule-segment schedule-segment--${stage}`} style={{ flexGrow: day.stages[stage] }} />)}
          </span>
          <span className="schedule-label">{day.label}</span>
        </button>)}
      </div>
      {selected ? <div className="statistics-tooltip" role="status"><strong>{formatChartDate(selected.date)}</strong><span>共需复习 {selected.total} 词</span>{scheduleKeys.filter((stage) => selected.stages[stage] > 0).map((stage) => <span key={stage}>{scheduleLabels[stage]} {selected.stages[stage]}</span>)}</div> : <p className="statistics-chart-hint">点击任意日期查看当天复习构成。</p>}
      <div className="statistics-legend">{scheduleKeys.map((stage) => <span key={stage}><i className={`schedule-segment--${stage}`} />{scheduleLabels[stage]}</span>)}</div>
    </section>
  );
}

function MasteryStatusChart({ words, learnedCount, stages, completionRate }: { words: WordWithProgress[]; learnedCount: number; stages: Record<MasteryStage, number>; completionRate: number }) {
  const max = Math.max(1, ...Object.values(stages));
  return (
    <section className="statistics-card">
      <div className="statistics-card-heading"><div><p className="statistics-kicker">当前词书</p><h2>我的掌握现状</h2></div><strong>{Math.round(completionRate * 100)}%</strong></div>
      {learnedCount === 0 ? <p className="statistics-empty">完成第一轮新学后，这里会展示记忆阶段的变化。</p> : <>
        <div className="mastery-chart" aria-label="当前掌握阶段分布">{MASTERY_STAGES.map((stage) => <div className="mastery-column" key={stage}><strong>{stages[stage]}<small>词</small></strong><div className="mastery-track"><i style={{ height: `${Math.max(6, stages[stage] / max * 100)}%`, backgroundColor: stageColors[stage] }} /></div><span>{stageLabels[stage]}</span></div>)}</div>
        <p className="statistics-summary">当前已学习 {learnedCount} / {words.length} 词 · 词书完成度 {(completionRate * 100).toFixed(1)}%</p>
        <div className="statistics-stage-summary">{MASTERY_STAGES.map((stage) => <span key={stage}>{stageLabels[stage]}：{stages[stage]}词 · {learnedCount ? Math.round(stages[stage] / learnedCount * 100) : 0}%</span>)}</div>
      </>}
    </section>
  );
}

function stackedPath(days: TrendDay[], stage: MasteryStage, index: number, max: number) {
  const width = 1000;
  const height = 210;
  const step = width / Math.max(1, days.length - 1);
  const lower = (day: TrendDay) => MASTERY_STAGES.slice(0, index).reduce((sum, key) => sum + day.stages[key], 0);
  const upper = (day: TrendDay) => lower(day) + day.stages[stage];
  const y = (value: number) => height - value / max * height;
  const top = days.map((day, dayIndex) => `${dayIndex ? "L" : "M"}${dayIndex * step} ${y(upper(day))}`).join(" ");
  const bottom = [...days].reverse().map((day, reverseIndex) => `L${(days.length - 1 - reverseIndex) * step} ${y(lower(day))}`).join(" ");
  return `${top} ${bottom} Z`;
}

function MasteryProgressChart({ days, hasTrend }: { days: TrendDay[]; hasTrend: boolean }) {
  const [active, setActive] = useState(days.length - 1);
  const max = Math.max(1, ...days.map((day) => day.total));
  const selected = days[active];
  const pointerIndex = (event: { currentTarget: SVGSVGElement; clientX: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(days.length - 1, Math.round((event.clientX - rect.left) / rect.width * (days.length - 1))));
  };
  return <section className="statistics-card">
    <div className="statistics-card-heading"><div><p className="statistics-kicker">最近 10 天</p><h2>我的掌握进度</h2></div><p>累计学习词数</p></div>
    {!hasTrend ? <p className="statistics-empty">从下一次新学或复习起，系统会记录真实的阶段变化，并在这里生成十日趋势。</p> : <>
      <svg className="trend-chart" viewBox="0 0 1000 250" role="img" aria-label="最近十天掌握阶段趋势" onPointerMove={(event) => setActive(pointerIndex(event))} onClick={(event) => setActive(pointerIndex(event))}>{MASTERY_STAGES.map((stage, index) => <path key={stage} d={stackedPath(days, stage, index, max)} fill={stageColors[stage]} fillOpacity={0.88} />)}<line x1="0" y1="210" x2="1000" y2="210" stroke="#dbeafe" strokeWidth="4" /></svg>
      <div className="trend-labels">{days.map((day) => <span key={day.date.toISOString()}>{day.label}</span>)}</div>
      <div className="statistics-tooltip" role="status"><strong>{formatChartDate(selected.date)}</strong><span>累计 {selected.total} 词</span>{MASTERY_STAGES.filter((stage) => selected.stages[stage] > 0).map((stage) => <span key={stage}>{stageLabels[stage]} {selected.stages[stage]}</span>)}</div>
      <StageLegend />
    </>}
  </section>;
}

export default function StatisticsPage({ words, events }: { words: WordWithProgress[]; events: LearningEvent[] }) {
  const data = useMemo(() => buildLearningStatistics(words, events), [events, words]);
  return <div className="statistics-page">
    <header className="statistics-page-header"><a href="#/" className="statistics-back">←</a><div><h1>学习统计</h1><p>CET 4/6 真题词库</p></div></header>
    <ReviewReminderCard count={data.reviewDueCount} />
    <ReviewScheduleChart days={data.schedule} />
    <MasteryStatusChart words={words} learnedCount={data.learnedCount} stages={data.mastery} completionRate={data.completionRate} />
    <MasteryProgressChart days={data.trend} hasTrend={data.hasTrend} />
  </div>;
}
