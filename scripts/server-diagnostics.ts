import { stripVTControlCharacters } from "node:util";

/** 页面断言无法覆盖旧文档和服务端日志；普通 E2E 与性能门禁使用同一告警判定。 */
export function serverDiagnosticFailures(output: string): string[] {
  return stripVTControlCharacters(output).split(/\r?\n/)
    .filter((line) => /\b(?:ERROR|WARN(?:ING)?|Warning|Error)\b|\b\w+Warning:|\b(?:warning|error):|\[console\.(?:warn|error)\]|(?:^|\s)\(!\)/.test(line));
}
