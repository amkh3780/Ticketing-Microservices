import express from "express";
import "express-async-errors";
import { json } from "body-parser";

import cookieSession from "cookie-session";

import { currentUserRouter } from "./routes/current-user";
import { signinRouter } from "./routes/signin";
import { signoutRouter } from "./routes/signout";
import { signupRouter } from "./routes/signup";
import { errorHandler, NotFoundError } from "@srayen-tickets/common";

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

app.use(currentUserRouter);
app.use(signinRouter);
app.use(signoutRouter);
app.use(signupRouter);

/** ===== TEMP: Infra test routes ===== */
app.get('/api/users/healthz', (_req, res) => res.status(200).send({ status: 'ok' }));
/** ===== END TEMP ===== */

app.all("*", async (req, res) => {
  throw new NotFoundError();
});

app.use(errorHandler);

export { app };
