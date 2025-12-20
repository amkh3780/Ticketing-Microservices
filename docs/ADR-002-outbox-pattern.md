# ADR-002: Outbox Pattern for Transactional Event Publishing

**Status:** Proposed
**Date:** 2025-12-20
**Deciders:** Architecture Review
**Technical Story:** Eliminate dual-write problem in event-driven microservices
**Prerequisites:** ADR-001 (Graceful Shutdown) - reduces but doesn't eliminate the problem

---

## Context

### The Dual-Write Problem

Event-driven microservices commonly require atomicity across two independent systems:

1. **Local database write** (MongoDB) - ACID guarantees
2. **Event broker publish** (NATS Streaming) - no transactional coordination

**Example from Orders Service:**
```typescript
// orders/src/routes/new.ts:56-75
const order = Order.build({ userId, status, expiresAt, ticket });
await order.save();  // ← Database transaction commits here

new OrderCreatedPublisher(natsWrapper.client).publish({
  id: order.id,      // ← Event publish happens here (separate operation)
  version: order.version,
  // ...
});

res.status(201).send(order);
```

**This is a dual write:** Two non-transactional writes to separate systems.

### Why Naive Implementation is Unsafe

**Failure Scenario 1: Event Publish Fails**
```
1. order.save() succeeds (committed to MongoDB)
2. NATS connection dies / network timeout / broker unavailable
3. publish() throws exception
4. HTTP request fails with 500 error
5. Client retries with new request
6. Idempotency check fails (order already exists)
7. User sees error, order exists but is invisible to other services
```

**Result:** Data exists in database but no event published. State divergence.

**Failure Scenario 2: Process Crashes Between Operations**
```
1. order.save() succeeds
2. CPU spike / OOM / SIGKILL / kernel panic
3. Process terminates before publish()
4. Order exists in DB, no event in NATS
5. Restart doesn't replay (operation completed from DB perspective)
```

**Result:** Permanent inconsistency. No self-healing mechanism.

**Failure Scenario 3: Event Published But Save Fails (Reverse Order)**
```typescript
// If we reverse the order:
new OrderCreatedPublisher(natsWrapper.client).publish({...});  // ← succeeds
await order.save();  // ← fails (constraint violation, OOM, connection drop)
```

**Result:** Event exists, entity doesn't. Downstream services process phantom order.

### Why Graceful Shutdown (ADR-001) Isn't Enough

ADR-001 solves the **pod termination** race condition but doesn't address:
- Network failures during `publish()`
- NATS broker unavailability
- Process crashes (SIGKILL, OOM, hardware failure)
- MongoDB replica set failover mid-transaction
- Cosmic ray bit flips (yes, really - see [1])

**Graceful shutdown reduces probability, Outbox Pattern eliminates the problem.**

### Current Mitigation (Insufficient)

**Client-side retry:**
- User sees error, retries request
- Idempotency prevents duplicate orders
- But: relies on user action (bad UX)

**NATS redelivery:**
- Only applies to messages that reached broker but weren't acked
- Doesn't help if message never sent

**Manual ops intervention:**
- Query MongoDB for orders with no corresponding events
- Manually republish events
- Doesn't scale, requires tribal knowledge

---

## Decision

Implement the **Transactional Outbox Pattern** for all event-publishing services.

### Pattern Overview

Instead of publishing events directly to NATS, write events to an **outbox table** in the same database transaction as the business entity.

**Two-phase process:**
1. **Write phase:** Save entity + event to outbox (single ACID transaction)
2. **Publish phase:** Background worker reads outbox, publishes to NATS, marks published

### Guarantees

- **Atomicity:** Event is persisted if and only if entity is persisted
- **Durability:** Event survives process crashes, broker outages
- **At-least-once delivery:** Worker retries until event published
- **Audit trail:** Full history of events in database

### Implementation

#### 1. Outbox Schema

```typescript
// orders/src/models/outbox.ts
import mongoose from 'mongoose';

interface OutboxAttrs {
  aggregateType: string;   // 'Order', 'Ticket', etc.
  aggregateId: string;     // UUID of the entity
  eventType: string;       // 'OrderCreated', 'OrderCancelled', etc.
  payload: object;         // JSON event data
}

interface OutboxDoc extends mongoose.Document {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: object;
  published: boolean;
  publishedAt?: Date;
  createdAt: Date;
  attempts: number;        // Retry counter
  lastError?: string;      // For debugging failed publishes
}

const outboxSchema = new mongoose.Schema({
  aggregateType: { type: String, required: true, index: true },
  aggregateId: { type: String, required: true, index: true },
  eventType: { type: String, required: true },
  payload: { type: Object, required: true },
  published: { type: Boolean, default: false, index: true },
  publishedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  attempts: { type: Number, default: 0 },
  lastError: { type: String },
});

// Compound index for efficient worker queries
outboxSchema.index({ published: 1, createdAt: 1 });

const Outbox = mongoose.model<OutboxDoc>('Outbox', outboxSchema);
export { Outbox };
```

