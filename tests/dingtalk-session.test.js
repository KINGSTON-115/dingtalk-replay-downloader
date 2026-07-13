import { afterEach, describe, expect, it } from "vitest";
import {
  DINGTALK_DESKTOP_USER_AGENT,
  collectDingtalkCookieHeader,
  fetchDingtalkWithSession,
  requestDingtalkCookiePermission
} from "../src/adapters/dingtalk-session.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete globalThis.chrome;
  globalThis.fetch = originalFetch;
});

describe("钉钉 Cookie 会话", () => {
  it("只在用户授权后读取并合并钉钉 Cookie", async () => {
    const permissionRequests = [];
    const cookieQueries = [];
    globalThis.chrome = {
      permissions: {
        contains: async () => true,
        request: async (request) => {
          permissionRequests.push(request);
          return true;
        }
      },
      cookies: {
        getAllCookieStores: async () => [{ id: "store-1", tabIds: [77] }],
        getAll: async (details) => {
          cookieQueries.push(details);
          if (details.url === "https://lv.dingtalk.com/") return [{ name: "LV_PC_SESSION", value: "api-token", domain: ".dingtalk.com" }];
          if (details.url?.startsWith("https://n.dingtalk.com/")) return [{ name: "page", value: "page-token", domain: "n.dingtalk.com" }];
          return [];
        }
      }
    };

    await expect(requestDingtalkCookiePermission()).resolves.toBe(true);
    const cookies = await collectDingtalkCookieHeader({
      pageUrl: "https://n.dingtalk.com/live?roomId=r&liveUuid=u",
      sourceTabId: 77
    });
    expect(permissionRequests).toEqual([{ permissions: ["cookies"] }]);
    expect(cookies.header).toContain("LV_PC_SESSION=api-token");
    expect(cookies.header).toContain("PC_SESSION=api-token");
    expect(cookies.header).toContain("page=page-token");
    expect(cookieQueries.every((query) => query.storeId === "store-1")).toBe(true);
  });

  it("用短生命周期 DNR 规则把 Cookie 和 Referer 限定到钉钉接口", async () => {
    const updates = [];
    globalThis.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
      permissions: { contains: async () => true },
      cookies: {
        getAllCookieStores: async () => [],
        getAll: async (details) => details.url === "https://lv.dingtalk.com/"
          ? [{ name: "LV_PC_SESSION", value: "token", domain: ".dingtalk.com" }]
          : []
      },
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules: async (update) => updates.push(update)
      }
    };
    globalThis.fetch = async () => new Response(JSON.stringify({ isLogined: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    const resource = await fetchDingtalkWithSession("https://lv.dingtalk.com/getOpenLiveInfo?roomId=r&liveUuid=u", {
      pageUrl: "https://n.dingtalk.com/live?roomId=r&liveUuid=u"
    });
    const rule = updates[0].addRules[0];
    expect(resource.text).toContain("isLogined");
    expect(rule.action.requestHeaders).toEqual([
      { header: "Cookie", operation: "set", value: "LV_PC_SESSION=token; PC_SESSION=token" },
      { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
      { header: "Sec-Fetch-Site", operation: "set", value: "none" },
      { header: "Sec-Fetch-Mode", operation: "set", value: "navigate" },
      { header: "Sec-Fetch-User", operation: "set", value: "?1" },
      { header: "Sec-Fetch-Dest", operation: "set", value: "document" },
      { header: "User-Agent", operation: "set", value: DINGTALK_DESKTOP_USER_AGENT }
    ]);
    expect(rule.condition).toMatchObject({
      urlFilter: "|https://lv.dingtalk.com/getOpenLiveInfo?roomId=r&liveUuid=u|",
      initiatorDomains: ["abcdefghijklmnopabcdefghijklmnop"],
      resourceTypes: ["xmlhttprequest"]
    });
    expect(updates[1]).toEqual({ removeRuleIds: [rule.id] });
  });

  it("拒绝把 Cookie 会话发送到其他地址", async () => {
    globalThis.chrome = { permissions: { contains: async () => true } };
    await expect(fetchDingtalkWithSession("https://example.com/getOpenLiveInfo")).rejects.toThrow(/拒绝/);
  });
});
