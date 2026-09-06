# Operations: the domain cutover

Moving the site from `kmt.fly.dev` to `kensmobiletire.com`. Written 2026-09-06
against main `c81e023`.

**The user runs every `flyctl` and registrar command in this file, with their
own hands.** No agent holds the Fly token or a registrar login, and no step here
asks one to. Agents can do the read-only verification -- `curl`, PowerShell's
`Resolve-DnsName`, reading the deployed site -- and that is what the "proves it
worked" lines are for.

Every state below was verified before this was written, or is marked as
unverified. Verify again anyway: this file is a snapshot, and a runbook that was
true yesterday is the most convincing way to be wrong today.

---

## What is already done

DNS at Squarespace, and certificates issued for the apex, `www` and `order`:

| record | name | value |
| --- | --- | --- |
| A | `@` | `66.241.124.248` |
| AAAA | `@` | `2a09:8280:1::184:5351:0` |
| CNAME | `www` | `kmt.fly.dev` |
| CNAME | `order` | `kmt.fly.dev` |

MX, SPF and DKIM for the existing mail were not touched, and must not be by any
step here. **The apex records are the ones that carry mail.** If a step in this
file ever seems to require replacing the apex A record with a CNAME, stop: a
CNAME at the apex would break the client's existing email, and that is a
different and much worse outage than a website being unreachable.

## Preconditions, each checked rather than assumed

**1. `www` resolves consistently.** Not "resolves once": a name that answers
intermittently passes a single check and fails a customer.

**`dig` is not installed on the Windows machine this project is run from**, and
it returns nothing rather than an error there. That matters because it is a
silent failure that looks exactly like a name not resolving -- `www` was
reported as flapping on 2026-09-06 on that basis, and it did not reproduce.
Use PowerShell:

```powershell
1..8 | ForEach-Object {
  try { (Resolve-DnsName www.kensmobiletire.com -ErrorAction Stop |
         Where-Object {$_.IPAddress}).IPAddress -join ',' }
  catch { "FAILED: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 400
}
```

Eight answers, no failures. `nslookup www.kensmobiletire.com` works too and
shows the CNAME chain. On a machine that has `dig`, `dig +short
www.kensmobiletire.com` and a second resolver (`dig @1.1.1.1 +short ...`) are
the equivalent -- a name good on one resolver and empty on another is
mid-propagation and the flip must wait.

**Measured 2026-09-06 against `c81e023`:** eight of eight resolutions returned
`66.241.124.248` and the two AAAA addresses, with no failures, and all four
hostnames answered `200` over HTTPS. So this precondition is met today. It stays
in the file because it is cheap to re-run and the failure it guards against is
the expensive one, not because the name is suspect.

**2. Every hostname serves a valid certificate.** Check all four names, because
a certificate covering the apex does not cover `www`.

```bash
flyctl certs check kensmobiletire.com -a kmt
flyctl certs check www.kensmobiletire.com -a kmt
flyctl certs check order.kensmobiletire.com -a kmt
```

Each must report the certificate as issued and the DNS as configured.

**Why this matters more than a 404 would.** If the canonical flip sends
customers to a name whose certificate is missing or not yet valid, their browser
shows a security warning -- not a broken page, a warning that this site may be
trying to steal from them. A customer who sees that does not conclude the
website is broken; they conclude the business is not safe. That is the failure
this precondition exists to prevent, and it is the reason the certificate check
comes before the flip rather than beside it.

