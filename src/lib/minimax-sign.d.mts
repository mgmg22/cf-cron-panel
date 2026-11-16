export const HOST: string;
export const DEFAULT_UUID: string;
export const DEFAULT_DEVICE_ID: string;
export function pyQuotePlus(s: string): string;
export function buildDeviceParams(userId: string, uuid: string, deviceId: string): Record<string, string>;
export function signRequest(
  path: string,
  token: string,
  params: Record<string, string>,
  method: string,
  body: unknown,
  md5hex: (s: string) => string,
): { url: string; headers: Record<string, string>; bodyStr: string };
