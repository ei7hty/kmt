# Operations: the domain cutover

Moving the site from `kmt.fly.dev` to `kensmobiletire.com`. Written 2026-09-06
against main `c81e023`; revised the same day against `3c6b71f`, the deploy that
made t46 live. Where a line says what was measured, it names the release it was
measured against.

**The user runs every `flyctl` and registrar command in this file, with their
own hands.** No agent holds the Fly token or a registrar login, and no step here
asks one to. Agents can do the read-only verification -- `curl`, PowerShell's
`Resolve-DnsName`, reading the deployed site -- and that is what the "proves it
worked" lines are for.

Every state below was verified before this was written, or is marked as
unverified. Verify again anyway: this file is a snapshot, and a runbook that was
true yesterday is the most convincing way to be wrong today.

---

## Preflight: which steps have already run

**Run this before any step in this document, and before concluding anything from
the site's behaviour.**

```bash
flyctl secrets list -a kmt
```

Every switch in this file is a secret, so one command shows which steps have
already been done. It is faster than reading logs, needs no deploy, writes
nothing, and it answered in seconds a question that three sessions spent an hour
inferring from behaviour.

| secret | absent means | present means |
| --- | --- | --- |
| `KMT_OWNER_PASSWORD` | the server refuses to boot | the owner can sign in |
| `KMT_SESSION_SECRET` | a random one per boot, so sessions die on restart | sessions survive a restart |
| `KMT_SERVICE_RADIUS_MILES` | **the service-area check is ENFORCING** at base 02148, 100 mi, 25 mi review | it is set to something -- read the boot line for which |
| `KMT_ALLOWED_HOSTS` | **Step 1 has not been done**; any Host is accepted | Step 1 has been done |
| `KMT_CANONICAL_HOST` | **Step 2 has not been done**; the redirect is dormant | the flip is live |
| `KMT_MAIL_SMTP_HOST` / `_USER` / `_PASSWORD` | mail is outbox-only; nothing sends | SMTP is configured (see below) |
| `KMT_MAIL_FROM`, `KMT_OWNER_EMAIL` | fine while no SMTP variable is set | required once any is |

**Two of these no longer need `flyctl` at all.** The running server now answers
both as headers, which is faster than a secrets list and proves what actually
resolved rather than what was set:

```bash
curl -sI https://kensmobiletire.com/ | grep -i '^x-kmt-'
```

```
x-kmt-release: 71cd81a
x-kmt-service-area: on
```

Measured 2026-09-06: the service-area check is **on**, so a customer outside the
radius is refused at submit. `KMT_SERVICE_RADIUS_MILES` is present and set, which
is why the "absent means enforcing" row below is now about a state this
deployment is no longer in -- it stays because it is still true of any
deployment where the secret is missing.

**A digest is not a value.** `secrets list` shows that a secret exists, not what
it resolves to -- so it can prove a step has been done, and cannot prove what it
was set to. `KMT_SERVICE_RADIUS_MILES` is the case that matters: present, it may
be `off` or a number of miles, and only the boot line says which:

```
service-area check OFF: accepting every ZIP
service-area check ON: base 02148, radius 100 mi, review beyond 25 mi
```

Presence and resolution are two different questions and each needs its own
evidence. Both were used to settle this on 2026-09-06: the secret was listed as
Deployed, and three boot lines across three deploys all read `OFF`.

**The service-area row is the one to read carefully, because it fails closed.**
Nothing set means customers beyond 100 miles are refused at submit -- and a
refused customer does not come back to say so. Absence of that secret is not a
quiet default; it is the check running.

**Mail refuses a half-configuration rather than half-sending.** `configured` is
true if **any** of `KMT_MAIL_SMTP_HOST`, `_USER` or `_PASSWORD` is set, and from
that moment `KMT_MAIL_FROM` and `KMT_OWNER_EMAIL` are required or the server
refuses to boot, naming the missing one. `_USER` and `_PASSWORD` must also be set
together or neither. So a partial mail setup cannot start and quietly send from
the wrong address; it stops, the way a missing owner password does.

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
read by code that shipped in #167; setting the secret before that code is live
does nothing at all, which is a confusing way to spend an afternoon.

