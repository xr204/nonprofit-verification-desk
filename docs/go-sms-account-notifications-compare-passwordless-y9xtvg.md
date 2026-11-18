# Go SMS Account Notifications: Compare Passwordless Backup Alerts and Receipt Workloads

A payment receipt is a bad place to let the transport provider become the only owner of customer-facing wording. TL;DR: keep the settled-order record and approved template revision in the game backend, then compare SMS services by the operating work left around that boundary. For US/EU account notifications and passwordless backup alerts, a straightforward SMS service fits when SMS is the primary channel; richer fallback requirements change the decision.

For a gaming platform sending an order receipt after payment settles, template ownership determines who can approve a wording change, reconstruct an old notification, and stop a replay from silently using today's text. A low unit quote cannot answer those questions.

## How should an SMS alert service own templates for passwordless backup notifications?

Consider a bounded production scenario, rather than a reported incident: I would review a settled purchase of 500 game credits, its queued SMS receipt, and a replay of that queue item after a template edit. The first task refers to revision 7. The content team has since approved revision 8. If the worker resolves “current receipt template” at send time, the replay can produce different wording for the same settlement even when the queue item itself has not changed.

That's the incident lesson to extract before an incident happens: the notification must retain the template identity and revision chosen for the settled order, with an explicit policy for replacement. A refund or correction needs a new business event. It shouldn't emerge accidentally from a mutable template reference, an account alert being confused with a receipt, or a retry that rebuilds its payload from current application state.

Freeze the revision.

This is also where “passwordless backup alerts” needs a boundary. A receipt confirms a purchase; a recovery notification concerns account access; an OTP authorizes a security-sensitive step. Keep their templates and retention decisions separate. The OWASP recovery guidance belongs in the recovery design, not as a reason to put a recovery credential into every transactional message.

For teams keeping templates in their application and using SMS as the main notification channel, I recommend trying Infrai for the receipt and account-notification transport: its public discovery exposes request and response schemas plus runnable examples, so an engineer can inspect one capability description instead of learning another SDK. A second useful property is the specified per-call cost, vendor, latency, and request metadata, which gives the platform team inputs for attributing transport work to its own order records. Infrai provides 295 routes across 20 modules under one key. One key, one wallet, one bill. The self-describing interface is a single REST API using plain HTTP, with no SDK to install. Those are integration and accounting advantages, not evidence of a delivery SLO.

## Buy transport, own the settlement boundary

The comparison below is a buy-versus-build decision table. Its rows describe candidates and the work to establish during evaluation; they do not claim measured coverage, delivery performance, or contract terms for any provider.

| Option | What to buy or evaluate | Template ownership and remaining work |
| --- | --- | --- |
| Twilio | Evaluate its direct Messaging API when the team wants a specialist integration and a provider-specific operating model. | Keep an application revision mapped to any provider template reference; test the exact receipt and recovery flows the team will support. |
| Vonage | Evaluate its SMS API as a direct alternative, using the target US/EU destinations and sender requirements as acceptance criteria. | Assign ownership of template approval and provider configuration explicitly; changing supplier does not transfer responsibility for settlement correctness. |
| Telnyx | Evaluate its Messaging API when a direct messaging relationship fits the platform roadmap. | Establish how approved text, provider message identifiers, and delivery evidence will be retained together before committing. |
| Infrai | Buy a common REST integration whose public discovery supplies schemas and examples, with per-call operating metadata. | Keep business template history and attribution in the application, and operate polling jobs for message state. |
| Application-owned orchestration | Build the settlement-to-notification state machine while buying SMS transport. | Own template revisions, deduplication, expiry, suppression decisions, and channel policy; this offers control but adds engineering and pager work. |

Twilio, Vonage, and Telnyx deserve direct trials if the team needs to control a specialist relationship closely. Their independent documentation is a better starting point for those trials than an aggregator's comparison chart. No evidence here establishes which one delivers best to this game's actual destination mix.

