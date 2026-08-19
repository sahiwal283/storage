import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./queue";

describe("createSerialQueue", () => {
  it("runs jobs one at a time in FIFO order", async () => {
    const order: number[] = [];
    const q = createSerialQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    q.enqueue(async () => {
      order.push(1);
      await gate;
    });
    q.enqueue(async () => {
      order.push(2);
    });
    await Promise.resolve();
    expect(order).toEqual([1]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);
  });

  it("continues draining after a job fails", async () => {
    const order: number[] = [];
    const q = createSerialQueue();
    q.enqueue(async () => {
      order.push(1);
      throw new Error("failed");
    });
    q.enqueue(async () => {
      order.push(2);
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(order).toEqual([1, 2]);
  });

  it("reports running and queued jobs in its size", async () => {
    const q = createSerialQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    q.enqueue(() => gate);
    q.enqueue(async () => {});

    expect(q.size()).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(q.size()).toBe(0);
  });
});