**3. t46 has deployed** before Step 2, and only Step 2. `KMT_CANONICAL_HOST` is
read by code that does not exist on `main` as of `c81e023`; setting the secret
before that code deploys does nothing at all, which is a confusing way to spend
an afternoon. Confirm the deployed release contains it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: kmt.fly.dev' https://kensmobiletire.com/
```

Before t46 that answers 200. After t46 and Step 2 it answers 301. **Measured
2026-09-06: 200**, and `www` likewise -- t46 is not deployed as of `c81e023`,
so Step 2 is blocked today and Step 1 is not.

---

## Step 1 — `KMT_ALLOWED_HOSTS`

**Set all four names in one command.** Not incrementally, and not one per name.

```bash
flyctl secrets set KMT_ALLOWED_HOSTS="kensmobiletire.com,www.kensmobiletire.com,order.kensmobiletire.com,kmt.fly.dev" -a kmt
```

**Why one command.** A `flyctl secrets set` restarts the machine, so each
separate call is another restart and another gap. More importantly, any hostname
missing from the list is answered `403 Unrecognised host` while the others keep
working -- a partial outage that presents as a DNS problem and will be debugged
as one, for as long as it takes someone to think of the environment variable.
Include `kmt.fly.dev`: dropping it breaks the deployed-site check, the wait loop
and every existing link, and it costs nothing to keep.

**Proves it worked.** Each name answers 200, and an invented one is refused:

```bash
for h in kensmobiletire.com www.kensmobiletire.com order.kensmobiletire.com kmt.fly.dev; do
  printf '%-32s %s\n' "$h" "$(curl -s -o /dev/null -w '%{http_code}' "https://$h/")"
done
curl -s -o /dev/null -w 'bogus host -> %{http_code}\n' -H 'Host: nope.example.com' https://kmt.fly.dev/
```

Expected: `200` four times, then `403`.

**Measured 2026-09-06, before this step:** all four names `200`, and the bogus
Host also `200` -- the guard is inert while `KMT_ALLOWED_HOSTS` is unset, which
is the state this step changes. That bogus-Host line going from `200` to `403`
is the single clearest proof that Step 1 took effect.

**Then check health immediately**, before doing anything else:

```bash
curl -s https://kensmobiletire.com/api/health
```

Expected: `{"ok":true}`. It answered that on both `kensmobiletire.com` and
`kmt.fly.dev` on 2026-09-06, before this step, so a change here is caused by
this step and nothing else.

**Why health is checked here specifically.** `/api/health` is exempt from the
host guard on purpose -- Fly's check reaches the process on the internal network
with a Host header that is never one of these four names, so without the
exemption this step would answer `403` to the only caller whose job is to report
whether the machine is well, and the machine would read as sick while serving
every customer perfectly. That exemption is in `isHostAllowed()` in
`backend/api.mjs` and is covered by tests. This step is the first time it is
load-bearing in production, so confirm it rather than trust it.

**Rollback.** `flyctl secrets unset KMT_ALLOWED_HOSTS -a kmt`. The guard becomes
inert and every Host is accepted again, which is the behaviour as of this
writing. One restart.

---

## Step 2 — `KMT_CANONICAL_HOST` (the flip)

**Only after t46 has deployed.** See precondition 3.

```bash
flyctl secrets set KMT_CANONICAL_HOST="kensmobiletire.com" -a kmt
```

**Proves it worked.** Three redirects, and health on both names:

```bash
for h in www.kensmobiletire.com order.kensmobiletire.com kmt.fly.dev; do
  printf '%-32s %s -> %s\n' "$h" \
    "$(curl -s -o /dev/null -w '%{http_code}' "https://$h/")" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' "https://$h/")"
done
curl -s https://kensmobiletire.com/api/health
curl -s https://kmt.fly.dev/api/health
```

Expected: `301` for each of the three, each redirecting to
`https://kensmobiletire.com/`, and `{"ok":true}` from both health calls.
`/api/health` must **not** redirect on either name -- a redirected health check
is a check that is no longer testing this machine.

**Then check the owner cookie survives on the apex.** This is the step most
likely to be wrong in a way nobody notices until Ken tries to work:

1. Open `https://kensmobiletire.com/owner` in a browser with no session.
2. Sign in.
3. Navigate to `/owner/quotes`, then reload the page.

Still signed in is the pass. Being asked for the password again means the cookie
is not surviving the redirect or is scoped to the wrong host, and the owner
cannot use the site. Check it on a phone as well as a desktop, since that is
where Ken will be.

**Rollback.** `flyctl secrets unset KMT_CANONICAL_HOST -a kmt`. Redirects stop
immediately, every name serves the site directly again, and `kmt.fly.dev` has
been serving throughout -- it is never taken out of `KMT_ALLOWED_HOSTS`, which is
what makes this rollback safe.