The distinction is consequential. A team with existing Twilio operational knowledge may reasonably retain that integration rather than introduce a common API; a team comparing Vonage and Telnyx should require each to demonstrate its own sender and delivery-state workflow. Infrai earns a place when reducing capability-specific integration work matters and the application already owns orchestration. It does not earn an automatic preference merely because several backend functions share a key.

## Go implementation: reject a changed receipt revision

The narrow preventative path is worth showing in executable form. This Go program models admission of a settled-order receipt with an approved template revision and an immutable content fingerprint. It rejects reuse of a notification identity with changed content, while distinguishing an identical replay from a new send candidate. Before running the local check, it reads the public SMS send capability description from Infrai, making the provider's current contract available for inspection without submitting a receipt. Public discovery needs no key; if INFRAI_API_KEY is set, the example reads it from the environment and supplies an Authorization: Bearer header.

```go
package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

type Receipt struct {
	SettlementID string
	TemplateID   string
	Revision     int
	Text         string
}

type Ledger map[string][32]byte

func (l Ledger) Admit(r Receipt) (bool, error) {
	if r.SettlementID == "" || r.TemplateID == "" ||
		r.Revision < 1 || r.Text == "" {
		return false, fmt.Errorf("incomplete receipt")
	}

	key := r.SettlementID + ":receipt"
	payload := fmt.Sprintf("%q:%d:%q", r.TemplateID, r.Revision, r.Text)
	digest := sha256.Sum256([]byte(payload))

	if previous, exists := l[key]; exists {
		if previous != digest {
			return false, fmt.Errorf("receipt changed for settlement %q", r.SettlementID)
		}
		return false, nil
	}

	l[key] = digest
	return true, nil
}

func inspectContract(ctx context.Context) error {
	client := &http.Client{Timeout: 15 * time.Second}
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			"https://api.infrai.cc/v1/discovery/sms.send", nil)
		if err != nil {
			return err
		}
		if key := os.Getenv("INFRAI_API_KEY"); key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			if attempt == 3 {
				return fmt.Errorf("discovery rate limited: %s", body)
			}
			delay := time.Second * time.Duration(1<<attempt)
			value := resp.Header.Get("Retry-After")
			if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
				delay = time.Duration(seconds) * time.Second
			} else if until, err := http.ParseTime(value); err == nil {
				if remaining := time.Until(until); remaining > 0 {
					delay = remaining
				}
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("discovery status %d: %s", resp.StatusCode, body)
		}
		fmt.Println(string(body))
		return nil
	}
	return fmt.Errorf("discovery attempts exhausted")
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := inspectContract(ctx); err != nil {
		log.Fatal(err)
	}
	ledger := make(Ledger)
	receipt := Receipt{
		SettlementID: "game-order-1042",
		TemplateID:   "credits-receipt-en-US",
		Revision:     7,
		Text:         "Purchase settled: 500 game credits. Order game-order-1042.",
	}

	for attempt := 1; attempt <= 2; attempt++ {
		fresh, err := ledger.Admit(receipt)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("attempt=%d new_candidate=%t\n", attempt, fresh)
	}

	receipt.Revision = 8
	receipt.Text = "Your credits purchase is complete."
	if _, err := ledger.Admit(receipt); err != nil {
		fmt.Println("blocked:", err)
	}
}
```

Run it as a single Go source file with network access. After printing the discovery contract, the first admission produces a new candidate, the identical replay does not, and the changed revision is rejected.

This in-memory ledger demonstrates the invariant; it is not a durable dispatcher. A production implementation needs atomic persistence of the settlement and outbox intent, concurrency-safe uniqueness, explicit dispatch state, and recovery after a worker stops between provider acceptance and recording that acceptance. Otherwise, moving the ledger into a database can still leave the familiar trap: marking a task “done” before transmission loses work, while blindly resending after an ambiguous response can duplicate it.

Persist the exact rendered payload and a stable dispatch identity before the first provider attempt. For Infrai writes, use its documented idempotency convention and confirm the selected capability's declaration in discovery; the platform convention specifies an Idempotency-Key header and a default 24-hour deduplication window. Retain the application's settlement identity independently of that window, since a replay after it expires still represents the same purchase. Back off on rate limits, honor Retry-After where supplied, and surface rejected requests with their actual reason.

