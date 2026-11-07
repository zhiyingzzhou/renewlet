import { describe, expect, it } from "vitest";
import { createFetchGuard } from "./fetch-guard";

describe("unit test fetch guard", () => {
  it.each([
    "https://example.test/rates",
    new URL("https://example.test/rates"),
    new Request("https://example.test/rates"),
  ])("rejects unmocked requests and reports them even after the caller catches the error: %s", async (input) => {
    const guard = createFetchGuard();

    await expect(guard.fetch(input)).rejects.toThrow("Unexpected fetch without a test mock");
    expect(() => guard.assertNoRequests()).toThrow("https://example.test/rates");
    expect(() => guard.assertNoRequests()).not.toThrow();
  });

  it("reports every unexpected request without contaminating another guard", async () => {
    const guard = createFetchGuard();
    const independentGuard = createFetchGuard();

    await Promise.allSettled([
      guard.fetch("https://example.test/first"),
      guard.fetch("https://example.test/second"),
    ]);

    expect(() => guard.assertNoRequests()).toThrow(
      "https://example.test/first\nhttps://example.test/second",
    );
    expect(() => independentGuard.assertNoRequests()).not.toThrow();
  });
});
