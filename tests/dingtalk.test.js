import { describe, expect, it } from "vitest";
import { extractDingtalkParams, matchesDingtalkReplay, parseDingtalkResponse } from "../src/adapters/dingtalk.js";

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
});
