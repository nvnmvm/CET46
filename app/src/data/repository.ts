import { localStore } from "./localStore";

/**
 * 页面只依赖这个入口。接入服务器 API 后，保持同一组方法并在此处替换实现，
 * 可避免修改导入、复习和词库页面的业务流程。
 */
export type WordRepository = typeof localStore;

export const wordRepository: WordRepository = localStore;
