import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import { serverDiagnosticFailures } from "../../scripts/server-diagnostics";

export default class ServerDiagnosticsReporter implements Reporter {
  private outputFile: string;
  private stdoutChunks: string[] = [];
  private stderrChunks: string[] = [];

  constructor(options: { outputFile: string }) {
    this.outputFile = options.outputFile;
  }

  // WebServer 启动日志可早于 onBegin；分流保存完整 chunk，避免拆行或 stdout/stderr 交错导致漏判。
  onStdOut(chunk: string | Buffer) {
    this.stdoutChunks.push(chunk.toString());
  }

  onStdErr(chunk: string | Buffer) {
    this.stderrChunks.push(chunk.toString());
  }

  async onEnd(result: Pick<FullResult, "status">): Promise<{ status: FullResult["status"] }> {
    const failures = [
      ...serverDiagnosticFailures(this.stdoutChunks.join("")),
      ...serverDiagnosticFailures(this.stderrChunks.join("")),
    ];
    const status = failures.length > 0 ? "failed" : result.status;
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify({ status, failures }, null, 2));
    console.log(`Server diagnostics: ${status}; ${failures.length} warning/error lines; ${this.outputFile}`);
    return { status };
  }
}
