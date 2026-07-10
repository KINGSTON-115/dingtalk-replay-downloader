import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

describe("扩展清单", () => {
  it("默认权限不包含全站 Cookie 读取", () => {
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.optional_permissions).toContain("cookies");
    expect(manifest.optional_host_permissions).toContain("https://*/*");
  });

  it("使用 MV3 模块化后台任务协调器", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toMatchObject({ type: "module" });
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest.optional_permissions).toContain("webRequest");
    expect(manifest.permissions).toContain("declarativeNetRequestWithHostAccess");
  });
});
