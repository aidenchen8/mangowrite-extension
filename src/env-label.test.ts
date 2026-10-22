import { describe, expect, it } from "vitest";
import { classifyEnv } from "./env-label.js";

describe("classifyEnv", () => {
  it("treats the apex site as production and shows no badge", () => {
    expect(classifyEnv("https://mangowrite.com")).toEqual({
      kind: "production",
      label: "",
      // name 恒有值：切换器要给正式环境这一行起名，徽章仍靠 label 为空来隐藏。
      name: "正式环境",
      detail: "",
    });
    expect(classifyEnv("https://www.mangowrite.com")).toMatchObject({ kind: "production" });
  });

  it("flags the test deployment", () => {
    expect(classifyEnv("https://write.aidenchen.cn")).toEqual({
      kind: "test",
      label: "测试环境",
      name: "测试环境",
      detail: "",
    });
  });

  it("flags anything else, keeping the host visible", () => {
    expect(classifyEnv("http://localhost:3001")).toEqual({
      kind: "other",
      label: "其他环境",
      name: "其他环境",
      detail: "localhost",
    });
    expect(classifyEnv("https://192.168.1.9:5173")).toMatchObject({
      kind: "other",
      detail: "192.168.1.9",
    });
    // 旧测试域名已退役：不再识别为 test，落到「其他环境」把 host 亮出来。
    expect(classifyEnv("https://write.mangowrite.com")).toMatchObject({ kind: "other" });
  });

  it("does not let a lookalike host pass as production", () => {
    expect(classifyEnv("https://mangowrite.com.evil.test")).toMatchObject({ kind: "other" });
    expect(classifyEnv("https://notmangowrite.com")).toMatchObject({ kind: "other" });
  });

  it("matches host case-insensitively and ignores path/port noise", () => {
    expect(classifyEnv("https://MangoWrite.com/library?x=1")).toMatchObject({
      kind: "production",
    });
    expect(classifyEnv("https://Write.AidenChen.cn/")).toMatchObject({ kind: "test" });
  });

  it("falls back to 'other' for missing or unparseable URLs", () => {
    expect(classifyEnv(null)).toMatchObject({ kind: "other", detail: "" });
    expect(classifyEnv("")).toMatchObject({ kind: "other", detail: "" });
    expect(classifyEnv("not a url")).toMatchObject({ kind: "other", detail: "" });
  });
});
