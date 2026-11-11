const AI_RECOGNITION_PROCESS_NOTE_FRAGMENTS = [
  "ai根据",
  "ai建议",
  "ai未能",
  "ai无法",
  "ai生成",
  "ai猜测",
  "输入没有",
  "输入未",
  "用户输入",
  "原文",
  "图片未",
  "图像未",
  "表格未",
  "无法确定",
  "不能确定",
  "不确定",
  "未能确定",
  "未能高置信识别",
  "无法识别",
  "未明确",
  "未提供",
  "没有提供",
  "请确认",
  "需要确认",
  "确认后",
  "低置信",
  "高置信识别",
  "模型返回",
  "模型输出",
  "模型无法",
  "aigenerated",
  "aiguessed",
  "theinputdoesnot",
  "inputdoesnot",
  "inputdidnot",
  "notprovided",
  "notspecified",
  "uncertain",
  "cannotdetermine",
  "cantdetermine",
  "pleaseconfirm",
  "userconfirmation",
  "needsconfirmation",
  "confirmsubscriptionstatus",
  "lowconfidence",
  "modeloutput",
  "modelreturned",
] as const;

const AI_RECOGNITION_NOTE_DROP_CLAUSE_FRAGMENTS = [
  "适合记录",
  "可用于记录",
  "用于记录",
  "便于记录",
  "方便记录",
  "订阅管理",
  "套餐订阅",
  "请确认",
  "需要确认",
  "导入前",
  "导入到",
  "导入订阅",
  "导入记录",
  "renewlet",
  "suitableforrecording",
  "canbeusedtorecord",
  "usedtorecord",
  "subscriptionmanagement",
  "pleaseconfirm",
  "importintorenewlet",
  "importthis",
] as const;

const AI_RECOGNITION_NOTE_MARKETING_FRAGMENTS = [
  "优质",
  "领先",
  "专业",
  "全方位",
  "一站式",
  "可靠",
  "高性能",
  "稳定",
  "premium",
  "leading",
  "professional",
  "comprehensive",
  "all-in-one",
] as const;

const AI_RECOGNITION_NOTE_GENERIC_FRAGMENTS = [
  "的",
  "是",
  "提供",
  "相关",
  "服务",
  "平台",
  "产品",
  "业务",
  "方案",
  "领域",
  "商",
  "service",
  "services",
  "provider",
  "platform",
  "product",
  "solution",
] as const;

const AI_RECOGNITION_EXPLICIT_MERCHANT_NOTE_RE = /(?:^|\s)(?:note|remark|memo|terms|备注|说明|用途)\s*[:：-]/iu;
// 这是“明显是简介”的弱证据，用于过滤账单字段拼接；source=suggested 不依赖它，避免把真实产品简介误删。
const AI_RECOGNITION_SERVICE_DESCRIPTION_RE = /(?:\b(?:is|are|provides?|offers?|includes?|service|platform|product|hosting|server|software|tool|provider|assistant|application|app|storage|backup|streaming|video|music|design|email|domain|vpn|proxy|chat|code|collaboration|document|security|game|news|translation|learning|workspace|suite|content|media|payment|commerce|developer)\b|是|提供|主营|经营|面向|平台|服务|产品|网站|工具|软件|服务器|主机|云存储|备份|应用|助手|聊天|视频|音乐|设计|邮箱|域名|网络|代理|协作|文档|安全|游戏|新闻|翻译|学习|支付|电商|代码|开发|工作区|套件|内容|媒体)/iu;
const AI_RECOGNITION_NOTE_ADVICE_RE = /^(?:please\s+(?:read|review|check)|请(?:阅读|查看|确认)|(?:read|review)\s+the\s+terms|terms?\s+first|term(?:s| of service)\b)/iu;
const AI_RECOGNITION_NOTE_PURPOSE_RE = /^(?:用于|可用于|适合|主要用于)\s*/u;
const AI_RECOGNITION_DATE_FACT_RE = /(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月\d{1,2}日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/u;
const AI_RECOGNITION_MONEY_FACT_RE = /(?:[$€£¥￥]\s*\d|\d[\d,.]*\s*(?:usd|cny|rmb|eur|gbp|jpy|元|人民币|美元|欧元|英镑|日元)\b|\d[\d,.]*\s*\/\s*(?:day|week|month|year|天|周|月|年))/iu;
const AI_RECOGNITION_CYCLE_FACT_RE = /\d+(?:\.\d+)?\s*[a-z]?\s*\/\s*(?:day|week|month|year|天|周|月|年)/iu;
const AI_RECOGNITION_TERM_FACT_RE = /\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?|天|日|周|星期|个月|月|年|年度)/iu;
const AI_RECOGNITION_SPEC_FACT_RE = /(?:\b\d+\s*[x×]\s*\d+\b|\b\d+\s*(?:c\s*\d+\s*g|gbps?|mbps?|tb|gb|mb|x\d+)\b)/iu;
const AI_RECOGNITION_PLAN_OR_REGION_RE = /(?:\b(?:tier|plan|pro|basic|premium)\b|套餐|方案|地区|区域|线路|机房|节点|洛杉矶|香港|东京|新加坡|美国|德国|日本|\b(?:lax|hkg|nrt|sin|us|de|jp)\b)/iu;
const AI_RECOGNITION_ORDER_IDENTIFIER_RE = /(?:[A-Za-z]{2,}[._-][A-Za-z0-9._-]*\d|\b(?:tier|plan|pro)[-_]?\d+)/iu;
const AI_RECOGNITION_PROMOTION_FACT_RE = /(?:黑五|black\s*friday|promo(?:tion)?|促销|优惠|折扣|传家宝|sale|discount|coupon|special)/iu;

