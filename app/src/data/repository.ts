import { cloudRepository } from "./cloudRepository";

/**
 * 页面只依赖这个入口。cloudRepository 的同步 getter 读取当前账号的内存快照，
 * 所有持久化读写都通过 API；这样可以逐页保留既有业务流程，同时把 MySQL 作为唯一真实来源。
 */
export type WordRepository = typeof cloudRepository;

export const wordRepository: WordRepository = cloudRepository;
