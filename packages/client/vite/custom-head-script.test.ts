import { describe, expect, it } from "vitest";

import {
  injectCustomHeadScriptHtml,
  parseCustomHeadScript,
  updateCustomHeadScriptStaticHeaders,
} from "./custom-head-script";

describe("parseCustomHeadScript", () => {
  it("accepts one external script and preserves markup", () => {
    const raw = `<script defer src="https://cdn.example.com/widget.js" data-widget-id="widget-id"></script>`;

    const script = parseCustomHeadScript(raw);

    expect(script?.markup).toBe(raw);
    expect(script?.scriptOrigin).toBe("https://cdn.example.com");
    expect(script?.connectOrigins).toEqual(["https://cdn.example.com"]);
  });

  it("adds data-host-url to connect origins", () => {
    const script = parseCustomHeadScript(
      `<script defer src="https://cdn.example.com/widget.js" data-host-url="https://api.example.com/widget"></script>`,
    );

    expect(script?.connectOrigins).toEqual(["https://cdn.example.com", "https://api.example.com"]);
  });

  it("rejects unsafe or malformed scripts", () => {
    const cases = [
      `<script>alert(1)</script>`,
      `<script src="https://example.com/a.js"></script><script src="https://example.com/b.js"></script>`,
      `<div></div>`,
      `<script defer></script>`,
      `<script src="javascript:alert(1)"></script>`,
      `<script src="https://user:pass@example.com/a.js"></script>`,
      `<script src="https://example.com/a.js" onload="alert(1)"></script>`,
      `<script src="https://example.com/a.js" SRC="https://example.com/b.js"></script>`,
      `<script src="https://example.com/a.js">`,
      `<script src="https://example.com/a.js" />`,
    ];

    for (const raw of cases) {
      expect(() => parseCustomHeadScript(raw), raw).toThrow();
    }
  });
});

describe("injectCustomHeadScriptHtml", () => {
  it("injects the script before the closing head tag", () => {
    const script = parseCustomHeadScript(`<script defer src="https://cdn.example.com/widget.js"></script>`);

    const html = injectCustomHeadScriptHtml("<html><head><title>Renewlet</title></head><body></body></html>", script);

    expect(html).toContain(`<script defer src="https://cdn.example.com/widget.js"></script>\n  </head>`);
  });

  it("leaves html unchanged when the script is absent", () => {
    const html = "<html><head></head><body></body></html>";

    expect(injectCustomHeadScriptHtml(html, undefined)).toBe(html);
  });

  it("does not inject the same markup twice", () => {
    const script = parseCustomHeadScript(`<script defer src="https://cdn.example.com/widget.js"></script>`);
    const html = "<html><head><title>Renewlet</title></head><body></body></html>";

    const once = injectCustomHeadScriptHtml(html, script);
    const twice = injectCustomHeadScriptHtml(once, script);

    expect(twice).toBe(once);
  });
});

describe("updateCustomHeadScriptStaticHeaders", () => {
  it("adds custom script origins to script-src and connect-src", () => {
    const script = parseCustomHeadScript(
      `<script defer src="https://cdn.example.com/widget.js" data-host-url="https://api.example.com/widget"></script>`,
    );
    const headers = [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'",
      "",
    ].join("\n");

    const updated = updateCustomHeadScriptStaticHeaders(headers, script);

    expect(updated).toContain("script-src 'self' 'wasm-unsafe-eval' https://cdn.example.com");
    expect(updated).toContain("connect-src 'self' https://cdn.jsdelivr.net https://cdn.example.com https://api.example.com");
  });

  it("keeps CSP origins unique when headers are updated again", () => {
    const script = parseCustomHeadScript(`<script defer src="https://cdn.example.com/widget.js"></script>`);
    const headers = [
      "/*",
      "  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://cdn.example.com",
      "",
    ].join("\n");

    const once = updateCustomHeadScriptStaticHeaders(headers, script);
    const twice = updateCustomHeadScriptStaticHeaders(once, script);

    expect(twice).toBe(once);
  });
});
