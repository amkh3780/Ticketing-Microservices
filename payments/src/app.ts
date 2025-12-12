import express from "express";
import "express-async-errors";
import { json } from "body-parser";
import cookieSession from "cookie-session";
import {
  errorHandler,
  NotFoundError,
  currentUser,
} from "@srayen-tickets/common";
import { createChargeRouter } from "./routes/new";
 

const app = express();
app.set("trust proxy", true); //For Express to trust  the proxy of ingress-nginx
app.use(json());
app.use(
  cookieSession({
    signed: false, //disable encryption: (To be understood between diff languages!) / (JWT is already encrypted)
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax', //True in PROD (only used with https)  //False in TEST (To work without https)
    //RQ: NODE_ENV variable are : development | production | test
  })
);

app.use(currentUser);

app.use(createChargeRouter)
/** ===== TEMP: Infra test routes ===== */
app.get('/api/payments/healthz', (_req, res) => res.status(200).send({ status: 'ok' }));
/** ===== END TEMP ===== */

app.all("*", async (req, res) => {
  throw new NotFoundError();
});

app.use(errorHandler);

export { app };
