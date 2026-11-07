import { assert, it } from "@effect/vitest";
import { hasTestFlightTesters } from "./fork-mobile-apple.ts";

it("confirms testers through Apple's build-filtered groups API", async () => {
  for (const hasTesters of [false, true]) {
    const apple = (path: string) => {
      const url = new URL(path, "https://api.appstoreconnect.apple.com/v1/");
      if (url.pathname === "/v1/betaGroups" && url.searchParams.get("filter[builds]") === "build-1")
        return Promise.resolve({ data: [{ id: "empty-group" }, { id: "release-group" }] });
      if (url.pathname === "/v1/betaGroups/empty-group/betaTesters")
        return Promise.resolve({ data: [] });
      if (url.pathname === "/v1/betaGroups/release-group/betaTesters")
        return Promise.resolve({ data: hasTesters ? [{ id: "tester-1" }] : [] });
      return Promise.reject(
        new Error("The relationship 'betaGroups' does not allow 'GET_RELATED'."),
      );
    };
    assert.equal(await hasTestFlightTesters(apple, "build-1"), hasTesters);
  }
});
