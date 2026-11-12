/**
 * AI 评语。
 *
 * 规则模板能把数字摆清楚，但「这一轮改得值不值」这种话，
 * 每次跑的结果都不一样，写死在代码里就成了套话。
 * 这里把这次跑出来的真实数字交给模型，让它照着数字讲一段话。
 *
 * 铁律有两条：
 * 1. 模型只能引用给它的数字——事实以 JSON 原样递过去，提示词里写死「不许编」；
 * 2. 写完再验一遍——评语里出现的每个数字都得在事实里找得到，
 *    找不到就重写一次，还不行就不要这段评语。
 *
 * 第 2 条是这套东西能信的前提：自己写的东西自己先查一遍，
 * 免得评测台自己也犯「编数字」的毛病。
 */

import { chat, type LlmConfig } from "./llm.ts";
import type {
  ExperimentReport,
  LadderStep,
  ReportNarrative,
} from "./schema.ts";

/** 百分数，写成评测台通篇都在用的那种口径。 */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 成本，跟着报告自己的计价符号走。 */
function money(value: number, currency: string): string {
  return `${currency}${value.toFixed(4)}`;
}

/** 模型有时候会带代码围栏或者多余的前后缀，掐掉。 */
function clean(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/^\s*评语[:：]\s*/, "")
    .trim();
}

/** 文本里出现的所有数字。 */
function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    found.push(Number(match[0]));
  }
  return found;
}

/** 保留两位小数再比：0.3082 和 0.31 说的是同一笔钱。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 评语里有没有事实之外的数字。
 *
 * 返回的是那些「查无此数」的数——有的话，这段评语就不能用。
 */
function unverifiedNumbers(narrative: string, facts: string): number[] {
  const allowed = new Set(numbersIn(facts).map(round2));
  return numbersIn(narrative).filter((value) => !allowed.has(round2(value)));
}

/** 带货币符号的数。负数也算：某一轮可能反而省了钱。 */
const MONEY_PATTERN = /[¥￥$]\s*(-?[0-9]+(?:\.[0-9]+)?)/g;

/**
 * 钱的说法要宽容一点。
 *
 * 事实里写的是 ¥0.3082，模型写成 ¥0.308 说的是同一笔钱——
 * 这种不算编数字。但 ¥0.51 就是另一回事了。
 *
 * 钱的数先摘出去，剩下的数再按精确口径查：
 * 同一笔钱的两种写法不该算成编数字。
 */
function moneyClaims(text: string, facts: string): string[] {
  const claimed = [...text.matchAll(MONEY_PATTERN)].map((match) =>
    Number(match[1]),
  );
  if (claimed.length === 0) return [];
  const allowed = [...facts.matchAll(MONEY_PATTERN)].map((match) =>
    Number(match[1]),
  );
  return claimed
    .filter(
      (value) => !allowed.some((item) => Math.abs(item - value) < 0.0006),
    )
    .map((value) => `${value}`);
}

/** 把带货币符号的数摘掉，剩下的按精确口径查。 */
function stripMoney(text: string): string {
  return text.replace(MONEY_PATTERN, " ");
}

/**
 * 评语该说到的三件事，一件都不能少。
 *
 * 上一轮改对方向后，模型把成本那句整个删了——数字没错，
 * 但这张图要讲的就是钱，删了等于没评。
 */
function ladderCoverage(
  text: string,
  total: number,
  dearestId: string,
  bestValueId: string,
): string[] {
  const problems: string[] = [];
  const claimed = [...text.matchAll(MONEY_PATTERN)].map((match) =>
    Number(match[1]),
  );
  if (!claimed.some((value) => Math.abs(value - total) < 0.0006)) {
    problems.push(`没有说到这几轮一共花了 ${total.toFixed(4)}`);
  }
  if (dearestId && !new RegExp(`${dearestId}`, "i").test(text)) {
    problems.push(`没有说到最贵的一轮是 ${dearestId}`);
  }
  if (bestValueId && !new RegExp(`${bestValueId}`, "i").test(text)) {
    problems.push(`没有说到每提升一个百分点花得最少的是 ${bestValueId}`);
  }
  return problems;
}

/**
 * 把评语拆成小句。
 *
 * 逗号和顿号不拆：「A 比 B 高 31.8 个百分点」这句话拆开了就找不到主语了。
 */