**Met as of 2026-09-06: #167 deployed as `3c6b71f`.** Production now serves all
six security headers, `GET //` answers 200, and -- the part that matters here --
the canonical switch shipped **dormant**, because a code merge sets no
environment. The redirect is inert until the secret is set, which is the whole
separation Steps 1 and 2 depend on. Confirm for yourself rather than trusting
this line:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: kmt.fly.dev' https://kensmobiletire.com/
```

Before Step 2 that answers 200; after it, 301. **Measured 2026-09-06 against
`3c6b71f`, with t46 live: still 200**, which is the dormant state, not a
failure. Both steps are now technically unblocked; the timing is the user's.

---

## The failure that hides: a canonical host not in the allow-list

**If `KMT_CANONICAL_HOST` names a host that `KMT_ALLOWED_HOSTS` does not
contain, the site is down and every monitor says it is fine.** Measured by the
auditor on a throwaway server:

- the canonical name answers **403**, because the Host guard runs before the
  redirect;
- every other name **301s to it**, so every visitor is sent to the 403;
- nothing at boot warns.

**Why nothing catches it.** `/api/health` is exempt from both guards -- which is
what makes Fly's check work at all -- so the platform check, any uptime monitor
and the boot log all keep reporting a healthy machine. The only thing that
reveals it is a plain GET on the canonical name. And `flyctl secrets set`
restarts the machine *outside a deploy*, so the post-deploy verify job never
runs and CI never sees it either.

This is exactly the shape of Steps 1 and 2 below, which is why the order matters
and why each one is verified with a GET rather than with the health probe.

**The rule: `KMT_ALLOWED_HOSTS` contains the canonical name before
`KMT_CANONICAL_HOST` is ever set.** Step 1 does that -- it sets all four names,
canonical included -- which is the reason it comes first. Do not reorder them,
and do not narrow the allow-list later without checking what the canonical host
is set to.

**How this shows up depends on whether #167 has deployed, so check which state
you are in before diagnosing.** #167 added a boot refusal for this, and it is live: with a canonical host set
and a non-empty allow-list that does not contain it, the process refuses to
start and names both variables, the way `readAuthConfig` already refuses a bad
password.

| | symptom | where you see it |
| --- | --- | --- |
| before #167 deployed | the canonical name answers **403**, every other name 301s into it, **health stays green** | only a GET on the canonical name |
| **after #167 deployed — this is now the live behaviour, as of `3c6b71f`** | the machine **will not start**; the boot message names both variables and the fix | `flyctl status`, and the site is down |

The first row is kept deliberately. It is history for this deployment, but it is
the behaviour of any environment running a build older than #167 -- a rollback
to an earlier release, or a second app stood up from an old image -- and someone
reading this file in one of those is in that row, not this one.

Neither is quiet in the same way. Before, everything reports healthy and only a
customer notices. After, nothing reports healthy and the cause is written in the
log. The second is the better failure, which is the point of #167 -- but until
it is deployed, do not expect a crash to tell you, and do not read a running
machine as a working one.

**Either way the `curl -sI` checks below stay.** The guard prevents this one
contradiction; it does not prevent a typo in a hostname, a name whose
certificate has not issued, or a secret set on the wrong app. A guard against
one failure is not a substitute for checking the outcome.

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

Note: this expects `200` because it runs **before Step 2**. After Step 2 (the
flip), the three non-canonical names correctly answer **301** redirecting to
the canonical host -- that is the working state, not a failure. If you are
re-running this during a rollback or an incident, read `301` on
www/order/kmt.fly.dev as healthy; only the canonical name should be `200`.

**Measured 2026-09-06, before this step:** all four names `200`, and the bogus
Host also `200` -- the guard is inert while `KMT_ALLOWED_HOSTS` is unset, which
is the state this step changes. That bogus-Host line going from `200` to `403`
is the single clearest proof that Step 1 took effect.

**A GET on each name is the check that matters, not the health probe.**
`/api/health` is exempt from the host guard, so it answers 200 whether this step
worked or not. The four 200s above are the proof; health confirms something
narrower, below.

**Then check health**, which confirms the exemption is doing its job:

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

**Proves it worked.** The canonical name first -- if this is not 200, the site
is down for everyone and the rollback below is immediate:

```bash
curl -sI https://kensmobiletire.com/ | head -1
```

`HTTP/2 200`. A `403` here means the canonical name is missing from
`KMT_ALLOWED_HOSTS`; unset `KMT_CANONICAL_HOST` at once and fix Step 1 before
trying again. Do not diagnose further while it is set: every visitor is being
redirected into that 403, and health will keep saying the machine is well.

Then the three redirects, and health on both names:

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

## What changes for people on the day, and is not a bug

Four consequences of the cutover that will look like faults if nobody has
written them down.

**Ken has to sign in again on the new name.** The owner session cookie is scoped
per host, so his session on `kmt.fly.dev` does not carry to
`kensmobiletire.com`. Expected. Tell him before the flip, or the first thing he
meets on the new site is a password prompt that reads as the cutover having
broken his login.

**The import bookmarklet has to be regenerated.** One generated on
`kmt.fly.dev` posts to `kmt.fly.dev`, which now answers 301, and the post
fails. Regenerate it from the owner screen on the new name after the flip.

**Customers who submitted before the cutover will not see their list at
`/status` on the new name.** The per-browser key is stored per origin, so the
new origin starts empty. Their request is not lost and is reachable by its link
-- which is what the emailed link is for. Nobody has to do anything; it is worth
knowing before someone reports "my request disappeared".

**One open tab may fail its next submit.** A POST to a non-canonical name gets a
301, and browsers turn a redirected POST into a GET, so a form submitted from a
tab opened before the flip fails once and works on reload. Acceptable, and
short-lived; name it so it is not chased as a bug.

## Rollback summary

| step | rollback | effect | site down? |
| --- | --- | --- | --- |
| 1 | `flyctl secrets unset KMT_ALLOWED_HOSTS -a kmt` | any Host accepted | no, one restart |
| 2 | `flyctl secrets unset KMT_CANONICAL_HOST -a kmt` | redirects stop | no, one restart |
| 3 | set the variable back to `https://kmt.fly.dev` | CI tests the old name | no |

After any rollback, confirm with a GET rather than a health probe, for the same
reason as above:

```bash
curl -sI https://kensmobiletire.com/ | head -1
curl -sI https://kmt.fly.dev/ | head -1
```

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

---

# Operations: backups, restore, and what to do when it breaks

The cutover above happens once. This half is for every day after it.

Written 2026-09-06. **The restore drill in it has not been run.** Where a step
says what to expect, that is what the code and Fly's documentation say it should
do, not what someone watched happen -- and until the drill is performed once,
that distinction is the whole point of this section. A backup nobody has
restored is a hope.

## What exists today, and what it is worth

**Fly volume snapshots, taken automatically, kept five days.** That is the
entire backup story right now. Three things follow from it that are easy to get
wrong:

- **Five days is not an archive.** A problem discovered on the sixth day has no
  copy to go back to. Anything you want to keep longer has to leave Fly.
- **They are incremental.** One taken a minute after another stores kilobytes.
  A small snapshot is not a failed snapshot.
- **They are on the same platform as the thing they protect.** They cover a
  corrupted file, a bad migration, a deletion. They do not cover losing the
  account.

**What is in the file matters more than it used to.** After the supplier import,
`/data/owner.sqlite` holds the catalogue *and* every customer request. The
catalogue can be rebuilt -- it is a scrape, and `src/data/scraped-tires.json` is
in the repository. The requests cannot be rebuilt from anything. When you are
deciding how much a restore is worth, that is the number: not rows, but the
requests nobody can reconstruct.

## Taking a snapshot by hand

