import { describe, expect, it } from "vitest";
import {
  cleanJsonResponse,
  completeContent,
  hasBlackXykName,
  hasWhiteBankName,
  hasWhiteWord,
} from "../src/tasks/xb";

describe("cleanJsonResponse", () => {
  it("剥离 ```json 围栏，提取数组", () => {
    expect(cleanJsonResponse('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
  });
  it("前后有说明文字时提取首个 [ 到最后一个 ]", () => {
    expect(cleanJsonResponse('结果：[1,2,3] 完毕')).toBe("[1,2,3]");
  });
  it("提取内容不是合法 JSON 时原样返回", () => {
    expect(cleanJsonResponse("[not json]")).toBe("[not json]");
    expect(cleanJsonResponse("无数组")).toBe("无数组");
  });
  it("空数组", () => {
    expect(cleanJsonResponse("[]")).toBe("[]");
  });
});

describe("completeContent", () => {
  it("把文本是 http 链接的 <a> 替换成 markdown 链接", () => {
    const out = completeContent("看 http://a.com/x 好", [{ href: "http://real.com", text: "http://a.com/x" }]);
    expect(out).toBe("看 [http://real.com](http://real.com) 好");
  });
  it("链接文本不是 URL 或 href 为空则不替换", () => {
    expect(completeContent("点这里", [{ href: "http://x", text: "点这里" }])).toBe("点这里");
    expect(completeContent("http://a.com", [{ href: "", text: "http://a.com" }])).toBe("http://a.com");
  });
  it("trim 首尾空白", () => {
    expect(completeContent("  hi \n", [])).toBe("hi");
  });
});

describe("标题词表判断", () => {
  it("白名单命中", () => {
    expect(hasWhiteWord("云闪付立减")).toBe(true);
    expect(hasWhiteWord("今天天气")).toBe(false);
    expect(hasWhiteBankName("中国银行活动")).toBe(true);
    expect(hasWhiteBankName("建设银行活动")).toBe(false);
  });
  it("信用卡名 + 仅借记卡银行 才算「无该行信用卡」", () => {
    expect(hasBlackXykName("中行信用卡")).toBe(true);
    expect(hasBlackXykName("工行信用卡")).toBe(false); // 工行不在 cxk 名单
    expect(hasBlackXykName("中行借记卡")).toBe(false);
  });
});
