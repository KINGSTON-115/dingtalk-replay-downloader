import { afterEach, describe, expect, it } from "vitest";
import { createTask, loadDraft, listTasks, saveDraft } from "../src/core/task-store.js";

function area() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(patch) { Object.assign(values, patch); },
    async remove(key) { delete values[key]; }
  };
}

afterEach(() => { delete globalThis.chrome; });

describe("任务存储与隐私", () => {
  it("历史地址脱敏，原始恢复草稿仅写入 session storage", async () => {
    const local = area();
    const session = area();
    globalThis.chrome = { storage: { local, session } };
    await createTask({
      title: "课程",
      protocol: "hls",
      sourceUrl: "https://cdn.example/a.m3u8?token=short-secret&roomId=room-1"
    });
    await saveDraft({ input: "https://cdn.example/a.m3u8?token=short-secret" });
    const [task] = await listTasks();
    expect(task.sourceUrl).not.toContain("short-secret");
    expect(task.sourceUrl).not.toContain("room-1");
    expect((await loadDraft()).input).toContain("short-secret");
    expect(local.values["vwd.draft"]).toBeUndefined();
    expect(session.values["vwd.draft"]).toBeDefined();
  });
});