Before anything risky -- a migration, a reset, a schema change, the cutover
itself. `flyctl` is at `C:\Users\anune\.fly\bin\flyctl.exe` and is **not** on
`PATH`.

```bash
flyctl volumes list -a kmt                    # the volume id
flyctl volumes snapshots create <volume-id>   # take one now
flyctl volumes snapshots list <volume-id>     # confirm it exists
```

**Proves it worked**: the new snapshot appears in the list with a recent
timestamp. Watch its status rather than a summary line -- a poll that prints
"complete" while the status still says `running` is a poll with a bug in it,
which has happened here before.

## The monthly copy that leaves Fly

Snapshots expire in five days and live beside the thing they protect, so once a
month take a copy off the platform. The user does this; no agent holds the
credentials, and the file contains every customer's name, email, phone and
address.

```bash
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \".backup /tmp/owner-backup.sqlite\""
flyctl ssh sftp get /tmp/owner-backup.sqlite -a kmt
flyctl ssh console -a kmt -C "rm /tmp/owner-backup.sqlite"
```

One command per `ssh console` call: nested quoting through `-C` breaks in ways
that are hard to see. `Error: The handle is invalid` prints after every call on
Windows and is a console quirk -- the output above it is real.

**This procedure has still never been run end to end.** The restore drill was
run on 2026-09-06 and passed; the monthly copy was not, and it is the procedure
whose `sqlite3` call went undiscovered longest for exactly that reason. Expect
to correct a step the first time, and correct this file when you do -- that is
what the drill was worth, and it is worth the same here.

**Use `.backup`, not `cp`.** The database is in WAL mode and is being written to
while you copy. `cp` of a live SQLite file can produce a torn copy that opens
fine and is missing the most recent writes; `.backup` takes a consistent
snapshot of a live database. This is the difference between a backup and
something shaped like one.

**Where it goes matters as much as taking it.** It is the customer database:
somewhere encrypted, not a shared drive, not an email attachment, not a folder
that syncs to a machine other people use. And delete the copy on the server
afterwards, as above -- leaving it in `/tmp` puts a second copy of every
customer record inside the container.

## Before the drill: take the two numbers that make it provable

**Do this first, in under a minute, while production is healthy.** Without it,
"the restore worked" means "a file opened". With it, it means "the customer
records came back, all of them".

```bash
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite 'select (select count(*) from requests), (select count(*) from quotes)'"
```

Write the two numbers down with the time.

**`-readonly` is not decoration.** Opening a SQLite database read-write is not
inert: it can replay a hot journal and checkpoint a WAL, so an inspection can
quietly alter the live database it was sent to read. Every read against
production in this document carries that flag; the redaction statements later on
deliberately do not, because they write.

**On an image built before 2026-09-06, `sqlite3` is not installed** and these
commands fail with `executable file not found in $PATH` -- found by running the
restore drill, which is what a first drill is for. Node 24 and `node:sqlite` are
in every image, so this is the fallback that works on any of them, with the same
read-only guard:

```bash
flyctl ssh console -a kmt -C 'node -e "const s=require(\"node:sqlite\");const d=new s.DatabaseSync(\"/data/owner.sqlite\",{readOnly:true});console.log(JSON.stringify(d.prepare(\"select (select count(*) from requests) req,(select count(*) from quotes) quo\").get()))"'
```

Two quoting notes, each of which has cost someone a cycle: nested quotes through
`ssh -C` break in ways that are hard to see, so single-quote the outer and
double-quote inside; and in PowerShell the escape character is a backtick, which
only works inside a **double**-quoted string -- inside single quotes it arrives
literally. `Error: The handle is invalid` prints
after every `ssh console` call on Windows and is a console quirk; the output
above it is real.

**Those are the only numbers that matter.** The supplier tables can be rebuilt
from the scrape in the repository. A customer's request cannot be rebuilt from
anything, so the drill's pass condition is that the restored file holds the
requests and quotes the live database held when the snapshot was taken -- not
that it opened, not that it passed a schema check.

A snapshot taken before the count will hold fewer rows if requests arrived in
between. That is expected and it is why the time matters: compare against the
count at the snapshot's age, not at the moment you happen to run the drill.

## The restore drill

**This has not been run. Run it once on a quiet day.** The whole point is to
discover the steps that are wrong while nothing is lost, and every instruction
below is written to be checked rather than believed.

It restores to a **new volume and a throwaway machine**. Nothing in this
procedure touches the live volume: a restore creates a new volume rather than
overwriting one.

**That guarantee is about the volume, and it is not a guarantee about the app.**
It was written as the whole safety story and read that way, and on 2026-09-06 the
drill was run with the throwaway machine inside the production app -- which this
section did not forbid because it did not say which app to use. A Fly app
load-balances across its machines, so a machine that is not running the server
can still be handed real customer traffic. One was, for about thirteen minutes,
and the health monitor caught it: `no X-KMT-Release header`, because the request
was answered by a machine that is not the app.

Naming one hazard makes a reader stop looking for others. The volume was never
at risk and production was still briefly degraded.

1. **Pick a snapshot.**

   ```bash
   flyctl volumes list -a kmt
   flyctl volumes snapshots list <volume-id>
   ```

   Note its id and its age. If the newest is older than you expect, stop and
   find out why before restoring anything -- an unexplained gap in snapshots is
   itself the finding.

2. **Create a new volume from it.**

   ```bash
   flyctl volumes create kmt_restore_test --snapshot-id <snapshot-id> --region ewr --size 1 -a kmt
   ```

   A new volume, deliberately named so nobody mistakes it for the live one.

