# Ken's guide to the first week

One page for a phone between jobs. What arrives, what to check, what the
customer is looking at when they call, and what not to do. Written against
the site as it is in the week it goes live, with the catalogue at 6,169
supplier tires over 511 sizes; where something is awkward today and better
is coming, it says so.

Fill in before handing this over: **[maintainer's name and number]** and
**[the shop's phone number]** appear below and are placeholders.

## Where requests arrive

Open **kensmobiletire.com/owner/quotes** on your phone and tap **Sign in with
Google**. Use the same Google account as your business email — that is the
only account the site lets in. There is no separate password to remember.
Nothing emails or texts you yet, so the page is the only place a new request
shows up; check it between jobs. Sign out when you are done if the phone is
ever out of your hands.

Five tabs, each with a count:

- **Needs you** — requests waiting for your decision. This is the one to
  open. It lists the oldest first, so the customer who has waited longest
  is at the top.
- **Open** — everything that is not finished, whatever state it is in.
- **With customer** — you approved it; they have not paid yet. Nothing to
  do but wait, or call.
- **To fit** — paid. A van to drive somewhere.
- **Closed** — done, declined or cancelled.

## What a request card shows

The vehicle as the customer typed it, then: the tire line with the count
(**4 × Accelera Eco Plush · 215/60R16**), the location and preferred date,
the contact (tap the email or the number to write or call), the draft total,
the status, and a reference like **#98296987** with **"Submitted 3 hours
ago"** under it.

An amber block that says **Owner review required** means the quote drafted
itself but something needs a person: the tire is out of stock at the
supplier, the supplier does not list it, it is an off-road tire, or the
vehicle is a truck, pickup, van or SUV. The reason is written on the block.
Approve & Send still works on those; the block is there so you look first.

## Before you tap Approve & Send

Approve sends the quote to the customer as it stands. Check, in this order:

1. **The tire and size** against the vehicle. Customers pick from a list, so
   the size is one we carry; whether it is right for that car is your call.
2. **The supplier stock line** on the card. If it says the supplier shows
   **0 in stock**, or the stock was last seen weeks ago, do not approve
   until you know you can get the tires. Prices and stock come from the
   supplier's listing at the last refresh; they are not a reservation.
3. **The distance.** Beyond 25 miles from Malden the request is flagged for
   review with the distance on the card; beyond 100 miles the site refuses
   it at submit. Until that is switched on, read the address yourself.
4. **The quantity.** The tire line says how many. Four is the default; a
   customer who wanted two and got quoted four will not pay, and the other
   way round is worse.
5. **The total.** It is the tire price times the count plus the mobile
   installation fee, and nothing else: no tax, no disposal, no TPMS or
   valves. Anything else you charge, say before they pay, or do not charge.

You cannot change the price on the card yet. If the quote is wrong, use
**Cancel** and write a reason: the customer sees the reason on their page
with "You have not been charged", so a reason like *"Please call us on
[the shop's phone number] and we'll quote this by hand"* keeps the job.
**Reject** declines with no reason shown; use it for requests that are not
real. Neither one charges anybody.

## What the customer sees, state by state

They only see it by opening their own link (the page they landed on after
submitting, **Track this quote**). Nothing is sent to them yet, so after
you approve, **call or text them** — otherwise they find out when they next
look.

| your screen says | their page says |
| --- | --- |
| DRAFT (in Needs you) | "This quote is awaiting owner review." |
| SENT (With customer) | a **Pay $258.11** button with the quote |
| PAID (To fit) | "Payment received. Your service is confirmed." |
| DONE (Closed) | "Fitted. Thanks for choosing KMT." |
| REJECTED | "This quote was declined. Please submit a new request." |
| CANCELLED | "This request was cancelled." then your reason, then "You have not been charged." |

Payment on the site is a placeholder in the first week: tapping Pay records
the payment but moves no money. Collect as you do today until that changes,
and say so if a customer asks why nothing was charged to their card.

## Finding a request from a phone call

There is no search box yet. What works today:

- Ask the caller for the **first few characters of the reference** in the
  address bar of their page (the long code after `request=`). The card shows
  the first eight, like **#98296987**; match on those.
- Or ask for the **vehicle** and scroll the **Open** tab; the vehicle is the
  first line on every card.
- The **"Submitted 3 hours ago"** line helps when they say "I sent it this
  morning".

Search by name, phone, email or vehicle is planned for after launch. Until
then this is scrolling, and on a busy week it will feel like it.

## Marking a job done

After the tires are on: **To fit** tab, find the card, **Mark done**. The
customer's page changes to "Fitted. Thanks for choosing KMT." and the
request moves to Closed. That is the end of a request; nothing schedules or
dispatches anything.

## Two conversations you will have

**"You're outside our area."** Until the distance check is switched on,
anyone anywhere can submit. If the address is too far, **Cancel** with a
reason that says so and gives [the shop's phone number], so they can ask
whether you will make the trip. Do not approve and sort it out later; once
they have paid, cancelling is a refund conversation.

**"Can you get this tire?"** A quote flagged *not a supplier-listed tire*
or *out of stock* is priced from a placeholder, not from a supplier price.
Do not approve it as it stands. If you can source the tire, **Cancel** with
a reason to call and quote by hand; if you cannot, **Reject** and tell them
what you can offer in that size instead.

## When a customer asks to be removed

Nothing on your screens deletes anything, and that is on purpose: a request
is a business record. Pass the customer's request to **[maintainer's name
and number]**. What happens, per `docs/data-policy.md`: their **name, email,
phone, address and access notes are blanked**; the vehicle, the tire, the
quantity, the total, the status and the dates stay, so the ledger still
adds up. Tell the customer that is what removal means here. Do it within a
few days; do not promise it happened until the maintainer says so.

## When the site is down

Open **kensmobiletire.com/api/health**. If it does not say `{"ok":true}`,
or the owner page will not load, call **[maintainer's name and number]**.
Nothing you can do from the phone fixes it, and nothing you do from the
phone makes it worse. Customers can still call the shop; take the request
the old way and enter nothing later — the site has no way to add a request
by hand.

**If the site is up but Google will not let you in**, that is a different
problem and there is a written way back: **[owner-recovery.md](owner-recovery.md)**.
Customers are unaffected while it happens — their requests keep arriving and
are waiting for you when you get back in.

## Do not

- **Give anyone a Google code or password.** Your Google account is now the
  only way into the site, so it is the thing worth protecting. Nobody who
  builds or runs the site will ever ask you for a Google password, or for a
  code Google texts you. Anyone who does is trying to rob you, however
  convincing the reason sounds and whoever they say they are.
- **Approve a quote whose stock line you have not read.** The one thing the
  site cannot do is know whether the tires exist this morning.
- **Run a supplier refresh from your phone** on the Inventory screen. It
  opens a browser on the server and takes minutes per size; the catalogue
  is refreshed monthly from a laptop, on a schedule, by [maintainer's name
  and number].
- **Promise a price you set on the Inventory screen has reached the
  customer** until you have reloaded their page and seen it. Prices you
  set win over the automatic markup; a tire you switch off disappears from
  what customers can pick.

## The Inventory screen, in one paragraph

You do not need it in the first week. Every supplier tire is already priced
for customers by the markup rule. If you want your own price on one tire:
Inventory, type the size, find the tire, set the price, tick **Offer this
tire**, **Save offer**. Two numbers at the top tell you the state of the
catalogue: how many supplier tires are saved, and how many sizes have
supplier tires. Pricing a whole size at once is coming; today it is one
tire at a time, and a common size has a couple of hundred.
