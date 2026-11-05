// 5 段 cron（分 时 日 月 周）解析与匹配，统一按北京时间（UTC+8）计算。
// 支持：星号、列表 a,b、范围 a-b、步长（星号/n、a-b/n、a/n）；周 0-7（0 和 7 都是周日）。
// 日与周同时受限（均不以星号开头）时按标准 cron 取「或」，否则取「与」。
// 不支持名称（JAN / MON）和 6 段秒级。

const BJ_OFFSET_MS = 8 * 3600_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>; // 周日统一存 0（集合里不会出现 7）
  domStar: boolean;
  dowStar: boolean;
}

function parseField(text: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`${label}字段为空`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${label}字段 "${part}" 格式错误`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`${label}字段步长 "${stepPart}" 无效`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
      if (!m) throw new Error(`${label}字段 "${part}" 格式错误`);
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : stepPart !== undefined ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${label}字段 "${part}" 超出范围 ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析失败抛出带中文原因的 Error。 */
export function parseCron(expr: string): CronSpec {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 须为 5 段：分 时 日 月 周（不支持秒级）");
  const [m, h, d, mo, w] = parts;
  const dow = new Set<number>();
  for (const v of parseField(w, 0, 7, "周")) dow.add(v === 7 ? 0 : v);
  return {
    minute: parseField(m, 0, 59, "分"),
    hour: parseField(h, 0, 23, "时"),
    dom: parseField(d, 1, 31, "日"),
    month: parseField(mo, 1, 12, "月"),
    dow,
    domStar: d.startsWith("*"),
    dowStar: w.startsWith("*"),
  };
}

function bjFields(ms: number) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}

function dayMatches(spec: CronSpec, f: { dom: number; dow: number }): boolean {
  const domOk = spec.dom.has(f.dom);
  const dowOk = spec.dow.has(f.dow);
  return !spec.domStar && !spec.dowStar ? domOk || dowOk : domOk && dowOk;
}

/** 该时刻（精确到分钟）是否命中。 */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  const f = bjFields(date.getTime());
  return spec.minute.has(f.minute) && spec.hour.has(f.hour) && spec.month.has(f.month) && dayMatches(spec, f);
}

/** `after` 之后（不含）下一次触发时刻；366 天内没有则返回 null。 */
export function nextRun(spec: CronSpec, after: Date, maxDays = 366): Date | null {
  let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = t + maxDays * DAY_MS;
  while (t <= end) {
    const f = bjFields(t);
    if (!spec.month.has(f.month) || !dayMatches(spec, f)) {
      // 跳到北京时间次日 00:00
      t = Math.floor((t + BJ_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - BJ_OFFSET_MS;
    } else if (!spec.hour.has(f.hour)) {
      t = Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
    } else if (!spec.minute.has(f.minute)) {
      t += MINUTE_MS;
    } else {
      return new Date(t);
    }
  }
  return null;
}

/** 校验表达式；合法返回空串，否则返回原因（含「永远不会触发」）。 */
export function validateCron(expr: string): string {
  try {
    const spec = parseCron(expr);
    return nextRun(spec, new Date()) ? "" : "该表达式在未来一年内不会触发";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
