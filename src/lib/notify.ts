/** 通知渠道：server酱 + 钉钉机器人。
 *  职责边界：只做消息推送的 HTTP 封装，不含任何业务判断；
 *  钉钉加签协议 sign = quote(base64(hmac_sha256(secret, "{ts}\n{secret}")))，无 secret 时直发。 */

import { bytesToBase64 } from "./encoding";

/** server酱：sctapi.ftqq.com/{key}.send，desp 按 Markdown 渲染，单个 \n 转 \n\n 分段。
 *  未配置 key 返回 true（无需推送）；HTTP 非 2xx 或网络异常返回 false，不抛异常。 */
export async function notifyServerJ(
  title: string,
  content: string,
  pushKey?: string,
): Promise<boolean> {
  if (!pushKey) return true; // 未配置视为无需推送，不算失败
  const url = `https://sctapi.ftqq.com/${pushKey}.send`;
  const body = `text=${encodeURIComponent(title)}&desp=${encodeURIComponent(
    content.replace(/\n/g, "\n\n"),
  )}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      console.warn(`[notify] server酱推送失败：HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[notify] server酱推送失败:", e);
    return false;
  }
}

/** 钉钉机器人：markdown 消息。
 *  token 未配置时静默跳过（返回 true）；配置 secret 时按官方加签协议附 timestamp+sign。
 *  返回是否推送成功（HTTP 非 2xx 或 errcode != 0 均为失败）。 */
export async function notifyDingding(
  title: string,
  content: string,
  token?: string,
  secret?: string,
): Promise<boolean> {
  if (!token) return true;
  let url = `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
  if (secret) {
    const ts = Date.now();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}\n${secret}`)),
    );
    url += `&timestamp=${ts}&sign=${encodeURIComponent(bytesToBase64(mac))}`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title, text: content } }),
    });
    const data: any = await res.json().catch(() => null);
    if (res.ok && data?.errcode === 0) {
      console.log("[notify] 钉钉推送成功");
      return true;
    }
    console.warn(`[notify] 钉钉推送失败：HTTP ${res.status}`, JSON.stringify(data).slice(0, 200));
    return false;
  } catch (e) {
    console.warn("[notify] 钉钉推送失败:", e);
    return false;
  }
}
