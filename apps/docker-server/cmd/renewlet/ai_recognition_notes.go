package main

// ai_recognition_notes.go 清洗 AI 识别草稿中的长期备注。
//
// 业务边界：AI 输出的 notes 会在导入确认后进入订阅长期记录；input 来源只保留真实服务/产品简介或有内容的商户说明，
// suggested 来源保留官网服务/产品简介，价格、日期、期限、套餐、地区和规格继续由结构化字段承载。
import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var aiRecognitionProcessNoteFragments = []string{
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
}

var aiRecognitionNoteDropClauseFragments = []string{
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
}

var aiRecognitionNoteMarketingFragments = []string{
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
}

var aiRecognitionNoteGenericFragments = []string{
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
}

var (
	aiRecognitionExplicitMerchantNotePattern = regexp.MustCompile(`(?i)(?:^|\s)(?:note|remark|memo|terms|备注|说明|用途)\s*[:：-]`)
	aiRecognitionDateFactPattern             = regexp.MustCompile(`(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月\d{1,2}日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})`)
	aiRecognitionMoneyFactPattern            = regexp.MustCompile(`(?i)(?:[$€£¥￥]\s*\d|\d[\d,.]*\s*(?:usd|cny|rmb|eur|gbp|jpy|元|人民币|美元|欧元|英镑|日元)\b|\d[\d,.]*\s*/\s*(?:day|week|month|year|天|周|月|年))`)
	aiRecognitionCycleFactPattern            = regexp.MustCompile(`(?i)\d+(?:\.\d+)?\s*[a-z]?\s*/\s*(?:day|week|month|year|天|周|月|年)`)
	aiRecognitionTermFactPattern             = regexp.MustCompile(`(?i)\d+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?|天|日|周|星期|个月|月|年|年度)`)
	aiRecognitionSpecFactPattern             = regexp.MustCompile(`(?i)(?:\b\d+\s*[x×]\s*\d+\b|\b\d+\s*(?:c\s*\d+\s*g|gbps?|mbps?|tb|gb|mb|x\d+)\b)`)
	aiRecognitionPlanOrRegionPattern         = regexp.MustCompile(`(?i)(?:\b(?:tier|plan|pro|basic|premium)\b|套餐|方案|地区|区域|线路|机房|节点|洛杉矶|香港|东京|新加坡|美国|德国|日本|\b(?:lax|hkg|nrt|sin|us|de|jp)\b)`)
	aiRecognitionOrderIdentifierPattern      = regexp.MustCompile(`(?i)(?:[A-Za-z]{2,}[._-][A-Za-z0-9._-]*\d|\b(?:tier|plan|pro)[-_]?\d+)`)
	aiRecognitionPromotionFactPattern        = regexp.MustCompile(`(?i)(?:黑五|black\s*friday|promo(?:tion)?|促销|优惠|折扣|传家宝|sale|discount|coupon|special)`)
	aiRecognitionServiceDescriptionPattern   = regexp.MustCompile(`(?i)(?:\b(?:is|are|provides?|offers?|includes?|service|platform|product|hosting|server|software|tool|provider|assistant|application|app|storage|backup|streaming|video|music|design|email|domain|vpn|proxy|chat|code|collaboration|document|security|game|news|translation|learning|workspace|suite|content|media|payment|commerce|developer)\b|是|提供|主营|经营|面向|平台|服务|产品|网站|工具|软件|服务器|主机|云存储|备份|应用|助手|聊天|视频|音乐|设计|邮箱|域名|网络|代理|协作|文档|安全|游戏|新闻|翻译|学习|支付|电商|代码|开发|工作区|套件|内容|媒体)`)
	aiRecognitionNoteAdvicePattern           = regexp.MustCompile(`(?i)^(?:please\s+(?:read|review|check)|请(?:阅读|查看|确认)|(?:read|review)\s+the\s+terms|terms?\s+first|term(?:s| of service)\b)`)
	aiRecognitionNotePurposePattern          = regexp.MustCompile(`^(?:用于|可用于|适合|主要用于)\s*`)
	aiRecognitionNoteMarkerPrefixPattern     = regexp.MustCompile(`(?i)^(?:note|remark|memo|terms|备注|说明|用途)\s*[:：-]\s*`)
	// Go regexp 使用 RE2，不支持 lookahead；捕获备注标记并在替换时保留它，实现同样的分段语义。
	aiRecognitionMerchantMarkerSplitPattern = regexp.MustCompile(`(?i)\s+((?:note|remark|memo|terms|备注|说明|用途)\s*[:：])`)
	aiRecognitionNoteClauseSplitPattern     = regexp.MustCompile(`\s+-{1,3}\s+|\s+[—–|]\s+`)
	aiRecognitionPlaceholderNamePattern     = regexp.MustCompile(`(?i)^(?:unknown(?:\s+(?:app|service|subscription))?|unnamed|n/?a|none|未知(?:服务|应用)?|未命名(?:服务|应用)?)$`)
)

