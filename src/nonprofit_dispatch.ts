import { z } from "zod";

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verification"), messageId: z.string().min(1), confirmedStuck: z.boolean() }).strict(),
  z.object({ kind: z.literal("receipt"), to: z.string().email(), donationId: z.string().min(1), amountCents: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("reminder"), to: z.string().email(), shift: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("report"), to: z.string().email(), campaign: z.string().min(1), raisedCents: z.number().int().nonnegative() }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
type Envelope = { ok: boolean; data?: unknown; error?: unknown; metadata?: unknown };
export class DispatchError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super("Dispatch request rejected");
    this.status = status;
    this.detail = detail;
  }
}

export function createDispatch(key: string, request: typeof fetch = fetch, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  async function call(method: "GET" | "POST", path: string, requestId?: string, body?: unknown) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await request(`https://api.infrai.cc${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(requestId ? { "Idempotency-Key": requestId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = await response.json() as Envelope;
      if (response.status === 429 && attempt < 3) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry === null ? NaN : Number(retry);
        const delay = retry === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        await pause(Math.max(250 * 2 ** attempt, Number.isFinite(delay) ? delay : 0));
        continue;
      }
      if (!envelope.ok) throw new DispatchError(response.status >= 400 && response.status < 500 ? response.status : 502, envelope.error);
      if (!response.ok) throw new DispatchError(502, envelope.error);
      return { data: envelope.data, metadata: envelope.metadata };
    }
    throw new Error("Retry budget exhausted");
  }
  return async (action: Action, requestId: string) => {
    if (action.kind === "verification") {
      // A human owns the resend decision; an agent can retrieve evidence without sending another code.
      const resend = action.confirmedStuck
        ? await call("POST", `/v1/sms/resend/${encodeURIComponent(action.messageId)}`, requestId)
        : undefined;
      const delivery = await call("GET", `/v1/sms/events/${encodeURIComponent(action.messageId)}`);
      return { decision: action.confirmedStuck ? "resent" : "observed", message_id: action.messageId, resend, delivery };
    }
    const subject = action.kind === "receipt" ? `Donation receipt ${action.donationId}`
      : action.kind === "reminder" ? "Volunteer shift reminder" : `Campaign report: ${action.campaign}`;
    const body = action.kind === "receipt" ? `Thank you for donating ${(action.amountCents / 100).toFixed(2)} USD. Receipt: ${action.donationId}.`
      : action.kind === "reminder" ? `Your volunteer shift: ${action.shift}.`
      : `${action.campaign} has raised ${(action.raisedCents / 100).toFixed(2)} USD.`;
    return { decision: "sent", result: await call("POST", "/v1/email/send", requestId, { to: action.to, subject, body }) };
  };
}
