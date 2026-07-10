import { describe, expect, it } from "vitest";
import { normalizeUserInput, redactUrl, sanitizeFileName, stableId } from "../src/core/url.js";

describe("URL 与文件名工具", () => {
  it("从聊天文本中提取 URL 并移除中文标点", () => {
    expect(normalizeUserInput("请下载 https://example.com/a.m3u8?x=1。"))
      .toBe("https://example.com/a.m3u8?x=1");
  });

  it("清理 Windows 非法文件名和保留名", () => {
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("课程: 第一讲?.mp4 ")).toBe("课程_ 第一讲_.mp4");
  });

  it("脱敏签名参数但保留普通查询参数", () => {
    const value = redactUrl("https://cdn.example/video.m3u8?quality=hd&token=secret&signature=abc");
    expect(value).toContain("quality=hd");
    expect(value).not.toContain("secret");
    expect(value).not.toContain("signature=abc");
  });

  it("生成稳定 ID", () => {
    expect(stableId("a", 1)).toBe(stableId("a", 1));
    expect(stableId("a", 1)).not.toBe(stableId("a", 2));
  });
});
