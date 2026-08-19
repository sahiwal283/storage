import { STREAM_FALLBACK_MAX, SIMPLE_UPLOAD_MAX } from "./constants";

export type ChunkTransport = {
  start(
    folderId: string,
    body: { filename: string; size: number; content_type: string },
  ): Promise<{ upload_id: string; chunk_size: number }>;
  putChunk(
    uploadId: string,
    blob: Blob,
    contentRange: string,
    onProgress: (pct: number) => void,
    signal: AbortSignal,
  ): Promise<{ acked_end: number }>;
  complete(uploadId: string): Promise<void>;
  simpleUpload(
    folderId: string,
    file: File,
    onProgress: (pct: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
};

export class SessionExpiredError extends Error {
  constructor() {
    super("Your session expired. Sign in and try again.");
    this.name = "SessionExpiredError";
  }
}

export class UploadSessionExpiredError extends Error {
  readonly restartable = true;

  constructor() {
    super("The upload session expired and the upload had to restart.");
    this.name = "UploadSessionExpiredError";
  }
}

export class CompleteFailedError extends Error {
  readonly uploadId: string;
  readonly mode = "chunked" as const;
  readonly cause: unknown;

  constructor(uploadId: string, cause: unknown) {
    super("All chunks uploaded, but the upload could not be completed.");
    this.name = "CompleteFailedError";
    this.uploadId = uploadId;
    this.cause = cause;
  }
}

type UploadError = Error & {
  code?: string;
  status?: number;
  retryAfterMs?: number;
};

export type UploadCheckpoint = {
  uploadId: string;
  ackedEnd: number;
  chunkSize: number;
};

type UploadFileOptions = {
  brand: string;
  folderId: string;
  file: File;
  transport: ChunkTransport;
  onProgress: (pct: number) => void;
  isPaused: () => boolean;
  signal: AbortSignal;
  waitWhilePaused: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  resume?: UploadCheckpoint;
  onCheckpoint?: (state: UploadCheckpoint) => void;
};

export type UploadFileResult = {
  mode: "chunked" | "simple" | "fallback";
  uploadId?: string;
};

const RETRY_DELAYS = [1000, 2000, 4000] as const;
const MAX_CHUNK_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 60_000;

function statusOf(error: unknown): number | undefined {
  return (error as UploadError | undefined)?.status;
}

function normalizeLiveSessionError(error: unknown): never {
  const status = statusOf(error);
  if (status === 401) throw new SessionExpiredError();
  if (status === 404 || status === 410) throw new UploadSessionExpiredError();
  throw error;
}

function normalizeSessionError(error: unknown): never {
  if (statusOf(error) === 401) throw new SessionExpiredError();
  throw error;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

function retryDelayMs(error: unknown, attempt: number): number {
  if (statusOf(error) === 429) {
    const retryAfterMs = (error as UploadError | undefined)?.retryAfterMs;
    if (
      typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs > 0
    ) {
      return retryAfterMs;
    }
    return RATE_LIMIT_BACKOFF_MS;
  }
  return RETRY_DELAYS[attempt];
}

async function uploadChunkWithRetry(
  operation: () => Promise<{ acked_end: number }>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ acked_end: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 404 || status === 410) {
        normalizeLiveSessionError(error);
      }
      if ((error as Error | undefined)?.name === "AbortError") throw error;
      if (attempt >= MAX_CHUNK_ATTEMPTS - 1) throw error;
      await sleep(retryDelayMs(error, attempt));
    }
  }
}

export async function uploadFile(
  opts: UploadFileOptions,
): Promise<UploadFileResult> {
  const {
    file,
    folderId,
    transport,
    onProgress,
    signal,
    waitWhilePaused,
    sleep = defaultSleep,
    resume,
    onCheckpoint,
  } = opts;

  if (file.size < SIMPLE_UPLOAD_MAX && resume == null) {
    try {
      await transport.simpleUpload(folderId, file, onProgress, signal);
      return { mode: "simple" };
    } catch (error) {
      normalizeSessionError(error);
    }
  }

  let session: { upload_id: string; chunk_size: number };
  let ackedEnd: number;
  if (resume) {
    session = { upload_id: resume.uploadId, chunk_size: resume.chunkSize };
    ackedEnd = resume.ackedEnd;
  } else {
    try {
      session = await transport.start(folderId, {
        filename: file.name,
        size: file.size,
        content_type: file.type || "application/octet-stream",
      });
    } catch (error) {
      const uploadError = error as UploadError;
      if (uploadError.code !== "CHUNK_UPLOAD_UNAVAILABLE") {
        normalizeSessionError(error);
      }
      if (file.size > STREAM_FALLBACK_MAX) {
        throw new Error(
          "Files over 2 GiB require chunked upload, which is currently unavailable.",
        );
      }
      try {
        await transport.simpleUpload(folderId, file, onProgress, signal);
        return { mode: "fallback" };
      } catch (fallbackError) {
        normalizeSessionError(fallbackError);
      }
    }
    ackedEnd = -1;
    onCheckpoint?.({
      uploadId: session.upload_id,
      ackedEnd,
      chunkSize: session.chunk_size,
    });
  }

  while (ackedEnd + 1 < file.size) {
    await waitWhilePaused();
    const start = ackedEnd + 1;
    const end = Math.min(start + session.chunk_size, file.size) - 1;
    const blob = file.slice(start, end + 1);
    const contentRange = `bytes ${start}-${end}/${file.size}`;
    const result = await uploadChunkWithRetry(
      () =>
        transport.putChunk(
          session.upload_id,
          blob,
          contentRange,
          (chunkPct) => {
            const uploaded = start + (blob.size * chunkPct) / 100;
            onProgress((uploaded / file.size) * 100);
          },
          signal,
        ),
      sleep,
    );
    ackedEnd = result.acked_end;
    onCheckpoint?.({
      uploadId: session.upload_id,
      ackedEnd,
      chunkSize: session.chunk_size,
    });
    onProgress(((ackedEnd + 1) / file.size) * 100);
  }

  try {
    await transport.complete(session.upload_id);
  } catch (error) {
    let cause = error;
    const status = statusOf(error);
    if (status === 401) cause = new SessionExpiredError();
    if (status === 404 || status === 410) cause = new UploadSessionExpiredError();
    throw new CompleteFailedError(session.upload_id, cause);
  }
  return { mode: "chunked", uploadId: session.upload_id };
}
