import { afterEach, describe, expect, it } from "vitest";
import { collectAnalysisOrigins, installRequestContext } from "../src/core/request-context.js";
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
});
