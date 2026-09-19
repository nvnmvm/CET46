import type { WordInput } from "../types";

export const EDITABLE_TSV_HEADER = [
  "word",
  "phonetic",
  "meaning",
  "phrase",
  "sentence",
  "sentence_cn",
  "source",
  "type",
] as const;

/**
 * The import format is deliberately line-based and does not support quoted TSV
 * cells. Flattening tabs and line breaks here makes an exported file safe to
 * paste straight back into the existing importer.
 */
const toEditableTsvCell = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();

export const buildEditableTsv = (words: readonly WordInput[]) => [
  EDITABLE_TSV_HEADER.join("\t"),
  ...words.map((word) => [
    word.word,
    word.phonetic,
    word.meaning,
    word.phrase,
    word.sentence,
    word.sentenceCn,
    word.source,
    word.type,
  ].map(toEditableTsvCell).join("\t")),
].join("\n");