func missingDescribableAINoteNames(subscriptions []aiRecognizedSubscriptionDraft) []string {
	names := make([]string, 0, minInt(len(subscriptions), 20))
	for _, draft := range subscriptions {
		if draft.Notes == nil && isDescribableForAINotes(draft) {
			names = append(names, draft.Name)
			if len(names) >= 20 {
				break
			}
		}
	}
	return names
}

func isDescribableForAINotes(draft aiRecognizedSubscriptionDraft) bool {
	name := strings.TrimSpace(draft.Name)
	return name != "" && !aiRecognitionPlaceholderNamePattern.MatchString(name)
}

// mergeAIRecognitionNotes 只接受补全响应中的 notes，避免第二次模型调用覆盖首轮账单事实。
func mergeAIRecognitionNotes(response aiRecognizeResponse, repaired aiRecognizeResponse) aiRecognizeResponse {
	used := make(map[int]bool, len(repaired.Subscriptions))
	for index := range response.Subscriptions {
		candidateIndex := -1
		if index < len(repaired.Subscriptions) && strings.EqualFold(strings.TrimSpace(response.Subscriptions[index].Name), strings.TrimSpace(repaired.Subscriptions[index].Name)) {
			candidateIndex = index
		} else {
			for repairedIndex, candidate := range repaired.Subscriptions {
				if used[repairedIndex] || !strings.EqualFold(strings.TrimSpace(response.Subscriptions[index].Name), strings.TrimSpace(candidate.Name)) {
					continue
				}
				candidateIndex = repairedIndex
				break
			}
		}
		if candidateIndex < 0 || used[candidateIndex] || repaired.Subscriptions[candidateIndex].Notes == nil {
			continue
		}
		used[candidateIndex] = true
		response.Subscriptions[index].Notes = repaired.Subscriptions[candidateIndex].Notes
	}
	return response
}

func normalizeAINotesField(field *aiSuggestedTextField, maxLen int) *aiSuggestedTextField {
	normalized := normalizeAISuggestedField(field, maxLen)
	if normalized == nil {
		return nil
	}
	if normalized.Source == "input" {
		normalized.Value = normalizeAIGeneratedInputNoteText(normalized.Value, maxLen)
		if normalized.Value == "" {
			return nil
		}
		return normalized
	}
	// suggested 备注会进入订阅长期备注；这里兜底清掉识别过程和产品内视角，保留真实服务/产品简介。
	if isAIRecognitionProcessNote(normalized.Value) {
		return nil
	}
	value := stripAIRecognitionAdviceClauses(normalized.Value)
	if value == "" || isAIRecognitionProcessNote(value) || isAIRecognitionMarketingOnlyNote(value) {
		return nil
	}
	normalized.Value = trimMax(cleanAIRecognitionServiceDescription(value), maxLen)
	if normalized.Value == "" {
		return nil
	}
	return normalized
}