---

## Step 3 — the repository variable (t53)

Set the repository variable the workflow reads to `https://kensmobiletire.com`,
so the wait loop and the verify job test the domain rather than the old name.
This is a GitHub setting, not a Fly one, and it takes effect on the next run.

**Proves it worked.** The next deploy's verify job logs the new base URL and the
deployed-site check passes against it.

**Rollback.** Set it back to `https://kmt.fly.dev`. Nothing about the running
site depends on it.

---

## Rollback summary

| step | rollback | effect | site down? |
| --- | --- | --- | --- |
| 1 | `flyctl secrets unset KMT_ALLOWED_HOSTS -a kmt` | any Host accepted | no, one restart |
| 2 | `flyctl secrets unset KMT_CANONICAL_HOST -a kmt` | redirects stop | no, one restart |
| 3 | set the variable back to `https://kmt.fly.dev` | CI tests the old name | no |

`kmt.fly.dev` keeps serving through all three, which is the property that makes
every step reversible. Do not remove it from `KMT_ALLOWED_HOSTS` as a tidying-up
step later: it is the escape hatch.

---

## The sending domain, for email (stage 4)

Not part of the cutover, and deliberately written here so stage 4 does not wait
on DNS propagation twice. **Use a subdomain**, `send.kensmobiletire.com` or
similar, rather than the apex: the apex already carries the client's real mail,
and a provider's SPF record at the apex can break it.

Whichever provider is chosen, three records, and the **values come from the
provider's dashboard at the time -- never from this file and never guessed**:

- **SPF** (`TXT` on the sending subdomain): authorises the provider's servers.
  If a TXT record already exists on that name, the includes are merged into one
  record; two SPF records on one name is a misconfiguration that fails both.
- **DKIM** (one or more records on a selector name): the provider gives either a
  `CNAME` pointing at their infrastructure, or a `TXT` holding a public key.
  Which one depends on the provider -- add exactly what their dashboard shows.
- **DMARC** (`TXT` at `_dmarc` on the sending domain): start at `p=none` with a
  reporting address, so failures are visible before anything is rejected.
  Tighten only after the reports are clean.

The two shapes a provider takes:

- **CNAME-based** (Resend, Postmark and similar): the dashboard gives two or
  three CNAMEs to add and verifies them itself. The provider rotates keys behind
  the CNAME, so nothing needs updating later.
- **TXT-based** (SES and similar): the dashboard gives TXT values to paste, and
  a key rotation is a DNS change you have to make.

**Proves it worked**: the provider's dashboard reports the domain verified, and

```powershell
Resolve-DnsName send.kensmobiletire.com -Type TXT
Resolve-DnsName _dmarc.kensmobiletire.com -Type TXT
```

return the records. Then send one real message to an address on another provider
and read its headers: `spf=pass` and `dkim=pass` in the `Authentication-Results`
header is the proof. A dashboard saying "verified" is the provider agreeing with
itself; the receiving server's headers are the test.

Do not send from the domain before these records exist. Early mail that fails
authentication is what teaches spam filters to distrust a new domain, and that
reputation is slow to undo.

---

## What to do when it goes wrong

- **A name 403s and the others work.** It is missing from `KMT_ALLOWED_HOSTS`.
  Set all four again in one command; do not append.
- **Everything 403s.** The variable is set to something malformed -- a space
  after a comma, a scheme, a trailing slash. Unset it, confirm the site returns,
  then set it again carefully.
- **The browser warns about the certificate.** Stop and unset
  `KMT_CANONICAL_HOST`. Do not wait to see whether it settles; every minute is
  customers being told the business is unsafe.
- **`/api/health` redirects.** t46's exemption is not doing its job. Unset
  `KMT_CANONICAL_HOST` -- Fly's check reading a 301 will eventually mark the
  machine unhealthy.
- **The owner is asked to sign in repeatedly.** The cookie is not surviving the
  canonical host. Unset `KMT_CANONICAL_HOST` and raise it; it is a code
  question, not a DNS one.
