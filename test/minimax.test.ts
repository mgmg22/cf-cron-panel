import { describe, expect, it } from "vitest";
import { cleanValue, pyQuotePlus } from "../src/tasks/minimax";

describe("pyQuotePlus（须与 Python urllib.parse.quote_plus 一致）", () => {
  it("安全字符不转义", () => {
    expect(pyQuotePlus("AZaz09_.-~")).toBe("AZaz09_.-~");
  });
  it("空格 -> +", () => {
    expect(pyQuotePlus("a b")).toBe("a+b");
  });
  it("保留字符按大写十六进制转义", () => {
    expect(pyQuotePlus("a/b?c=d&e")).toBe("a%2Fb%3Fc%3Dd%26e");
    expect(pyQuotePlus("*'()!")).toBe("%2A%27%28%29%21");
  });
  it("空串", () => {
    expect(pyQuotePlus("")).toBe("");
  });
  it("非 ASCII 字符按 UTF-8 字节转义（与 Python 一致）", () => {
    expect(pyQuotePlus("你")).toBe("%E4%BD%A0");
    expect(pyQuotePlus("é a")).toBe("%C3%A9+a");
    expect(pyQuotePlus("😀")).toBe("%F0%9F%98%80");
  });
});

describe("cleanValue", () => {
  it("去首尾空白", () => {
    expect(cleanValue("  abc \n")).toBe("abc");
  });
  it("去成对引号（含嵌套与引号内空白）", () => {
    expect(cleanValue('"abc"')).toBe("abc");
    expect(cleanValue("'abc'")).toBe("abc");
    expect(cleanValue(`" 'abc' "`)).toBe("abc");
  });
  it("不成对的引号保留", () => {
    expect(cleanValue(`"abc'`)).toBe(`"abc'`);
    expect(cleanValue(`"abc`)).toBe(`"abc`);
  });
  it("空/undefined 输入", () => {
    expect(cleanValue("")).toBe("");
    expect(cleanValue(undefined as unknown as string)).toBe("");
  });
});
