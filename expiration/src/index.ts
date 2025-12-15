import { OrderCreatedListener } from "./events/listeners/order-created-listener";
import { natsWrapper } from "./nats-wrapper";

function assertEnv(names: string[]) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

const start = async () => {
  process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
    process.exit(1);
  });

  assertEnv(["NATS_CLIENT_ID", "NATS_URL", "NATS_CLUSTER_ID"]);

  //connect to NATS (we have created a class to simulate mongoose's accessibility )
  await natsWrapper.connect(
    process.env.NATS_CLUSTER_ID!,
    process.env.NATS_CLIENT_ID!,
    process.env.NATS_URL!
  );
  //Capture any close event
  natsWrapper.client.on("close", () => {
    console.log("NATS connection closed!");
    process.exit();
  });

  //2 listeners:Watching for interrupt signals or terminate signals (Exp:ctrl + c in terminal)
  process.on("SIGINT", () => natsWrapper.client.close()); //Interrupt
  process.on("SIGTERM", () => natsWrapper.client.close()); //Terminate

  new OrderCreatedListener(natsWrapper.client).listen();
};

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
