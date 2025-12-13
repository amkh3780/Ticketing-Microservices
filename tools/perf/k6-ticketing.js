import http from 'k6/http';
import { sleep, check } from 'k6';
import { randomSeed } from 'k6';

randomSeed(42);

export const options = {
  vus: 20,
  duration: '2m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

const BASE = __ENV.BASE_URL || 'http://ticketing.dev';

export default function () {
  // Health checks
  const health = http.get(`${BASE}/api/users/healthz`);
  check(health, { 'health 200': (r) => r.status === 200 });

  // Signup
  const email = `user${__ITER}@test.com`;
  const signup = http.post(`${BASE}/api/users/signup`, JSON.stringify({ email, password: 'password' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(signup, { 'signup 201/200': (r) => r.status === 201 || r.status === 200 });
  const cookie = signup.headers['Set-Cookie'];

  // Create ticket
  const ticket = http.post(
    `${BASE}/api/tickets`,
    JSON.stringify({ title: `show-${__ITER}`, price: 20 }),
    { headers: { 'Content-Type': 'application/json', Cookie: cookie } }
  );
  check(ticket, { 'ticket 201': (r) => r.status === 201 });

  // Create order
  const ticketId = ticket.json('id');
  const order = http.post(
    `${BASE}/api/orders`,
    JSON.stringify({ ticketId }),
    { headers: { 'Content-Type': 'application/json', Cookie: cookie } }
  );
  check(order, { 'order 201': (r) => r.status === 201 });

  sleep(1);
}
