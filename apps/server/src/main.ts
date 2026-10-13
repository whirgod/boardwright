import { buildApp } from "./app.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);
const hostname = Deno.env.get("HOST") ?? "127.0.0.1";

const app = buildApp({ games: [] });

Deno.serve({ port, hostname }, app.fetch);