// 输入来源的备注可能是账单原文中的 NOTE/Remark/Memo；它是用户提供的事实，不能按 AI 建议简介过滤。
func normalizeAIInputNoteText(value string, maxLen int) string {
	value = trimMax(value, maxLen)
	var builder strings.Builder
	for _, r := range value {
		if unicode.IsControl(r) {
			builder.WriteRune(' ')
			continue
		}
		builder.WriteRune(r)
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

func normalizeAIGeneratedInputNoteText(value string, maxLen int) string {
	text := normalizeAIInputNoteText(value, maxLen)
	if text == "" || isAIRecognitionProcessNote(text) {
		return ""
	}
	clauses := splitAIGeneratedInputNoteClauses(text)
	kept := make([]string, 0, len(clauses))
	for _, clause := range clauses {
		if clause == "" {
			continue
		}
		cleanedClause := stripAIRecognitionMerchantMarker(clause)
		if cleanedClause == "" || aiRecognitionNoteAdvicePattern.MatchString(cleanedClause) {
			continue
		}
		if aiRecognitionExplicitMerchantNotePattern.MatchString(clause) && !looksLikeAIGeneratedBillingFact(clause) && !aiRecognitionPromotionFactPattern.MatchString(clause) && aiRecognitionServiceDescriptionPattern.MatchString(cleanedClause) {
			kept = append(kept, cleanedClause)
			continue
		}
		if looksLikeAIGeneratedBillingFact(clause) {
			continue
		}
		if aiRecognitionPromotionFactPattern.MatchString(clause) && !aiRecognitionServiceDescriptionPattern.MatchString(cleanedClause) {
			continue
		}
		if aiRecognitionPlanOrRegionPattern.MatchString(clause) && !aiRecognitionServiceDescriptionPattern.MatchString(cleanedClause) {
			continue
		}
		if aiRecognitionOrderIdentifierPattern.MatchString(clause) && !aiRecognitionServiceDescriptionPattern.MatchString(cleanedClause) {
			continue
		}
		if len([]rune(cleanedClause)) >= 8 && !strings.HasPrefix(cleanedClause, "用于") && !strings.HasPrefix(cleanedClause, "适合") && aiRecognitionServiceDescriptionPattern.MatchString(cleanedClause) {
			kept = append(kept, cleanedClause)
		}
	}
	return strings.Join(kept, " - ")
}

func stripAIRecognitionMerchantMarker(value string) string {
	return strings.TrimSpace(aiRecognitionNoteMarkerPrefixPattern.ReplaceAllString(value, ""))
}

func splitAIGeneratedInputNoteClauses(value string) []string {
	marked := aiRecognitionMerchantMarkerSplitPattern.ReplaceAllString(value, " - $1")
	parts := aiRecognitionNoteClauseSplitPattern.Split(marked, -1)
	clauses := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			clauses = append(clauses, trimmed)
		}
	}
	return clauses
}

func looksLikeAIGeneratedBillingFact(value string) bool {
	return aiRecognitionDateFactPattern.MatchString(value) ||
		aiRecognitionMoneyFactPattern.MatchString(value) ||
		aiRecognitionCycleFactPattern.MatchString(value) ||
		aiRecognitionTermFactPattern.MatchString(value) ||
		aiRecognitionSpecFactPattern.MatchString(value)
}

func isAIRecognitionProcessNote(value string) bool {
	key := aiRecognitionNoteMatchKey(value)
	if key == "" {
		return false
	}
	for _, fragment := range aiRecognitionProcessNoteFragments {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func aiRecognitionNoteMatchKey(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(norm.NFKC.String(value))) {
		if unicode.IsSpace(r) {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func stripAIRecognitionAdviceClauses(value string) string {
	clauses := splitAIRecognitionNoteClauses(value)
	kept := []string{}
	for _, clause := range clauses {
		text := strings.TrimSpace(clause)
		if text == "" || aiRecognitionNotePurposePattern.MatchString(text) || aiRecognitionNoteContainsFragment(text, aiRecognitionNoteDropClauseFragments) {
			continue
		}
		kept = append(kept, text)
	}
	joined := strings.Join(kept, "，")
	joined = strings.NewReplacer(
		"，。", "。",
		"，.", ".",
		"，!", "!",
		"，！", "！",
		"，?", "?",
		"，？", "？",
		"，；", "；",
		"，;", ";",
	).Replace(joined)
	return strings.TrimSpace(joined)
}

func splitAIRecognitionNoteClauses(value string) []string {
	clauses := []string{}
	var builder strings.Builder
	for _, r := range value {
		if strings.ContainsRune("，,", r) {
			clauses = append(clauses, builder.String())
			builder.Reset()
			continue
		}
		if strings.ContainsRune("。.!?！？；;", r) {
			builder.WriteRune(r)
			clauses = append(clauses, builder.String())
			builder.Reset()
			continue
		}
		builder.WriteRune(r)
	}
	clauses = append(clauses, builder.String())
	return clauses
}

func isAIRecognitionMarketingOnlyNote(value string) bool {
	key := aiRecognitionNoteMatchKey(value)
	if key == "" || !aiRecognitionNoteContainsFragment(key, aiRecognitionNoteMarketingFragments) {
		return false
	}
	for _, fragment := range aiRecognitionNoteMarketingFragments {
		key = strings.ReplaceAll(key, fragment, "")
	}
	for _, fragment := range aiRecognitionNoteGenericFragments {
		key = strings.ReplaceAll(key, fragment, "")
	}
	return len([]rune(key)) < 2
}

func aiRecognitionNoteContainsFragment(value string, fragments []string) bool {
	key := aiRecognitionNoteMatchKey(value)
	if key == "" {
		return false
	}
	for _, fragment := range fragments {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func cleanAIRecognitionServiceDescription(value string) string {
	text := strings.ReplaceAll(value, "相关服务", "服务")
	text = strings.ReplaceAll(text, "等服务服务", "等服务")
	text = strings.ReplaceAll(text, "服务服务", "服务")
	return strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
}
