import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

// 把源码打成 zip 随站点一起发布，让任何人都能从站点直接下载并本地复现。
//
// 打包范围是白名单：只收 harness 的源码/评测集/脚本、语料拉取脚本、站点源码。
// 明确排除密钥、依赖目录、评测产物和大体积截图。

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outFile = join(root, "site", "public", "eval-bench-source.zip");

/** 需要收进包里的路径，相对于仓库根目录。 */
const INCLUDE = [
  "harness/src",
  "harness/scripts",
  "harness/datasets",
  "harness/package.json",
  "harness/tsconfig.json",
  "harness/README.md",
  "harness/.env.example",
  "corpus/fetch.sh",
  "corpus/README.md",
  "site/src",
  "site/components",
  "site/hooks",
  "site/lib",
  "site/data/report.ts",
  "site/data/report.json",
  "site/index.html",
  "site/package.json",
  "site/package-lock.json",
  "site/tsconfig.json",
  "site/vite.config.ts",
  "site/components.json",
  "site/postcss.config.mjs",
  "site/scripts/build.mjs",
  "site/scripts/check-node.mjs",
  "site/vendor",
  "site/PROVENANCE.md",
  "README.md",
  "LICENSE",
  ".gitignore",
];

/** 这些名字在任何层级都不进包。 */
const EXCLUDE_NAMES = new Set([
  ".env",
  ".env.local",
  ".qoder.site",
  "node_modules",
  "dist",
  ".git",
  "out",
  "shots",
  "coverage",
  ".DS_Store",
]);

async function collect(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

const README = `# 课设 Copilot 评测台 · 源码包

在线版：https://copilot-eval-bench-fzlro45ljfz.qoder.zone

这个包包含评测流水线和站点本身。你不需要读懂全部代码——
先跑通「只跑检索层」这条路径，它不花钱、不需要密钥，几分钟就能看到和站点一样的数字。

## 目录

| 路径 | 是什么 |
| --- | --- |
| \`harness/\` | 评测流水线：检索层、生成层、judge 自检、失败归因、迭代阶梯 |
| \`corpus/fetch.sh\` | 拉取被测仓库（Flask 3.1.3 等四个包，版本固定） |
| \`site/\` | 站点源码（React + Vite + Tailwind），数字直接读 \`report.json\` |

## 依赖

- Node.js 22.13 或 24 以上（\`--experimental-strip-types\` 用来直接跑 TypeScript，无需编译）
- bash + curl + tar（拉语料用；Windows 上 Git Bash 自带）
- 想跑生成层的话，另需一个 OpenAI 兼容接口的密钥（DeepSeek、百炼、Kimi、本地 vLLM 都行）

\`harness/\` 本身零第三方依赖，不需要 \`npm install\`。

## 三步跑起来

\`\`\`bash
# 1. 拉被测仓库（只需一次，约 3 MB）
bash corpus/fetch.sh

# 2. 跑离线检索层：不需要密钥，结果与站点的检索层数字完全一致
cd harness
node --experimental-strip-types src/cli.ts experiment \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json

# 3. 看结果
cat out/report.json
\`\`\`

第 2 步会打印三种切分策略的 recall@1/3/6 和 MRR。
在没有配置密钥时，生成层会被跳过，检索层的数字不受影响。

## 跑生成层（需要密钥）

\`\`\`bash
cp .env.example .env    # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
node --experimental-strip-types src/cli.ts models   # 确认模型 id
node --experimental-strip-types src/cli.ts experiment \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
\`\`\`

密钥只写在 \`harness/.env\` 里，该文件已被 \`.gitignore\` 忽略，不要提交，也不要贴进任何聊天窗口。

## 跑迭代阶梯

五轮，每轮只改一个变量：

\`\`\`bash
node --experimental-strip-types src/cli.ts ladder \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
\`\`\`

## 把站点跑起来

\`\`\`bash
cd site
npm ci
npm run dev
\`\`\`

站点读 \`site/data/report.json\`。想换成自己的报告，把 \`harness/out/report.json\` 拷过去即可。

## 换成你自己的课设仓库

1. 在 \`harness/datasets/\` 下放一份自己的题集，格式参考 \`flask.json\`：
   每题要写清人工参考答案、证据的 \`文件名 + 起止行号\`，以及人工评分。
2. 把被测仓库放到任意路径，替换命令行里的 \`../corpus/repos/flask-3.1.3\`。
3. 先跑 \`node --experimental-strip-types src/validate.ts datasets/你的.json 你的仓库路径\`，
   校验每条证据的行号真实存在——行号错了，评测结论就是错的。

其余代码一行都不用改。

## 许可

评测流水线与站点代码见 \`LICENSE\`。
被测的四个仓库各自保留原始许可文件（Flask/Jinja2 为 BSD-3-Clause，Requests 为 Apache-2.0，Werkzeug 为 BSD-3-Clause），
语料只保留源码树与包根文件，不含文档、测试与示例。
`;

async function main() {
  const picked = [];
  for (const rel of INCLUDE) {
    const from = join(root, rel);
    const info = await stat(from).catch(() => null);
    if (!info) {
      console.warn(`跳过不存在的路径：${rel}`);
      continue;
    }
    if (info.isFile()) {
      picked.push(from);
      continue;
    }
    picked.push(...(await collect(from)));
  }

  // 按路径排序收集条目，产出稳定的包内容。
  const entries = [];
  for (const file of [...new Set(picked)].sort()) {
    const rel = relative(root, file).split("\\").join("/");
    entries.push({
      name: `eval-bench/${rel}`,
      data: await readFile(file),
    });
  }
  entries.push({
    name: "eval-bench/开始这里.md",
    data: Buffer.from(README, "utf8"),
  });

  await rm(outFile, { force: true });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, createZip(entries));

  const size = (await stat(outFile)).size;
  console.log(`源码包已生成：${outFile}`);
  console.log(`  文件数 ${entries.length}，体积 ${(size / 1024).toFixed(0)} KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
