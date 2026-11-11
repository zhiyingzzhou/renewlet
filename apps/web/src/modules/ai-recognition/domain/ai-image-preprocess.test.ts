import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunWorkerJobOptions } from "@/lib/workers/run-worker-job";
import type {
  AIImagePreprocessWorkerPayload,
  AIImagePreprocessWorkerResult,
} from "./ai-image-preprocess-contract";
import {
  AI_RECOGNITION_IMAGE_SOFT_BYTES,
  AI_RECOGNITION_IMAGE_TOTAL_SOFT_BYTES,
  AIRecognitionImagePreprocessError,
  aiRecognitionImageTargetBytes,
  prepareAIRecognitionImage,
} from "./ai-image-preprocess";

type RunAIImageWorkerJob = (
  options: RunWorkerJobOptions<AIImagePreprocessWorkerPayload>,
) => Promise<AIImagePreprocessWorkerResult>;

const workerMocks = vi.hoisted(() => ({
  runWorkerJob: vi.fn<RunAIImageWorkerJob>(),
}));

vi.mock("@/lib/workers/run-worker-job", () => ({
  runWorkerJob: workerMocks.runWorkerJob,
}));

const HARD_BYTES = 5 * 1024 * 1024;

function fileOfSize(size: number, name = "subscriptions.png", type = "image/png"): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1 });
}

describe("ai image preprocess", () => {
  beforeEach(() => {
    workerMocks.runWorkerJob.mockReset();
  });

  it("uses a 2MB per-image target while the total soft budget stays at 10MB", () => {
    expect(aiRecognitionImageTargetBytes(1)).toBe(AI_RECOGNITION_IMAGE_SOFT_BYTES);
    expect(aiRecognitionImageTargetBytes(5)).toBe(AI_RECOGNITION_IMAGE_SOFT_BYTES);
    expect(aiRecognitionImageTargetBytes(6)).toBe(Math.floor(AI_RECOGNITION_IMAGE_TOTAL_SOFT_BYTES / 6));
  });

  it("transfers the source buffer to the dedicated worker and keeps an unchanged result", async () => {
    const file = fileOfSize(300 * 1024);
    const sourceBuffer = new ArrayBuffer(file.size);
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(sourceBuffer);
    workerMocks.runWorkerJob.mockResolvedValue({
      buffer: new ArrayBuffer(file.size),
      mimeType: "image/png",
      optimized: false,
      warning: null,
    });

    const result = await prepareAIRecognitionImage(file, {
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
    });

    expect(result).toMatchObject({
      optimized: false,
      warning: null,
      originalSizeBytes: file.size,
      targetSizeBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
    });
    expect(result.file).toMatchObject({ name: file.name, type: file.type, size: file.size });
    const call = workerMocks.runWorkerJob.mock.calls[0];
    if (!call) throw new Error("Expected the image worker job");
    expect(call[0].payload).toEqual({
      buffer: sourceBuffer,
      mimeType: "image/png",
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
      maxBytes: HARD_BYTES,
      maxEdge: 3072,
    });
    expect(call[0].transfer).toEqual([sourceBuffer]);
  });

  it("rebuilds the optimized File and forwards cancellation and progress", async () => {
    const file = fileOfSize(3 * 1024 * 1024, "bill.png", "image/png");
    const controller = new AbortController();
    const onProgress = vi.fn();
    workerMocks.runWorkerJob.mockResolvedValue({
      buffer: new ArrayBuffer(1800 * 1024),
      mimeType: "image/webp",
      optimized: true,
      warning: null,
    });

    const result = await prepareAIRecognitionImage(file, {
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
      signal: controller.signal,
      onProgress,
    });

    expect(result.file).toMatchObject({ name: "bill.webp", type: "image/webp", size: 1800 * 1024 });
    expect(result.optimized).toBe(true);
    const call = workerMocks.runWorkerJob.mock.calls[0];
    if (!call) throw new Error("Expected the image worker job");
    expect(call[0].signal).toBe(controller.signal);
    expect(call[0].onProgress).toBe(onProgress);
  });

  it("maps an unsupported worker result to the domain error", async () => {
    workerMocks.runWorkerJob.mockRejectedValue(new Error("unsupported"));

    await expect(prepareAIRecognitionImage(fileOfSize(512 * 1024), {
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
    })).rejects.toMatchObject({
      name: "AIRecognitionImagePreprocessError",
      code: "unsupported",
    } satisfies Partial<AIRecognitionImagePreprocessError>);
  });

  it("rejects files over the hard model input limit before reading bytes", async () => {
    const file = fileOfSize(HARD_BYTES + 1);
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    await expect(prepareAIRecognitionImage(file, {
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
    })).rejects.toMatchObject({
      name: "AIRecognitionImagePreprocessError",
      code: "too-large",
    } satisfies Partial<AIRecognitionImagePreprocessError>);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(workerMocks.runWorkerJob).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted selection before creating the worker", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(prepareAIRecognitionImage(fileOfSize(512 * 1024), {
      targetBytes: AI_RECOGNITION_IMAGE_SOFT_BYTES,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(workerMocks.runWorkerJob).not.toHaveBeenCalled();
  });
});
