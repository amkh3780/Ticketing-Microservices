import request from "supertest";
import { app } from "../../app";
import mongoose from "mongoose";
import { Ticket } from "../../models/ticket";

describe("NoSQL injection protections", () => {
  it("rejects object-based price injection on ticket creation", async () => {
    await request(app)
      .post("/api/tickets")
      .set("Cookie", global.signin())
      .send({
        title: "bad",
        price: { $gt: 0 },
      })
      .expect(400);
  });

  it("does not return tickets when queried with object id injection", async () => {
    // seed a ticket
    await request(app)
      .post("/api/tickets")
      .set("Cookie", global.signin())
      .send({ title: "safe", price: 10 })
      .expect(201);

    const res = await request(app)
      .get("/api/tickets/" + encodeURIComponent('{"$gt":""}'))
      .expect(400);

    expect(res.body.errors?.length || 0).toBeGreaterThan(0);
  });

  it("prevents update with injected orderId filter", async () => {
    const cookie = global.signin();
    const createRes = await request(app)
      .post("/api/tickets")
      .set("Cookie", cookie)
      .send({ title: "to-update", price: 15 })
      .expect(201);

    const ticketId = createRes.body.id;
    const res = await request(app)
      .put(`/api/tickets/${ticketId}`)
      .set("Cookie", cookie)
      .send({ title: "new", price: { $ne: 0 } })
      .expect(400);

    expect(res.body.errors?.length || 0).toBeGreaterThan(0);
    const ticket = await Ticket.findById(ticketId);
    expect(ticket?.price).toBe(15);
  });
});
