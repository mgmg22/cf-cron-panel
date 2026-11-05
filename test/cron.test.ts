import { describe, expect, it } from "vitest";
import { cronMatches, nextRun, parseCron, validateCron } from "../src/lib/cron";

/** 北京时间 -> Date（UTC = 北京 - 8h）。 */
const bj = (y: number, mo: number, d: number, h: number, mi: number) => new Date(Date.UTC(y, mo - 1, d, h - 8, mi));
const m = (expr: string, d: Date) => cronMatches(parseCron(expr), d);

describe("parseCron", () => {
  it.each([
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "a * * * *",
    "1,,2 * * * *",
    "1/2/3 * * * *",
    "",
  ])("非法表达式 %j 抛出带原因的错误", (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });

  it("接受常见写法", () => {
    for (const e of ["* * * * *", "*/5 * * * *", "0 9-18/3 * * 1-5", "3,33 8-23 * * *", "0 0 1 1 *", "0 0 * * 7", "5/10 * * * *"]) {
      expect(() => parseCron(e)).not.toThrow();
    }
  });
});

describe("cronMatches（北京时间）", () => {
  it("UTC 16:08 即北京 00:08", () => {
    expect(m("8 0 * * *", new Date("2026-01-01T16:08:00Z"))).toBe(true);
    expect(m("8 0 * * *", new Date("2026-01-01T00:08:00Z"))).toBe(false);
  });
  it("分/时列表与范围", () => {
    expect(m("3,33 8-23 * * *", bj(2026, 3, 5, 8, 3))).toBe(true);
    expect(m("3,33 8-23 * * *", bj(2026, 3, 5, 23, 33))).toBe(true);
    expect(m("3,33 8-23 * * *", bj(2026, 3, 5, 7, 33))).toBe(false);
    expect(m("3,33 8-23 * * *", bj(2026, 3, 5, 8, 4))).toBe(false);
  });
  it("步长", () => {
    expect(m("*/15 * * * *", bj(2026, 3, 5, 10, 15))).toBe(true);
    expect(m("*/15 * * * *", bj(2026, 3, 5, 10, 10))).toBe(false);
    expect(m("5/20 * * * *", bj(2026, 3, 5, 10, 45))).toBe(true); // 5,25,45
  });
  it("日与周同时受限时取「或」", () => {
    // 2024-01-01 周一，2024-01-02 周二，2024-01-03 周三
    expect(m("0 0 2 * 1", bj(2024, 1, 1, 0, 0))).toBe(true); // 周一
    expect(m("0 0 2 * 1", bj(2024, 1, 2, 0, 0))).toBe(true); // 2 号
    expect(m("0 0 2 * 1", bj(2024, 1, 3, 0, 0))).toBe(false);
  });
  it("只限日或只限周时取「与」", () => {
    expect(m("0 0 * * 1", bj(2024, 1, 2, 0, 0))).toBe(false);
    expect(m("0 0 2 * *", bj(2024, 1, 2, 0, 0))).toBe(true);
  });
  it("周 0 与 7 都是周日", () => {
    expect(m("0 0 * * 7", bj(2024, 1, 7, 0, 0))).toBe(true);
    expect(m("0 0 * * 0", bj(2024, 1, 7, 0, 0))).toBe(true);
  });
});

describe("nextRun", () => {
  it("同一天稍后 / 次日", () => {
    expect(nextRun(parseCron("8 0 * * *"), bj(2024, 1, 1, 0, 7))).toEqual(bj(2024, 1, 1, 0, 8));
    expect(nextRun(parseCron("8 0 * * *"), bj(2024, 1, 1, 0, 8))).toEqual(bj(2024, 1, 2, 0, 8)); // 严格晚于 after
  });
  it("跨天并跳过不在范围的小时", () => {
    expect(nextRun(parseCron("3,33 8-23 * * *"), bj(2024, 1, 1, 23, 33))).toEqual(bj(2024, 1, 2, 8, 3));
    expect(nextRun(parseCron("3,33 8-23 * * *"), bj(2024, 1, 1, 3, 0))).toEqual(bj(2024, 1, 1, 8, 3));
  });
  it("跨月", () => {
    expect(nextRun(parseCron("0 0 1 3 *"), bj(2024, 1, 1, 0, 0))).toEqual(bj(2024, 3, 1, 0, 0));
  });
  it("每分钟", () => {
    expect(nextRun(parseCron("* * * * *"), bj(2024, 1, 1, 0, 0))).toEqual(bj(2024, 1, 1, 0, 1));
  });
  it("一年内不会触发返回 null", () => {
    expect(nextRun(parseCron("0 0 30 2 *"), bj(2024, 1, 1, 0, 0))).toBeNull();
  });
});

describe("validateCron", () => {
  it("合法返回空串", () => {
    expect(validateCron("8 0 * * *")).toBe("");
  });
  it("非法返回原因", () => {
    expect(validateCron("* * * *")).toContain("5 段");
    expect(validateCron("60 * * * *")).toContain("超出范围");
    expect(validateCron("0 0 30 2 *")).toContain("不会触发");
  });
});
