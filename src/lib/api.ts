/** 各业务接口共用的响应判断。接口形态：HTTP 状态码 + 业务 code / success / status / base_resp 其一。 */

/** 业务成功：code 为 0/200（数字或字符串）、success === true、status === "success"、base_resp.status_code === 0。 */
export function apiSucceeded(d: any): boolean {
  const br = d?.base_resp;
  if (br && br.status_code === 0) return true;
  const code = d?.code;
  if (typeof code === "number" && (code === 0 || code === 200)) return true;
  if (typeof code === "string" && (code === "0" || code === "200")) return true;
  if (d?.success === true) return true;
  return String(d?.status || "").toLowerCase() === "success";
}

/** HTTP 层鉴权失败（401/403）。 */
export function isAuthStatus(sc: number): boolean {
  return sc === 401 || sc === 403;
}

/** HTTP 层限频或临时故障（429 / 500 / 502 / 503 / 504）。 */
export function isTransientStatus(sc: number): boolean {
  return sc === 429 || sc === 500 || sc === 502 || sc === 503 || sc === 504;
}
