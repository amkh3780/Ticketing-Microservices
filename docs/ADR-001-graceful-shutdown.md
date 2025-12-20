# ADR-001: Graceful Shutdown for Event-Driven Services

**Status:** Proposed
**Date:** 2025-12-20
**Deciders:** Architecture Review
**Technical Story:** Prevent data loss during pod termination in Kubernetes rolling updates

---

## Context

### The Problem

In event-driven microservices, a write operation typically involves two distinct systems:
1. **Persistent storage** (MongoDB) - transactional, durable
2. **Message broker** (NATS Streaming) - async, fire-and-forget

When Kubernetes terminates a pod during rolling updates, the process receives `SIGTERM` and has 30 seconds (default `terminationGracePeriodSeconds`) to clean up before `SIGKILL`.

**Current implementation:**
```typescript
// orders/src/index.ts:56-57
process.on('SIGTERM', () => natsWrapper.client.close());
process.on('SIGINT', () => natsWrapper.client.close());
```

This immediately closes the NATS connection but does **not**:
- Stop the HTTP server from accepting new requests
- Wait for in-flight HTTP requests to complete
- Flush pending NATS messages from the internal buffer
- Close database connections gracefully

### Failure Scenario: The Dual-Write Problem

```
Timeline during pod termination:

T+0ms:   Kubernetes sends SIGTERM to pod
T+10ms:  New HTTP request arrives: POST /api/orders
         (Ingress hasn't updated endpoints yet)
T+20ms:  Order saved to MongoDB (COMMITTED)
T+30ms:  Code executes: natsWrapper.client.publish(OrderCreated)
T+35ms:  SIGTERM handler fires: natsWrapper.client.close()
         (NATS connection closes before publish completes)
T+40ms:  HTTP response sent: 201 Created
T+50ms:  Pod terminates

Result:
- Order exists in database (visible to user)
- OrderCreated event NEVER published
- Ticket never reserved (no listener processed event)
- Expiration never scheduled (no job in Bull queue)
- User receives success response but order is orphaned
```

**Probability:** Empirically, 1-5% of requests during rolling updates experience this race condition in systems without graceful shutdown.

### Why This Matters in Event-Driven Systems

Unlike monolithic applications where state is self-contained, microservices rely on **eventual consistency via events**. A lost event creates **permanent state divergence**:

