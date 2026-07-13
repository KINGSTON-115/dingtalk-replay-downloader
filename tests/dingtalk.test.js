import { describe, expect, it } from "vitest";
import { extractDingtalkParams, matchesDingtalkReplay, parseDingtalkResponse, resolveDingtalkReplay } from "../src/adapters/dingtalk.js";

describe("钉钉适配器", () => {
  it("解析查询参数、hash 参数和裸参数", () => {
    expect(extractDingtalkParams("https://n.dingtalk.com/live#/?roomId=r1&liveUuid=u1")).toMatchObject({ roomId: "r1", liveUuid: "u1" });
    expect(extractDingtalkParams("roomId=r2&liveUuid=u2")).toMatchObject({ roomId: "r2", liveUuid: "u2" });
  });

  it("不会把任意钉钉页面误判为回放", () => {
    expect(matchesDingtalkReplay("https://www.dingtalk.com/")).toBe(false);
    expect(matchesDingtalkReplay("https://n.dingtalk.com/live?roomId=r&liveUuid=u")).toBe(true);
  });

  it("从嵌套扩展字段提取播放地址", () => {
    const parsed = parseDingtalkResponse({
      openLiveDetailModel: {
        title: "课程一",
        extension: JSON.stringify({ sprites: { playUrl: "https://cdn.example/course/master.m3u8?token=abc" } })
      }
    }, { roomId: "r", liveUuid: "u" });
    expect(parsed.title).toBe("课程一");
    expect(parsed.playbackCandidates[0]).toMatchObject({ kind: "hls" });
  });

  it("明确拒绝未登录响应", () => {
    expect(() => parseDingtalkResponse({ isLogined: false }, {})).toThrow(/未登录/);
  });

  it("优先通过来源标签页复用钉钉登录会话", async () => {
    const requests = [];
    const resolved = await resolveDingtalkReplay("https://n.dingtalk.com/live?roomId=r&liveUuid=u", {
      async pageFetchText(url, options) {
        requests.push({ url, options });
        return {
          text: JSON.stringify({
            isLogined: true,
            openLiveDetailModel: {
              title: "已登录回放",
              playbackUrl: "https://cdn.example/replay/master.m3u8"
            }
          })
        };
      }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("roomId=r");
    expect(requests[0].options.headers.Accept).toContain("application/json");
    expect(requests[0].options.pageUrl).toContain("roomId=r");
    expect(resolved).toMatchObject({ adapter: "dingtalk", title: "已登录回放", playbackUrl: "https://cdn.example/replay/master.m3u8" });
  });

  it("优先使用显式 Cookie 会话并跳过页面兼容路径", async () => {
    let pageFetches = 0;
    const resolved = await resolveDingtalkReplay("https://n.dingtalk.com/live?roomId=r&liveUuid=u", {
      authenticatedFetchText: async () => ({
        text: JSON.stringify({
          isLogined: true,
          openLiveDetailModel: { title: "Cookie 回放", playbackUrl: "https://cdn.example/cookie/master.m3u8" }
        })
      }),
      pageFetchText: async () => {
        pageFetches += 1;
        return { text: JSON.stringify({ isLogined: false }) };
      }
    });
    expect(pageFetches).toBe(0);
    expect(resolved).toMatchObject({ title: "Cookie 回放", playbackUrl: "https://cdn.example/cookie/master.m3u8" });
  });
});
