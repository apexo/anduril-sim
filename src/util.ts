export class DataFormatError extends Error {};

/*
 * TODO: remove once node 24 is EOL (2028-05-01?)
 * node <25 doesn't have Uint8Array.fromHex, so we use Buffer.from(_, "hex") instead
 */
type fromHex = (s: string) => Uint8Array | Buffer;
const fromHex: fromHex = "fromHex" in Uint8Array
  ? Uint8Array.fromHex as fromHex
  : (s: string) => Buffer.from(s, "hex");

export function loadHex(source: string, target: Uint8Array) {
  for (const line of source.split('\n')) {
    if (line[0] !== ":") continue;
    if (line.length < 11) throw new DataFormatError("line too short");
    const data = fromHex(line.slice(1).trimEnd());
    if (data[3]) return new DataFormatError("unexpected data[3] !== 0");
    const n = data[0];
    const addr = (data[1] << 8) | data[2];
    if (addr + n > target.length) new DataFormatError("target address out of bounds");
    if (n + 4 !== data.length) new DataFormatError("inconsistent data length");
    target.set(data.subarray(4), addr);
  }
}
