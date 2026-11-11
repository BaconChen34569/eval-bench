/**
 * 并发跑一批任务。
 *
 * 评测慢在等模型解码，一个请求一个请求地等，时间全耗在等待上。
 * 几道题同时发出去，整体时间就从「所有题加起来」变成「最慢的那道题」。
 *
 * 返回结果按输入顺序排列：并发只影响什么时候拿到结果，不影响报告里的顺序，
 * 所以同一份配置跑两次出来的报告仍然能逐条对照。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: size }, () => lane()));
  return results;
}
