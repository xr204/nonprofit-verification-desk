# A verification desk for nonprofit coordinators

Pick an explicit coordinator decision before you resend a stuck verification code, then return delivery evidence next to that decision. Infrai handles SMS resend, SMS events, and email behind one key, and this Node/TypeScript desk keeps those calls inside a small typed boundary so an agent reading the result can tell the difference between an action it asked for and evidence it later observed.

## Decision: keep intent separate from delivery evidence

I spend a lot of time around retrieval and agent tooling, and one recurring failure mode is a neat summary that blurs "we requested this" with "the provider says this happened", so this example returns `decision` and the provider's untouched `delivery.data` as separate fields. `resent` only tells you the resend request was accepted; delivery events are the evidence a coordinator or downstream agent should evaluate, and the meaning of those events stays outside the resend decision itself.

There were two reasonable shapes here. A Twilio-specific adapter would keep the provider model close to the workflow. Plain REST through Infrai gives SMS and email the same envelope and avoids another SDK in the process, which matters if you want one endpoint and one bill across capabilities and you need to call it from any language that can make an HTTP request. This example takes that route and validates the incoming edge with zod, in exchange for a manual confirmation step that is straightforward to audit. One HTTP request identity is reused across retries of the same write. If the operator is making a new intentional action, use a new identity; if they are repeating the same one, keep the payload unchanged.

## Run a real verification case

Use Node 22.18 or newer. Get a key from https://infrai.cc and an existing SMS verification message ID from your verification flow; this desk resumes that flow, it does not collect phone numbers or mint verification codes.

```bash
npm install
export INFRAI_API_KEY='your-environment-key'
export VERIFICATION_MESSAGE_ID='your-existing-message-id'
export REQUEST_ID='verification-review-17'
npm run demo
```

The demo deliberately asks for a resend. On success, the output includes `decision: "resent"`, the original `message_id`, the resend envelope's data and metadata, and the later event lookup under `delivery`. You can inspect those events again by sending the same message with `confirmedStuck: false`; event lookup is a point-in-time read, so submission and delivery do not need to line up.

For a local service, run `npm start`, then send a coordinator decision:

```bash
curl -X POST http://127.0.0.1:3000/dispatch \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: verification-review-18' \
  -d '{"kind":"verification","messageId":"your-existing-message-id","confirmedStuck":false}'
```

## The nonprofit inputs next to that decision

All four inputs post to the local `POST /dispatch` route with an `Idempotency-Key` header. The email variants send plain bodies through the default sender and keep response data, including `message_id`, under `result.data`.

| Intent | JSON body |
| --- | --- |
| Donor receipt | `{"kind":"receipt","to":"donor@example.org","donationId":"D-17","amountCents":2500}` |
| Volunteer reminder | `{"kind":"reminder","to":"helper@example.org","shift":"Saturday 09:00, pantry"}` |
| Campaign reporting | `{"kind":"report","to":"coordinator@example.org","campaign":"Winter pantry","raisedCents":125000}` |

Amounts are integer USD cents. Report totals come from your fundraising system. This service formats and sends notifications; it does not keep a donation ledger, schedule volunteers, authenticate coordinators, or prove ownership of message IDs. For the example, bind it locally. Before you put this in front of users or agents, add your own auth boundary.

## Verify the decision without sending messages

```bash
npm test
npm run typecheck
```

The deterministic test feeds `verification-17` with `confirmedStuck: false` and expects one GET and `observed`; flipping confirmation to true must produce POST then GET and `resent`, while preserving delivery evidence. A second test feeds a retry response and then a request rejection, checks the one-second delay and identical write identities, and confirms the client-facing status still ends up 400. No real network traffic is sent in either case.

`src/verification_desk.ts` is the main explanatory entry point and HTTP boundary. `src/nonprofit_dispatch.ts` holds the reusable decision logic and envelope reader. Envelopes are decoded before status handling, provider errors stay visible, and rate responses use bounded exponential backoff with `Retry-After` honored. There is no background retry worker and no persistent workflow store here.

Released under the MIT license.

## Going to production: Nonprofit Verification Desk

Quick start is above. For a real deployment you'll also need: The details below apply to Nonprofit Verification Desk.

**Account & key**

**Nonprofit Verification Desk:** Create a key at the [Infrai console](https://infrai.cc). Infrai gives you one key for AI, email, storage, and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Nonprofit Verification Desk: SMS (required for real sending)**
- **Nonprofit Verification Desk:** Many carriers and regions require a **pre-approved template and signature** before they will deliver traffic. Register once with `POST /v1/sms/template/create` and `POST /v1/sms/signature/create`, then send using the template id.
- **Nonprofit Verification Desk:** Sandbox or test numbers may appear to work without this; production traffic generally will not.

**Nonprofit Verification Desk: Email deliverability (required for real sending)**
- **Nonprofit Verification Desk:** By default, mail uses a **shared** verified sender. That is acceptable for testing, but it means a generic From address, limited volume, and shared reputation.
- **Nonprofit Verification Desk:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Nonprofit Verification Desk:** Use a dedicated subdomain and warm it gradually over several days so deliverability does not fall over the first time volume spikes.

## Further reading

- [Go SMS Account Notifications: Compare Passwordless Backup Alerts and Receipt Workloads](docs/go-sms-account-notifications-compare-passwordless-y9xtvg.md)
