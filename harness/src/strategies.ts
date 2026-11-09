import type { ChunkingStrategy, RetrievalConfig } from "./schema.ts";

/**
 * 横向对比用的切分策略。
 *
 * 放在独立模块里，是为了让 serve 命令能用同一份定义——
 * cli.ts 在模块顶层就会执行 main()，别的模块不能 import 它。
 */
export const STRATEGIES: Record<string, ChunkingStrategy> = {
  "fixed-800": {
    id: "fixed-800",
    label: "固定窗口 800 字符",
    kind: "fixed-window",
    windowSize: 800,
    overlap: 120,
  },
  "fixed-400": {
    id: "fixed-400",
    label: "固定窗口 400 字符",
    kind: "fixed-window",
    windowSize: 400,
    overlap: 60,
  },
  "function-level": {
    id: "function-level",
    label: "函数级切分",
    kind: "function-level",
    minFunctionLines: 3,
  },
};

/** 横向对比时三种切分策略共用的检索配置。 */
export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  topK: 6,
  rerank: true,
  rerankMode: "structure-aware",
  queryExpansion: true,
};

/** 参与对比的策略，按固定顺序。 */
export const STRATEGY_LIST: ChunkingStrategy[] = [
  STRATEGIES["fixed-800"],
  STRATEGIES["fixed-400"],
  STRATEGIES["function-level"],
];
