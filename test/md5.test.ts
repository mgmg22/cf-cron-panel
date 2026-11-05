import { describe, expect, it } from "vitest";
import { md5hex } from "../src/lib/md5";

describe("md5hex", () => {
  it("RFC 1321 标准向量", () => {
    expect(md5hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5hex("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
  });
  it("长输入（跨多个 64 字节块）", () => {
    expect(md5hex("1234567890".repeat(8))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });
  it("多字节字符按 UTF-8 处理", () => {
    expect(md5hex("你好")).toBe("7eca689f0d3389d9dea66ae112e5cfd7");
  });
});
