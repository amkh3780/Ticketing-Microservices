import mongoose from 'mongoose';
import { app } from './app';
import { natsWrapper } from './nats-wrapper';
import { OrderCreatedListener } from './events/listeners/order-created-listener';
import { OrderCancelledListener } from './events/listeners/order-cancelled-listener';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function assertEnv(names: string[]) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

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

async function start() {
  process.on('unhandledRejection', (err) => { console.error('UNHANDLED REJECTION:', err); process.exit(1); });
  process.on('uncaughtException',  (err) => { console.error('UNCAUGHT EXCEPTION:',  err); process.exit(1); });

  assertEnv([
    'JWT_KEY',
    'MONGO_URI',
    'NATS_URL',
    'NATS_CLIENT_ID',
    'NATS_CLUSTER_ID',
    'STRIPE_KEY',
  ]);

  // --- Stripe key sanity check (fail-fast) ---
  {
    const sk = (process.env.STRIPE_KEY || '').trim();
    if (!sk.startsWith('sk_')) {
      throw new Error('STRIPE_KEY must be an sk_* server secret (not a publishable key).');
    }
    process.env.STRIPE_KEY = sk;
  }

  // --- NATS connect with retry & dynamic clientId to avoid "clientID already registered"
  const clusterId = process.env.NATS_CLUSTER_ID!;
  const baseClientId = process.env.NATS_CLIENT_ID!; // معمولاً نام پاد از fieldRef
  const natsUrl = process.env.NATS_URL!;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let natsConnected = false;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const suffix =
      attempt === 1 ? '' : `-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const clientId = `${baseClientId}${suffix}`;
    try {
      await natsWrapper.connect(clusterId, clientId, natsUrl);
      natsWrapper.client.on('close', () => {
        console.log('NATS connection closed!');
        process.exit();
      });
      process.on('SIGINT', () => natsWrapper.client.close());
      process.on('SIGTERM', () => natsWrapper.client.close());
      process.on('SIGUSR2', () => natsWrapper.client.close()); // برای ری‌لودهای dev
      console.log(`Connected to NATS as clientId=${clientId}`);
      natsConnected = true;
      break;
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      console.warn(`NATS connect failed (attempt ${attempt}/8): ${msg}`);
      if (!msg.includes('clientID already registered') && attempt >= 3) {
        throw err;
      }
      await delay(Math.min(5000, attempt * 800));
    }
  }
  if (!natsConnected) throw new Error('Failed to connect to NATS after retries.');

  // Listeners
  new OrderCreatedListener(natsWrapper.client).listen();
  new OrderCancelledListener(natsWrapper.client).listen();

  await connectMongo(process.env.MONGO_URI!);

  app.listen(PORT, () => {
    console.log(`Payments service listening on port ${PORT} !!!`);
  });
}

start().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
