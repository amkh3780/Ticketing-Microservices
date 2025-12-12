import mongoose from 'mongoose';
import { app } from './app';
import { natsWrapper } from './nats-wrapper';
import { OrderCreatedListener } from './events/listeners/order-created-listener';
import { OrderCancelledListener } from './events/listeners/order-cancelled-listener';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function connectMongo(uri: string) {
  const max = 20;
  const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
  for (let i = 1; i <= max; i++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 20000,
      } as any);
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      console.error(`Mongo connect failed (attempt ${i}/${max}):`, (err as Error).message);
      await delay(Math.min(5000, i * 500));
    }
  }
  throw new Error('Mongo connection failed after retries');
}

function assertEnv(names: string[]) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

async function start() {
  process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  });

  assertEnv(['JWT_KEY', 'MONGO_URI', 'NATS_URL', 'NATS_CLIENT_ID', 'NATS_CLUSTER_ID']);

  await natsWrapper.connect(
    process.env.NATS_CLUSTER_ID!,
    process.env.NATS_CLIENT_ID!,
    process.env.NATS_URL!
  );
  natsWrapper.client.on('close', () => {
    console.log('NATS connection closed!');
    process.exit();
  });
  process.on('SIGINT', () => natsWrapper.client.close());
  process.on('SIGTERM', () => natsWrapper.client.close());
  console.log('Connected to NATS');

  // لیسنرهای وابسته به ناتس
  new OrderCreatedListener(natsWrapper.client).listen();
  new OrderCancelledListener(natsWrapper.client).listen();

  await connectMongo(process.env.MONGO_URI!);

  app.listen(PORT, () => {
    console.log(`Tickets service listening on port ${PORT} !!!`);
  });
}

start().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});

