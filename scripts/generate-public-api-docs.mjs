#!/usr/bin/env node
/**
 * Public API 文档生成器。
 *
 * 触发时机：Public API shared schema、Go route 或 Worker route 变化后运行；`--check` 用于 CI 守卫。
 * 副作用：无参数会重写 `docs/public-api.openapi.json` 和 `docs/public-api.md`。
 *
 * 契约：OpenAPI/Markdown 是生成物，事实源是 shared Zod schema + endpoint registry + 双运行面 route 注册。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_MONEY_STRING, MONEY_DECIMAL_SCALE } from "@renewlet/shared/money";
import {
  publicApiDocumentationSchemas,
  publicApiEndpointDocs,
} from "@renewlet/shared/public-api-docs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkMode = process.argv.includes("--check");
const openApiPath = path.join(rootDir, "docs/public-api.openapi.json");
const markdownPath = path.join(rootDir, "docs/public-api.md");
const goRoutesPath = path.join(rootDir, "apps/docker-server/cmd/renewlet/routes.go");
const workerRoutesPath = path.join(rootDir, "apps/worker/src/index.ts");
const publicApiTag = "Public API";
const publicApiMoneyPropertyNames = new Set(["price", "balance", "customAmount"]);
const publicApiDateOnlyPropertyNames = new Set(["joinedDate"]);
const allowedEmptyComponentSchemaPaths = new Set([
  "components.schemas.PublicApiErrorResponse.properties.error.properties.details",
  "components.schemas.PublicApiSubscriptionsListResponse.properties.data.properties.subscriptions.items.properties.extra.additionalProperties",
  "components.schemas.PublicApiSubscriptionResponse.properties.data.properties.subscription.properties.extra.additionalProperties",
  "components.schemas.PublicApiDueResponse.properties.data.properties.items.items.properties.subscription.properties.extra.additionalProperties",
]);
// 这是 OpenAPI 投影，不是新的金额事实源；真实校验仍在 shared moneyStringSchema，避免文档层绕过 canonicalize。
const moneyDecimalStringSchema = {
  type: "string",
  pattern: `^(?:(?:0|[1-9][0-9]{0,${MAX_MONEY_STRING.length - 2}})(?:\\.[0-9]{0,${MONEY_DECIMAL_SCALE - 1}}[1-9])?|${MAX_MONEY_STRING})$`,
  description: `Canonical Renewlet decimal money string. Non-negative, max ${MAX_MONEY_STRING}, up to ${MONEY_DECIMAL_SCALE} fractional digits, no scientific notation.`,
  example: "12.34",
};
// DateOnly transform 会让 Zod JSON Schema 输出 `{}`；Public API 文档必须保住 wire shape，避免客户端误以为是任意值。
const dateOnlyStringSchema = {
  type: "string",
  format: "date",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Renewlet date-only string in YYYY-MM-DD format. No time or time zone.",
  example: "2026-01-01",
};

const statusDescriptions = {
  400: "Invalid query parameters.",
  401: "Missing, malformed, deleted, or unauthorized Public API token.",
  404: "The requested resource does not exist for the token owner.",
  500: "Unexpected server error.",
};

const statusExamples = {
  400: { error: { code: "INVALID_QUERY", message: "Invalid request parameters" } },
  401: { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
  404: { error: { code: "NOT_FOUND", message: "Not found" } },
  500: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
};

function withoutJsonSchemaDialect(value) {
  if (Array.isArray(value)) return value.map(withoutJsonSchemaDialect);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => [key, withoutJsonSchemaDialect(child)]),
  );
}

function isEmptyJsonSchema(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function applyPublicApiJsonSchemaOverrides({ jsonSchema, path: schemaPath }) {
  const propertyName = schemaPath.at(-1);
  if (!isEmptyJsonSchema(jsonSchema) || typeof propertyName !== "string") return;
  if (publicApiMoneyPropertyNames.has(propertyName)) {
    // moneyStringSchema 带 canonicalize transform，Zod 只能输出 `{}`；OpenAPI 投影必须保住 decimal string 契约。
    Object.assign(jsonSchema, moneyDecimalStringSchema);
    return;
  }
  if (publicApiDateOnlyPropertyNames.has(propertyName)) {
    Object.assign(jsonSchema, dateOnlyStringSchema);
  }
}

function schemaFor(name) {
  const schema = publicApiDocumentationSchemas[name];
  if (!schema) throw new Error(`Missing Public API documentation schema: ${String(name)}`);
  // OpenAPI 只表达 wire shape；Zod preprocess/pipe 等运行时转换仍由 shared schema 和接口测试守门。
  return withoutJsonSchemaDialect(z.toJSONSchema(schema, {
    unrepresentable: "any",
    override: applyPublicApiJsonSchemaOverrides,
  }));
}

function parameterSchema(parameter) {
  const schema = schemaFor(parameter.schemaName);
  if (!parameter.schemaProperty) return schema;
  const property = schema.properties?.[parameter.schemaProperty];
  if (!property) {
    throw new Error(`Missing schema property ${parameter.schemaName}.${parameter.schemaProperty} for ${parameter.name}`);
  }
  return property;
}

function responseFor(endpoint) {
  const responses = {
    200: {
      description: "Successful response.",
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${endpoint.responseSchemaName}` },
          examples: { success: { value: endpoint.successExample } },
        },
      },
    },
  };
  for (const status of endpoint.errorStatuses) {
    responses[status] = {
      description: statusDescriptions[status] ?? "Error response.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PublicApiErrorResponse" },
          examples: { error: { value: statusExamples[status] ?? statusExamples[500] } },
        },
      },
    };
  }
  return responses;
}

function operationFor(endpoint) {
  return {
    tags: [publicApiTag],
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: endpoint.description,
    security: [{ PublicApiBearer: [] }],
    parameters: (endpoint.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      description: parameter.description,
      schema: parameterSchema(parameter),
      ...(parameter.example === undefined ? {} : { example: parameter.example }),
    })),
    responses: responseFor(endpoint),
  };
}

function buildOpenApiDocument() {
  const paths = {};
  for (const endpoint of publicApiEndpointDocs) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method] = operationFor(endpoint);
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Renewlet Public API",
      version: "1.0.0",
      description: [
        "Read-only API for subscriptions, status summaries, and upcoming due items.",
        "All endpoints require an `Authorization: Bearer rlt_*` token created in Renewlet settings.",
      ].join(" "),
      license: {
        name: "MIT",
        url: "https://github.com/zhiyingzzhou/renewlet/blob/main/LICENSE",
      },
    },
    servers: [
      {
        url: "/",
        description: "Same-origin Renewlet deployment.",
      },
    ],
    tags: [{ name: publicApiTag, description: "Read-only Renewlet Public API." }],
    paths,
    components: {
      securitySchemes: {
        PublicApiBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "rlt_*",
          description: "Renewlet Public API token. Query parameter tokens and browser session cookies are rejected.",
        },
      },
      schemas: Object.fromEntries(
        ["PublicApiErrorResponse", ...publicApiEndpointDocs.map((endpoint) => endpoint.responseSchemaName)]
          .map((name) => [name, schemaFor(name)]),
      ),
    },
  };
}

function collectEmptyComponentSchemaPaths(value, schemaPath = []) {
  if (Array.isArray(value) || !value || typeof value !== "object") return [];
  const currentPath = schemaPath.join(".");
  const matches = currentPath.startsWith("components.schemas.") && isEmptyJsonSchema(value) ? [currentPath] : [];
  return Object.entries(value).reduce(
    (paths, [key, child]) => paths.concat(collectEmptyComponentSchemaPaths(child, schemaPath.concat(key))),
    matches,
  );
}

function validateOpenApiProjection(document) {
  // 空 schema 只允许用于明确 unknown 的扩展通道；业务字段为空通常说明 Zod transform 没有被投影成真实 wire shape。
  const unexpectedEmptySchemas = collectEmptyComponentSchemaPaths(document)
    .filter((schemaPath) => !allowedEmptyComponentSchemaPaths.has(schemaPath));
  if (unexpectedEmptySchemas.length > 0) {
    throw new Error(`Public API OpenAPI has unexpected empty component schemas:\n${unexpectedEmptySchemas.join("\n")}`);
  }
}

function routeKey(endpoint) {
  return `${endpoint.method.toUpperCase()} ${endpoint.path}`;
}

function normalizeWorkerPublicPath(value) {
  return `/api/public${value}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function discoverGoPublicApiRoutes() {
  const source = fs.readFileSync(goRoutesPath, "utf8");
  return [...source.matchAll(/api\.([A-Z]+)\("([^"]+)"/g)]
    .map((match) => `${match[1]} ${match[2]}`)
    .filter((entry) => entry.includes(" /api/public/v1/") || entry.endsWith(" /api/public/v1/me"));
}

function discoverWorkerPublicApiRoutes() {
  const source = fs.readFileSync(workerRoutesPath, "utf8");
  return [...source.matchAll(/defineRoute\(publicRoutes,\s*"([^"]+)"\s*,\s*\{\s*([A-Z]+)/g)]
    .map((match) => `${match[2]} ${normalizeWorkerPublicPath(match[1])}`)
    .filter((entry) => entry.includes(" /api/public/v1/") || entry.endsWith(" /api/public/v1/me"));
}

function compareRouteSets(label, actual) {
  const expected = publicApiEndpointDocs.map(routeKey).sort();
  const sortedActual = [...new Set(actual)].sort();
  const missing = expected.filter((item) => !sortedActual.includes(item));
  const extra = sortedActual.filter((item) => !expected.includes(item));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error([
      `${label} Public API routes drifted from docs registry.`,
      missing.length > 0 ? `Missing in ${label}: ${missing.join(", ")}` : "",
      extra.length > 0 ? `Extra in ${label}: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
}

function checkRuntimeRoutes() {
  // Go 与 Worker 都能注册 Public API route；生成器必须同时看两边，不能让某个运行面悄悄成为唯一事实源。
  compareRouteSets("Go", discoverGoPublicApiRoutes());
  compareRouteSets("Worker", discoverWorkerPublicApiRoutes());
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownTable(rows) {
  if (rows.length === 0) return "None.";
  return [
    "| Name | In | Required | Description |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| \`${row.name}\` | \`${row.in}\` | ${row.required ? "yes" : "no"} | ${row.description} |`),
  ].join("\n");
}

function buildMarkdown() {
  const lines = [
    "<!-- This file is generated by scripts/generate-public-api-docs.mjs. Do not edit it by hand. -->",
    "",
    "# Renewlet Public API",
    "",
    "Renewlet Public API is read-only and scoped to the owner of the token. Create a token in Settings, then send it as a bearer token:",
    "",
    "```bash",
    "curl -H \"Authorization: Bearer rlt_your_token\" https://renewlet.example.com/api/public/v1/subscriptions",
    "```",
    "",
    "The API does not accept query parameter tokens, browser session cookies, calendar feed tokens, or public status page tokens.",
    "",
    "Machine-readable OpenAPI 3.1 document: [`docs/public-api.openapi.json`](./public-api.openapi.json).",
    "",
    "All JSON success responses use `{ \"ok\": true, \"data\": ... }`. Error responses use `{ \"error\": { \"code\", \"message\", \"details?\", \"requestId?\" } }`.",
    "",
    "## Endpoints",
    "",
  ];

  for (const endpoint of publicApiEndpointDocs) {
    lines.push(`### ${endpoint.method.toUpperCase()} \`${endpoint.path}\``);
    lines.push("");
    lines.push(endpoint.description);
    lines.push("");
    lines.push("Parameters:");
    lines.push("");
    lines.push(markdownTable([...(endpoint.parameters ?? [])]));
    lines.push("");
    lines.push("Example:");
    lines.push("");
    lines.push("```bash");
    lines.push(`curl -H "Authorization: Bearer rlt_your_token" "https://renewlet.example.com${endpoint.exampleUrl}"`);
    lines.push("```");
    lines.push("");
    lines.push("Success response example:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(endpoint.successExample, null, 2));
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function writeOrCheck(outputs) {
  const failures = [];
  for (const output of outputs) {
    if (!fs.existsSync(output.path)) {
      if (checkMode) failures.push(`${path.relative(rootDir, output.path)} is missing. Run \`pnpm generate:public-api-docs\`.`);
      if (checkMode) continue;
    }
    if (checkMode && fs.readFileSync(output.path, "utf8") !== output.source) {
      failures.push(`${path.relative(rootDir, output.path)} is out of sync. Run \`pnpm generate:public-api-docs\`.`);
    }
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  if (!checkMode) {
    for (const output of outputs) {
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, output.source);
    }
  }
}

checkRuntimeRoutes();

const openApiDocument = buildOpenApiDocument();
validateOpenApiProjection(openApiDocument);

const outputs = [
  { path: openApiPath, source: stableJson(openApiDocument) },
  { path: markdownPath, source: buildMarkdown() },
];

writeOrCheck(outputs);

if (checkMode) {
  console.log("public api docs OK.");
} else {
  console.log("generated public api OpenAPI and Markdown docs.");
}