function clauses(text: string): string[] {
  return text
    .split(/[。！？；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 比对名字时忽略空格：「固定窗口 800 字符」和「固定窗口800字符」是一回事。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 一组实体，以及它们之间算好的差值（单位是百分点）。 */
interface GapScope {
  /** 实体名，评语里要原样出现 */
  names: string[];
  /** 允许出现的差值 */
  gaps: number[];
}

/**
 * 事实怎么摆，评语就怎么讲。
 *
 * 每个板块单独一次请求：一次只讲一件事，
 * 模型不容易把阶梯的成本和策略对比的召回混着说。
 */
interface Section {
  key: keyof ReportNarrative;
  /** 板块的名字，提示词里用 */
  title: string;
  /** 这一板块该讲什么 */
  focus: string;
  facts: unknown;
  /** 写完之后再查一遍：评语里的话跟事实对不上，返回问题清单 */
  audit?: (text: string) => string[];
}

/** 中文数词，只够数「几轮」用。 */
const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 把「四」「10」这种写法变成数字。 */
function parseCount(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.length === 1) return CN_DIGITS[raw] ?? null;
  return null;
}

/**
 * 句子在说「提升了」还是在说「没提升」。
 *
 * 返回 1 表示在说提升，-1 表示在说没提升或下降，0 表示看不出来。
 * 否定要先判：「没有带来成功率提升」这句里有「提升」两个字，
 * 但它说的是没提升——先看否定再看关键词才对。
 *
 * 成本那一截要先摘掉：「反而省了 ¥0.0091」说的是钱，
 * 不是成功率——摘掉之后这句就看不出方向了，正好。
 */
function directionOf(clause: string): number {
  const costMark = /(成本|花费|花销|费用|价格|钱|花了|省了|多花|贵了|便宜)/;
  const scope = clause
    .split(/[，,；;]/)
    .filter((part) => !costMark.test(part))
    .join("，");
  if (!scope) return 0;
  if (/(没有|没|未|不曾|并没有)[^。！？]{0,10}(带来|换来|提升|提高|改善|进步|涨)/.test(scope)) {
    return -1;
  }
  if (/(反而|下降|掉了|降低|回落|滑落|退步)/.test(scope)) return -1;
  if (/(提升|提高|改善|进步|上升|涨|更好)/.test(scope)) return 1;
  return 0;
}

/**
 * 一句「谁最怎么样」里，说的是哪一轮。
 *
 * 「v3 性价比最高」的主语在前面，「性价比最高的一轮是 v3」的主语在后面，
 * 两种都得认。同一句里还可能提到别的轮次——
 * 所以看的是离这句评价最近的那一轮，不是最先出现的那一轮。
 */
function claimSubject(clause: string, match: RegExpMatchArray): string {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const before = [...clause.slice(0, start).matchAll(/[vV]\d+/g)];
  const after = [...clause.slice(end).matchAll(/[vV]\d+/g)];
  const last = before[before.length - 1];
  const first = after[0];
  const beforeId = last ? last[0].toLowerCase() : "";
  const beforeGap = last
    ? start - (last.index ?? 0) - last[0].length
    : Number.POSITIVE_INFINITY;
  let afterId = "";
  let afterGap = Number.POSITIVE_INFINITY;
  if (first) {
    const gap = first.index ?? 0;
    const between = clause.slice(end, end + gap);
    // 中间隔着别的评价（「最贵，……但性价比最高的是 v3」里的 v3 说的是性价比），
    // 这轮就不是它说的那一轮。
    const clean = !/(最高|最低|最多|最大|最贵|最划算|最有效|最明显)/.test(
      between,
    );
    if (clean && (gap <= 8 || /[是为：由由]/.test(between))) {
      afterId = first[0].toLowerCase();
      afterGap = gap;
    }
  }
  if (!beforeId) return afterId;
  if (!afterId) return beforeId;
  return afterGap < beforeGap ? afterId : beforeId;
}

/**
 * 阶梯这块的复查：每一轮到底涨了还是跌了。
 *
 * 评语里说「v6 没有带来成功率提升」——v6 明明比 v5 高，
 * 这话摆在旁边的图上一眼就能看出不对。
 *
 * 方向只看轮次后面那一段：「v2 到 v4 的成功率下滑」这种跨轮比较，
 * 不该算到 v2 头上。但「v2、v3、v5 四轮都提升」是并列，
 * 后面那几个字对前面几个轮次同样成立。
 */
function ladderAudit(
  steps: LadderStep[],
  bestValueId: string,
  dearestId: string,
): (text: string) => string[] {
  const delta = new Map<string, number>();
  steps.forEach((step, index) => {
    const previous = steps[index - 1];
    delta.set(
      step.id,
      previous ? step.summary.successRate - previous.summary.successRate : 0,
    );
  });
  const upIds = steps
    .filter((step, index) => (delta.get(step.id) ?? 0) > 0)
    .map((step) => step.id);
  const downIds = steps
    .filter((step, index) => (delta.get(step.id) ?? 0) < 0)
    .map((step) => step.id);

  return (text: string) => {
    const problems: string[] = [];
    for (const clause of clauses(text)) {
      const mentions = [...clause.matchAll(/[vV]\d+/g)];
      if (mentions.length === 0) continue;

      // 「除了 v4 轮次外，其他轮次都提升了」——
      // 被排除的那一轮不参与方向判断，它前面明写着「除」。
      const excluded = mentions.map((match, index) => {
        const before = clause.slice(0, match.index);
        const after = clause.slice(
          match.index + match[0].length,
          index + 1 < mentions.length
            ? mentions[index + 1].index
            : clause.length,
        );
        const excludedBy = /除[了]?[^，,。；]{0,12}$/.test(before);
        const closedBy = /^[^，,。；]{0,12}(外|以外)/.test(after);
        return excludedBy && closedBy;
      });

      // 每一轮自己的方向；方向跟着它后面那段话走。
      const own: number[] = [];
      const separators: string[] = [];
      for (let index = 0; index < mentions.length; index += 1) {
        const start = mentions[index].index + mentions[index][0].length;
        const end =
          index + 1 < mentions.length
            ? mentions[index + 1].index
            : clause.length;
        const window = clause.slice(start, end);
        if (index + 1 < mentions.length) {
          separators.push(clause.slice(start, mentions[index + 1].index));
        }
        own.push(
          excluded[index] || !/(成功率|成功|成绩|表现|收益|效果)/.test(window)
            ? 0
            : directionOf(window),
        );
      }

      // 并列（「v2、v3」）的轮次继承后面那个轮次的方向；
      // 区间（「v2 到 v7」）不算，前后是两个极端。
      const directions = [...own];
      for (let index = own.length - 2; index >= 0; index -= 1) {
        if (own[index] !== 0) continue;
        if (excluded[index]) continue;
        if (!/[、，,/]/.test(separators[index] ?? "")) continue;
        directions[index] = directions[index + 1];
      }

      const ids = mentions.map((match) => match[0].toLowerCase());
      for (let index = 0; index < ids.length; index += 1) {
        const direction = directions[index];
        if (direction === 0) continue;
        const change = delta.get(ids[index]);
        // 头一轮没有上一轮，涨跌无从谈起，不查。
        if (change === undefined || change === 0) continue;
        const actual = change > 0 ? 1 : -1;
        if (actual !== direction) {
          problems.push(
            `「${clause}」说 ${ids[index]} ${direction > 0 ? "提升了" : "没提升"}，` +
              `但事实里 ${ids[index]} 的成功率比上一轮${change > 0 ? "高" : "低"} ` +
              `${Math.abs(change * 100).toFixed(1)} 个百分点`,
          );
        }
      }

      // 「其中 v2、v3、v5、v7 四轮都提升」这种写法，
      // 说的像是提升过的轮次全在这儿——漏掉一轮就是错的。
      const count = clause.match(/([0-9]+|[一二两三四五六七八九十]+)\s*轮/);
      if (count) {
        const claimed = parseCount(count[1]);
        const listed = ids.filter((id) => delta.has(id));
        if (claimed !== null && listed.length === claimed && listed.length >= 2) {
          const expected = upIds.filter((id) => !listed.includes(id));
          // 只在意涨得不算小的那些轮次：差个零点几个百分点，说漏不算错。
          const notable = expected.filter(
            (id) => (delta.get(id) ?? 0) * 100 >= 1,
          );
          if (notable.length > 0) {
            problems.push(
              `「${clause}」只数了 ${claimed} 轮，事实里还轮有 ${notable.join("、")} 也有提升`,
            );
          }
        }
      }

      // 「v7 带来了最大的提升」——「提升」有两种读法：
      // 单轮涨得最多，还是最后成功率最高。
      // 「带来了提升」说的是这一轮的增量，「成功率最高」说的是终点。
      // 中间不能跨过标点：「性价比最高，提升了 13.6 个百分点」
      // 里「最高」说的是性价比，不是提升幅度。
      const superlative = clause.match(
        /(最大|最多|最明显|最有效|最高)[^。；，,、]{0,6}(提升|增益|进步|涨)/,
      );
      if (superlative) {
        const subject = claimSubject(clause, superlative);
        if (subject && delta.has(subject)) {
          const bestStep = upIds.reduce(
            (best, id) =>
              (delta.get(id) ?? 0) > (delta.get(best) ?? 0) ? id : best,
            upIds[0] ?? "",
          );
          const bestFinal = steps.reduce(
            (best, step) =>
              step.summary.successRate > best.summary.successRate ? step : best,
            steps[0],
          );
          // 说的是这一轮的增量，就该是涨得最多的那一轮。
          const aboutStep = /(带来|带来了|提升幅度|涨了最多)/.test(clause);
          const allowed = aboutStep
            ? [bestStep]
            : [bestStep, bestFinal.id];
          if (!allowed.includes(subject)) {
            problems.push(
              `「${clause}」说 ${subject} 的提升最大，` +
                `但事实里${aboutStep ? `涨得最多的是 ${bestStep}` : `涨得最多的是 ${bestStep}，成功率最高的是 ${bestFinal.id}`}`,
            );
          }
        }
      }

      // 「v1轮涨了9.1个百分点」——每一轮相对上一轮的涨跌是有数的，
      // 说出来的数得对得上。起点那一轮没有上一轮，说不了涨跌。
      //
      // 「v2 比 v1 涨了 9.1 个百分点」说的是 v2 这一轮，
      // 跟「v2轮涨了9.1个百分点」是一回事，两种写法都要算到 v2 头上。
      const compareClaims = [
        ...clause.matchAll(
          /(比|跟|和)\s*([vV]\d+)[^。；]{0,4}?(涨了|涨|跌了|跌|提升了|提升|下降了|下降)[（(]?\s*([0-9]+(?:\.[0-9]+)?)\s*个百分点/g,
        ),
      ];
      for (const item of compareClaims) {
        const before = clause.slice(0, item.index);
        const idsBefore = [...before.matchAll(/[vV]\d+/g)];
        const subject = idsBefore[idsBefore.length - 1]?.[0].toLowerCase();
        if (!subject || !delta.has(subject)) continue;
        const claimed = Number(item[4]);
        const actual = Math.abs((delta.get(subject) ?? 0) * 100);
        if (Math.abs(actual - claimed) >= 0.051) {
          problems.push(
            `「${clause}」说 ${subject} ${item[3]} ${claimed} 个百分点，` +
              (actual < 0.01
                ? `但事实里 ${subject} 是起点，没有上一轮，说不了涨跌`
                : `但事实里 ${subject} 相对上一轮是 ${actual.toFixed(1)} 个百分点`),
          );
        }
      }

      const deltaClaims = [
        ...clause.matchAll(
          /([vV]\d+)([^。；]{0,12}?)(涨了|涨|跌了|跌|提升了|提升|下降了|下降)[（(]?\s*([0-9]+(?:\.[0-9]+)?)\s*个百分点/g,
        ),
      ];
      for (const item of deltaClaims) {
        const id = item[1].toLowerCase();
        if (!delta.has(id)) continue;
        const before = clause.slice(0, item.index);
        // 「比 v1 涨了 9.1 个百分点」的主语是比号前的那一轮，上面已经算过了。
        if (/[比跟和]\s*$/.test(before)) continue;
        const between = item[2];
        // 中间隔着别的轮次，或者写的是「从 v1 到 v7」——
        // 那是起点到终点的差，不是某一轮的涨跌，交给别处查。
        if (/[vV]\d+/.test(between)) continue;
        if (/[到至~从]/.test(between)) continue;
        const claimed = Number(item[4]);
        const actual = Math.abs((delta.get(id) ?? 0) * 100);
        if (Math.abs(actual - claimed) >= 0.051) {
          problems.push(
            `「${clause}」说 ${id} ${item[3]} ${claimed} 个百分点，` +
              (actual < 0.01
                ? `但事实里 ${id} 是起点，没有上一轮，说不了涨跌`
                : `但事实里 ${id} 相对上一轮是 ${actual.toFixed(1)} 个百分点`),
          );
        }
      }

      // 「v3 性价比最高」说的是每提升一个百分点花得最少，
      // 跟涨得最多、成功率最高都不是一回事。
      const valueClaim = clause.match(
        /(性价比最高|最划算|每提升一个百分点花得最少|单位成本最低)/,
      );
      if (valueClaim) {
        const subject = claimSubject(clause, valueClaim);
        if (subject && delta.has(subject) && subject !== bestValueId) {
          problems.push(
            `「${clause}」说 ${subject} 性价比最高，` +
              `但事实里每提升一个百分点花得最少的是 ${bestValueId}`,
          );
        }
      }

      // 「v5 成本最高」——最贵的那一轮和涨得最多的那一轮不是同一轮。
      // 说在最贵的前面 («v5…最贵») 和说在最贵的后面的 («最贵的一轮是 v7») 都要查。
      const costClaim = clause.match(
        /(成本(也)?最高|成本最多|最贵|花得最多|最花钱|花钱最多)/,
      );
      if (costClaim) {
        const subject = claimSubject(clause, costClaim);
        if (subject && delta.has(subject) && subject !== dearestId) {
          problems.push(
            `「${clause}」说 ${subject} 最贵，` +
              `但事实里最贵的一轮是 ${dearestId}`,
          );
        }
      }
    }
    return problems;
  };
}

/**
 * 同一组事实之间，差值只可能是算好的那几个。
 *
 * 评语说「A 比 B 高 31.8 个百分点」，这个 31.8 必须就是
 * A 和 B 在事实里的真实差——不然就是模型自己心算出来的。
 */
function gapClaims(
  text: string,
  scopes: GapScope[],
  extraGaps: number[] = [],
): string[] {
  const problems: string[] = [];
  for (const clause of clauses(text)) {
    if (!/(差|距|拉开|高|低)/.test(clause)) continue;
    const match = clause.match(/([0-9]+(?:\.[0-9]+)?)\s*个百分点/);
    if (!match) continue;
    const claimed = Number(match[1]);
    const flat = normalize(clause);
    const matched = scopes.filter((scope) =>
      scope.names.every((name) => flat.includes(normalize(name))),
    );
    // 一次冒出好几对名字，说不清差值指的是哪一对，放过。
    if (matched.length !== 1) continue;
    const scope = matched[0];
    const ok =
      scope.gaps.some((gap) => Math.abs(gap - claimed) < 0.051) ||
      // 「最高与最低的落差」这种整体差值，不属于任何一对，
      // 但它本身也是算好的数，照单放行。
      extraGaps.some((gap) => Math.abs(gap - claimed) < 0.051);
    if (!ok) {
      problems.push(`「${clause}」里的 ${claimed} 个百分点对不上事实`);
    }
  }
  return problems;
}

/** 差值取一位小数，和事实里的写法保持一致。 */
function gapPercent(value: number): number {
  return Number(((value * 100).toFixed(1)));
}

/**
 * 两两配对：每一对名字之间，允许出现哪些差值。
 *
 * 差值可以有好几个——同一个对比，评语可能说的是成功率差，
 * 也可能说的是召回率差，只要数字对得上其中之一就行。
 */
function pairScopes(
  labels: string[],
  gapsOf: (a: string, b: string) => number[],
): GapScope[] {
  const scopes: GapScope[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      scopes.push({
        names: [labels[i], labels[j]],
        gaps: gapsOf(labels[i], labels[j]),
      });
    }
  }
  return scopes;
}


function ladderSection(report: ExperimentReport): Section | null {
  const steps = report.ladder ?? [];
  if (steps.length === 0) return null;
  const currency = report.costCurrency || "¥";
  const first = steps[0];
  const last = steps[steps.length - 1];

  // 单独看没换来收益的轮次，和被拉低的轮次，都摆成明明白白的事实。
  // 空的就写「无」——模型看到空数组容易自己脑补出一轮来。
  const flat = steps
    .map((step, index) => ({ step, previous: steps[index - 1] }))
    .filter(
      ({ step, previous }) =>
        previous &&
        step.summary.successRate <= previous.summary.successRate &&
        step.summary.totalCost > previous.summary.totalCost,
    );
  const dropped = steps
    .map((step, index) => ({ step, previous: steps[index - 1] }))
    .filter(
      ({ step, previous }) =>
        previous && step.summary.successRate < previous.summary.successRate,
    );

  // 哪几轮涨了、哪几轮跌了，直接写成名单。
  // 模型上次把 v6 说成「没带来提升」，v6 其实比 v5 高——
  // 名字摆在明面上，它就没有自由发挥的余地了。
  const up = steps.filter((step, index) => {
    const previous = steps[index - 1];
    return previous && step.summary.successRate > previous.summary.successRate;
  });
  const down = steps.filter((step, index) => {
    const previous = steps[index - 1];
    return previous && step.summary.successRate < previous.summary.successRate;
  });

  // 花钱最多的那一轮，和每一轮多花的钱摊到了多少成功率上。
  // 成本这块不给现成的话，模型就不提钱——这正是这张图要讲的事。
  const dearest = steps.reduce(
    (worst, step) =>
      step.summary.totalCost > worst.summary.totalCost ? step : worst,
    steps[0],
  );
  const totalCost = steps.reduce(
    (sum, step) => sum + step.summary.totalCost,
    0,
  );
  const costPerPoint = steps
    .map((step, index) => ({ step, previous: steps[index - 1] }))
    .filter(
      ({ step, previous }) =>
        previous && step.summary.successRate > previous.summary.successRate,
    )
    .map(({ step, previous }) => {
      const gained = step.summary.successRate - previous!.summary.successRate;
      const extraCost = step.summary.totalCost - previous!.summary.totalCost;
      return {
        轮次: step.id,
        涨幅: gained * 100,
        每点成本: extraCost / (gained * 100),
        这一轮的成功率变化: `${(gained * 100).toFixed(1)} 个百分点`,
        这一轮的成本变化:
          extraCost >= 0
            ? `多花了 ${money(extraCost, currency)}`
            : `反而省了 ${money(-extraCost, currency)}`,
        每提升一个百分点花了:
          extraCost >= 0
            ? money((extraCost / (gained * 100)), currency)
            : `省了 ${money(-extraCost / (gained * 100), currency)}`,
      };
    });

  // 涨得最多的那一轮，和性价比最高的那一轮，往往不是同一轮。
  // 模型每次都在这里搞混，两边都摆成名字，它就没有发挥的余地了。
  const biggestGain = costPerPoint.reduce(
    (best, item) => (item.涨幅 > best.涨幅 ? item : best),
    costPerPoint[0] ?? { 轮次: "无", 涨幅: 0, 每点成本: 0 },
  );
  const bestValue = costPerPoint.reduce(
    (best, item) => (item.每点成本 < best.每点成本 ? item : best),
    costPerPoint[0] ?? { 轮次: "无", 涨幅: 0, 每点成本: 0 },
  );
  const bestValueId = costPerPoint.length > 0 ? bestValue.轮次 : "";

  return {
    key: "ladder",
    title: "迭代阶梯",
    focus:
      "照着「逐轮一句话」说每一轮：哪一轮涨了、哪一轮跌了、涨了多少，" +
      "每一轮花了多少钱，成本和收益是不是对得上。" +
      "如果某轮没换来提升或者把成功率拉低了，也要点出来；" +
      "如果事实里写「无」，就说明没有这种情况，不要编一轮出来。" +
      "成本必须写进去，而且下面这三件事一件都不能漏：" +
      "这几轮一共花了多少钱、哪一轮最贵、" +
      "哪一轮每提升一个百分点花得最少（也就是性价比最高的那一轮）。",
    audit: (text) => {
      const scopes = pairScopes(
        steps.map((step) => step.id),
        (a, b) => {
          const left = steps.find((step) => step.id === a);
          const right = steps.find((step) => step.id === b);
          if (!left || !right) return [];
          return [
            gapPercent(
              Math.abs(left.summary.successRate - right.summary.successRate),
            ),
          ];
        },
      );
      return [
        ...ladderAudit(steps, bestValueId, dearest.id)(text),
        ...gapClaims(text, scopes),
        ...ladderCoverage(text, totalCost, dearest.id, bestValueId),
      ];
    },
    facts: {
      轮数: steps.length,
      每轮题目数: first?.summary.byCategory
        ? Object.values(first.summary.byCategory).reduce(
            (sum, item) => sum + item.total,
            0,
          )
        : 0,
      计价符号: currency,
      起点: {
        轮次: first?.id,
        成功率: first ? percent(first.summary.successRate) : "",
        证据召回率: first ? percent(first.retrievalMetrics.recallAtBudget) : "",
        成本: first ? money(first.summary.totalCost, currency) : "",
      },
      终点: {
        轮次: last?.id,
        成功率: last ? percent(last.summary.successRate) : "",
        证据召回率: last ? percent(last.retrievalMetrics.recallAtBudget) : "",
        成本: last ? money(last.summary.totalCost, currency) : "",
      },
      起点到终点的成功率变化:
        first && last
          ? `${((last.summary.successRate - first.summary.successRate) * 100).toFixed(1)} 个百分点`
          : "",
      起点到终点的成本变化:
        first && last
          ? money(last.summary.totalCost - first.summary.totalCost, currency)
          : "",
      全部轮次一共花了: money(totalCost, currency),
      最贵的一轮: {
        轮次: dearest.id,
        改了什么: dearest.change,
        本轮成本: money(dearest.summary.totalCost, currency),
        这一轮的上下文: `${Math.round(dearest.retrievalMetrics.avgContextChars)} 字符`,
      },
      提升的代价:
        costPerPoint.length === 0
          ? "无"
          : costPerPoint.map(
              ({ 轮次, 这一轮的成功率变化, 这一轮的成本变化, 每提升一个百分点花了 }) => ({
                轮次,
                这一轮的成功率变化,
                这一轮的成本变化,
                每提升一个百分点花了,
              }),
            ),
      涨得最多的一轮:
        costPerPoint.length === 0
          ? "无"
          : {
              轮次: biggestGain.轮次,
              成功率变化: biggestGain.这一轮的成功率变化,
              每提升一个百分点花了: biggestGain.每提升一个百分点花了,
            },
      性价比最高的一轮:
        costPerPoint.length === 0
          ? "无"
          : {
              轮次: bestValue.轮次,
              成功率变化: bestValue.这一轮的成功率变化,
              每提升一个百分点花了: bestValue.每提升一个百分点花了,
            },
      单独看没换来成功率提升的轮次:
        flat.length === 0
          ? "无"
          : flat.map(({ step, previous }) => ({
              轮次: step.id,
              成功率变化: `${(
                (step.summary.successRate - previous!.summary.successRate) *
                100
              ).toFixed(1)} 个百分点`,
              成本变化: money(
                step.summary.totalCost - previous!.summary.totalCost,
                currency,
              ),
            })),
      成功率上升的轮次: up.length === 0 ? "无" : up.map((step) => step.id),
      成功率下降的轮次: down.length === 0 ? "无" : down.map((step) => step.id),
      逐轮一句话: steps.map((step, index) => {
        const previous = steps[index - 1];
        const change = previous
          ? step.summary.successRate - previous.summary.successRate
          : 0;
        const costChange = previous
          ? step.summary.totalCost - previous.summary.totalCost
          : 0;
        const parts = [
          `${step.id}：成功率 ${percent(step.summary.successRate)}，` +
            `成本 ${money(step.summary.totalCost, currency)}`,
        ];
        if (!previous) {
          parts.push("这是起点，没有上一轮，谈不上涨跌");
        } else if (change > 0) {
          parts.push(`比 ${previous.id} 涨了 ${(change * 100).toFixed(1)} 个百分点`);
        } else if (change < 0) {
          parts.push(
            `比 ${previous.id} 跌了 ${(Math.abs(change) * 100).toFixed(1)} 个百分点`,
          );
        } else {
          parts.push(`跟 ${previous.id} 持平`);
        }
        if (previous && costChange > 0) {
          parts.push(`比上一轮多花了 ${money(costChange, currency)}`);
        } else if (previous && costChange < 0) {
          parts.push(`比上一轮省了 ${money(-costChange, currency)}`);
        }
        return parts.join("，");
      }),
      每一轮到底涨没涨: steps.map((step, index) => {
        const previous = steps[index - 1];
        const change = previous
          ? step.summary.successRate - previous.summary.successRate
          : 0;
        return `${step.id}：${
          !previous
            ? "起点"
            : change > 0
              ? `涨了 ${(change * 100).toFixed(1)} 个百分点`
              : change < 0
                ? `跌了 ${Math.abs(change * 100).toFixed(1)} 个百分点`
                : "没变"
        }`;
      }),
      成功率被拉低的轮次:
        dropped.length === 0
          ? "无"
          : dropped.map(({ step, previous }) => ({
              轮次: step.id,
              成功率变化: `${(
                (step.summary.successRate - previous!.summary.successRate) *
                100
              ).toFixed(1)} 个百分点`,
              同一轮的证据召回率变化: `${(
                (step.retrievalMetrics.recallAtBudget -
                  previous!.retrievalMetrics.recallAtBudget) *
                100
              ).toFixed(1)} 个百分点`,
            })),
      每轮: steps.map((step, index) => {
        const previous = steps[index - 1];
        const change = previous
          ? step.summary.successRate - previous.summary.successRate
          : 0;
        return {
          轮次: step.id,
          标题: step.title,
          改了什么: step.change,
          预期: step.hypothesis,
          成功率: percent(step.summary.successRate),
          相对上一轮的成功率变化: previous
            ? `${(change * 100).toFixed(1)} 个百分点`
            : "（起点，没有上一轮）",
          这一轮算不算带来了提升: !previous
            ? "起点，谈不上提升"
            : change > 0
              ? `带来了提升（${(change * 100).toFixed(1)} 个百分点）`
              : change < 0
                ? `把成功率拉低了（${Math.abs(change * 100).toFixed(1)} 个百分点）`
                : "成功率没变",
          judge均分: step.summary.avgJudgeScore.toFixed(2),
          证据召回率: percent(step.retrievalMetrics.recallAtBudget),
          平均上下文字符: Math.round(step.retrievalMetrics.avgContextChars),
          本轮成本: money(step.summary.totalCost, currency),
          失败归因: step.summary.byCategory,
        };
      }),
    },
  };
}

function strategiesSection(report: ExperimentReport): Section | null {
  const strategies = report.strategies ?? [];
  if (strategies.length === 0) return null;
  const currency = report.costCurrency || "¥";
  const bestRecall = Math.max(...strategies.map((item) => item.recallAt6));
  return {
    key: "strategies",
    title: "切分策略对比",
    focus:
      "说清哪种切法检索命中更好、哪种更省上下文，" +
      "如果这一段有生成层成功率，还要说清性价比最高的是哪一种。" +
      "也要说清代价：切得更准是不是就一定更贵。",
    audit: (text) => {
      // 同一种对比可能说的是召回率差，也可能说的是成功率差，
      // 两个都算数——只要数字对得上其中之一。
      const scopes = pairScopes(
        strategies.map((item) => item.strategy.label),
        (a, b) => {
          const left = strategies.find((item) => item.strategy.label === a);
          const right = strategies.find((item) => item.strategy.label === b);
          if (!left || !right) return [];
          const gaps = [
            gapPercent(Math.abs(left.recallAt6 - right.recallAt6)),
          ];
          if (left.successRate !== undefined && right.successRate !== undefined) {
            gaps.push(
              gapPercent(Math.abs(left.successRate - right.successRate)),
            );
          }
          return gaps;
        },
      );
      return gapClaims(text, scopes);
    },
    facts: {
      题数: strategies[0]?.cases.length ?? 0,
      计价符号: currency,
      最高的_recall_at_6: percent(bestRecall),
      每种策略: strategies.map((item) => ({
        策略: item.strategy.label,
        代码块数: item.chunkCount,
        平均上下文字符: Math.round(item.avgContextChars),
        recall_at_1: percent(item.recallAt1),
        recall_at_3: percent(item.recallAt3),
        recall_at_6: percent(item.recallAt6),
        与最高_recall_at_6的差距: `${((bestRecall - item.recallAt6) * 100).toFixed(1)} 个百分点`,
        MRR: item.mrr.toFixed(3),
        达标题数: `${item.cases.filter((entry) => entry.recallAt6 >= 1).length} / ${item.cases.length}`,
        成功率:
          item.successRate === undefined ? "没跑生成层" : percent(item.successRate),
        judge均分:
          item.avgJudgeScore === undefined
            ? "没跑生成层"
            : item.avgJudgeScore.toFixed(2),
        成本:
          item.totalCost === undefined
            ? "没跑生成层"
            : money(item.totalCost, currency),
      })),
    },
  };
}

function modelComparisonSection(report: ExperimentReport): Section | null {
  const comparison = report.modelComparison;
  if (!comparison || comparison.rows.length === 0) return null;
  const currency = report.costCurrency || "¥";

  // 主尺子下的排名，以及第一名和第二名差多少。
  // 这些差值在评测台这边算好再给模型，模型不自己心算——
  // 它心算过一次，就把「4.5 个百分点」说成了「0.3 分」。
  const ranked = comparison.rows
    .map((row) => ({
      row,
      cell: row.cells.find((cell) => cell.judgeModel === comparison.primaryJudge),
    }))
    .filter((item) => item.cell !== undefined)
    .sort((a, b) => (b.cell!.successRate ?? 0) - (a.cell!.successRate ?? 0));
  const leader = ranked[0];
  const runnerUp = ranked[1];
  const leaderGap =
    leader && runnerUp
      ? `${((leader.cell!.successRate - runnerUp.cell!.successRate) * 100).toFixed(1)} 个百分点`
      : "只有第一名，没有第二名";
  const weakestPair = [...comparison.agreementMatrix].sort(
    (a, b) => a.agreement - b.agreement,
  )[0];
  const widestRulerGap = comparison.agreementMatrix.reduce(
    (worst, item) => {
      const gap = Math.abs(item.judgeASuccessRate - item.judgeBSuccessRate);
      return gap > worst.gap ? { gap, item } : worst;
    },
    { gap: 0, item: undefined as (typeof comparison.agreementMatrix)[number] | undefined },
  );

  return {
    key: "modelComparison",
    title: "多模型对比",
    focus:
      "说清排名靠不靠得住：第一名和第二名差多少、换一把尺子会不会翻盘、" +
      "尺子之间的误差有多大，以及有没有自评偏袒。" +
      "结论要落在「排名该怎么读」上。",
    audit: (text) => {
      const labels = comparison.rows.map((row) => row.agentProfileLabel);
      const scopes: GapScope[] = pairScopes(
        labels,
        (a, b) => {
          const left = comparison.rows.find(
            (row) => row.agentProfileLabel === a,
          );
          const right = comparison.rows.find(
            (row) => row.agentProfileLabel === b,
          );
          if (!left || !right) return [];
          const leftCell = left.cells.find(
            (cell) => cell.judgeModel === comparison.primaryJudge,
          );
          const rightCell = right.cells.find(
            (cell) => cell.judgeModel === comparison.primaryJudge,
          );
          const gaps = [gapPercent(Math.abs(left.avgSuccessRate - right.avgSuccessRate))];
          if (leftCell && rightCell) {
            gaps.push(
              gapPercent(
                Math.abs(leftCell.successRate - rightCell.successRate),
              ),
            );
          }
          return gaps;
        },
      );

      // 尺子之间也会被拿来比成功率，尺子名是模型名，跟被测模型名分开算。
      for (const pair of comparison.agreementMatrix) {
        scopes.push({
          names: [pair.judgeA, pair.judgeB],
          gaps: [
            gapPercent(
              Math.abs(pair.judgeASuccessRate - pair.judgeBSuccessRate),
            ),
          ],
        });
      }

      return gapClaims(text, scopes);
    },
    facts: {
      题目数: comparison.rows[0]?.caseScores.length ?? 0,
      计价符号: currency,
      配置: {
        切分: comparison.chunking.label,
        topK: comparison.retrieval.topK,
        重排: comparison.retrieval.rerankMode ?? "none",
        提示词: comparison.promptVersion,
      },
      主尺子: comparison.primaryJudge,
      尺子: comparison.judges.map((judge) => ({
        名称: judge.label,
        模型: judge.model,
      })),
      主尺子下的排名: ranked.map((item, index) => ({
        名次: index + 1,
        名称: item.row.agentProfileLabel,
        模型: item.row.agentModel,
        成功率: percent(item.cell!.successRate),
        均分: item.cell!.avgJudgeScore.toFixed(2),
      })),
      第一名和第二名的成功率差距: leaderGap,
      一致率最低的一对尺子: weakestPair
        ? {
            尺子A: weakestPair.judgeA,
            尺子B: weakestPair.judgeB,
            一致率: percent(weakestPair.agreement),
            抽样题数: weakestPair.sampled,
            达标判定被翻转的次数: weakestPair.flips,
          }
        : "只有一把尺子",
      尺子之间最大的成功率差距: widestRulerGap.item
        ? `${(widestRulerGap.gap * 100).toFixed(1)} 个百分点（${widestRulerGap.item.judgeA} 与 ${widestRulerGap.item.judgeB}）`
        : "只有一把尺子",
      被测模型: comparison.rows.map((row) => ({
        名称: row.agentProfileLabel,
        模型: row.agentModel,
        各尺子成功率: row.cells.map((cell) => ({
          尺子: cell.judgeProfileLabel,
          成功率: percent(cell.successRate),
          均分: cell.avgJudgeScore.toFixed(2),
        })),
        平均成功率: percent(row.avgSuccessRate),
        平均均分: row.avgJudgeScore.toFixed(2),
        总成本: money(row.totalCost, currency),
        失败归因: row.failureKinds,
      })),
      尺子之间的一致率: comparison.agreementMatrix.map((item) => ({
        尺子A: item.judgeA,
        尺子B: item.judgeB,
        抽样题数: item.sampled,
        一致率: percent(item.agreement),
        达标判定被翻转的次数: item.flips,
        尺子A成功率: percent(item.judgeASuccessRate),
        尺子B成功率: percent(item.judgeBSuccessRate),
      })),
      自评偏袒: comparison.selfPreference.map((item) => ({
        尺子: item.judgeProfileLabel,
        给本家模型的均分: item.ownAvgScore.toFixed(2),
        给别家的均分: item.otherAvgScore.toFixed(2),
        差值: item.gap.toFixed(2),
      })),
    },
  };
}

function multiProjectSection(report: ExperimentReport): Section | null {
  const multi = report.multiProject;
  if (!multi || multi.rows.length === 0) return null;
  const currency = report.costCurrency || "¥";
  const ranked = [...multi.rows].sort((a, b) => b.successRate - a.successRate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  return {
    key: "multiProject",
    title: "多项目对比",
    focus:
      "说清同一把尺子换仓库之后还灵不灵：落差有多大、" +
      "哪个项目在样本内（配置就是在它身上调出来的）、" +
      "泛化检验的结论是什么。",
    audit: (text) => {
      const scopes = pairScopes(
        multi.rows.map((row) => row.label),
        (a, b) => {
          const left = multi.rows.find((row) => row.label === a);
          const right = multi.rows.find((row) => row.label === b);
          if (!left || !right) return [];
          return [
            gapPercent(Math.abs(left.successRate - right.successRate)),
            gapPercent(
              Math.abs(
                left.retrievalMetrics.recallAtBudget -
                  right.retrievalMetrics.recallAtBudget,
              ),
            ),
          ];
        },
      );
      return gapClaims(text, scopes, [
        gapPercent(best.successRate - worst.successRate),
      ]);
    },
    facts: {
      计价符号: currency,
      配置: {
        切分: multi.chunking.label,
        topK: multi.retrieval.topK,
        重排: multi.retrieval.rerankMode ?? "none",
        提示词: multi.promptVersion,
        来自阶梯的哪一轮: multi.step,
      },
      最高与最低的落差: `${((best.successRate - worst.successRate) * 100).toFixed(1)} 个百分点`,
      排名: ranked.map((row, index) => ({
        名次: index + 1,
        项目: row.label,
        成功率: percent(row.successRate),
        证据召回率: percent(row.retrievalMetrics.recallAtBudget),
        成本: money(row.totalCost, currency),
        与第一名的差距: `${((best.successRate - row.successRate) * 100).toFixed(1)} 个百分点`,
      })),
      每个项目: multi.rows.map((row) => ({
        项目: row.label,
        仓库: row.project,
        题数: row.questions,
        成功率: percent(row.successRate),
        judge均分: row.avgJudgeScore.toFixed(2),
        证据召回率: percent(row.retrievalMetrics.recallAtBudget),
        成本: money(row.totalCost, currency),
        失败归因: row.byCategory,
      })),
    },
  };
}

function sectionsOf(report: ExperimentReport): Section[] {
  return [
    ladderSection(report),
    strategiesSection(report),
    modelComparisonSection(report),
    multiProjectSection(report),
  ].filter((item): item is Section => item !== null);
}

const SYSTEM_PROMPT = [
  "你是评测报告的评语撰写者。你会拿到这次评测跑出来的真实数字（JSON）。",
  "写一段中文评语，3 到 6 句，只讲这一段该讲的事。",
  "硬要求：",
  "1. 只能引用 JSON 里出现过的数字，不许自己算别的数、不许编造任何数字或结论；",
  "2. 要比较两个数时用 JSON 里已经算好的差值字段，不要自己心算；",
  "3. JSON 里写「无」的地方就是真的没有，不要脑补出不存在的情况；",
  "4. 不要写「总的来说」「综上所述」「可以看出」这类空话；",
  "5. 不要用 markdown 标记、标题、列表、表格；",
  "6. 说清代价和边界，不要只报喜：失败的地方也要点出来；",
  "7. 不要复述 JSON 里的字段名。",
  "8. 每一轮涨还是跌，以 JSON 里「相对上一轮的成功率变化」为准，" +
    "不要凭印象判断哪一轮有提升；",
  "9. 提到某轮「带来了最大的提升」时，要看「提升的代价」里" +
    "每提升一个百分点花了多少，别把终点最高说成增量最大；",
  "10. 金额一律照抄 JSON 里已经算好的字符串，" +
    "比如「每提升一个百分点花了」，不要自己算、自己换算或改写格式；",
].join("\n");

/**
 * 让模型写一段评语，再验一遍它写的数字。
 *
 * 写完的数字只要有一个在事实里找不到，就重写一次；
 * 还不行就放弃这段评语——宁可没有，也不能让评测台自己编数字。
 */
async function writeSection(
  section: Section,
  llm: LlmConfig,
): Promise<{ text?: string; problem?: string }> {
  const facts = JSON.stringify(section.facts, null, 2);
  let extra = "";
  let problems: string[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completion = await chat(llm, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `板块：${section.title}\n` +
          `这一段要讲的重点：${section.focus}\n\n` +
          `真实数字：\n${facts}` +
          extra,
      },
    ]);
    const text = clean(completion.content);
    if (!text) {
      problems = ["模型没有写出内容"];
      continue;
    }
    const stray = unverifiedNumbers(stripMoney(text), stripMoney(facts));
    const badMoney = moneyClaims(text, facts);
    const claims = section.audit ? section.audit(text) : [];
    if (stray.length === 0 && badMoney.length === 0 && claims.length === 0) {
      return { text };
    }
    problems = [
      ...(stray.length > 0
        ? [`写了事实里没有的数字：${stray.join("、")}`]
        : []),
      ...(badMoney.length > 0
        ? [`这些钱数在事实里找不到：${badMoney.join("、")}`]
        : []),
      ...claims,
    ];
    extra =
      `\n\n你上一版有这些问题，请按真实数字重写一遍：\n` +
      problems.map((item) => `- ${item}`).join("\n") +
      `\n注意：上面指出的说法要么按事实改写，要么整句删掉。` +
      `不要保留任何和事实冲突的句子。` +
      `如果上面写的是「没有说到…」，说明该说的内容缺了，要按真实数字补上，` +
      `原来写得对的句子要留着。` +
      `重写时只使用「真实数字」里出现过的数字和已经算好的差值，不要自己心算。`;
  }

  return { problem: problems.join("；") };
}

/**
 * 给报告里的每个板块写一段评语。
 *
 * 某个板块失败不影响别的板块：评语只是锦上添花，
 * 数字本身才是报告的主体。
 */
export async function generateNarrative(
  report: ExperimentReport,
  llm: LlmConfig,
): Promise<{ narrative: ReportNarrative; failed: string[] }> {
  const narrative: ReportNarrative = {};
  const failed: string[] = [];

  for (const section of sectionsOf(report)) {
    try {
      const result = await writeSection(section, llm);
      if (result.text) narrative[section.key] = result.text;
      else failed.push(`${section.title}（${result.problem ?? "没写成"}）`);
    } catch (error) {
      failed.push(
        `${section.title}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }

  return { narrative: { ...narrative, model: llm.model }, failed };
}
