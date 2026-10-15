import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import type { SpellingResponse } from "../types";

type PracticeSpellingCardProps = {
  word: string;
  meaning: string;
  phonetic: string;
  sentenceCn: string;
  source: string;
  answer: string;
  onAnswerChange: (answer: string) => void;
  checked: SpellingResponse | null;
  saving: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  onCheck: () => void;
  onRetry: () => void;
  onContinue: () => void;
  continueLabel: string;
  correctedMessage: string;
};

export default function PracticeSpellingCard({
  word,
  meaning,
  phonetic,
  sentenceCn,
  source,
  answer,
  onAnswerChange,
  checked,
  saving,
  actionRef,
  onCheck,
  onRetry,
  onContinue,
  continueLabel,
  correctedMessage,
}: PracticeSpellingCardProps) {
  const inputId = useId();
  const feedbackId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    if (!checked) inputRef.current?.focus({ preventScroll: true });
  }, [checked, word]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || composing.current) return;
    if (!checked) onCheck();
    else if (checked.correct) onContinue();
    else onRetry();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  };

  const actionLabel = saving
    ? "保存中…"
    : !checked
      ? "提交"
      : checked.correct
        ? continueLabel
        : "隐藏答案，再拼一次";

  return (
    <section className="practice-spelling-card practice-card rounded-3xl bg-white p-5 shadow-card ring-1 ring-stone-100 sm:p-7">
      <div className="practice-card__prompt">
        <p className="text-sm font-medium text-blue-700">请根据中文释义写出英文</p>
        <h1 tabIndex={-1} className="mt-4 break-words text-2xl font-bold leading-relaxed [overflow-wrap:anywhere]">
          {meaning || "请根据语境写出英文"}
        </h1>
        {sentenceCn && <p className="mt-3 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">语境：{sentenceCn}</p>}
        {source && <p className="mt-2 break-words text-xs text-slate-400 [overflow-wrap:anywhere]">来源：{source}</p>}
      </div>

      <form className="mt-6" onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} noValidate>
        <label htmlFor={inputId} className="mb-2 block text-sm font-semibold text-slate-700">英文拼写</label>
        <input
          id={inputId}
          ref={inputRef}
          value={answer}
          onChange={(event) => onAnswerChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={handleKeyDown}
          readOnly={Boolean(checked)}
          disabled={saving}
          aria-invalid={checked ? !checked.correct : undefined}
          aria-describedby={feedbackId}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="输入英文单词"
          className="input practice-card__input font-mono text-lg"
        />

        <div id={feedbackId} className={`practice-card__feedback practice-card__feedback--${checked?.correct ? "correct" : checked ? "error" : "waiting"} mt-4 rounded-2xl p-4 text-sm leading-6 ${checked?.correct ? "bg-blue-50 text-blue-900" : checked ? "bg-amber-50 text-amber-950" : "bg-blue-50/60 text-slate-600"}`} role="status" aria-live="polite">
          {!checked ? (
            <p>按 Enter 或点击提交，检查拼写。</p>
          ) : checked.correct ? (
            <>
              <p className="font-bold">拼写正确</p>
              {checked.hadError && <p className="mt-2">{correctedMessage}</p>}
            </>
          ) : (
            <>
              <p className="font-bold">还差一点，再记一次</p>
              <p className="mt-2">你的答案：{checked.input.trim() || "（空）"}<br />正确答案：<strong className="break-all">{word}</strong></p>
              {phonetic && <p className="mt-2 break-words font-mono">{phonetic}</p>}
            </>
          )}
        </div>

        <button ref={actionRef} type="submit" disabled={saving} className="button-primary practice-card__action mt-4 w-full">
          {actionLabel}
        </button>
      </form>
    </section>
  );
}
