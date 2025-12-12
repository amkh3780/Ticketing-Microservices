// client/pages/orders/[orderId].js
import React, { useEffect, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import useRequest from '../../hooks/use-request';
import Router from 'next/router';

const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY; // از env

const CheckoutForm = ({ order, onSuccess }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const { doRequest, errors } = useRequest({
    url: '/api/payments',
    method: 'post',
    body: {}, // موقع submit پر می‌کنیم
    onSuccess,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    const card = elements.getElement(CardElement);

    // ساخت token روی فرانت‌اند با Stripe.js (Surface مجاز)
    const { token, error } = await stripe.createToken(card);
    if (error) {
      console.error(error);
      setSubmitting(false);
      return;
    }

    await doRequest({ token: token.id, orderId: order.id });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3">
      <div className="mb-3">
        <CardElement options={{ hidePostalCode: true }} />
      </div>
      <button className="btn btn-primary" disabled={!stripe || submitting}>
        {submitting ? 'Processing…' : `Pay $${order.ticket.price}.00`}
      </button>
      {errors}
    </form>
  );
};

const OrderShow = ({ order, currentUser }) => {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const findTimeLeft = () => {
      const msLeft = new Date(order.expiresAt) - new Date();
      setTimeLeft(Math.round(msLeft / 1000));
    };
    findTimeLeft();
    const timerId = setInterval(findTimeLeft, 1000);
    return () => clearInterval(timerId);
  }, [order]);

  if (timeLeft < 0) return <div>Order Expired</div>;

  const stripePromise = loadStripe(pk);

  return (
    <div className="text-center fs-1 my-5">
      <h1>Time left to pay: {timeLeft} seconds</h1>
      <Elements stripe={stripePromise}>
        <CheckoutForm order={order} onSuccess={() => Router.push('/orders')} />
      </Elements>
    </div>
  );
};

OrderShow.getInitialProps = async (context, client) => {
  const { orderId } = context.query;
  const { data } = await client.get(`/api/orders/${orderId}`);
  return { order: data };
};

export default OrderShow;
