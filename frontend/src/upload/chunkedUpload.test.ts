import { afterEach, describe, expect, it, vi } from "vitest";
import { api, errorCode } from "../api";
import { SIMPLE_UPLOAD_MAX, STREAM_FALLBACK_MAX } from "./constants";
import {
  CompleteFailedError,
  SessionExpiredError,
  UploadSessionExpiredError,
  uploadFile,
} from "./chunkedUpload";

function fileOf(size: number, name = "a.bin"): File {
  return new File([new Uint8Array(size)], name);
}

function baseOptions(size: number) {
  return {
    brand: "haute_brands",
    folderId: "fld",
    file: fileOf(size),
    onProgress: vi.fn(),
    isPaused: () => false,
    signal: new AbortController().signal,
    waitWhilePaused: vi.fn(async () => undefined),
  };
}

function installNonSignalingXhr() {
  const abort = vi.fn();
  const send = vi.fn();

  class FakeXmlHttpRequest {
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = "";

    open() {}
    setRequestHeader() {}
    abort = abort;
    send = send;
  }

  vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);
  return { abort, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("uses simple upload under 10 MiB", async () => {
    const simpleUpload = vi.fn().mockResolvedValue(undefined);
    const result = await uploadFile({
      ...baseOptions(SIMPLE_UPLOAD_MAX - 1),
      transport: {
        start: vi.fn(),
        putChunk: vi.fn(),
        complete: vi.fn(),
        simpleUpload,
      },
    });

    expect(result).toEqual({ mode: "simple" });
    expect(simpleUpload).toHaveBeenCalledOnce();
  });

  it("sends sequential ranges, reports acknowledged progress, then completes", async () => {
    const ranges: string[] = [];
    const onProgress = vi.fn();
    const complete = vi.fn().mockResolvedValue(undefined);
    const result = await uploadFile({
      ...baseOptions(12 * 1024 * 1024),
      onProgress,
      transport: {
        start: vi
          .fn()
          .mockResolvedValue({ upload_id: "uid", chunk_size: 8 * 1024 * 1024 }),
        putChunk: vi.fn(async (_id, _blob, contentRange) => {
          ranges.push(contentRange);
          const match = /bytes (\d+)-(\d+)\//.exec(contentRange)!;
          return { acked_end: Number(match[2]) };
        }),
        complete,
        simpleUpload: vi.fn(),
      },
    });

    expect(result).toEqual({ mode: "chunked", uploadId: "uid" });
    expect(ranges).toEqual([
      "bytes 0-8388607/12582912",
      "bytes 8388608-12582911/12582912",
    ]);
    expect(onProgress).toHaveBeenLastCalledWith(100);
    expect(complete).toHaveBeenCalledWith("uid");
  });

  it("falls back when chunk upload is unavailable", async () => {
    const error = Object.assign(new Error("nope"), {
      code: "CHUNK_UPLOAD_UNAVAILABLE",
      status: 503,
    });
    const simpleUpload = vi.fn().mockResolvedValue(undefined);
    const result = await uploadFile({
      ...baseOptions(15 * 1024 * 1024),
      transport: {
        start: vi.fn().mockRejectedValue(error),
        putChunk: vi.fn(),
        complete: vi.fn(),
        simpleUpload,
      },
    });

    expect(result).toEqual({ mode: "fallback" });
    expect(simpleUpload).toHaveBeenCalledOnce();
  });

  it("does not fall back over 2 GiB", async () => {
    const error = Object.assign(new Error("nope"), {
      code: "CHUNK_UPLOAD_UNAVAILABLE",
      status: 503,
    });
    const big = fileOf(1);
    Object.defineProperty(big, "size", { value: STREAM_FALLBACK_MAX + 1 });

    await expect(
      uploadFile({
        ...baseOptions(1),
        file: big,
        transport: {
          start: vi.fn().mockRejectedValue(error),
          putChunk: vi.fn(),
          complete: vi.fn(),
          simpleUpload: vi.fn(),
        },
      }),
    ).rejects.toThrow(/2 GiB/i);
  });

  it("retries the same failed chunk with specified backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    const putChunk = vi
      .fn()
      .mockRejectedValueOnce(new Error("net 1"))
      .mockRejectedValueOnce(new Error("net 2"))
      .mockResolvedValue({ acked_end: SIMPLE_UPLOAD_MAX - 1 });

    await uploadFile({
      ...baseOptions(SIMPLE_UPLOAD_MAX),
      sleep,
      transport: {
        start: vi
          .fn()
          .mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
        putChunk,
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
    });

    expect(putChunk).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(new Set(putChunk.mock.calls.map((call) => call[2]))).toEqual(
      new Set([`bytes 0-${SIMPLE_UPLOAD_MAX - 1}/${SIMPLE_UPLOAD_MAX}`]),
    );
  });

  it("backs off for 60 seconds after a rate limit response", async () => {
    const sleep = vi.fn(async () => undefined);
    const rateLimitError = Object.assign(new Error("slow down"), { status: 429 });
    const putChunk = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue({ acked_end: SIMPLE_UPLOAD_MAX - 1 });

    await uploadFile({
      ...baseOptions(SIMPLE_UPLOAD_MAX),
      sleep,
      transport: {
        start: vi
          .fn()
          .mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
        putChunk,
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
    });

    expect(putChunk).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("resumes from the last acknowledged byte without starting again", async () => {
    const start = vi.fn();
    const putChunk = vi
      .fn()
      .mockResolvedValue({ acked_end: 12 * 1024 * 1024 - 1 });

    await uploadFile({
      ...baseOptions(12 * 1024 * 1024),
      resume: {
        uploadId: "existing",
        ackedEnd: 8 * 1024 * 1024 - 1,
        chunkSize: 8 * 1024 * 1024,
      },
      transport: {
        start,
        putChunk,
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
    });

    expect(start).not.toHaveBeenCalled();
    expect(putChunk).toHaveBeenCalledOnce();
    expect(putChunk.mock.calls[0][0]).toBe("existing");
    expect(putChunk.mock.calls[0][2]).toBe(
      "bytes 8388608-12582911/12582912",
    );
  });

  it("reports the session and each acknowledged checkpoint", async () => {
    const onCheckpoint = vi.fn();

    await uploadFile({
      ...baseOptions(12 * 1024 * 1024),
      onCheckpoint,
      transport: {
        start: vi
          .fn()
          .mockResolvedValue({ upload_id: "uid", chunk_size: 8 * 1024 * 1024 }),
        putChunk: vi
          .fn()
          .mockResolvedValueOnce({ acked_end: 8 * 1024 * 1024 - 1 })
          .mockResolvedValueOnce({ acked_end: 12 * 1024 * 1024 - 1 }),
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
    });

    expect(onCheckpoint.mock.calls).toEqual([
      [{ uploadId: "uid", ackedEnd: -1, chunkSize: 8 * 1024 * 1024 }],
      [
        {
          uploadId: "uid",
          ackedEnd: 8 * 1024 * 1024 - 1,
          chunkSize: 8 * 1024 * 1024,
        },
      ],
      [
        {
          uploadId: "uid",
          ackedEnd: 12 * 1024 * 1024 - 1,
          chunkSize: 8 * 1024 * 1024,
        },
      ],
    ]);
  });

  it("does not start the next chunk while paused", async () => {
    let paused = false;
    let resume!: () => void;
    const waitWhilePaused = vi.fn(() => {
      if (!paused) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resume = resolve;
      });
    });
    const putChunk = vi.fn(async (_id, _blob, contentRange) => {
      const end = Number(/bytes \d+-(\d+)\//.exec(contentRange)![1]);
      if (putChunk.mock.calls.length === 1) paused = true;
      return { acked_end: end };
    });

    const upload = uploadFile({
      ...baseOptions(12 * 1024 * 1024),
      isPaused: () => paused,
      waitWhilePaused,
      transport: {
        start: vi
          .fn()
          .mockResolvedValue({ upload_id: "uid", chunk_size: 8 * 1024 * 1024 }),
        putChunk,
        complete: vi.fn().mockResolvedValue(undefined),
        simpleUpload: vi.fn(),
      },
    });

    await vi.waitFor(() => expect(waitWhilePaused).toHaveBeenCalledTimes(2));
    expect(putChunk).toHaveBeenCalledOnce();
    paused = false;
    resume();
    await upload;
    expect(putChunk).toHaveBeenCalledTimes(2);
  });

  it("maps 401 to SessionExpiredError without retry", async () => {
    const error = Object.assign(new Error("no"), { status: 401 });
    const putChunk = vi.fn().mockRejectedValue(error);

    await expect(
      uploadFile({
        ...baseOptions(SIMPLE_UPLOAD_MAX),
        sleep: vi.fn(async () => undefined),
        transport: {
          start: vi
            .fn()
            .mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
          putChunk,
          complete: vi.fn(),
          simpleUpload: vi.fn(),
        },
      }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(putChunk).toHaveBeenCalledOnce();
  });

  it.each([404, 410])("maps HTTP %s to a restartable upload error", async (status) => {
    const error = Object.assign(new Error("gone"), { status });

    await expect(
      uploadFile({
        ...baseOptions(SIMPLE_UPLOAD_MAX),
        transport: {
          start: vi
            .fn()
            .mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
          putChunk: vi.fn().mockRejectedValue(error),
          complete: vi.fn(),
          simpleUpload: vi.fn(),
        },
      }),
    ).rejects.toBeInstanceOf(UploadSessionExpiredError);
  });

  it("exposes the upload ID when completion fails", async () => {
    const completeError = new Error("complete failed");

    try {
      await uploadFile({
        ...baseOptions(SIMPLE_UPLOAD_MAX),
        transport: {
          start: vi
            .fn()
            .mockResolvedValue({ upload_id: "uid", chunk_size: SIMPLE_UPLOAD_MAX }),
          putChunk: vi
            .fn()
            .mockResolvedValue({ acked_end: SIMPLE_UPLOAD_MAX - 1 }),
          complete: vi.fn().mockRejectedValue(completeError),
          simpleUpload: vi.fn(),
        },
      });
      throw new Error("Expected completion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CompleteFailedError);
      expect(error).toMatchObject({
        uploadId: "uid",
        mode: "chunked",
        cause: completeError,
      });
    }
  });
});

describe("errorCode", () => {
  it("reads the nested storage error envelope", () => {
    expect(
      errorCode({
        detail: {
          error: {
            code: "CHUNK_UPLOAD_UNAVAILABLE",
            message: "Chunk upload is unavailable",
          },
        },
      }),
    ).toBe("CHUNK_UPLOAD_UNAVAILABLE");
    expect(errorCode({ detail: { code: "DIRECT_CODE" } })).toBe("DIRECT_CODE");
  });
});

describe("aborted XHR uploads", () => {
  it("rejects a chunk immediately when the signal is already aborted", async () => {
    const xhr = installNonSignalingXhr();
    const controller = new AbortController();
    controller.abort();

    await expect(
      Promise.race([
        api.putChunk(
          "haute_brands",
          "uid",
          new Blob(["chunk"]),
          "bytes 0-4/5",
          vi.fn(),
          controller.signal,
        ),
        Promise.resolve("still pending"),
      ]),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.send).not.toHaveBeenCalled();
  });

  it("rejects a simple upload immediately when the signal is already aborted", async () => {
    const xhr = installNonSignalingXhr();
    const controller = new AbortController();
    controller.abort();

    await expect(
      Promise.race([
        api.upload(
          "haute_brands",
          "fld",
          fileOf(1),
          vi.fn(),
          controller.signal,
        ),
        Promise.resolve("still pending"),
      ]),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.send).not.toHaveBeenCalled();
  });
});
