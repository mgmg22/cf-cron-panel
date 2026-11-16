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

const LOCK_TTL_SECONDS = 120; // KV expirationTtl 最小 60；覆盖任务最长耗时，进程异常退出时锁自动过期

/** 尽力而为的互斥锁（KV 非原子，极小概率两方同时拿到）。
 *  返回 true 表示拿到锁（或未绑定 KV / KV 异常时放行，不因锁故障阻塞任务）；false 表示已被占用。 */
export async function acquireLock(kv: KVNamespace | undefined, key: string): Promise<boolean> {
  if (!kv) return true;
  try {
    if (await kv.get(key)) return false;
    await kv.put(key, String(Date.now()), { expirationTtl: LOCK_TTL_SECONDS });
    return true;
  } catch (e) {
    console.warn(`[kv] 加锁 ${key} 失败，放行:`, e);
    return true;
  }
}

export async function releaseLock(kv: KVNamespace | undefined, key: string): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(key);
  } catch (e) {
    console.warn(`[kv] 释放锁 ${key} 失败（将在 TTL 后自动过期）:`, e);
  }
}