#### 2. Transactional Write

```typescript
// orders/src/routes/new.ts (revised)
import mongoose from 'mongoose';
import { Outbox } from '../models/outbox';

router.post('/api/orders', requireAuth, validateRequest, async (req, res) => {
  const { ticketId } = req.body;

  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new NotFoundError();

  const isReserved = await ticket.isReserved();
  if (isReserved) throw new BadRequestError('Ticket is already reserved');

  const expiration = new Date();
  expiration.setSeconds(expiration.getSeconds() + EXPIRATION_WINDOW_SECONDS);

  // === TRANSACTIONAL OUTBOX ===
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = Order.build({ userId: req.currentUser!.id, status, expiresAt, ticket });
    await order.save({ session });

    // Write event to outbox in SAME transaction
    await Outbox.create([{
      aggregateType: 'Order',
      aggregateId: order.id,
      eventType: 'OrderCreated',
      payload: {
        id: order.id,
        version: order.version,
        status: order.status,
        userId: order.userId,
        expiresAt: order.expiresAt.toISOString(),
        ticket: { id: ticket.id, price: ticket.price },
      },
    }], { session });

    await session.commitTransaction();

    // Event is now durably persisted
    // Background worker will publish to NATS asynchronously
    res.status(201).send(order);

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});
```

**Key Properties:**
- If `order.save()` fails, outbox entry rolls back (atomicity)
- If `Outbox.create()` fails, order rolls back (atomicity)
- If process crashes after commit, event is in database (durability)
- HTTP response only sent after both writes committed

#### 3. Background Publisher Worker

```typescript
// orders/src/workers/outbox-publisher.ts
import { Outbox } from '../models/outbox';
import { natsWrapper } from '../nats-wrapper';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 1000;  // 1 second
const MAX_RETRIES = 10;

async function publishBatch() {
  // Find unpublished events (oldest first)
  const events = await Outbox.find({
    published: false,
    attempts: { $lt: MAX_RETRIES },
  })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  if (events.length === 0) return;

  console.log(`Publishing ${events.length} events from outbox`);

  for (const event of events) {
    try {
      // Publish to NATS
      await natsWrapper.client.publish(event.eventType, event.payload);

      // Mark as published (atomic update)
      await Outbox.updateOne(
        { _id: event._id, published: false },  // Optimistic lock
        {
          $set: {
            published: true,
            publishedAt: new Date(),
          },
        }
      );

      console.log(`Published event ${event.eventType} for ${event.aggregateId}`);

    } catch (err) {
      console.error(`Failed to publish event ${event._id}:`, err);

      // Increment retry counter, store error
      await Outbox.updateOne(
        { _id: event._id },
        {
          $inc: { attempts: 1 },
          $set: { lastError: (err as Error).message },
        }
      );
    }
  }
}

export function startOutboxPublisher() {
  console.log('Starting outbox publisher worker');

  // Poll every second
  setInterval(() => {
    publishBatch().catch((err) => {
      console.error('Outbox publisher error:', err);
      // Don't crash worker on error - log and continue
    });
  }, POLL_INTERVAL_MS);
}

// Start worker on service initialization
// orders/src/index.ts
import { startOutboxPublisher } from './workers/outbox-publisher';

async function start() {
  // ... existing initialization ...
  await connectMongo(process.env.MONGO_URI!);

  // Start background worker
  startOutboxPublisher();

  app.listen(PORT, () => {
    console.log(`Orders service listening on port ${PORT}`);
  });
}
```

#### 4. Dead Letter Handling

```typescript
// After MAX_RETRIES, move to dead letter table for manual inspection
if (event.attempts >= MAX_RETRIES) {
  await DeadLetterQueue.create({
    originalEventId: event._id,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
    attempts: event.attempts,
    lastError: event.lastError,
    failedAt: new Date(),
  });

  await Outbox.deleteOne({ _id: event._id });
  console.error(`Event ${event._id} moved to DLQ after ${MAX_RETRIES} attempts`);
}
```

---

## Consequences

### Positive

1. **True Atomicity**
   - Event is persisted if and only if entity is persisted
   - No possibility of state divergence
   - Survives all failure modes (crash, network, broker outage)

2. **At-Least-Once Delivery Guarantee**
   - Worker retries until successful or max attempts
   - Events never lost (unless database itself fails)

3. **Audit Trail**
   - Full history of events in `outbox` table
   - Timestamp when event was created vs published
   - Debugging: query outbox to see pending/failed events