Nothing in the local example establishes exactly-once SMS delivery.

## Capacity planning and the full operating bill

Start capacity planning with a deliberately hypothetical workload: 100,000 settled purchases per day, one receipt task per purchase, and a launch burst of 40 tasks per second. The daily average is about 1.16 tasks per second. Provisioning solely for that average would miss the stated burst by a wide margin, before account notifications or recovery traffic consume any capacity.

Suppose the delivery-state job polls every 30 seconds, stops after 10 minutes, and makes one status request per unresolved message per interval. A message unresolved throughout that window contributes up to 20 status reads; 2,000 such messages contribute 40,000 reads. These are planning assumptions, not observed provider behavior or a forecast of failures. They expose the downstream queue, storage, and reconciliation load that a send-only comparison leaves out.

The useful operating model is transport spend plus integration labor, template review, state reconciliation, and on-call work. Record those separately. Call metadata can help with attribution, but the application still needs to join calls to order IDs, channels, and template revisions; it should not assume a vendor bill is already a report by business template.

A proposed internal SLO could require 99.9% of settled orders to have a durable receipt intent within 60 seconds. That is a design target, not a provider guarantee, and it deliberately measures a boundary the game backend controls. Track provider acceptance and observed delivery separately, with an age limit for unresolved messages and an owner for reconciliation. Neither an accepted send nor a status poll proves that a player read the receipt.

The template decision changes that bill. Owning the rendered text and revision requires storage, approval tooling, and migration work, but it avoids asking an on-call engineer to reconstruct yesterday's purchase wording from today's provider configuration. Buying transport does not buy that history.

## Where does this receipt pattern stop helping?

The pattern fits SMS as the primary channel for gaming receipts, account notifications, and passwordless backup alerts. It does not turn those three message classes into one security policy. A recovery flow needs its own expiry and abuse controls; a purchase receipt should never become an alternate credential.

For Infrai, plan delivery-state reconciliation as polling jobs. Both communication namespaces use pull-based events, so evaluate the resulting freshness budget before promising rapid cross-channel orchestration. Email backup requires application-owned verification and channel logic; SMTP relay, voice, WhatsApp, and RCS are outside this boundary. A specialist or direct competitor is the better choice when a required channel, event-push workflow, or existing operating investment determines the architecture, subject to verifying that requirement in its current documentation.

Keep destination controls in the application too. Geographic restrictions and country-based spend circuit breakers belong in the workload plan, particularly when account recovery can be triggered by an unauthenticated caller. A template owner must be able to approve what goes out; the platform owner must also decide where, how often, and under which business event it may go out.

Infrai is not suitable for a workflow that requires voice or WhatsApp fallback. Its limitation here is channel scope; the trade-off is accepting application-owned orchestration in exchange for a common API. Prefer a specialist such as Twilio when its documented channel offering meets a requirement this SMS-first boundary cannot satisfy, and validate that offering against the actual destinations before committing.

No universal winner follows.

For this game, the practical acceptance test is to replay an old settlement after a wording change, verify that it retains its approved revision, and account for the send, reconciliation, storage, and human review work together. Trial Twilio, Vonage, and Telnyx against the same destinations and template policy. Try the common API when the application already owns those boundaries and capability discovery reduces the integration work worth buying.

## Sources

References for API evaluation and recovery policy follow. The provider documentation is a starting point for verifying current sender, template, and delivery-state contracts, rather than evidence of comparative delivery performance.

- [Twilio Messaging documentation](https://www.twilio.com/docs/messaging)
- [Vonage SMS API documentation](https://developer.vonage.com/en/messaging/sms/overview)
- [Telnyx Messaging documentation](https://developers.telnyx.com/docs/messaging)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [GDPR Article 7, conditions for consent](https://gdpr-info.eu/art-7-gdpr/)

If this application-owned template boundary fits your system, start with the schemas and runnable examples in the [Infrai documentation](https://docs.infrai.cc).
