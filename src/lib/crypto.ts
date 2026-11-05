/// WebCrypto 版 ECDSA P-256/SHA-256 签名：
/// - env 里的私钥是 base64(PEM) 单行，先还原成 PEM 文本；
/// - WebCrypto 不能吃 PEM，剥头尾得到 DER 再 importKey('pkcs8')；
/// - crypto.subtle.sign 返回 IEEE P1363（raw r||s），需拆成 (r,s) 后做低 s 归一化，
///   再重编码成 DER（Trae 服务端按 DER 校验）。

import { base64ToBytes, bytesToBase64, bytesToHex } from "./encoding";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function decodeB64ToString(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

/** 还原 PEM 文本：已是 PEM 则原样；否则当 base64(PEM) 解码；再不行当裸 DER 补头尾。 */
export function resolvePem(raw: string, keyType: "PRIVATE" | "PUBLIC" = "PRIVATE"): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (s.includes("-----BEGIN")) return s;
  const head = `-----BEGIN ${keyType} KEY-----`;
  const tail = `-----END ${keyType} KEY-----`;
  try {
    const txt = decodeB64ToString(s);
    if (txt.includes("-----BEGIN")) return txt;
    return `${head}\n${s}\n${tail}`;
  } catch {
    return `${head}\n${s}\n${tail}`;
  }
}

function pemBodyToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN[^-]+-----/, "")
    .replace(/-----END[^-]+-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

export async function importPrivateKey(rawPem: string): Promise<CryptoKey> {
  const der = pemBodyToDer(resolvePem(rawPem));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function bigintToBytes(x: bigint, minLen = 32): Uint8Array {
  let hex = x.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  while (hex.length < minLen * 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encodeDerInteger(x: bigint): Uint8Array {
  // 最小 DER 编码：去掉前导 0x00，首字节 >=0x80 时补一个 0x00
  let b = bigintToBytes(x, 1);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) {
    const nb = new Uint8Array(b.length + 1);
    nb.set(b, 1);
    b = nb;
  }
  return b;
}

export function encodeDer(r: bigint, s: bigint): Uint8Array {
  const rb = encodeDerInteger(r);
  const sb = encodeDerInteger(s);
  const body = new Uint8Array(2 + rb.length + 2 + sb.length);
  let o = 0;
  body[o++] = 0x02; body[o++] = rb.length; body.set(rb, o); o += rb.length;
  body[o++] = 0x02; body[o++] = sb.length; body.set(sb, o);
  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30; out[1] = body.length; out.set(body, 2);
  return out;
}

/** 解析 WebCrypto 的 IEEE P1363 签名（高半 r，低半 s，各 32 字节）。 */
function parseRawSignature(sig: Uint8Array): { r: bigint; s: bigint } {
  const half = sig.length / 2;
  const r = BigInt("0x" + bytesToHex(sig.subarray(0, half)));
  const s = BigInt("0x" + bytesToHex(sig.subarray(half)));
  return { r, s };
}

/** 对 data 做 ECDSA P-256/SHA-256 签名，返回 base64(DER)，并做低 s 归一化。 */
export async function signEcdsaP256(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data),
  );
  const { r, s } = parseRawSignature(raw);
  const sNorm = s > P256_N / 2n ? P256_N - s : s;
  return bytesToBase64(encodeDer(r, sNorm));
}

/** 由私钥 material 直接对 canonical 字符串签名（Trae 用）。 */
export async function signCanonical(privatePem: string, canonical: string): Promise<string> {
  const key = await importPrivateKey(privatePem);
  return signEcdsaP256(key, new TextEncoder().encode(canonical));
}
