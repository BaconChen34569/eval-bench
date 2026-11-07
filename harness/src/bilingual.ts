/**
 * 中文提问 + 英文代码：术语对不上，检索就等于瞎猜。
 *
 * 实测的失败模式（22 题里 7 题「定位错了」，其中 6 题证据召回为 0），
 * 大多出在这里：问题里写「错误处理器」「模板」「蓝图」，代码里写的是
 * error handler、template、blueprint。字面上一个词都不重合，
 * BM25 再准也排不出来。
 *
 * 这一层做的事很简单：把问题里出现的中文术语，换成代码里可能用的英文词，
 * 加进查询词里一起参与打分。它不改切分、不改模型、不看标准答案，
 * 是一层纯字面的术语桥。
 *
 * 词表刻意保持通用（Web / Python 常用词汇），不做针对某道题的特判；
 * 它解决的是「中文问法与英文代码之间没有字面交集」这一类问题。
 */
const BILINGUAL_TERMS: Record<string, string[]> = {
  异常: ["exception", "error", "raise"],
  错误: ["error", "exception"],
  处理器: ["handler", "handle"],
  钩子: ["hook"],
  中间件: ["middleware"],
  模板: ["template", "jinja"],
  蓝图: ["blueprint"],
  静态文件: ["static"],
  响应: ["response"],
  请求: ["request"],
  上下文: ["context"],
  会话: ["session"],
  路由: ["route", "url"],
  视图: ["view"],
  表单: ["form"],
  配置: ["config"],
  日志: ["log"],
  缓存: ["cache"],
  序列化: ["serialize", "json", "dumps"],
  序列化器: ["serializer"],
  签名: ["sign", "signature"],
  摘要: ["sha1", "digest", "hash"],
  盐: ["salt"],
  工厂: ["factory"],
  注册: ["register"],
  装饰器: ["decorator"],
  生成器: ["generator", "yield"],
  调试: ["debug"],
  重定向: ["redirect"],
  状态码: ["status"],
  响应头: ["header"],
  线程: ["thread"],
  内存: ["memory"],
  测试: ["test"],
  模块: ["module"],
  文件: ["file"],
  方法: ["method"],
  函数: ["function", "def"],
  类: ["class"],
  继承: ["inherit", "base"],
  字段: ["field"],
  字典: ["dict"],
  列表: ["list"],
  参数: ["args", "kwargs", "param"],
  抛出: ["raise"],
  返回: ["return"],
  生命周期: ["lifecycle"],
  输入: ["input"],
  输出: ["output"],
  请求体: ["request", "body"],
  状态: ["state", "status"],
  顺序: ["order", "first"],
  优先: ["first", "priority"],
  目录: ["dir", "directory", "folder"],
  查找: ["find", "lookup", "search"],
  渲染: ["render"],
  分发: ["dispatch"],
  加载: ["load"],
  保存: ["save"],
  读取: ["read"],
  写入: ["write"],
};

/**
 * 把问题里的中文术语展开成英文候选词。
 *
 * 命中最长的词优先：先匹配「静态文件」，再匹配「文件」，
 * 免得长词被短词切碎。
 */
export function expandQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  const entries = Object.entries(BILINGUAL_TERMS).sort((a, b) => b[0].length - a[0].length);
  for (const [chinese, english] of entries) {
    if (!query.includes(chinese)) continue;
    for (const word of english) terms.add(word);
  }
  return [...terms];
}
