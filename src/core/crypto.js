export function sequenceToIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, Number(sequence) >>> 0, false);
  return iv;
}

export function parseIv(value, sequence) {
  if (!value) return sequenceToIv(sequence);
  if (value instanceof Uint32Array) {
    const output = new Uint8Array(16);
    const view = new DataView(output.buffer);
    for (let index = 0; index < Math.min(value.length, 4); index += 1) {
      view.setUint32(index * 4, value[index] >>> 0, false);
    }
    return output;
  }
  if (ArrayBuffer.isView(value) && value.byteLength === 16) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  const hex = String(value).replace(/^0x/i, "").replace(/\s/g, "").padStart(32, "0");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return sequenceToIv(sequence);
  const output = new Uint8Array(16);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export async function decryptAes128(bytes, keyBytes, iv) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength !== 16) {
    throw new Error("AES-128 密钥必须是 16 字节。");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const result = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, bytes);
  return new Uint8Array(result);
}
