import request from "supertest";
import { app } from "../../app";

describe("Security headers and rate limit", () => {
  it("sets Helmet security headers and CORS", async () => {
    const res = await request(app)
      .get("/api/users/healthz")
      .set("Origin", "http://example.com")
      .expect(200);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    expect(res.headers["x-download-options"]).toBe("noopen");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-xss-protection"]).toBeDefined();
    expect(res.headers["access-control-allow-origin"]).toBe("http://example.com");
  });

  it("enforces rate limiting after repeated requests", async () => {
    const attempts = 120; // limit is 100/min
    let lastStatus = 200;
    for (let i = 0; i < attempts; i++) {
      const res = await request(app).get("/api/users/healthz");
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
