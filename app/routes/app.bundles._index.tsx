import { redirect } from "@remix-run/node";

// The bundle list now lives on the app home page; keep old links working.
export const loader = () => redirect("/app");
