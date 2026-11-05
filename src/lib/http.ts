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

/** 通用请求：body 为字符串时原样发送，否则 JSON 序列化；GET 不带 body。超时（默认 15s）会中止请求。 */
export async function requestJson(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 15000,
): Promise<[number, any]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers,
      signal: ctrl.signal,
    };
    if (body !== undefined && method.toUpperCase() !== "GET") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);
    return [res.status, await parseBody(res)];
  } catch (e: any) {
    return [0, { error: String(e?.message || e) }];
  } finally {
    clearTimeout(t);
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
