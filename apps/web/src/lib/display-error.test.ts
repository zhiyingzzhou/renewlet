// display-error 测试保护后端错误 code/fieldErrors 到用户提示的映射，避免 UI 重新解析宽松 error shape。
import { describe, expect, it } from "vitest";
import { ApiError } from "./api-client";
import { genericLoginErrorMessage, getAuthDisplayMessage, getDisplayErrorMessage } from "./display-error";

describe("display-error", () => {
  it("uses ApiError messages for business errors", () => {
    const error = new ApiError("当前密码不正确", 400, undefined, "INVALID_PASSWORD");

    expect(getDisplayErrorMessage(error, "fallback")).toBe("当前密码不正确");
  });

  it("uses problem detail from plain objects", () => {
    expect(getDisplayErrorMessage({ detail: "图片过大" }, "fallback")).toBe("图片过大");
    expect(getDisplayErrorMessage("图片过大", "fallback")).toBe("图片过大");
  });

  it("localizes stable backend validation codes", () => {
    expect(getDisplayErrorMessage(new ApiError("COST_SHARING_MEMBER_JOINED_DATE_OUT_OF_RANGE.", 400, undefined, "INVALID_PAYLOAD"))).toBe("成员上车日期必须在订阅日期范围内");
    expect(getDisplayErrorMessage(new ApiError("请核对成员日期", 400, undefined, "INVALID_PAYLOAD"))).toBe("请核对成员日期");
    expect(getDisplayErrorMessage(new ApiError("SUBSCRIPTION_NAME_REQUIRED", 400))).toBe("请输入订阅名称");
    expect(getDisplayErrorMessage(new ApiError("NEXT_BILLING_DATE_BEFORE_START_DATE", 400))).toBe("到期日期不能早于开始日期");
    expect(getDisplayErrorMessage(new ApiError(
      "Invalid request parameters",
      422,
      { limit: 5000 },
      "SUBSCRIPTION_COLLECTION_LIMIT_EXCEEDED",
    ))).toBe("结果超过可处理上限，请缩小搜索或筛选范围");
    expect(getDisplayErrorMessage({ response: { message: "CUSTOM_CONFIG_ITEM_INVALID:categories:CONFIG_ITEM_LABELS_REQUIRED" } })).toBe("配置项必须同时填写中文名和英文名");
  });

  it("prefers stable backend codes over localized server messages", () => {
    expect(getDisplayErrorMessage(new ApiError("Request body is too large", 413, undefined, "BODY_TOO_LARGE"))).toBe("请求体过大");
    expect(getDisplayErrorMessage({ response: { code: "BODY_TOO_LARGE", message: "Request body is too large" } })).toBe("请求体过大");
  });

  it("keeps login failures generic for auth client plain objects", () => {
    expect(getAuthDisplayMessage({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
      status: 401,
    })).toBe(genericLoginErrorMessage);
  });

  it("shows non-enumerating operational auth failures", () => {
    expect(getAuthDisplayMessage({ status: 429 })).toBe("尝试次数过多，请稍后再试");
    expect(getAuthDisplayMessage({ status: 503 })).toBe("登录服务暂时不可用，请稍后重试");
  });
});
