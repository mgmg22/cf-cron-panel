/** 最小 fetch 封装：返回 [status, json|{raw}]，网络异常或超时返回 [0, {error}]；不抛异常。 */

/** POST JSON（自动带 Content-Type: application/json），其余同 requestJson。 */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown = {},
  timeoutMs = 15000,
): Promise<[number, any]> {
  return requestJson(url, "POST", { "Content-Type": "application/json", ...headers }, body, timeoutMs);
}

/** 带超时的 fetch（默认 15s）：超时中止请求并抛 AbortError；调用方自行处理异常。 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 超时只覆盖到响应头；调用方读 body 前 timer 已清除，body 读取不受限（响应体都很小）
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** 通用请求：body 为字符串时原样发送，否则 JSON 序列化；GET 不带 body。超时（默认 15s）会中止请求。 */
export async function requestJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 15000,
): Promise<[number, any]> {
  try {
    const init: RequestInit = { method: method.toUpperCase(), headers };
    if (body !== undefined && init.method !== "GET") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetchWithTimeout(url, init, timeoutMs);
    return [res.status, await parseBody(res)];
  } catch (e: any) {
    return [0, { error: String(e?.message || e) }];
  }
}

/** body 只能读一次：先取文本再尝试 JSON.parse，失败时返回 {raw: 前 300 字符}。 */
async function parseBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}
