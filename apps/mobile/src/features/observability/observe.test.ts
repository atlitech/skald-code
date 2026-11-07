import { expect, it, vi } from "vite-plus/test";

const environment = vi.hoisted(() => ({ projectId: undefined as string | undefined }));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        appVariant: "personal",
        relay: { url: "https://relay.test" },
        eas: {
          get projectId() {
            return environment.projectId;
          },
        },
      },
    },
  },
}));
vi.mock("expo-observe", () => {
  throw new Error("Project ID is required to send observability metrics.");
});

it.each([undefined, "4dfd2e15-bc73-461a-a26f-ba1c7d559172"])(
  "starts personal builds without native observability with OTA project %s",
  async (projectId) => {
    environment.projectId = projectId;
    vi.resetModules();
    vi.stubGlobal("__DEV__", false);
    try {
      const observe = await import("./observe");
      expect(observe.crashReportingAvailable).toBe(false);
      expect(() => observe.reportError(new Error("render failure"))).not.toThrow();
      await expect(observe.setCrashReportsEnabled(true)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
