import { afterEach, describe, expect, it } from "vitest";
import { fetchTextFromTab } from "../src/core/chrome.js";

afterEach(() => { delete globalThis.chrome; });

describe("标签页会话请求", () => {
  it("在页面 MAIN world 中携带凭据请求并返回文本", async () => {
    let execution;
    globalThis.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      scripting: {
        executeScript: async (details) => {
          execution = details;
          return [{
            frameId: 0,
            result: {
              ok: true,
              status: 200,
              url: details.args[0],
              mime: "application/json",
              contentLength: 12,
              text: "{\"ok\":true}"
            }
          }];
        }
      }
    };

    const result = await fetchTextFromTab(42, "https://lv.dingtalk.com/getOpenLiveInfo?roomId=r", {
      headers: { Accept: "application/json", Cookie: "must-not-cross-world" }
    });
    expect(execution).toMatchObject({ target: { tabId: 42 }, world: "MAIN" });
    expect(execution.args[1]).toEqual({ Accept: "application/json" });
    expect(result).toMatchObject({ text: "{\"ok\":true}", mime: "application/json" });
  });

  it("拒绝页面会话中的 HTTP 错误", async () => {
    globalThis.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      scripting: { executeScript: async () => [{ frameId: 0, result: { ok: false, status: 401 } }] }
    };
    await expect(fetchTextFromTab(42, "https://lv.dingtalk.com/getOpenLiveInfo")).rejects.toThrow("HTTP 401");
  });
});
