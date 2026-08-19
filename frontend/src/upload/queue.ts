export function createSerialQueue(): {
  enqueue(job: () => Promise<void>): void;
  size: () => number;
} {
  const jobs: Array<() => Promise<void>> = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    const job = jobs.shift();
    if (!job) return;

    running = true;
    try {
      await job();
    } catch {
      // A failed job must not stop the remaining uploads.
    } finally {
      running = false;
      void drain();
    }
  };

  return {
    enqueue(job) {
      jobs.push(job);
      void drain();
    },
    size: () => jobs.length + (running ? 1 : 0),
  };
}
