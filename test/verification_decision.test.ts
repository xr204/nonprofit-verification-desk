import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSchema, createDispatch, DispatchError } from "../src/nonprofit_dispatch.ts";

test("only an explicitly stuck verification triggers resend, and delivery evidence stays intact", async () => {
  const calls: { url: string; method: string; id: string | null }[] = [];
  const dispatch = createDispatch("test-credential", async (url, options) => {
    calls.push({ url: String(url), method: String(options?.method), id: new Headers(options?.headers).get("Idempotency-Key") });
    return Response.json({ ok: true, data: { message_id: "verification-17" }, metadata: {} });
  });
  const input = actionSchema.parse({ kind: "verification", messageId: "verification-17", confirmedStuck: false });
  assert(input.kind === "verification");
  assert.equal((await dispatch(input, "case-17")).decision, "observed");
  assert.deepEqual(calls.map(c => c.method), ["GET"]);
  calls.length = 0;
  const result = await dispatch({ ...input, confirmedStuck: true }, "case-17");
  assert.equal(result.decision, "resent");
  assert.deepEqual(calls.map(c => c.method), ["POST", "GET"]);
  assert.equal(calls[0]?.id, "case-17");
  assert.deepEqual(result.delivery?.data, { message_id: "verification-17" });
  assert.equal(actionSchema.safeParse({ ...input, confirmedStuck: "yes" }).success, false);
});

test("rate retries reuse the write identity and business rejection retains its status", async () => {
  const ids: (string | null)[] = [];
  const delays: number[] = [];
  const dispatch = createDispatch("test-credential", async (_url, options) => {
    ids.push(new Headers(options?.headers).get("Idempotency-Key"));
    return ids.length === 1
      ? Response.json({ ok: false, error: { message: "Retry later" } }, { status: 429, headers: { "Retry-After": "1" } })
      : Response.json({ ok: false, error: { message: "Check request" } }, { status: 400 });
  }, async ms => { delays.push(ms); });
  await assert.rejects(dispatch({ kind: "verification", messageId: "verification-17", confirmedStuck: true }, "case-17"), error => error instanceof DispatchError && error.status === 400);
  assert.deepEqual(ids, ["case-17", "case-17"]);
  assert.deepEqual(delays, [1000]);
});
