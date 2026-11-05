import { describe, expect, it } from "vitest";
import { apiSucceeded, isAuthStatus, isTransientStatus } from "../src/lib/api";

describe("apiSucceeded", () => {
  it.each([
    [{ code: 0 }],
    [{ code: 200 }],
    [{ code: "0" }],
    [{ code: "200" }],
    [{ success: true }],
    [{ status: "SUCCESS" }],
    [{ base_resp: { status_code: 0 } }],
  ])("成功形态 %j", (d) => expect(apiSucceeded(d)).toBe(true));

  it.each([
    [{ code: 1 }],
    [{ code: "500" }],
    [{ success: false }],
    [{ status: "fail" }],
    [{ base_resp: { status_code: 1 } }],
    [{}],
    [null],
    [undefined],
  ])("失败形态 %j", (d) => expect(apiSucceeded(d)).toBe(false));
});

describe("状态码分类", () => {
  it("isAuthStatus", () => {
    expect(isAuthStatus(401)).toBe(true);
    expect(isAuthStatus(403)).toBe(true);
    expect(isAuthStatus(200)).toBe(false);
  });
  it("isTransientStatus", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isTransientStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 501]) expect(isTransientStatus(s)).toBe(false);
  });
});
