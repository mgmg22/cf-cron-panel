import { base64UrlToBytes } from "./encoding";

/** 解码 JWT payload；格式不对或解析失败返回 null。 */
function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** 解码 JWT payload 的 exp（毫秒）；失败或无 exp 返回 0。 */
export function decodeJwtExp(token: string): number {
  const exp = parseFloat(String(decodePayload(token)?.exp || 0)) * 1000;
  return Number.isFinite(exp) ? exp : 0;
}

/** 解码 JWT payload 的 sub（用户 ID）；失败或无 sub 返回空串。
 *  用于识别「未绑定用户身份」的空壳 token（sub 缺失时上游网关对 /v2/* 全部 401）。 */
export function decodeJwtSub(token: string): string {
  const sub = decodePayload(token)?.sub;
  return typeof sub === "string" ? sub : "";
}
