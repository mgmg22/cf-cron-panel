import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeDer, resolvePem, signCanonical, signEcdsaP256, importPrivateKey } from "../src/lib/crypto";

/** 极简 DER 解析：SEQUENCE{INTEGER r, INTEGER s}，仅覆盖本项目的单字节长度。 */
function parseDer(der: Uint8Array): { r: bigint; s: bigint } {
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(der.length - 2);
  let o = 2;
  const ints: bigint[] = [];
  for (let k = 0; k < 2; k++) {
    expect(der[o++]).toBe(0x02);
    const len = der[o++];
    const bytes = der.subarray(o, o + len);
    o += len;
    // 最小编码：首字节为 0 时下一字节必须 >= 0x80
    if (bytes.length > 1 && bytes[0] === 0) expect(bytes[1] & 0x80).toBe(0x80);
    expect(bytes[0] & 0x80).toBe(0); // 非负
    ints.push(BigInt("0x" + Buffer.from(bytes).toString("hex")));
  }
  expect(o).toBe(der.length);
  return { r: ints[0], s: ints[1] };
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

describe("encodeDer", () => {
  it("小整数最小编码", () => {
    expect(Array.from(encodeDer(1n, 2n))).toEqual([0x30, 6, 0x02, 1, 1, 0x02, 1, 2]);
  });
  it("高位为 1 时补 0x00", () => {
    expect(Array.from(encodeDer(0x80n, 0x7fn))).toEqual([0x30, 7, 0x02, 2, 0, 0x80, 0x02, 1, 0x7f]);
  });
  it("32 字节大整数往返", () => {
    const r = N - 1n;
    const s = 0x7fffffff_00000000_ffffffff_ffffffff_5d576e73_57a4501d_dfe92f46_681b20a0n;
    expect(parseDer(encodeDer(r, s))).toEqual({ r, s });
  });
});

describe("resolvePem", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----";
  it("空输入返回空串", () => {
    expect(resolvePem("")).toBe("");
    expect(resolvePem("   ")).toBe("");
  });
  it("真 PEM 原样返回", () => {
    expect(resolvePem(pem)).toBe(pem);
  });
  it("base64(PEM) 单行被还原", () => {
    expect(resolvePem(Buffer.from(pem).toString("base64"))).toBe(pem);
  });
  it("裸 DER base64 补头尾，并按 keyType", () => {
    expect(resolvePem("QUJD", "PUBLIC")).toBe("-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----");
  });
});

describe("ECDSA 签名", () => {
  async function newKey() {
    const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`;
    return { kp, pem };
  }

  it("签名为合法 DER，且 s 已低位归一化，可用公钥校验", async () => {
    const { kp, pem } = await newKey();
    const data = new TextEncoder().encode("POST\n/path\nclient\nrefresh\n1700000000\nnonce");
    // 多次签名，覆盖 s 落在高/低半区的两种情况
    for (let i = 0; i < 20; i++) {
      const b64 = await signCanonical(pem, new TextDecoder().decode(data));
      const { r, s } = parseDer(new Uint8Array(Buffer.from(b64, "base64")));
      expect(s <= N / 2n).toBe(true);
      const raw = new Uint8Array(64);
      raw.set(Buffer.from(r.toString(16).padStart(64, "0"), "hex"), 0);
      raw.set(Buffer.from(s.toString(16).padStart(64, "0"), "hex"), 32);
      const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, raw, data);
      expect(ok).toBe(true);
    }
  });

  it("支持 base64(PEM) 形式的私钥", async () => {
    const { pem } = await newKey();
    const key = await importPrivateKey(Buffer.from(pem).toString("base64"));
    const sig = await signEcdsaP256(key, new Uint8Array([1, 2, 3]));
    expect(sig.length).toBeGreaterThan(0);
  });
});
