/**
 * 校验评测集：证据行号必须真实存在，且区间内确实出现对应的符号名。
 * 证据写错会让召回率变成噪声，所以这一步是硬门槛。
 *
 *   node --experimental-strip-types src/validate.ts <dataset.json> <repoRoot>
 *
 * 校验逻辑在 dataset-validate.ts，本地工作台（serve 命令）也用它。
 */

import { readFile } from "node:fs/promises";
import { validateDataset } from "./dataset-validate.ts";
import type { EvalDataset } from "./schema.ts";

const [datasetPath, repoRoot] = process.argv.slice(2);
if (!datasetPath || !repoRoot) {
  console.error(
    "用法: node --experimental-strip-types src/validate.ts <dataset.json> <repoRoot>",
  );
  process.exit(1);
}

const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvalDataset;
const { problems, warnings } = await validateDataset(dataset, repoRoot);

console.log(`数据集 ${dataset.id}：${dataset.questions.length} 题`);
if (warnings.length) {
  console.log(`提示 ${warnings.length} 条（不阻断）：`);
  for (const warning of warnings) console.log(`  · ${warning}`);
}
if (problems.length === 0) {
  console.log("全部证据校验通过");
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