| Service | State After Lost Event |
|---------|----------------------|
| Orders | Order exists (status: Created) |
| Tickets | Ticket available (not reserved) |
| Expiration | No scheduled job |
| Payments | Order ID unknown (can't accept payment) |

**Recovery:** Requires manual intervention (ops team must republish event or delete orphaned order).

### Kubernetes Pod Lifecycle

Understanding the shutdown sequence is critical:

```
1. Pod marked for termination (status: Terminating)
2. PreStop hook executes (if defined)
3. SIGTERM sent to container PID 1
4. Grace period begins (default: 30 seconds)
   ↓
   [Application cleanup happens here]
   ↓
5. If still running after grace period: SIGKILL
6. Pod removed from endpoints (eventually consistent)
```

**Key Issue:** Endpoints are updated **asynchronously**. For 1-5 seconds after SIGTERM, the pod still receives traffic from:
- Ingress controller (cached endpoints)
- Service load balancer (kube-proxy lag)
- Client-side load balancing (stale DNS)

---

## Decision

Implement **graceful shutdown** with this sequence:

### 1. Stop Accepting New Requests
Close HTTP server to reject new connections while allowing in-flight requests to complete.

### 2. Drain In-Flight Requests
Wait for all active HTTP handlers to finish (with timeout).

### 3. Flush NATS Messages
Ensure all buffered messages are sent before closing connection.

### 4. Close Resources
Shut down NATS, MongoDB, and other clients in dependency order.

### Implementation

```typescript
// orders/src/index.ts (revised)

import http from 'http';

let server: http.Server;
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress, ignoring', signal);
    return;
  }
  isShuttingDown = true;

  console.log(`${signal} received, starting graceful shutdown`);

  // 1. Stop accepting new requests
  //    - server.close() stops new connections
  //    - Existing connections remain open
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });

  // 2. Wait for in-flight requests to complete
  //    Timeout: 10 seconds (should be < terminationGracePeriodSeconds - 5s buffer)
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('Force closing after timeout');
      resolve(null);
    }, 10000);

    server.on('close', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });

  // 3. Flush NATS pending messages
  //    - flush() blocks until all buffered messages are acknowledged by server
  //    - Timeout: 5 seconds
  try {
    console.log('Flushing NATS messages');
    await Promise.race([
      natsWrapper.client.flush(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('NATS flush timeout')), 5000)
      ),
    ]);
    console.log('NATS messages flushed');
  } catch (err) {
    console.error('Error flushing NATS:', err);
  }

  // 4. Close NATS connection
  natsWrapper.client.close();
  console.log('NATS connection closed');

  // 5. Close database connections
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (err) {
    console.error('Error closing MongoDB:', err);
  }

  console.log('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function start() {
  // ... existing startup code ...

  server = app.listen(PORT, () => {
    console.log(`Orders service listening on port ${PORT}`);
  });
}
```

### Kubernetes Configuration

Add `preStop` hook to delay termination:

```yaml
# orders-depl.yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: orders
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
          # ... rest of container spec
```

**Why `sleep 5`:**
- Gives endpoints 5 seconds to propagate to Ingress/Services
- Reduces probability of new requests arriving during shutdown
- Low-tech alternative to readiness probe manipulation

**Why 30s grace period:**
- 5s preStop sleep
- 10s HTTP drain
- 5s NATS flush
- 5s MongoDB close
- 5s buffer for variability
- = 30s total

---

## Consequences

### Positive

1. **Eliminates dual-write inconsistency** during rolling updates
   - Database commits and event publishes are atomic from external perspective
   - No orphaned orders or state divergence

2. **Improved user experience**
   - No "successful" responses for operations that didn't complete
   - Clients receive connection errors instead of silent failures (fail-fast)

3. **Operational confidence**
   - Safe to deploy anytime (no "avoid deployments during peak traffic" rule)
   - Automated deployments don't require manual verification

4. **Debugging simplification**
   - Reduces "ghost" bugs where state is inconsistent without clear cause
   - Logs clearly show shutdown sequence completion

### Negative

1. **Increased deployment time**
   - Each pod takes ~15-20 seconds to terminate (vs instant)
   - Rolling update of 10 pods: +3 minutes total

2. **Code complexity**
   - Shutdown logic is ~50 lines per service (6 services = 300 LOC)
   - Must be tested (hard to write unit tests for signal handlers)

3. **Not a complete solution**
   - Doesn't prevent dual-write problem if process crashes (SIGKILL, OOM, kernel panic)
   - Doesn't prevent NATS message loss if broker is down
   - See ADR-002 (Outbox Pattern) for transactional guarantees

4. **Timeout tuning required**
   - If HTTP requests take >10s, they'll be killed mid-flight
   - Must correlate with application p99 latency
   - `terminationGracePeriodSeconds` must be > sum of all timeouts

### Monitoring

Add metrics to observe shutdown behavior:

```typescript
// Increment counter on graceful shutdown initiation
shutdownInitiatedTotal.inc({ signal: 'SIGTERM' });

// Track duration of each shutdown phase
shutdownDurationSeconds.observe({ phase: 'http_drain' }, duration);
shutdownDurationSeconds.observe({ phase: 'nats_flush' }, duration);

// Count incomplete requests at shutdown
incompleteRequestsTotal.inc(activeConnectionsCount);
```

**Alert on:**
- Shutdown duration > 25s (approaching grace period limit)
- Incomplete requests > 0 (means we're killing active requests)

---

## Alternatives Considered

### Alternative 1: Do Nothing (Status Quo)

**Rationale:** NATS redelivery will eventually process lost events.

**Rejection Reason:**
- Redelivery only applies to **unacknowledged** messages
- If `publish()` never completes, message never reaches broker
- No redelivery for messages that were never sent
- User sees success but order never completes = data corruption

### Alternative 2: Rely on Client Retries

**Rationale:** If operation fails, client retries the request.

**Rejection Reason:**
- HTTP response was 201 (success) - client won't retry
- Idempotency: retry creates duplicate order (new UUID)
- Shifts reliability burden to client (bad UX)

### Alternative 3: Disable Rolling Updates

**Rationale:** Only deploy by replacing all pods at once.

**Rejection Reason:**
- Causes downtime (all pods down simultaneously)
- Doesn't solve the problem for pod crashes (OOM, node failure)
- Defeats purpose of Kubernetes self-healing

### Alternative 4: Asynchronous Order Creation

**Rationale:** Return 202 Accepted immediately, process order in background worker.

**Benefits:**
- Decouples HTTP response from event publishing
- Background worker can retry indefinitely

**Rejection Reason:**
- Changes API contract (breaks client expectations)
- Requires job queue (Redis/RabbitMQ)
- Doesn't prevent shutdown race (worker still has dual-write problem)
- Complexity increase for marginal benefit (see ADR-002 for better solution)

### Alternative 5: Outbox Pattern (Deferred)

**Rationale:** Store events in database, publish via background worker (transactional).

**Status:** See ADR-002 for full analysis.

**Why Not Here:**
- Solves broader problem (transactional event publishing)
- Requires schema changes and background workers
- Graceful shutdown is prerequisite anyway (prevents worker interruption)

---

## Open Questions

1. **What if NATS flush times out after 5 seconds?**
   - Current: Log error and proceed to shutdown
   - Alternative: Extend timeout to 15s, reduce HTTP drain to 5s
   - Decision: Prefer losing events over blocking deployments indefinitely

2. **Should we implement exponential backoff for NATS flush retry?**
   - Current: Single attempt with 5s timeout
   - Alternative: Retry 3 times with backoff (1s, 2s, 4s)
   - Decision: Deferred until we have metrics showing flush failure rate

3. **How to test graceful shutdown in CI?**
   - Manual testing: `kubectl delete pod orders-depl-xxx --grace-period=30`
   - Automated: Chaos engineering (kill pods during load test)
   - Decision: Manual testing initially, automate after implementation stabilizes

---

## Implementation Checklist

- [ ] Update all 6 services (auth, tickets, orders, payments, expiration, client)
- [ ] Add `terminationGracePeriodSeconds: 30` to all deployments
- [ ] Add `preStop` lifecycle hook with 5s sleep
- [ ] Add graceful shutdown handlers to all services
- [ ] Update health check endpoints to return 503 during shutdown
- [ ] Add shutdown duration metrics (Prometheus)
- [ ] Document shutdown behavior in runbooks
- [ ] Load test with rolling updates to verify no data loss
- [ ] Update ADR-002 (Outbox Pattern) to reference this as prerequisite

---

## Related Decisions

- ADR-002: Outbox Pattern (builds on this for full transactional guarantees)
- ADR-003: NATS Clustering (removes broker as single point of failure)
- Runbook: Rolling Update Verification (operational procedures)

---

**Last Updated:** 2025-12-20
**Implementation Status:** Not Started
**Target Completion:** Q1 2026
