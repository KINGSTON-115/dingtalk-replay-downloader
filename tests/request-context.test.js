import { afterEach, describe, expect, it } from "vitest";
import { collectAnalysisOrigins, createRequestContext, installRequestContext } from "../src/core/request-context.js";
import { DINGTALK_DESKTOP_USER_AGENT } from "../src/adapters/dingtalk-session.js";
import { nativeCookieScopeSafe } from "../src/native/client.js";

afterEach(() => { delete globalThis.chrome; });

const analysis = {
  protocol: "hls",
  resolved: { pageUrl: "https://site.example/watch?id=1", playbackUrl: "https://manifest.example/master.m3u8" },
  plan: {
    playlist: {
      url: "https://manifest.example/video.m3u8",
      segments: [{
        url: "https://segments.example/1.ts",
        map: { url: "https://segments.example/init.mp4" },
        key: { uri: "https://keys.example/key.bin" }
      }]
    },
    audioPlaylist: null,
    subtitlePlaylist: null
  }
};

describe("任务级请求上下文", () => {
  it("收集所有清单、分片、map 和 key 域名", () => {
    expect(collectAnalysisOrigins(analysis).sort()).toEqual([
      "https://keys.example/*",
      "https://manifest.example/*",
      "https://segments.example/*"
    ]);
    expect(nativeCookieScopeSafe(analysis)).toBe(false);
  });

  it("仅为扩展自身请求安装 Referer session rule 并在结束时移除", async () => {
    const updates = [];
    globalThis.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules: async (update) => updates.push(update)
      }
    };
    const cleanup = await installRequestContext(analysis);
    const rule = updates[0].addRules[0];
    expect(rule.action.requestHeaders[0]).toMatchObject({ header: "Referer", operation: "set", value: "https://site.example/" });
    expect(rule.condition.initiatorDomains).toEqual(["abcdefghijklmnopabcdefghijklmnop"]);
    expect(rule.condition.requestDomains.sort()).toEqual(["keys.example", "manifest.example", "segments.example"]);
    await cleanup();
    expect(updates[1].removeRuleIds).toEqual([rule.id]);
  });

  it("在解析清单前增量安装钉钉媒体请求上下文", async () => {
    const updates = [];
    globalThis.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules: async (update) => updates.push(update)
      }
    };
    const pageUrl = "https://n.dingtalk.com/live?roomId=r&liveUuid=u";
    const context = await createRequestContext(pageUrl, () => {}, {
      referrer: pageUrl,
      requestHeaders: [
        { header: "Origin", value: "https://n.dingtalk.com" },
        { header: "Accept-Language", value: "zh-CN,zh;q=0.9" },
        { header: "User-Agent", value: DINGTALK_DESKTOP_USER_AGENT }
      ],
      cookieHeader: "LV_PC_SESSION=token; PC_SESSION=token",
      cookieDomains: ["dingtalk.com"]
    });
    await context.addUrls(["https://dtliving.dingtalk.com/replay/master.m3u8"]);
    const firstRules = updates[0].addRules;
    expect(firstRules).toHaveLength(2);
    const headerRule = firstRules.find((rule) => rule.priority === 1);
    const cookieRule = firstRules.find((rule) => rule.priority === 2);
    expect(headerRule.condition.requestDomains).toEqual(["dtliving.dingtalk.com"]);
    expect(headerRule.action.requestHeaders).toEqual([
      { header: "Referer", operation: "set", value: pageUrl },
      { header: "Origin", operation: "set", value: "https://n.dingtalk.com" },
      { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
      { header: "User-Agent", operation: "set", value: DINGTALK_DESKTOP_USER_AGENT }
    ]);
    expect(cookieRule.condition.requestDomains).toEqual(["dtliving.dingtalk.com"]);
    expect(cookieRule.action.requestHeaders).toEqual([{ header: "Cookie", operation: "set", value: "LV_PC_SESSION=token; PC_SESSION=token" }]);

    await context.addUrls(["https://dtliving.dingtalk.com/replay/1080/index.m3u8"]);
    expect(updates).toHaveLength(1);
    await context.addUrls(["https://segments.example/1.ts"]);
    expect(updates[1].addRules.find((rule) => rule.priority === 1).condition.requestDomains.sort()).toEqual(["dtliving.dingtalk.com", "segments.example"]);
    expect(updates[1].addRules.find((rule) => rule.priority === 2).condition.requestDomains).toEqual(["dtliving.dingtalk.com"]);
    await context.cleanup();
    expect(updates[2].removeRuleIds.length).toBe(2);
  });
});
