import { describe, expect, it } from "vitest";
import { decodeJwtExp, decodeJwtSub } from "../src/lib/jwt";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function jwt(payload: unknown): string {
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("decodeJwtExp", () => {
  it("返回毫秒", () => {
    expect(decodeJwtExp(jwt({ exp: 1700000000 }))).toBe(1700000000_000);
  });
  it("无 exp / 非法格式返回 0", () => {
    expect(decodeJwtExp(jwt({}))).toBe(0);
    expect(decodeJwtExp("abc")).toBe(0);
    expect(decodeJwtExp("a.!!!.c")).toBe(0);
    expect(decodeJwtExp("")).toBe(0);
  });
  it("base64url 含 - _ 且需补 = 的 payload", () => {
    const token = jwt({ exp: 1700000000, name: "???>>>" });
    expect(decodeJwtExp(token)).toBe(1700000000_000);
  });
  it("多字节 payload（UTF-8）", () => {
    expect(decodeJwtExp(jwt({ exp: 1, u: "你好" }))).toBe(1000);
  });
});

describe("decodeJwtSub", () => {
  it("返回 sub", () => {
    expect(decodeJwtSub(jwt({ sub: "u123" }))).toBe("u123");
  });
  it("缺失 / 非字符串 / 非法 token 返回空串", () => {
    expect(decodeJwtSub(jwt({}))).toBe("");
    expect(decodeJwtSub(jwt({ sub: 123 }))).toBe("");
    expect(decodeJwtSub("x.y")).toBe("");
  });
});
