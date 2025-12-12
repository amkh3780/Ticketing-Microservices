import {
  BadRequestError,
  NotAuthorizedError,
  NotFoundError,
  OrderStatus,
  requireAuth,
  validateRequest,
} from "@srayen-tickets/common";
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { natsWrapper } from "../nats-wrapper";
import { body } from "express-validator";
import { Order } from "../models/order";
import { stripe } from "../stripe";
import { Payment } from "../models/payment";
import { PaymentCreatedPublisher } from "../events/publishers/payment-created-publisher";
const router = express.Router();
router.post(
  "/api/payments",
  requireAuth,
  [
    body("token").not().isEmpty(),
    body("orderId").not().isEmpty().bail().custom((id) => mongoose.Types.ObjectId.isValid(id)),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    const { token, orderId } = req.body;
    const order = await Order.findById(orderId);

    if (!order) {
      throw new NotFoundError();
    }
    if (order.userId !== req.currentUser?.id) {
      throw new NotAuthorizedError();
    }
    if (order.status === OrderStatus.Cancelled) {
      throw new BadRequestError("Cannot pay for an cancelled order");
    }
    if (order.status === OrderStatus.Complete) {
      throw new BadRequestError("Order is already paid");
    }

    const existingPayment = await Payment.findOne({ orderId });
    if (existingPayment) {
      throw new BadRequestError("Payment already exists for this order");
    }

    const charge = await stripe.charges.create({
      currency: "usd",
      amount: order.price * 100, //( * 100 to convert into cents)
      source: token,
    }, { idempotencyKey: order.id });

    const payment = Payment.build({ orderId, stripeId: charge.id });
    await payment.save();

    new PaymentCreatedPublisher(natsWrapper.client).publish({
      id: payment.id,
      orderId: payment.orderId,
      stripeId: payment.stripeId,
    });

    res.status(201).send({ id: payment.id });
  }
);

export { router as createChargeRouter };
