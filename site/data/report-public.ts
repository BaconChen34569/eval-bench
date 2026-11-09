import raw from "./report.json";

import { setReport, type ExperimentReport } from "./report";

/**
 * 公开站那一版报告。
 *
 * 只有公开站需要这份构建期写死的数据：
 * 本地工作台从空数据开始，用户跑完评测再自己载入，
 * 所以工作台的产物里不会塞进这一份 1MB 多的示例。
 *
 * 副作用模块：import 它就等于把报告装进数据容器。
 */
setReport(raw as unknown as ExperimentReport);
