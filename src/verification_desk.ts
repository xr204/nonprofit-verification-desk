import { createServer } from "node:http";
import { actionSchema, createDispatch, DispatchError } from "./nonprofit_dispatch.ts";

const key = process.env.INFRAI_API_KEY;
if (!key) throw new Error("Set INFRAI_API_KEY");
const dispatch = createDispatch(key);

if (process.argv.includes("--demo")) {
  const messageId = process.env.VERIFICATION_MESSAGE_ID;
  const requestId = process.env.REQUEST_ID;
  if (!messageId || !requestId) throw new Error("Set VERIFICATION_MESSAGE_ID and REQUEST_ID");
  console.log(JSON.stringify(await dispatch({ kind: "verification", messageId, confirmedStuck: true }, requestId), null, 2));
} else {
  createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.url !== "/dispatch") return reply(404, { error: "Route not found" });
    try {
      const requestId = req.headers["idempotency-key"];
      if (typeof requestId !== "string" || !requestId.trim()) return reply(400, { error: "Supply Idempotency-Key" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) return reply(413, { error: "Body too large" });
        chunks.push(Buffer.from(chunk));
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return reply(400, { error: "Expected JSON" }); }
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) return reply(400, { error: parsed.error.flatten() });
      reply(200, await dispatch(parsed.data, requestId));
    } catch (error) {
      if (error instanceof DispatchError) reply(error.status, { error: error.detail });
      else reply(502, { error: "Dispatch could not complete" });
    }
  }).listen(3000, "127.0.0.1", () => console.log("Nonprofit desk: http://127.0.0.1:3000/dispatch"));
}
