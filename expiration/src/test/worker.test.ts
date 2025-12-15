import { OrderCreatedListener } from "../events/listeners/order-created-listener";
import { natsWrapper } from "../nats-wrapper";
import { expirationQueue } from "../queues/expiration-queue";

jest.mock("../nats-wrapper");
jest.mock("../queues/expiration-queue", () => {
  const jobs: any[] = [];
  return {
    expirationQueue: {
      add: jest.fn((data, opts) => {
        jobs.push({ data, opts });
        return Promise.resolve();
      }),
      __jobs: jobs,
    },
  };
});

describe("Expiration worker listener", () => {
  it("queues a job with correct delay", async () => {
    const listener = new OrderCreatedListener(natsWrapper.client as any);
    const data: any = {
      id: "orderId",
      version: 0,
      status: "created",
      userId: "user",
      expiresAt: new Date(Date.now() + 15 * 1000).toISOString(),
      ticket: { id: "ticketId", price: 10 },
    };
    // @ts-ignore
    await listener.onMessage(data, { ack: jest.fn() });

    // @ts-ignore
    const jobs = (expirationQueue as any).__jobs;
    expect(jobs.length).toBe(1);
    expect(jobs[0].data.orderId).toBe("orderId");
    expect(jobs[0].opts?.delay).toBeGreaterThanOrEqual(0);
  });
});
