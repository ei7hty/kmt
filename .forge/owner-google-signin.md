# Owner sign-in with Google, restricted to `@kensmobiletire.com`

Written by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) on 2026-09-06
at main `71cd81a`, on the user's instruction. The what and the why; the
PROJECT MANAGER turns it into briefs and the REPO AGENT owns the gate.

## One correction before the plan

**Google Cloud IAM does not apply here, and neither does IAP.** Identity-Aware
Proxy sits in front of an application running on Google Cloud. **KMT runs on
Fly**, so there is no proxy to put in front of it and no IAM policy that could
guard `/owner`.

The thing that does the job is **Google Sign-In — an OpenID Connect
authorization-code flow in the app itself**, with the Workspace domain
enforced on our side. That is what this document specifies. The outcome the
user asked for is exactly right; only the mechanism's name changes.

## Why this is worth doing, and it is not mainly about passwords

`backend/auth.mjs:11` states the current design plainly: *"One shared
password, because there is one owner."* That was a reasonable call when it was
written. Three things have changed since, and the third is the one that
matters.

1. **A shared password cannot be revoked for one person.** Offboarding anyone
   means rotating it for everyone.
2. **Nobody has to prove who they are**, only that they know a string.
3. **Decisions are unattributable, and that is a hole in the one thing this
   project says nothing may weaken.** `quotes.decide` records the decision and
   the version; **it does not record who made it.** So "Ken approved this
   quote" is not a fact the system can produce — only "someone holding the
   password approved it." The owner approval gate is the product's central
   promise, and today it cannot name its own actor.

**Google sign-in fixes the third one, which is the reason to do it.** The
password improvements are a side effect.

## What it looks like

**The flow, standard OIDC authorization code:**

1. `/owner` unauthenticated shows **"Sign in with Google"** instead of a
   password field.
2. Redirect to Google with our client id, `scope=openid email profile`, a
   `state` we generate and store, and `hd=kensmobiletire.com` as a *hint*.
3. Google returns a code; we exchange it server-side for an ID token.
4. **We verify the token, then issue the session cookie the app already has.**

**The verification, in order, all of it server-side:**

| check | why |
| --- | --- |
| `state` matches what we issued | CSRF on the callback |
| token signature and `iss` is Google | it is a real Google token |
| `aud` equals our client id | it is a token for *us*, not one minted for another app |
| `email_verified` is true | a Workspace account, not an unverified alias |
| **`hd` equals `kensmobiletire.com`** | **the domain restriction** |
| email is in the allow-list, when set | see below |

**`hd` alone is not the restriction.** It is a claim inside a token, and it
means nothing until `aud` and the signature have been checked — a token from
another application, or an unverified one, can carry any `hd`. **The order
above is the control; the `hd=` parameter in step 2 is only a convenience
that pre-fills the account chooser.**

## The part that makes this cheap: no new dependency

Verifying a Google ID token properly means fetching Google's JWKS and doing
an RS256 verify. **We do not have to.** Google publishes a token-info endpoint
that performs exactly that verification and returns the claims:

```
GET https://oauth2.googleapis.com/tokeninfo?id_token=<token>
```

**One HTTPS call, at login only** — a handful of times a day, not per request
— and it returns `aud`, `iss`, `email`, `email_verified` and `hd` for us to
check. Google documents local verification as the option for high volume;
**this is not high volume.**

That matters because `AGENTS.md` says *"no new dependencies without a
justification that beats keeping the surface small"*, and a JWT library plus
JWKS caching is a real amount of surface for a login that happens twice a day.
**If the token-info route is ever the wrong trade, local verification is a
change inside one function and nothing above it moves.**

**And everything after verification is already built.** `createSessionStore`
gives server-side sessions in `owner_sessions`; the signed cookie, the
expiry, `SameSite=Lax` (t47) and logout-invalidates-the-session all exist and
are unchanged. **Google decides who you are; the session mechanism we already
have decides that you stay signed in.** The new code ends where `signIn`
currently begins.

## Two decisions the user should make, with recommendations

**1. Domain, or domain plus an allow-list?**

Domain-only means anyone Ken ever adds to the Workspace can approve quotes and
read every customer's address. That is fine today and stops being fine the
first time he adds someone for email alone.

**Recommendation: both.** `KMT_OWNER_EMAILS` as an optional comma-separated
allow-list, checked after the domain. **Unset means "anyone on the domain"**,
so it costs nothing now and is one secret away when it is needed.

**2. Does the password stay?**

**Recommendation: yes, during a transition, then removed.**

Deleting it the same day is the tidier engineering and the worse product
decision: if the OAuth client is misconfigured on a Saturday, Ken cannot
approve quotes and real customers wait. **Keep `KMT_OWNER_PASSWORD` as
break-glass, log loudly whenever it is used, and remove it once Google sign-in
has carried the real workload for a week.** A fallback nobody has needed for a
week is a fallback that can go; one removed on day one is an outage waiting
for its trigger.

## The one part that is not free

**Recording who decided.** Once identity exists, `quotes.decide` should store
the acting email so the approval gate can name its actor. That is a **new
column, which means `migrate()` and a migration test** — the rule this project
learned the hard way, because a schema change that only fails in production
is the failure mode that database has already had once.

**Ship the sign-in first and the attribution second.** They are separable, and
the migration should not be riding in the same change as an auth rewrite.

## What blocks it, and it is the same blocker as DKIM

**Creating the OAuth client needs Google Workspace admin on
`kensmobiletire.com`** — the same access that `google._domainkey` is waiting
on. Specifically: a Google Cloud project owned by the org, an OAuth client
with our redirect URI, and the consent screen set to **Internal**, which is
itself a second domain restriction independent of our code.

**So this joins the DKIM queue rather than forming its own.** When the user
has admin, both become possible in the same sitting.

**The client secret is a credential.** It is a Fly secret, set by the user's
own hands, and it does not pass through an agent — the same boundary as the
owner password and the mail key.

## What must not change

- **The owner approval gate.** No customer sees a quote Ken has not sent. This
  changes who may press the button and how we know it was them; it does not
  change that the button exists.
- **The four public customer routes stay public.** A customer never signs in,
  and nothing here touches `backend/api.mjs`'s allow-list.
- **`/owner` still shows a sign-in rather than a 404** when unauthenticated,
  so the deployed-site check's "owner API refuses without a session" assertion
  keeps meaning what it means.
