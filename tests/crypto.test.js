import { describe, expect, it } from "vitest";
import { decryptAes128, parseIv, sequenceToIv } from "../src/core/crypto.js";

describe("AES-128 HLS 解密", () => {
  it("按媒体序列生成 128 位 IV", () => {
    expect(Array.from(sequenceToIv(9).slice(12))).toEqual([0, 0, 0, 9]);
    expect(Array.from(parseIv(new Uint32Array([0, 0, 0, 10]), 1).slice(12))).toEqual([0, 0, 0, 10]);
  });

  it("解密 WebCrypto AES-CBC 数据", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = new TextEncoder().encode("authorized media test");
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext);
    const decrypted = await decryptAes128(new Uint8Array(encrypted), keyBytes, iv);
    expect(new TextDecoder().decode(decrypted)).toBe("authorized media test");
  });
});
