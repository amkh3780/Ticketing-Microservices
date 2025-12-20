const charges: Array<{ id: string; amount: number; currency: string }> = [];

export const stripe = {
  charges: {
    create: jest.fn(async (opts: { amount: number; currency: string }) => {
      const charge = {
        id: `ch_${Math.random().toString(36).slice(2, 10)}`,
        amount: opts.amount,
        currency: opts.currency,
      };
      charges.push(charge);
      return charge;
    }),
    list: jest.fn(async () => ({ data: charges })),
  },
};