3. **Get the file off it and onto your machine**, using a temporary machine with
   that volume mounted -- **in a separate Fly app, never in `kmt`.**

   **This is the step that degraded production once.** A machine created with
   `-a kmt` joins that app's routing pool the moment it exists, whatever it is
   running. Fly balances customer requests across it, and a machine running
   `sleep 900` answers them without the app: no release header, no site. Nothing
   about mounting a restored volume requires being inside the app that serves
   customers.

   **The invariant, whichever way you achieve it: no machine may exist in the
   customer-serving app that is not the server.** Everything below is about how
   to satisfy that, and the honest answer is that nobody here has established
   which method actually works.

   **Preferred, and UNVERIFIED: a separate app.** `flyctl apps create
   kmt-restore-test`, restore into a volume there, mount it, take the file,
   destroy the app. Nothing customers can reach is involved at any point.

   **The open question that decides whether this is possible: a Fly volume
   belongs to exactly one app, and it is not established here whether a snapshot
   of `kmt`'s volume can be restored into another app's volume.** If it can,
   this is simply the right procedure and the paragraph below is unnecessary. If
   it cannot, the separate-app path does not exist and pretending otherwise
   sends the next person round a loop at the worst moment. **Settle it once, at
   the start of the next drill, and rewrite this step with the answer** --
   `flyctl volumes create --help` and one attempt will say.

   **Fallback, if the volume cannot leave the app.** Do it in `kmt`, and treat
   the machine as a live incident from the moment it exists:

   - tell whoever watches the health monitor **before** creating it, because it
     will fire and it should not be diagnosed from scratch;
   - give it the shortest life that gets the file off, not `sleep 900`;
   - destroy it the moment the transfer finishes, not at the end of the drill;
   - confirm afterwards that the app is back to one machine and that
     `x-kmt-release` is stable across several reads.

   That is containment, not safety. It was thirteen minutes and a low-traffic
   evening last time; the same procedure at 9am on a launch week is a different
   sentence. Fly's exact invocation for a one-off machine changes
   between `flyctl` versions, so read `flyctl machine run --help` rather than
   trusting a command written here months earlier. What you need is a container
   with `kmt_restore_test` mounted at `/data` and a shell.

   Then the same `.backup` and `sftp get` as the monthly copy, against the
   restored volume.

4. **Prove the file is sound**, with the read-only integrity check:

   ```bash
   node .forge/restore-integrity-check.mjs /path/to/restored.sqlite
   ```

   This is the step that turns "the file came back" into "the data is sound".

   **The drill passes when both of these hold**, and it is worth writing them
   down as they come rather than deciding afterwards whether it went well:

   - the script prints `SOUND` and exits 0 (or `OLDER SCHEMA` and exits 2, which
     is intact -- see the verdict table below); and
   - the `requests` and `quotes` counts it prints match the two numbers taken
     before the drill, allowing for rows that arrived after the snapshot.

   A `SOUND` verdict with a requests count of zero is a failed restore that
   passed every structural check. That combination is the one to watch for: the
   file is a valid database, and it is not the customers' database.
   It opens the database **read-only**, so it cannot repair the evidence it is
   judging -- opening a damaged SQLite file read-write can silently checkpoint
   and fix it, after which every run passes and nobody learns anything.

   A sound file looks like this. The row counts vary per restore, so they are
   counts to read, not numbers to match:

   ```
   Restore-integrity check against /path/to/restored.sqlite
   OK: /path/to/restored.sqlite exists
   OK: opens as a SQLite database in read-only mode
   PRAGMA user_version: 0
   OK: PRAGMA integrity_check reports ok
   OK: PRAGMA foreign_key_check reports no violations
   OK: table supplier (rebuildable) is present with its expected columns and readable: N row(s)
   OK: table offers (rebuildable) is present with its expected columns and readable: N row(s)
   OK: table coverage (rebuildable) is present with its expected columns and readable: N row(s)
   OK: table metadata (rebuildable) is present with its expected columns and readable: N row(s)
   OK: table requests (irreplaceable) is present with its expected columns and readable: N row(s)
   OK: table quotes (irreplaceable) is present with its expected columns and readable: N row(s)
   OK: table owner_sessions (operational) is present with its expected columns and readable: N row(s)
   OK: table outbox (operational) is present with its expected columns and readable: N row(s)
   OK: quotes.status CHECK constraint includes every current status
   OK: if metadata.seeded is set, the supplier table actually holds rows

   14 OK, 0 OLDER SCHEMA, 0 FAIL -- 14 of 14 expected checks ran

   SOUND: this file passed every check this script knows to run.
   ```

   **Three verdicts, and they mean three different next actions.** Read the
   last line, or the exit code, and do the matching thing:

   | verdict | exit | what it means | what you do |
   | --- | --- | --- | --- |
   | `SOUND` | 0 | every check passed | restore from this file |
   | `OLDER SCHEMA` | 2 | **intact**, but written before a table or a constraint the current code has | restore it and let the app's own migration run before serving from it |
   | `NOT SOUND` | 1 | corruption, a missing original table, a missing column, or the seeded-but-empty trap | do not serve from this file; find another copy |

   **`OLDER SCHEMA` is not a failure and must not be treated as one.** Fly's
   snapshots are kept five days, and this project has added tables and widened
   constraints on consecutive days, so *every* restore is a file from a schema
   in the past -- an intact one reporting `OLDER SCHEMA` is the normal case,
   not the alarming one. It exists as its own verdict precisely so that
   `NOT SOUND` keeps meaning "stop". A check that cried wolf here would be
   worse than no check, because the one time it matters is the one time
   somebody is frightened and in a hurry.

   The two things it covers: a table added later (`owner_sessions`, `outbox`)
   being absent, which `CREATE TABLE IF NOT EXISTS` recreates empty on the next
   boot with nothing lost; and `quotes.status`'s CHECK predating t36's widening,
   which `migrate()` rebuilds losslessly. A real `FAIL` alongside an
   `OLDER SCHEMA` finding still wins the verdict and the exit code.

   `PRAGMA user_version` is printed, not asserted -- nothing in this project has
   ever set it, so it is `0` on every file today. It is there because it is the
   fastest way to say which migration generation a file belongs to if that ever
   changes, and because it answers the first question anyone asks when this
   output is pasted into a message.

5. **Record what happened**, in `.forge/HANDOFF.md`: the snapshot id and age,
   how long each step took, the check's output verbatim, and **every step whose
   written instruction turned out to be wrong.** That last one is the reason to
   do this at all. Then fix this document.