/**
 * 清洗 AI 建议来源的长期备注。
 *
 * suggested 备注会进入订阅长期记录；这里只兜底清掉识别过程、产品内视角和营销套话，保留真实服务/产品简介。
 */
export function normalizeAIRecognitionUsefulNotes(value: string | null | undefined, maxLength = 5000): string | null {
  const text = trimMax(value ?? "", maxLength);
  if (!text || isAIRecognitionProcessNote(text)) return null;
  const withoutAdvice = stripAIRecognitionAdviceClauses(text);
  if (!withoutAdvice || isAIRecognitionProcessNote(withoutAdvice) || isAIRecognitionMarketingOnlyNote(withoutAdvice)) return null;
  return trimMax(cleanAIRecognitionServiceDescription(withoutAdvice), maxLength) || null;
}

/**
 * 保留用户输入或账单图片中明确出现的备注；这类事实不是模型建议，不能套用服务简介过滤器。
 * 控制字符和版面换行会被压平，确保最终订阅备注在单行编辑控件、导出和通知中保持可读。
 */
export function normalizeAIRecognitionInputNotes(value: string | null | undefined, maxLength = 5000): string | null {
  const text = trimMax(value ?? "", maxLength)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * 只用于模型生成的 source=input 备注。
 *
 * source=input 表示证据来自账单/截图，并不代表整段“账单字段拼接”都适合作为长期备注。
 * 价格、日期、期限、套餐、地区和规格继续进入各自结构化字段；这里只留下真实服务/产品简介或有内容的商户说明。
 */
export function normalizeAIRecognitionGeneratedInputNotes(value: string | null | undefined, maxLength = 5000): string | null {
  const text = normalizeAIRecognitionInputNotes(value, maxLength);
  if (!text || isAIRecognitionProcessNote(text)) return null;
  const clauses = splitGeneratedInputNoteClauses(text);
  const kept = clauses.filter((clause) => {
    if (!clause) return false;
    const cleanedClause = stripExplicitMerchantMarker(clause);
    if (!cleanedClause || AI_RECOGNITION_NOTE_ADVICE_RE.test(cleanedClause)) return false;
    if (AI_RECOGNITION_EXPLICIT_MERCHANT_NOTE_RE.test(clause) && !looksLikeGeneratedBillingFact(clause) && !AI_RECOGNITION_PROMOTION_FACT_RE.test(clause)) {
      return looksLikeServiceDescription(cleanedClause);
    }
    if (looksLikeGeneratedBillingFact(clause)) return false;
    if (AI_RECOGNITION_PROMOTION_FACT_RE.test(clause) && !looksLikeServiceDescription(cleanedClause)) return false;
    if (AI_RECOGNITION_PLAN_OR_REGION_RE.test(clause) && !looksLikeServiceDescription(cleanedClause)) return false;
    if (AI_RECOGNITION_ORDER_IDENTIFIER_RE.test(clause) && !looksLikeServiceDescription(cleanedClause)) return false;
    return looksLikeServiceDescription(cleanedClause);
  }).map(stripExplicitMerchantMarker);
  return kept.length > 0 ? trimMax(kept.join(" - "), maxLength) : null;
}

function splitGeneratedInputNoteClauses(value: string): string[] {
  return value
    .replace(/\s+(?=(?:note|remark|memo|terms|备注|说明|用途)\s*[:：])/giu, " - ")
    .split(/\s+-{1,3}\s+|\s+[—–|]\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function looksLikeGeneratedBillingFact(value: string): boolean {
  return AI_RECOGNITION_DATE_FACT_RE.test(value)
    || AI_RECOGNITION_MONEY_FACT_RE.test(value)
    || AI_RECOGNITION_CYCLE_FACT_RE.test(value)
    || AI_RECOGNITION_TERM_FACT_RE.test(value)
    || AI_RECOGNITION_SPEC_FACT_RE.test(value);
}

function stripExplicitMerchantMarker(value: string): string {
  return value.replace(/^(?:note|remark|memo|terms|备注|说明|用途)\s*[:：-]\s*/iu, "").trim();
}

function looksLikeServiceDescription(value: string): boolean {
  const text = value.trim();
  if (text.length < 8 || AI_RECOGNITION_NOTE_ADVICE_RE.test(text)) return false;
  if (/^(?:用于|适合|可用于|主要用于)\b/u.test(text)) return false;
  if (looksLikeGeneratedBillingFact(text)) return false;
  return AI_RECOGNITION_SERVICE_DESCRIPTION_RE.test(text);
}

/** 识别模型推理、低置信提示或“请确认”类备注；这些内容不应随订阅导入长期入库。 */
export function isAIRecognitionProcessNote(value: string): boolean {
  const key = recognitionNoteMatchKey(value);
  return Boolean(key) && AI_RECOGNITION_PROCESS_NOTE_FRAGMENTS.some((fragment) => key.includes(fragment));
}

function recognitionNoteMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function stripAIRecognitionAdviceClauses(value: string): string {
  const clauses = value.split(/(?<=[。.!?！？；;])|[，,]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !AI_RECOGNITION_NOTE_PURPOSE_RE.test(part))
    .filter((part) => !AI_RECOGNITION_NOTE_DROP_CLAUSE_FRAGMENTS.some((fragment) => recognitionNoteMatchKey(part).includes(fragment)));
  return clauses.join("，").replace(/，([。.!?！？；;])/g, "$1").trim();
}

function isAIRecognitionMarketingOnlyNote(value: string): boolean {
  const key = recognitionNoteMatchKey(value);
  if (!key || !AI_RECOGNITION_NOTE_MARKETING_FRAGMENTS.some((fragment) => key.includes(fragment))) return false;
  const factKey = AI_RECOGNITION_NOTE_GENERIC_FRAGMENTS.reduce(
    (current, fragment) => current.replaceAll(fragment, ""),
    AI_RECOGNITION_NOTE_MARKETING_FRAGMENTS.reduce((current, fragment) => current.replaceAll(fragment, ""), key),
  );
  // Punctuation does not add meaning; remove it before deciding whether the
  // sentence is only marketing boilerplate.  This keeps phrases such as
  // “领先的全方位云服务平台。” from becoming a long-term service note.
  return factKey.replace(/[。，、！？；：:,.!?;()[\]{}"“”‘’\-_/|]/g, "").length < 2;
}

function cleanAIRecognitionServiceDescription(value: string): string {
  return value
    .replace(/相关服务/g, "服务")
    .replace(/等服务服务/g, "等服务")
    .replace(/服务服务/g, "服务")
    .replace(/\s+/g, " ")
    .trim();
}

function trimMax(value: string, maxLength: number): string {
  return [...value.trim()].slice(0, maxLength).join("");
}
