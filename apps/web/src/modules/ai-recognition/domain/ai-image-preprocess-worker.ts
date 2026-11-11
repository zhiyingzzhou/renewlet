import type { WorkerJobEvent, WorkerJobRequest } from "@/lib/workers/job-protocol";
import type {
  AIImagePreprocessWorkerPayload,
  AIImagePreprocessWorkerResult,
} from "./ai-image-preprocess-contract";

const QUALITY_STEPS = [0.92, 0.9, 0.88, 0.86] as const;
const OUTPUT_MIME_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
const cancelledJobs = new Set<string>();

interface EncodedCandidate {
  blob: Blob;
  mimeType: string;
}

self.onmessage = (event: MessageEvent<WorkerJobRequest<AIImagePreprocessWorkerPayload>>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledJobs.add(message.jobId);
    return;
  }
  void processImage(message.jobId, message.payload);
};

async function processImage(jobId: string, payload: AIImagePreprocessWorkerPayload): Promise<void> {
  try {
    assertActive(jobId);
    const bitmap = await createImageBitmap(new Blob([payload.buffer], { type: payload.mimeType }));
    try {
      assertActive(jobId);
      const size = fitImageSize(bitmap.width, bitmap.height, payload.maxEdge);
      if (!size.resized && payload.buffer.byteLength <= payload.targetBytes) {
        postResult(jobId, {
          buffer: payload.buffer,
          mimeType: normalizedMimeType(payload.mimeType) ?? "image/png",
          optimized: false,
          warning: null,
        });
        return;
      }

      const canvas = new OffscreenCanvas(size.width, size.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("unsupported");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size.width, size.height);

      let bestUnderHardLimit: EncodedCandidate | null = null;
      const total = QUALITY_STEPS.reduce(
        (count, _quality, index) => count + (index === 0 ? OUTPUT_MIME_TYPES.length : OUTPUT_MIME_TYPES.length - 1),
        0,
      );
      let completed = 0;
      for (const [qualityIndex, quality] of QUALITY_STEPS.entries()) {
        const mimeTypes = qualityIndex === 0 ? OUTPUT_MIME_TYPES : OUTPUT_MIME_TYPES.filter((type) => type !== "image/png");
        const sameQualityCandidates: EncodedCandidate[] = [];
        for (const mimeType of mimeTypes) {
          assertActive(jobId);
          const blob = await canvas.convertToBlob({ type: mimeType, quality });
          completed += 1;
          postProgress(jobId, completed, total);
          const actualMimeType = normalizedMimeType(blob.type);
          if (!actualMimeType || blob.size >= payload.buffer.byteLength) continue;
          sameQualityCandidates.push({ blob, mimeType: actualMimeType });
        }
        // 同一质量下先比较所有 MIME，再决定是否提前结束；避免格式遍历顺序牺牲清晰度或体积。
        // 同一质量和尺寸下，预算内体积最大的候选保留更多 OCR 细节；选择最小文件会主动损失账单小字。
        const underTarget = largestCandidate(sameQualityCandidates.filter((candidate) => candidate.blob.size <= payload.targetBytes));
        if (underTarget) {
          await postCandidateResult(jobId, underTarget, null);
          return;
        }
        const underHardLimit = largestCandidate(sameQualityCandidates.filter((candidate) => candidate.blob.size <= payload.maxBytes));
        // 质量步进按高到低排列；硬上限兜底优先保留最高质量，再在同一质量内保留更大候选。
        if (underHardLimit && !bestUnderHardLimit) {
          bestUnderHardLimit = underHardLimit;
        }
      }

      if (bestUnderHardLimit) {
        await postCandidateResult(jobId, bestUnderHardLimit, "large-after-optimization");
        return;
      }
      postResult(jobId, {
        buffer: payload.buffer,
        mimeType: normalizedMimeType(payload.mimeType) ?? "image/png",
        optimized: false,
        warning: payload.buffer.byteLength > payload.targetBytes ? "large-after-optimization" : null,
      });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (cancelledJobs.has(jobId)) return;
    postMessage({
      type: "error",
      jobId,
      error: error instanceof Error ? error.message : "unsupported",
    } satisfies WorkerJobEvent<never>);
  } finally {
    cancelledJobs.delete(jobId);
  }
}

function fitImageSize(width: number, height: number, maxEdge: number) {
  const sourceWidth = Math.max(1, Math.round(width));
  const sourceHeight = Math.max(1, Math.round(height));
  const edge = Math.max(sourceWidth, sourceHeight);
  if (edge <= maxEdge) return { width: sourceWidth, height: sourceHeight, resized: false };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    resized: true,
  };
}

function largestCandidate(candidates: EncodedCandidate[]): EncodedCandidate | null {
  return candidates.reduce<EncodedCandidate | null>(
    (largest, candidate) => !largest || candidate.blob.size > largest.blob.size ? candidate : largest,
    null,
  );
}

function normalizedMimeType(value: string): string | null {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp" ? normalized : null;
}

async function postCandidateResult(
  jobId: string,
  candidate: EncodedCandidate,
  warning: AIImagePreprocessWorkerResult["warning"],
): Promise<void> {
  const buffer = await candidate.blob.arrayBuffer();
  assertActive(jobId);
  postResult(jobId, { buffer, mimeType: candidate.mimeType, optimized: true, warning });
}

function postProgress(jobId: string, completed: number, total: number): void {
  postMessage({ type: "progress", jobId, progress: { completed, total, phase: "encode" } } satisfies WorkerJobEvent<never>);
}

function postResult(jobId: string, result: AIImagePreprocessWorkerResult): void {
  assertActive(jobId);
  postMessage(
    { type: "result", jobId, result } satisfies WorkerJobEvent<AIImagePreprocessWorkerResult>,
    { transfer: [result.buffer] },
  );
}

function assertActive(jobId: string): void {
  if (cancelledJobs.has(jobId)) throw new DOMException("Worker job cancelled", "AbortError");
}