6. **Destroy the test volume**, so it does not sit there costing money and
   holding a second copy of every customer record:

   ```bash
   flyctl volumes destroy <restore-volume-id>
   ```

   And delete the local copy unless you have deliberately decided to keep it
   somewhere encrypted.

**What a successful drill proves**: that a snapshot can become a volume, that
the file on it opens, that its schema matches what the code expects, and that
the requests are there. **What it does not prove**: that the app runs against
it. That is a bigger exercise and it is worth doing separately once, but a file
that fails this check will not be fixed by pointing an app at it.

## Rotating the secrets

Both of these restart the machine. Set them one at a time and check the site in
between, so you know which one broke it if something does.

```bash
flyctl secrets set KMT_OWNER_PASSWORD="<new password, 12+ characters>" -a kmt
flyctl secrets set KMT_SESSION_SECRET="<new random value>" -a kmt
```

`KMT_OWNER_PASSWORD` is Ken's; tell him before, not after. Under twelve
characters and the server refuses to boot, which presents as the machine failing
to start rather than as a rejected password.

`KMT_SESSION_SECRET` invalidates every existing owner session, which is the
point when rotating it deliberately, and an unwelcome surprise when not. It also
means Ken signs in again.

**Proves it worked**: sign in on the owner screen with the new password. Do not
assume -- a password that was set with the wrong quoting is a password nobody
knows.

## Data removal

