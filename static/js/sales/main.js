/*
 * Page entry point: start the generic dashboard with the sales data model.
 */
import { createDashboard } from "../dashboard/index.js";
import { salesConfig } from "./config.js";

createDashboard(salesConfig);
