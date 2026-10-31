import { Hono } from "hono";
import type { AppEnv } from "../http/types";

export const healthRoutes = () =>
	new Hono<AppEnv>().get("/health", (c) => c.json({ status: "ok" }));
