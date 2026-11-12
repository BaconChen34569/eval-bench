/**
 * 限流闸门。
 *
 * 本地工作台允许把并发调高，但服务商的额度是它自己的：
 * 用户选 8 路、厂商只给 2 路时，多出来的请求会撞上 429。
 *
 * 撞上了怎么办？这里的选择是「自己降下来」，而不是把失败的题留在报告里：
 * 一收到 429 就把有效并发减半，同时让所有请求一起冷静一段时间；
 * 等连续成功若干次，再把并发一档一档加回去。
 *
 * 于是用户选 8 路跑完 22 题，看到的仍然是完整的一份结果，
 * 只是慢了一点，而不是满屏「请求失败 (429)」。
 *
 * 没有闸门时行为跟以前完全一样——命令行默认一次只跑一题，
 * 撞限流的概率本来就低，不必为它改动已发布的数字。
 */

/** 被限流之后冷静多久。节奏跟 llm.ts 里重试 429 的等待一致。 */
const COOLDOWN_MS = [3000, 8000, 20000, 40000];

/** 连续成功多少次，才把并发加回去一档。 */
const RECOVER_AFTER = 8;

export interface RateLimitEvent {
  /** 事件发生时的有效并发 */
  from: number;
  /** 调整之后的有效并发 */
  to: number;
  /** 这次要冷静多久（毫秒）；恢复并发时为 0 */
  waitMs: number;
  kind: "limited" | "recovered";
}

export class RateLimitGovernor {
  /** 用户选的上限 */
  private readonly cap: number;
  /** 当前真正允许的同时请求数 */
  private limit: number;
  /** 现在有多少个请求在飞 */
  private inFlight = 0;
  /** 冷却到什么时候 */
  private cooldownUntil = 0;
  /** 连续被限流了几次 */
  private strikes = 0;
  /** 连续成功了几次 */
  private streak = 0;
  /** 有变动了就通知外面，工作台日志用它说话 */
  onEvent?: (event: RateLimitEvent) => void;

  constructor(cap = 1) {
    this.cap = Math.max(1, Math.floor(cap));
    this.limit = this.cap;
  }

  /** 现在的有效并发：用户选了 8、服务商只给 2，这里就会变成 2。 */
  get effectiveLimit(): number {
    return this.limit;
  }

  /**
   * 拿一个请求名额。
   *
   * 拿不到就等：等冷却过去，也等别人腾出位置。
   * 有效并发最低留 1，所以不会出现所有 worker 一起干等。
   */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now >= this.cooldownUntil && this.inFlight < this.limit) {
        this.inFlight += 1;
        return;
      }
      const wait = Math.min(
        2000,
        Math.max(100, this.cooldownUntil - now, 200),
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /** 用完名额。 */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /**
   * 服务商说「你太快了」。
   *
   * 并发减半（下限 1 路），并让所有人一起冷静。
   * 冷静时间随被限流的次数递增：一次可能是巧合，第三次就是额度真的不够。
   */
  onRateLimited(): RateLimitEvent {
    this.strikes += 1;
    this.streak = 0;
    const waitMs =
      COOLDOWN_MS[Math.min(this.strikes - 1, COOLDOWN_MS.length - 1)];
    const from = this.limit;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.cooldownUntil = Date.now() + waitMs;
    return this.emit({ from, to: this.limit, waitMs, kind: "limited" });
  }

  /** 一次请求成功了。连续成功够多，就把并发加回去一档。 */
  onSuccess(): void {
    this.streak += 1;
    if (this.streak < RECOVER_AFTER || this.limit >= this.cap) return;
    this.streak = 0;
    const from = this.limit;
    this.limit += 1;
    this.emit({ from, to: this.limit, waitMs: 0, kind: "recovered" });
  }

  private emit(event: RateLimitEvent): RateLimitEvent {
    this.onEvent?.(event);
    return event;
  }
}