`/privacy` promises this today, in these exact words: *"To ask for your name,
contact details and address to be removed, call (617) 410-8319."* **If that
phone rings, run one command:** `scripts/redact.mjs`, which is the
implementation `docs/data-policy.md` describes and this section used to
stand in for (#286).

```bash
flyctl ssh console -a kmt -C "node /app/scripts/redact.mjs --request <request-id>"
```

That prints exactly what it would change and **writes nothing**. Read it, then
run it again with `--write`.

The rest of this section is: how to find the id in the first place (step 1,
unchanged and still needed), what the command does and how to check it (step
2), and **the hand-written SQL, kept as a fallback** for the day the
application code will not run -- a damaged database, a machine that boots far
enough for `sqlite3` and no further. It is no longer the procedure. Prefer the
command every time it will start, because the SQL is copied from four constant
lists by hand and cannot stay in step with them; the command builds its
statements from those lists directly, so adding a personal field changes what
it redacts with no edit here.

**Take a snapshot first.** Same rule as everywhere else in this document: it
costs seconds, and it is the difference between one problem and two if a typed
`WHERE` clause is wrong. See "Taking a snapshot by hand," above.

**`requests`, `quotes` and `outbox` are live tables today** (#157 and #205
merged, #206 wired `mail.mjs` to write outbox rows on submit, on quote-sent,
and on payment -- the outbox is not empty the way it was when this section was
first written). Everything below applies to those three unconditionally.

`inquiries` is live too. Confirm the wiring rather than trusting this line:

```bash
grep -n "Inquiries" backend/server.mjs backend/dev.mjs backend/api.mjs
```

This must return the live imports and handlers; as a positive control,
grepping `Quotes` the same files must return lines too.

If a future schema change ever drops one of these tables, a query against it
fails loudly with `no such table` rather than silently skipping -- that
failure is correct, not a sign this procedure is out of date.

### 1. Find what you have

You will be holding a request id (from an emailed link, or read off `/status`
by the customer), or only a name or phone number. `flyctl ssh console -a kmt`
puts you on the machine; one `sqlite3` invocation per call, per the rule above
-- nested quoting through `-C` breaks in ways that are hard to see.

By id, if you have one:

```bash
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT id, payload FROM requests WHERE id='<request-id>';\""
```

By name or phone, if that is all you have -- the payload is JSON, so this
reads inside it:

```bash
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT id, json_extract(payload,'\$.customerName'), json_extract(payload,'\$.customerPhone') FROM requests WHERE json_extract(payload,'\$.customerName') LIKE '%<name>%' OR json_extract(payload,'\$.customerPhone') LIKE '%<digits>%';\""
```

A name with an apostrophe (O'Brien) needs it doubled for SQL, not backslash-escaped:
`O''Brien`, not `O\'Brien`.

**Read the row back before touching anything.** More than one match, or no
match at all, both mean stop and confirm you have the right person before the
next step -- there is no undo on the write that follows.

Then, with the request id in hand, find everything attached to it:

```bash
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT id, status FROM quotes WHERE request_id='<request-id>';\""
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT id, type, status FROM outbox WHERE request_id='<request-id>';\""
```

An inquiry is not attached to a request at all -- there is no `request_id` to
search by, because an inquiry was never about a tire. If the person also
submitted the "more than tires" form, you need its own id or a name/contact
search the same shape as above, against `inquiries` directly.

### 2. Redact exactly what `docs/data-policy.md` promises -- no more, no less

**Run the command.** Everything after it in this step is the fallback SQL and
the reasoning both share.

```bash
flyctl ssh console -a kmt -C "node /app/scripts/redact.mjs --request <request-id>"
flyctl ssh console -a kmt -C "node /app/scripts/redact.mjs --request <request-id> --write"
```

An inquiry is not attached to a request, so it is redacted by its own id with
`--inquiry <inquiry-id>` instead. The first form opens the database
**read-only** and prints the fields, quotes and outbox rows it would touch; the
second performs it in one transaction and then re-reads the request through the
owner-audience API path to confirm nothing personal survived. Both are
idempotent: running either twice is a no-op, and the command says so rather
than leaving you guessing whether last month's call was acted on.

Three things it does that the SQL below cannot. It **derives** its statements
from `REQUEST_PERSONAL_DATA_KEYS`, `OUTBOX_PERSONAL_DATA_KEYS`,
`OUTBOX_REDACTED_COLUMNS` and `INQUIRY_PERSONAL_FIELDS`, so a field added to any
of those is redacted without anyone remembering this page. It is **atomic** --
a request and its outbox messages are redacted together or not at all, where
three separate `UPDATE`s at a prompt can leave a half-done removal if the
connection drops between them. And it **needs no `sqlite3`**: it runs on
`node:sqlite`, the same thing the server runs on, so it cannot fail the way
three procedures in this document once failed when that package was missing
from the image.

**This is a deliberate, authorised exception to R27 ("nothing is deleted"),
not a violation of it -- read closely, they say different things.** R27
governs the *row*: a request or quote is never deleted, through every state
including cancelled, and this procedure does not delete one either. What it
blanks is a handful of columns inside a row that stays. `docs/data-policy.md`
draws exactly this line -- "redaction, not deletion" -- and its own header
says the policy behind it was decided by the lead under the user's standing
direction, with the user holding veto; `/privacy` making this promise in
production is that authorisation already exercised, not something this
procedure grants itself. If a future reader still sees a contradiction
between R27 and this section, that reading is worth a ruling from the PM or
the lead rather than either DB ADMIN or DEV OPS deciding it in a doc.

**What gets blanked:** `requests.payload`'s `customerName`, `customerEmail`,
`customerPhone`, `location`, `locationNotes` and `customerNotes` (t64, "anything
else I should know?" -- free text, and the field most likely to hold the
actual thing someone wants gone) (`REQUEST_PERSONAL_DATA_KEYS` in
`backend/quotes.mjs`); `outbox`'s `to_address`, `to_name` and `error`
(`OUTBOX_REDACTED_COLUMNS` in `backend/outbox.mjs`), and inside its `data` the
same six personal keys (`OUTBOX_PERSONAL_DATA_KEYS` in `backend/outbox.mjs`);
`inquiries`' `name` and `contact` (`INQUIRY_PERSONAL_FIELDS` in
`backend/inquiries.mjs`); and **`quotes.reason`**, the free text a rejection
or cancellation carries.

Two of those are newer than the rest and worth a line each, because both were
found by the completeness audit in `.forge/personal-data-removal.md` rather
than by anyone designing the list. **`outbox.error`** holds whatever the mail
provider said when a send failed, and SMTP rejections conventionally name the
mailbox -- it is unbounded text from a system KMT does not control, written
into a row a removal is meant to clear. **`quotes.reason`** is free text
written by the owner *and* by the customer through the public cancel endpoint,
which makes it the field someone walking away is most likely to type a new
phone number into. Redacting it costs the ledger nothing: the decision --
status, version, total, line items, timestamps -- is what the record is, and
the prose attached to that decision is not.

**What survives, on every table, and must not be touched:** the quote ledger
-- status, version, total, line items, both timestamps (`reason` is the one
field on `quotes` that is redacted, for the reason given above; everything
else on the row stays, and the proof that the owner approved a quote is
untouched by any removal); on
`requests`, `vehicleInfo`, `tireSelection`, `quantity`, `date`, `locationType`
and `serviceZip`; on `outbox`, `type`, `template_version`, the business fields
inside `data` (tire, size, quantity, price, the request id), `status`,
`provider_id`; on `inquiries`, `vehicle_info` and `message`. These are the
ledger and the business record this policy exists to keep, not contact
information -- see "What redaction does not touch, and why" in
`docs/data-policy.md`.

**Never touch `requests.customer_key`.** It is what lets the customer's own
device still see their history at `/status`; redacting contact information
and revoking device access are two different asks, and this call was only
one of them.

**The marker is the literal string `[redacted]`,** written into every blanked
field, not an empty string and not a deleted key -- so a reader can tell "this
was removed" apart from "this was never collected," which is exactly what
`docs/data-policy.md` asks for and does not itself pick a value for. It is now
picked in one place -- `REDACTED` in `backend/redaction.mjs`, which the command
uses and a test pins -- so a row fixed by hand at this prompt and a row
redacted by the command are indistinguishable afterward, which is what this
paragraph previously could only ask for.

**Everything from here to the end of this step is the fallback**, for when the
command will not run. It is hand-copied from the constant lists and will drift
from them; check it against `backend/redaction.mjs` before trusting it, and
it now includes a statement for `quotes.reason` that earlier versions did not
have, because that field was not in the removal set until #286.

```bash
flyctl ssh console -a kmt -C "sqlite3 /data/owner.sqlite \"UPDATE requests SET payload = json_set(payload, '\$.customerName','[redacted]', '\$.customerEmail','[redacted]', '\$.customerPhone','[redacted]', '\$.location','[redacted]', '\$.locationNotes','[redacted]', '\$.customerNotes','[redacted]'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='<request-id>';\""
```

Then `outbox`, in the same visit -- every message mail.mjs recorded for this
request carries the same six personal keys inside `data` that the request's
own payload does (`backend/mail-templates.mjs`'s `baseData()` writes them
under those exact names, matching `OUTBOX_PERSONAL_DATA_KEYS`), so this is
not optional once `mail.mjs` has sent anything about the request:

```bash
flyctl ssh console -a kmt -C "sqlite3 /data/owner.sqlite \"UPDATE outbox SET to_address='[redacted]', to_name='[redacted]', error='[redacted]', data = json_set(data, '\$.to_name','[redacted]', '\$.to_email','[redacted]', '\$.customerPhone','[redacted]', '\$.location','[redacted]', '\$.locationNotes','[redacted]', '\$.customerNotes','[redacted]'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id='<request-id>';\""
```

Then the quote's reason text, which lives on `quotes` rather than on the
request and so needs its own statement (added with #286; free text the owner
or the customer typed, not part of the ledger):

```bash
flyctl ssh console -a kmt -C "sqlite3 /data/owner.sqlite \"UPDATE quotes SET reason='[redacted]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id='<request-id>' AND reason IS NOT NULL;\""
```

And for an inquiry, by its own id:

```bash
flyctl ssh console -a kmt -C "sqlite3 /data/owner.sqlite \"UPDATE inquiries SET name='[redacted]', contact='[redacted]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='<inquiry-id>';\""
```

**Idempotent by construction.** `json_set` writing the same literal twice, or
a plain `UPDATE ... = '[redacted]'` run twice, changes nothing the second
time -- running this whole section again on a request already handled is safe,
which matters if you are not sure whether last month's call was ever acted on.

### 3. Verify

Read the row back -- the same `SELECT`s as step 1 -- and confirm all six
personal fields (`customerNotes` included) now read `[redacted]` and nothing
else moved: the quote's status, the outbox row's `type`, the inquiry's
`vehicle_info`, all unchanged.

**Then check the customer's own access paths, not only the table.** The
request is reachable by its 128-bit id at `GET /api/requests/<request-id>`
and by the per-browser key at `/status` -- a row whose columns are blanked in
`sqlite3` but which still answers with the old name over the API has not been
removed from the one point of view that actually matters. If you have the id:

```bash
curl -s https://kensmobiletire.com/api/requests/<request-id>
```

The shaped response must no longer carry the real name, email, phone or
location. Checking the table alone would not have caught a redaction that
missed the row the public API actually reads.

Then pull a copy off the machine (the same `.backup` and `sftp get` as "The
monthly copy that leaves Fly," above) and run the read-only checker against
it, from your own machine, the same way the restore drill's own
integrity-check step does (see "The restore drill," above):

```bash
node .forge/restore-integrity-check.mjs /path/to/owner-backup.sqlite
```

A hand-edited database is exactly the case that checker exists for -- a typo
in a `WHERE` clause, a quoted value that did not close the way it looked like
it would, or a request whose `outbox` rows were missed is a mistake it
catches, not one it prevents. Read its own output for what passed; a database
that predates the `outbox` or `inquiries` tables reads as such on its own
terms and is not evidence this procedure went wrong. Delete the local copy
once you have read the result, the same as after any other backup.

### What "removed" actually means here

**Blanking a column does not erase the old bytes from the file.** SQLite
writes the new value elsewhere on disk and leaves the previous one in
freelist pages until something reuses them; the WAL holds the prior version
too, until it is checkpointed. Your `UPDATE` reporting success means the app
can no longer reach the name and address through any query -- it does not
mean those bytes are gone from `/data/owner.sqlite`. If someone asks precisely
what "removed" means, the honest answer is **no longer reachable by the app,
today** -- not **erased from the file, today**.

**`VACUUM` is what actually reclaims those pages**, rewriting the database
without them. It is not part of this procedure by default, because it is not
free: it needs roughly the size of the database again in free space, holds an
exclusive lock for the duration, and on a live file that duration is real
time, not instant. Whether it is worth running right after a removal, or
batched for a quiet moment, is a judgement call -- but it is the tool for
"gone from the file," and this procedure does not reach that state on its
own.

```bash
flyctl ssh console -a kmt -C "sqlite3 /data/owner.sqlite \"VACUUM;\""
```

**And every snapshot or off-Fly copy taken before this was run still holds
the original bytes, in full**, until it ages out on its own schedule -- five
days for a Fly snapshot, whenever it is next replaced for a monthly copy
someone kept encrypted. Neither an `UPDATE` nor a `VACUUM` against the live
volume reaches back into a copy that already existed before the call came in.

**Mail already sent** is the fourth boundary, and it is live now, not
hypothetical: `mail.mjs` (#206) sends on submit, on quote-sent, and on
payment. Once a message has actually left for the customer's own inbox --
`status = 'sent'` on its outbox row, or check whether `KMT_MAIL_SMTP_HOST`
is configured at all, since with no provider configured every row stays
`queued` and never really left -- this procedure can redact KMT's record of
having sent it; it cannot recall the message itself.

Say all of this on the call if it comes up, in the terms above: reachable
today, gone from the file only after a `VACUUM`, and out of every backup only
once each ages out on its own schedule. That is the honest shape of the
promise `/privacy` makes, not a weaker one than it sounds, but not a stronger
one either.

## When it breaks

**The site is down.** Read `flyctl status -a kmt` first: a machine that will not
start is a different problem from a machine serving errors. If it will not start
and a secret was changed recently, read the boot output -- `KMT_OWNER_PASSWORD`
too short and the canonical-host contradiction both refuse to start and say so
by name. If it is running and serving errors, `flyctl logs -a kmt`.

**The machine reports unhealthy but the site works.** The health check reads
`/api/health`, which asks SQLite a question. If the site serves pages and health
fails, suspect the database rather than the web layer -- and check whether a
supplier import is running: the import blocks the event loop for longer than the
check's timeout, which is a known false alarm rather than a sick machine (see
`fly.toml`).

**A deploy went out and the site is wrong.** Roll back to the previous release
rather than fixing forward under pressure. The image gate in CI means a deploy
that could not boot should never have reached production, so a bad deploy that
did is worth understanding afterwards -- but afterwards.

**The database is corrupt, or data is missing.** Stop writing to it. Take a
snapshot immediately -- even of the damaged file, because it is evidence and
because the five-day window is running. Then restore to a new volume by the
drill above and compare, rather than repairing the live file in place.

**The supplier is blocking the scraper.** Not an outage. The catalogue in the
database is what customers see and it does not go away when a scrape fails; see
`docs/supplier-refresh.md`.

**A CI job failed and its log is gone.** `gh run view --log` returns `log not
found` once a log has aged out or while a re-run is in flight. That is the
absence of one instrument, not the absence of an answer -- the jobs API still
holds each step's outcome:

```bash
gh api "repos/ei7hty/kmt/actions/runs/<run-id>/jobs" \
  --jq '.jobs[] | select(.conclusion=="failure") | {name, steps_run: (.steps|length), failed: [.steps[]|select(.conclusion=="failure")|.name]}'
```

**Read `steps_run` first.** An empty steps array means the job failed before
running anything -- a runner that never started -- and nothing in the job body
can be responsible. A named failed step means the opposite. Those are different
diagnoses and only one of them is ours, and distinguishing them costs one call
rather than an evening of pattern-matching across runs.

Three failures on 2026-09-06 looked like one story and were three: a job with
zero steps (infrastructure), a verify job timing out at step 11 on a deploy that
had actually succeeded (a real defect, since fixed), and both monitor jobs firing
correctly during the restore drill's rogue machine. Only the middle one needed a
change.

**In every case, before acting: take a snapshot.** It costs seconds and
kilobytes, and it is the difference between one problem and two.

---

# The domain's mail records

**This section was rewritten on 2026-09-06 against a fresh authoritative
measurement, because the version before it described a zone that no longer
existed and its deletion steps had become dangerous.** An earlier revision told
the reader to delete "the junk apex TXT" and "the `rsend` CNAME". Both
descriptions have since stopped matching reality: the junk TXT is gone, the apex
TXT now holds something that must be kept, and the Resend records have been
completed into working ones. **Do not act on any deletion instruction in an
older copy of this file.**

That is the general hazard with a runbook about live DNS: it ages into a
weapon. Every table below carries the time it was measured, and the first step
of using it is re-measuring.

## Measure before you touch anything

```powershell
$ns = 'ns-cloud-a1.googledomains.com'
Resolve-DnsName -Name kensmobiletire.com                   -Type MX    -Server $ns
Resolve-DnsName -Name kensmobiletire.com                   -Type TXT   -Server $ns
Resolve-DnsName -Name google._domainkey.kensmobiletire.com -Type TXT   -Server $ns
Resolve-DnsName -Name resend._domainkey.kensmobiletire.com -Type TXT   -Server $ns
Resolve-DnsName -Name rsend.kensmobiletire.com             -Type CNAME -Server $ns
```

**`Resolve-DnsName`, never `dig`.** `dig` is not installed on this machine and
prints nothing rather than failing, so its silence is indistinguishable from a
record that does not exist. On this question that mistake sends someone to
repair a zone that was fine, or to declare a broken one healthy. Ask the
authoritative server, never a public cache: resolvers answer with stale good
records for hours after a zone is wrong, and stale bad ones after it is right.

## What is in the zone, measured 2026-09-06

| record | name | state |
| --- | --- | --- |
| MX | `kensmobiletire.com` | five `aspmx` hosts (1 / 5 / 5 / 10 / 10) — **correct, inbound mail works** |
| TXT | `kensmobiletire.com` | `google-site-verification=...` — **correct, and must not be deleted** |
| TXT | `google._domainkey` | **absent — Google DKIM is not published** |
| TXT | `resend._domainkey` | a real DKIM key (`p=MIGf...`) — **live and valid** |
| CNAME | `rsend` | `rsend.forge.rmta.net` — **live and valid** |
| A | `kensmobiletire.com` | `66.241.124.248` — the site, and the mail domain's address record |
| CNAME | `www` | `kmt.fly.dev` — the site |

**There is no SPF record.** The apex TXT is a Google *site verification* string,
not an SPF policy. It is easy to glance at a TXT record at the apex and conclude
SPF is handled; it is not.

## What must not be deleted, and why

**The apex TXT (`google-site-verification=...`).** This is how Google proves the
domain belongs to this Workspace tenant. Removing it can un-verify the domain
and take Workspace mail with it. An older revision of this section described an
apex TXT as junk to delete — that junk record is gone, and this one is not it.
**Delete a TXT record by matching its value, never by its position or by "the
TXT at the apex".**

**The five MX records.** They are why mail is delivered at all.

**The apex `A` record.** It serves the website *and* is the mail domain's
address record. Replacing it with a CNAME would break mail permanently: a CNAME
at the apex cannot coexist with MX.

**`resend._domainkey` and the `rsend` CNAME.** These are now complete, working
Resend records — a published DKIM key and its sending CNAME. They were incomplete
when an earlier revision called them leftovers. **Deleting them breaks Resend
sending.**

## The open question, which is the user's and not an agent's

Resend was said to be cancelled on 2026-09-06, and the zone now contains
correctly configured Resend records. Those two facts disagree, and the
disagreement is not for an agent to resolve by deleting something.

- If Resend **is** cancelled, its two records are inert and may be removed —
  after the user confirms, and after checking that nothing is configured to send
  through it (`KMT_MAIL_SMTP_HOST` and friends; `flyctl secrets list -a kmt`).
- If Resend **is** in use, they are load-bearing and deleting them stops mail.

Either way, removal is a step to take deliberately once, not a tidy-up bundled
into a repair.

## What is actually still missing

**1. SPF, at the apex.** One TXT record beginning `v=spf1`, authorising whoever
sends for this domain. Take the `include:` from the provider's own
documentation.

**Add it beside the verification record; do not replace it.** A name may carry
many TXT records, and the apex already carries one. What a domain may only have
*one* of is an **SPF** record specifically — two `v=spf1` records fail every
sender. Those are different rules and conflating them is how the verification
record gets overwritten.

**2. Google DKIM, at `google._domainkey`.** Generated in the Workspace admin
console, which produces the TXT record to add. Not automatic, and easy to skip
because nothing visibly breaks without it: unsigned mail is simply more likely
to be filtered, which looks like customers ignoring you rather than a fault.

**No values are written in this document, deliberately.** They are
tenant-specific and come from the Workspace admin console or the provider's
dashboard at the time. A wrong value here is worse than a missing one.

## Proving it

Re-run the measurement block above. Then prove it with mail rather than with
DNS, because DNS answering correctly is the precondition and not the result:

- send a message **to** an `@kensmobiletire.com` address from an outside account
  and confirm it arrives;
- send one **from** the domain to an address on another provider and read the
  received message's `Authentication-Results` header. `spf=pass` and `dkim=pass`
  is the proof. A dashboard reporting "verified" is a provider agreeing with
  itself.

**Do not send bulk mail from the domain until SPF and DKIM are both correct.**
Early unauthenticated mail is what teaches spam filters to distrust a new
sending domain, and that reputation is slow to undo.

## What the app depends on

Nothing here affects the website. The app reads no DNS and its records — the
apex `A`, and the `www` and `order` CNAMEs — are not touched by any step above.
