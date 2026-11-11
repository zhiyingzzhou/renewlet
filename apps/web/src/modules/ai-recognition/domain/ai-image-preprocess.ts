import { AI_RECOGNITION_MAX_IMAGE_BYTES } from "@/lib/api/schemas/ai-recognition";
import { runWorkerJob } from "@/lib/workers/run-worker-job";
import type {
  AIImagePreprocessProgress,
  AIImagePreprocessWorkerPayload,
  AIImagePreprocessWorkerResult,
  AIRecognitionImagePreprocessErrorCode,
  AIRecognitionImagePreprocessWarning,
} from "./ai-image-preprocess-contract";

export const AI_RECOGNITION_IMAGE_SOFT_BYTES = 2 * 1024 * 1024;
export const AI_RECOGNITION_IMAGE_TOTAL_SOFT_BYTES = 10 * 1024 * 1024;
// 账单截图优先保留小字清晰度；3,072px 在 OCR 精度和单图 token 成本之间取平衡，最终仍受 5MB 硬上限约束。
export const AI_RECOGNITION_IMAGE_MAX_EDGE = 3072;

export type { AIRecognitionImagePreprocessWarning } from "./ai-image-preprocess-contract";

export class AIRecognitionImagePreprocessError extends Error {
  constructor(readonly code: AIRecognitionImagePreprocessErrorCode) {
    super(code);
    this.name = "AIRecognitionImagePreprocessError";
  }
}

export interface PreparedAIRecognitionImage {
  file: File;
  originalSizeBytes: number;
  targetSizeBytes: number;
  optimized: boolean;
  warning: AIRecognitionImagePreprocessWarning | null;
}

interface PrepareAIRecognitionImageOptions {
  targetBytes: number;
  maxBytes?: number;
  maxEdge?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AIImagePreprocessProgress) => void;
}

export function aiRecognitionImageTargetBytes(finalImageCount: number): number {
  const count = Math.max(1, finalImageCount);
  return Math.min(AI_RECOGNITION_IMAGE_SOFT_BYTES, Math.floor(AI_RECOGNITION_IMAGE_TOTAL_SOFT_BYTES / count));
}

export async function prepareAIRecognitionImage(
  file: File,
  options: PrepareAIRecognitionImageOptions,
): Promise<PreparedAIRecognitionImage> {
  const maxBytes = options.maxBytes ?? AI_RECOGNITION_MAX_IMAGE_BYTES;
  if (file.size > maxBytes) throw new AIRecognitionImagePreprocessError("too-large");
  const targetBytes = Math.min(Math.max(1, options.targetBytes), maxBytes);
  const sourceBuffer = await file.arrayBuffer();
  if (options.signal?.aborted) throw createAbortError();
  const originalSizeBytes = sourceBuffer.byteLength;

  try {
    const result = await runWorkerJob<AIImagePreprocessWorkerPayload, AIImagePreprocessWorkerResult>({
      createWorker: () => new Worker(new URL("./ai-image-preprocess-worker.ts", import.meta.url), { type: "module" }),
      payload: {
        buffer: sourceBuffer,
        mimeType: file.type,
        targetBytes,
        maxBytes,
        maxEdge: options.maxEdge ?? AI_RECOGNITION_IMAGE_MAX_EDGE,
      },
      transfer: [sourceBuffer],
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const outputFile = new File(
      [result.buffer],
      result.optimized ? imageFilenameForMime(file.name, result.mimeType) : file.name,
      { type: result.mimeType, lastModified: file.lastModified },
    );
    return {
      file: outputFile,
      originalSizeBytes,
      targetSizeBytes: targetBytes,
      optimized: result.optimized,
      warning: result.warning,
    };
  } catch (error) {
    if (isAIRecognitionImageAbort(error)) throw error;
    if (error instanceof Error && error.message === "unsupported") {
      throw new AIRecognitionImagePreprocessError("unsupported");
    }
    throw error;
  }
}

function imageFilenameForMime(filename: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const stem = filename.trim().replace(/\.[^.]*$/, "") || "image";
  return `${stem}.${extension}`;
}

export function isAIRecognitionImageAbort(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function createAbortError(): Error {
  return new DOMException("Image preprocessing cancelled", "AbortError");
}
