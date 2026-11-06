package main

import "encoding/json"

var aiRecognitionGeneratedSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "subscriptions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "price": { "type": ["number", "string", "null"] },
          "currency": { "type": ["string", "null"] },
          "billingCycle": { "type": ["string", "null"] },
          "customDays": { "type": ["integer", "string", "null"] },
          "customCycleUnit": { "type": ["string", "null"] },
          "oneTimeTermCount": { "type": ["integer", "string", "null"] },
          "oneTimeTermUnit": { "type": ["string", "null"] },
          "category": {
            "type": ["string", "null"],
            "description": "Renewlet category value from provided options when possible; otherwise a concise user-facing category only when the service type is obvious."
          },
          "status": { "type": ["string", "null"] },
          "paymentMethod": {
            "type": ["string", "null"],
            "description": "Renewlet payment method value from provided options when possible; otherwise a concise user-facing payment method only when the input explicitly names one."
          },
          "startDate": { "type": ["string", "null"] },
          "nextBillingDate": { "type": ["string", "null"] },
          "autoCalculateNextBillingDate": { "type": ["boolean", "null"] },
          "trialEndDate": { "type": ["string", "null"] },
          "website": {
            "type": ["object", "null"],
            "description": "Official or user-provided website for the subscribed service. Use null for the entire website field when the official site is ambiguous or unknown.",
            "properties": {
              "value": { "type": ["string", "null"] },
              "source": { "type": "string", "enum": ["input", "suggested"] }
            },
            "required": ["value", "source"],
            "additionalProperties": false
          },
          "notes": {
            "type": "object",
		"description": "Optional service/site description or product description / meaningful merchant note decision object. Use source=input only for an explicit merchant note or visible service/site or product description, source=suggested for a concise AI description grounded in a reliable official site or unambiguous product knowledge, and value=null/source=none when identity is ambiguous.",
            "properties": {
              "value": {
                "type": ["string", "null"],
				"description": "Human-readable service/site description or product description, or meaningful NOTE/Remark/Memo/Terms text from visible input; suggested may be an AI description grounded in a reliable official site or unambiguous product knowledge; null when identity is ambiguous. Do not repeat price, package/plan, region/route, specifications, payment date, service dates, billing term/duration, or promotion. Never write a category, import advice, confirmation reminder, or AI process note."
              },
              "source": { "type": "string", "enum": ["input", "suggested", "none"] }
            },
            "required": ["value", "source"],
            "additionalProperties": false
          },
          "tags": {
            "type": "array",
            "description": "User-facing reusable organization tags. Prefer existing user tags from prompt context; if none fit, generate only stable reusable service/product/domain tags, not one-off order attributes.",
            "items": { "type": "string" },
            "maxItems": 3
          },
          "reminderDays": { "type": ["integer", "string", "null"] },
          "repeatReminderEnabled": { "type": ["boolean", "null"] },
          "repeatReminderInterval": { "type": ["string", "null"] },
          "repeatReminderWindow": { "type": ["string", "null"] },
          "confidence": {
            "type": "string",
            "description": "Use high only when the extracted row can be directly confirmed; use low for ambiguous, partial, or inferred records.",
            "enum": ["high", "low"]
          },
          "warnings": {
            "type": "array",
            "description": "Stable warning codes for uncertain or invalid fields; keep uncertainty out of notes.",
            "items": { "type": "string" }
          }
        },
        "required": [
          "name",
          "price",
          "currency",
          "billingCycle",
          "customDays",
          "customCycleUnit",
          "oneTimeTermCount",
          "oneTimeTermUnit",
          "category",
          "status",
          "paymentMethod",
          "startDate",
          "nextBillingDate",
          "autoCalculateNextBillingDate",
          "trialEndDate",
          "website",
          "notes",
          "tags",
          "reminderDays",
          "repeatReminderEnabled",
          "repeatReminderInterval",
          "repeatReminderWindow",
          "confidence",
          "warnings"
        ],
        "additionalProperties": false
      }
    },
    "warnings": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["subscriptions", "warnings"],
  "additionalProperties": false
}`)
