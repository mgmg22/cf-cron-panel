/** 共用的编码小工具：base64 / base64url / hex / 随机十六进制串。无业务逻辑。 */

/** 标准 base64 -> 字节；先去掉所有空白。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url -> 字节：还原 -/_，再按 (4 - len%4)%4 补 =。 */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b + "=".repeat((4 - (b.length % 4)) % 4));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesToHex(bytes: Uint8Array): string {
  let h = "";
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, "0");
  return h;
}

/** 密码学随机的 n 字节，输出 2n 位小写十六进制。 */
export function randomHex(byteLen: number): string {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