4. **Temporal Decoupling**
   - HTTP request completes immediately (doesn't wait for NATS)
   - NATS downtime doesn't block order creation
   - Eventual consistency window is explicit and observable

5. **Operational Visibility**
   - Metrics: outbox depth, publish latency, retry rate
   - Alerts: outbox depth > 1000 (backlog building)
   - Dashboard: events published per second

### Negative

1. **Increased Database Load**
   - Every business write = 2 database writes (entity + outbox)
   - Outbox queries every second (polling overhead)
   - Storage: outbox table grows indefinitely (requires purging)

2. **Latency Increase**
   - Events published asynchronously (not immediate)
   - Median latency: ~1 second (poll interval)
   - P99 latency: up to 10 seconds under high load

3. **Code Complexity**
   - Transactional sessions in Mongoose (learning curve)
   - Background worker lifecycle management
   - Error handling for worker failures

4. **Operational Overhead**
   - Must monitor outbox depth and worker health
   - Purge old published events (or table grows forever)
   - Dead letter queue requires manual investigation

5. **Not True Exactly-Once**
   - Worker crash after publish but before marking published → duplicate
   - Downstream consumers must be idempotent (already required)

### Performance Characteristics

**Write Path:**
- Additional ~5ms latency (transactional write to outbox)
- Storage: ~500 bytes per event
- Throughput: Same as MongoDB write throughput

**Publish Path:**
- Batch processing: 100 events per second (conservative)
- Can scale by adding worker replicas (with coordination)
- Bottleneck: NATS throughput (~10k msg/sec single-threaded)

### Monitoring Metrics

```typescript
// Prometheus metrics to export
outboxDepthGauge.set(unpublishedCount);
outboxPublishDurationSeconds.observe(publishLatency);
outboxPublishErrorsTotal.inc({ eventType, error: err.message });
outboxDeadLetterTotal.inc({ eventType });
```

**Alert Conditions:**
- Outbox depth > 1000 for >5 minutes (worker stuck or NATS down)
- Publish error rate > 5% (connectivity issues)
- Dead letter queue size > 10 (poison messages)

---

## Alternatives Considered

### Alternative 1: Two-Phase Commit (2PC)

**Description:** Distributed transaction coordinator between MongoDB and NATS.

**Rejection Reason:**
- NATS Streaming doesn't support XA transactions
- 2PC is slow (multiple round-trips)
- Coordinator becomes SPOF
- MongoDB doesn't support 2PC across replica sets

**Verdict:** Not feasible with current technology stack.

---

### Alternative 2: Event Sourcing

**Description:** Store events as source of truth, project to read models.

```typescript
// Event store is primary
await EventStore.append('Order', orderId, [
  new OrderCreatedEvent({ userId, ticketId, expiresAt }),
]);

// Read model is projection
const order = await projectOrderFromEvents(orderId);
```

**Benefits:**
- No dual-write problem (events are the database)
- Full audit trail (temporal queries: "state at time T")
- Replay events to rebuild state or create new projections

**Rejection Reasons:**

1. **Infrastructure Complexity**
   - Requires event store (Kafka, EventStore, custom solution)
   - Kafka: Zookeeper, partition management, rebalancing
   - EventStore: .NET dependency, clustering complexity
   - Adds operational burden for portfolio project

2. **Query Complexity**
   - Can't query current state directly (must project events)
   - Projections add latency and staleness
   - Complex queries (joins, aggregations) require specialized projections

3. **Schema Evolution**
   - Event schemas are immutable (published contract)
   - Changing event structure requires upcasting/downcasting
   - Migration complexity increases with event count

4. **Learning Curve**
   - Different mental model (events vs entities)
   - CQRS almost always required (separate read/write models)
   - Overkill for demonstrating microservices fundamentals

**Verdict:** Deferred to future iteration. Outbox Pattern provides 80% of benefits with 20% of complexity.

---

### Alternative 3: Change Data Capture (CDC)

**Description:** Tail MongoDB oplog, publish changes as events (e.g., Debezium).

**Benefits:**
- Zero application code changes
- Guaranteed consistency (oplog is transactional)
- Reuses MongoDB's replication mechanism

**Rejection Reasons:**

1. **MongoDB Oplog Semantics**
   - Oplog contains low-level operations (insert, update, delete)
   - Doesn't capture business intent ("OrderCreated" vs "insert into orders")
   - Requires transformation layer to map oplog → domain events

2. **Operational Complexity**
   - Debezium requires Kafka Connect cluster
   - Must deploy and manage separate infrastructure
   - Oplog tailing performance impact on MongoDB

3. **Event Enrichment**
   - Oplog only contains changed fields (deltas)
   - Building full event payload requires additional queries
   - Race conditions between oplog read and enrichment query

4. **Loss of Explicit Events**
   - Events are implicit (derived from state changes)
   - Harder to reason about event contracts
   - Doesn't support events without state changes (e.g., "OrderViewed")

**Verdict:** Good for legacy systems retrofitting events, overkill for greenfield.

---

### Alternative 4: Do Nothing (Accept Risk)

**Description:** Keep current implementation, document as known limitation.

**Benefits:**
- Zero implementation cost
- Simpler codebase
- Acceptable for non-critical systems

**Rejection Reasons:**

1. **Portfolio Credibility**
   - Dual-write problem is well-known anti-pattern
   - Senior engineers expected to recognize and solve this
   - "Known limitation" acceptable, "didn't know to solve it" is not

2. **Operational Pain**
   - Manual reconciliation required
   - Data integrity issues erode trust in system
   - On-call burden (paged for inconsistencies)

3. **Slippery Slope**
   - "Good enough for portfolio" → "good enough for production"
   - Builds bad habits in design thinking

**Verdict:** Not acceptable for demonstrating Staff+ architecture skills.

---

## Why Outbox Pattern Was Chosen

1. **Minimal Infrastructure**
   - Uses existing MongoDB (no new components)
   - Simple polling worker (no complex frameworks)
   - Can implement in 200 LOC

2. **Solves 90% of Dual-Write Problem**
   - Handles crashes, network failures, broker outages
   - Doesn't solve Byzantine failures (acceptable trade-off)

3. **Demonstrates Key Concepts**
   - Transactional thinking in distributed systems
   - At-least-once delivery semantics
   - Trade-offs between consistency and complexity

4. **Production-Ready Pattern**
   - Used by Uber, Netflix, Airbnb (with variations)
   - Well-documented (e.g., [2], [3])
   - Compatible with future migration to Event Sourcing

---

## Migration Path to Event Sourcing (Future)

If system scales beyond Outbox Pattern:

1. **Phase 1:** Replace outbox table with Kafka topic
   - Worker publishes to Kafka instead of NATS
   - Kafka = durable, partitioned event log

2. **Phase 2:** Introduce projections
   - Services consume from Kafka, build read models
   - MongoDB becomes cache (can rebuild from Kafka)

3. **Phase 3:** Remove MongoDB writes from request path
   - Events written to Kafka only (source of truth)
   - Read models updated asynchronously

**Outbox Pattern is stepping stone, not dead end.**

---

## Implementation Checklist

- [ ] Create `Outbox` model in all event-publishing services
- [ ] Add transactional session support to Mongoose schemas
- [ ] Refactor all event publishers to use outbox
- [ ] Implement background worker with batch processing
- [ ] Add dead letter queue table and handling
- [ ] Add Prometheus metrics (outbox depth, publish latency)
- [ ] Create Grafana dashboard for outbox monitoring
- [ ] Write integration tests (simulate NATS outage)
- [ ] Document outbox purging strategy (retention: 7 days)
- [ ] Update runbooks with outbox troubleshooting

---

## Open Questions

1. **How to handle worker high availability?**
   - Single worker is SPOF (but failure is safe - events queue up)
   - Multiple workers require coordination (distributed lock or leader election)
   - Decision: Start with single worker, add Redis-based locking if needed

2. **What is acceptable event latency?**
   - Current: p50 = 1s, p99 = 10s
   - Alternative: Adaptive polling (poll faster when outbox not empty)
   - Decision: 1s is acceptable for current use case (order expiration is 15min)

3. **How to purge old events without breaking audit trail?**
   - Option A: Archive to cold storage (S3) after 30 days
   - Option B: Keep forever (storage cost)
   - Option C: Delete after 7 days (assume logs suffice for audit)
   - Decision: TBD based on storage growth rate

---

## Related Decisions

- ADR-001: Graceful Shutdown (prerequisite - prevents worker interruption)
- ADR-003: NATS Clustering (complementary - improves broker availability)
- Future ADR: Event Sourcing Migration (evolution path)

---

## References

[1] Kleppmann, M. (2017). *Designing Data-Intensive Applications*. Chapter 8: The Trouble with Distributed Systems.

[2] Richardson, C. (2018). *Microservices Patterns*. Chapter 6: Developing Business Logic with Event Sourcing.

[3] Microsoft. (2020). *Cloud Design Patterns: Event Sourcing*.
https://docs.microsoft.com/en-us/azure/architecture/patterns/event-sourcing

[4] Uber Engineering. (2020). *Reliable Processing at Uber*.
https://eng.uber.com/reliable-processing/

---

**Last Updated:** 2025-12-20
**Implementation Status:** Proposed (Not Started)
**Target Completion:** Q1 2026
**Estimated Effort:** 2-3 weeks (all services + testing)
