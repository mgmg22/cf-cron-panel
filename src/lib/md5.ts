/// 纯 TS MD5（WebCrypto 仅支持 SHA，MiniMax 签名需要 MD5，故自带实现）。
/// 标准 RFC 1321 实现，输入 UTF-8 字符串，输出 32 位小写十六进制。无外部依赖，Worker 可用。

// 每轮加法常数 K（RFC1321 常数表，用 Int32Array 按有符号 32 位存储）
const K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

// 每轮左旋位数
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// 消息调度：每轮参与运算的字索引（FF / GG / HH / II 各 16 个）
const IDX = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  1, 6, 11, 0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12,
  5, 8, 11, 14, 1, 4, 7, 10, 13, 0, 3, 6, 9, 12, 15, 2,
  0, 7, 14, 5, 12, 3, 10, 1, 8, 15, 6, 13, 4, 11, 2, 9,
];

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

function md5bytes(bytes: Uint8Array): string {
  const ml = bytes.length;
  const bitLenLo = (ml * 8) >>> 0;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000) >>> 0;

  // 填充：末尾 0x80，补零到长度 ≡ 56 (mod 64)，再附 8 字节小端 bit 长度
  let paddedLen = ml + 1;
  while (paddedLen % 64 !== 56) paddedLen++;
  paddedLen += 8;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[ml] = 0x80;
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  dv.setUint32(paddedLen - 8, bitLenLo, true);
  dv.setUint32(paddedLen - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const x = new Int32Array(16);
  for (let i = 0; i < paddedLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      x[j] = dv.getInt32(i + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;

    for (let k = 0; k < 64; k++) {
      let F: number;
      const g = IDX[k];
      if (k < 16) {
        F = (B & C) | (~B & D);
      } else if (k < 32) {
        F = (D & B) | (~D & C);
      } else if (k < 48) {
        F = B ^ C ^ D;
      } else {
        F = C ^ (B | ~D);
      }
      F = (F + A + K[k] + x[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[k])) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0 >>> 0, true);
  out.setUint32(4, b0 >>> 0, true);
  out.setUint32(8, c0 >>> 0, true);
  out.setUint32(12, d0 >>> 0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += out.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}

export function md5hex(input: string): string {
  return md5bytes(new TextEncoder().encode(input));
}
