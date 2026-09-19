import type { WordInput } from "../../types";

export type ParseResult = {
  rows: WordInput[];
  errors: string[];
  duplicateLines: number;
};

export function parseTsv(value: string): ParseResult {
  const rows: WordInput[] = [];
  const errors: string[] = [];
  let duplicateLines = 0;
  const normalizedValue = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const withoutFence = normalizedValue
    .replace(/^```(?:tsv|text)?\s*\n/i, "")
    .replace(/\n```\s*$/, "");
  const lines = withoutFence.split("\n").filter((line) => line.trim());
  const header = ["word", "phonetic", "meaning", "phrase", "sentence", "sentence_cn", "source", "type"];

  if (lines.length === 0) return { rows, errors: ["导入内容为空，请粘贴含 8 列表头和至少一行单词的 TSV。"], duplicateLines };
  if (value.length > 1_000_000 || lines.length > 501) {
    return { rows, duplicateLines, errors: ["单次最多导入 500 个词，文件大小不能超过 1 MB。请分批导入。"] };
  }
  const actualHeader = lines[0].split("\t").map((cell) => cell.trim().toLowerCase());
  if (actualHeader.length !== header.length || actualHeader.some((cell, index) => cell !== header[index])) {
    return {
      rows,
      duplicateLines,
      errors: ["首行必须是含音标的固定 8 列表头：word、phonetic、meaning、phrase、sentence、sentence_cn、source、type。"],
    };
  }

  const expectedColumns = header.length;
  const merged = new Map<string, WordInput>();
  lines.slice(1).forEach((line, index) => {
    const lineNumber = index + 2;
    const cells = line.split("\t");
    if (cells.length !== expectedColumns) {
      errors.push(`第 ${lineNumber} 行有 ${cells.length} 列，应为 ${expectedColumns} 列。`);
      return;
    }
    const [rawWord, phonetic, meaning, phrase, sentence, sentenceCn, source, rawType] = cells.map((cell) => cell.trim());
    const word = rawWord.toLowerCase();
    if (!word) {
      errors.push(`第 ${lineNumber} 行的 word 不能为空。`);
      return;
    }
    if (!/^[a-z][a-z'-]*$/.test(word)) {
      errors.push(`第 ${lineNumber} 行的 word 应为单个英文词典原形，只能包含字母、连字符或撇号。`);
      return;
    }
    if (!phonetic) {
      errors.push(`第 ${lineNumber} 行的 phonetic 音标不能为空。`);
      return;
    }
    if (!/^\/[^/]+\/$/.test(phonetic)) {
      errors.push(`第 ${lineNumber} 行的 phonetic 应使用 /.../ 格式，例如 /ˈæləkeɪt/。`);
      return;
    }
    if (!meaning) {
      errors.push(`第 ${lineNumber} 行的 meaning 不能为空，请写成“词性 + 中文释义”，例如 v. 分配；拨出。`);
      return;
    }
    if (rawType !== "marked" && rawType !== "added") {
      errors.push(`第 ${lineNumber} 行的 type 只能是 marked 或 added。`);
      return;
    }
    const next: WordInput = { word, phonetic, meaning, phrase, sentence, sentenceCn, source, type: rawType };
    const prior = merged.get(word);
    if (prior) {
      duplicateLines += 1;
      merged.set(word, {
        word,
        phonetic: next.phonetic || prior.phonetic,
        meaning: next.meaning || prior.meaning,
        phrase: next.phrase || prior.phrase,
        sentence: next.sentence || prior.sentence,
        sentenceCn: next.sentenceCn || prior.sentenceCn,
        source: next.source || prior.source,
        type: prior.type === "marked" || next.type === "marked" ? "marked" : "added",
      });
    } else {
      merged.set(word, next);
    }
  });

  if (lines.length === 1) errors.push("请至少提供一行单词数据。\n");
  return { rows: [...merged.values()], errors, duplicateLines };
}
