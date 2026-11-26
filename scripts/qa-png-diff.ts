import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
export function decode(buf: Buffer) {
  let p = 8, w = 0, h = 0, ct = 0; const idat: Buffer[] = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]!; if (d[8] !== 8) throw Error("depth"); } else if (type === "IDAT") idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw Error("colour type " + ct);
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]!; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? out[y * stride + x - bpp]! : 0, b = y ? out[(y - 1) * stride + x]! : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp]! : 0;
      let v = row[x]!; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } out[y * stride + x] = v & 255; } }
  return { w, h, bpp, data: out };
}
export function diff(a: Buffer, b: Buffer) { const A = decode(a), B = decode(b); if (A.w !== B.w || A.h !== B.h) return { sameSize: false, differing: -1, total: 0, maxDelta: 0 };
  let n = 0, max = 0; for (let i = 0; i < A.w * A.h; i++) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.data[i * A.bpp + k]! - B.data[i * B.bpp + k]!)); if (d) n++; if (d > max) max = d; }
  return { sameSize: true, differing: n, total: A.w * A.h, maxDelta: max }; }
if (import.meta.main) console.log(diff(readFileSync(process.argv[2]!), readFileSync(process.argv[3]!)));
