/** KV 读写封装：读写失败不抛异常，错误以文本返回，由调用方决定如何处理。
 *  kv 为 undefined（未绑定 KV）时视为无数据、无错误。 */

export interface KvRead<T> {
  value: T | null; // 键不存在或读取失败时为 null
  error: string; // 读取失败原因；空串表示成功（含键不存在）
}

export async function kvReadJson<T = any>(kv: KVNamespace | undefined, key: string): Promise<KvRead<T>> {
  if (!kv) return { value: null, error: "" };
  try {
    return { value: await kv.get<T>(key, "json"), error: "" };
  } catch (e: any) {
    console.warn(`[kv] 读取 ${key} 失败:`, e);
    return { value: null, error: String(e?.message || e) };
  }
}

/** 写入 JSON；返回失败原因，成功或未绑定 KV 返回空串。 */
export async function kvWriteJson(kv: KVNamespace | undefined, key: string, value: unknown): Promise<string> {
  if (!kv) return "";
  try {
    await kv.put(key, JSON.stringify(value));
    return "";
  } catch (e: any) {
    console.warn(`[kv] 写入 ${key} 失败:`, e);
    return String(e?.message || e);
  }
}
