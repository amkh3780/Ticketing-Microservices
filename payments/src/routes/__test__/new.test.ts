import request from "supertest";
import { app } from "../../app";
import mongoose from "mongoose";
import { Order } from "../../models/order";
import { OrderStatus } from "@srayen-tickets/common";
import { stripe } from "../../stripe";
import { Payment } from "../../models/payment";

jest.mock("../../stripe.ts");

it("returns a 400 when orderId is not a valid ObjectId", async () => {
  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin())
    .send({
      token: "tok_visa",
      orderId: "not-a-valid-id",
    })
    .expect(400);
});

it("returns a 404 when purchasing an order that does not exist", async () => {
  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin())
    .send({
      token: "azerty123",
      orderId: new mongoose.Types.ObjectId().toHexString(),
    })
    .expect(404);
});

it("returns a 401 when purchasing an order that dosent belong to the user", async () => {
  const order = Order.build({
    id: new mongoose.Types.ObjectId().toHexString(),
    userId: new mongoose.Types.ObjectId().toHexString(),
    version: 0,
    price: 20,
    status: OrderStatus.Created,
  });
  await order.save();

  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin())
    .send({ token: "azerty123", orderId: order.id })
    .expect(401);
});

it("returns a 400 when purchasing a cancelled order", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const order = Order.build({
    id: new mongoose.Types.ObjectId().toHexString(),
    userId,
    version: 0,
    price: 20,
    status: OrderStatus.Cancelled,
  });
  await order.save();

  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin(userId))
    .send({ orderId: order.id, token: "azerty123" })
    .expect(400);
});

it("returns a 400 when purchasing an already completed order", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const order = Order.build({
    id: new mongoose.Types.ObjectId().toHexString(),
    userId,
    version: 0,
    price: 20,
    status: OrderStatus.Complete,
  });
  await order.save();

  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin(userId))
    .send({ orderId: order.id, token: "azerty123" })
    .expect(400);
});

it("returns a 201 with valid inputs", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const price = Math.floor(Math.random() * 100000);
  const order = Order.build({
    id: new mongoose.Types.ObjectId().toHexString(),
    userId,
    version: 0,
    price,
    status: OrderStatus.Created,
  });
  await order.save();
  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin(userId))
    .send({ token: 'tok_visa', orderId: order.id })
    .expect(201);
  //Load charges (how : from Stripe documentation ):
  const stripeCharges = await stripe.charges.list({ limit: 50 });

  const stripeCharge = stripeCharges.data.find((charge) => {
    return charge.amount === price * 100; //*100 for converting dollar to cents
  });

  expect(stripeCharge).toBeDefined();
  
  expect(stripeCharge?.currency).toEqual("usd");

  const payment = await Payment.findOne({
    orderId: order.id,
    stripeId: stripeCharge?.id,
  });
  expect(payment).not.toBeNull();
});

it("returns a 400 on duplicate payments for the same order (idempotent)", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const order = Order.build({
    id: new mongoose.Types.ObjectId().toHexString(),
    userId,
    version: 0,
    price: 10,
    status: OrderStatus.Created,
  });
  await order.save();

  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin(userId))
    .send({ token: "tok_visa", orderId: order.id })
    .expect(201);

  await request(app)
    .post("/api/payments")
    .set("Cookie", global.signin(userId))
    .send({ token: "tok_visa", orderId: order.id })
    .expect(400);
});
