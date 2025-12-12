import express from "express";
import "express-async-errors";
import { json } from "body-parser";
import cookieSession from "cookie-session";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "crypto";
import {
  errorHandler,
  NotFoundError,
  currentUser,
} from "@srayen-tickets/common";
import { createChargeRouter } from "./routes/new";
 

const app = express();
app.set("trust proxy", true); //For Express to trust  the proxy of ingress-nginx

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const corsOrigins =
  process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean) || true;

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const headerId = req.headers["x-request-id"] as string | undefined;
      if (headerId) return headerId;
      const id = randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
  })
);
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);
app.use(json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
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
