/**
 * Minimal reader for the stored (uncompressed) ZIP files that client-zip writes. Reads the central directory, so
 * entries written with data descriptors and Zip64 extra fields are handled. Test helper only.
 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;

export function readZip(input: ArrayBuffer | Uint8Array): ZipEntry[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file: end of central directory not found");

  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const locator = eocd - 20;
  if ((count === 0xffff || offset === 0xffffffff) && locator >= 0 && view.getUint32(locator, true) === ZIP64_EOCD_LOCATOR) {
    const zip64 = Number(view.getBigUint64(locator + 8, true));
    count = Number(view.getBigUint64(zip64 + 32, true));
    offset = Number(view.getBigUint64(zip64 + 48, true));
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== CENTRAL) throw new Error(`Bad central directory entry at ${offset}`);
    const method = view.getUint16(offset + 10, true);
    let size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // Zip64 extended information: the fields present are the ones set to 0xFFFFFFFF, in this order.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        const uncompressed = view.getUint32(offset + 24, true);
        if (uncompressed === 0xffffffff) {
          size = Number(view.getBigUint64(field, true));
          field += 8;
        }
        if (view.getUint32(offset + 20, true) === 0xffffffff) field += 8;
        if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(field, true));
      }
      extra += 4 + length;
    }

    if (method !== 0) throw new Error(`Entry ${name} is compressed (method ${method})`);
    if (view.getUint32(localOffset, true) !== LOCAL) throw new Error(`Bad local header for ${name}`);
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    entries.push({ name, data: bytes.slice(start, start + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
