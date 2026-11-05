import type { Env } from "../src/types";

/** 内存版 KVNamespace（仅实现项目用到的 get(json) / put）。 */
export function fakeKv(initial: Record<string, unknown> = {}, opts: { failGet?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    get: async (key: string) => {
      if (opts.failGet) throw new Error("kv get failed");
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    put: async (key: string, value: string) => {
      if (opts.failPut) throw new Error("kv put failed");
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

export const req = (path: string, init: RequestInit & { json?: unknown; csrf?: boolean } = {}) => {
  const headers = new Headers(init.headers);
  if (init.csrf !== false && (init.method || "GET") !== "GET") headers.set("x-requested-with", "dashboard");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://panel.example${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
};

export const envWith = (kv?: KVNamespace, extra: Partial<Env> = {}): Env => ({ CHECKIN_STATE: kv, ...extra }) as Env;
