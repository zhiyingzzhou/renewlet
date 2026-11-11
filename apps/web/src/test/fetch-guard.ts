export function createFetchGuard() {
  const unexpectedRequests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    unexpectedRequests.push(url);
    throw new Error(`Unexpected fetch without a test mock: ${url}`);
  };

  return {
    fetch,
    assertNoRequests() {
      // 业务代码可能捕获请求失败或在卸载后忽略结果；仍须在当前用例结束时暴露遗漏的网络隔离。
      const requests = unexpectedRequests.splice(0);
      if (requests.length > 0) {
        throw new Error(`Unexpected fetch without a test mock:\n${requests.join("\n")}`);
      }
    },
  };
}
