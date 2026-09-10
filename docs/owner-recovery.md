# If you cannot sign in to your own workspace

This is for one situation: **you go to sign in with Google and it will not let you
in.** Wrong account, an error page from Google, a warning about an unverified app,
or the button just does not work.

It is not your fault and nothing is broken on the site. Customers can still submit
requests the whole time this is happening. What you have lost is your own way in.

**This page gets you back in without waiting for anybody.**

---

## First, thirty seconds of checks

Before the real procedure, because these are common and quick:

1. **Are you signed into the right Google account?** If your browser is signed into
   a personal Gmail, the workspace will refuse it — it only accepts your
   `@kensmobiletire.com` account. Sign out of Google, or open a private window, and
   try again.
2. **Try a private/incognito window.** This clears a stale half-finished sign-in,
   which is the most common cause.
3. **Try your phone.** If your phone works and your computer does not, it is the
   computer, and you can keep working from the phone.

If none of those work, carry on.

---

## What you need

**A computer with `flyctl` installed and signed in to the Fly account that runs the
site.** That is the whole prerequisite.

> **If you do not have that, stop here and skip to [If you cannot do this
> yourself](#if-you-cannot-do-this-yourself).** There is no way to do this from a
> phone or from the website itself, and that is deliberate.

To check, open a terminal and run:

```bash
flyctl auth whoami
```

If it prints your email, you are ready. If it says you are not logged in, run
`flyctl auth login` first.

---

## The procedure

### Step 1 — get a key

Copy this line exactly and run it:

```bash
flyctl ssh console -a kmt -C "node /app/scripts/mint-session.mjs --quiet"
```

It prints one long line that starts with `kmt_owner=`. That is your key. It is good
for **12 hours** and then stops working, which is fine — you only need it once.

Copy the whole line, including the `kmt_owner=` part.

### Step 2 — open the site

Go to **https://kensmobiletire.com/owner** in your browser. You will see the
sign-in screen. Leave it open.

### Step 3 — put the key in

This is the fiddly part. You need your browser's developer console:

- **Chrome or Edge**: press `F12`, then click the **Console** tab.
- **Safari**: enable the Develop menu in Settings → Advanced, then
  Develop → Show JavaScript Console.
- **Firefox**: press `F12`, then click the **Console** tab.

You may see a red warning telling you not to paste things here. That warning is
there to protect you from scams. **You are pasting a key you just generated
yourself, from your own machine.** If somebody sent you the line below, or asked
you to run it, do not — close the window and call the number in your records.

Type or paste this, replacing `PASTE_KEY_HERE` with the whole line from Step 1:

```js
document.cookie = 'PASTE_KEY_HERE; path=/'
```

So it ends up looking like:

```js
document.cookie = 'kmt_owner=eyJ...long...string; path=/'
```

Press Enter.

### Step 4 — reload

Reload the page. **You should now be in your workspace**, looking at your
inventory or your quote requests, exactly as normal.

You can close the developer console. Everything works normally from here —
approving quotes, setting prices, marking jobs done.

---

## What to do next

**You are in, but Google sign-in is still broken.** The key expires in 12 hours,
so this is a way to keep working today, not a fix.

**Tell whoever maintains the site that Google sign-in is failing**, and say what
you saw — the exact error, or a photo of the screen. That is the information that
gets it fixed; without it, the problem has to be found from scratch.

If 12 hours runs out and it is still broken, run the procedure again. There is no
limit on how many times you can do this.

---

## Two things worth knowing

**Every decision you make this way is recorded as "break-glass", not as you.** The
site keeps a record of who approved each quote. A key made this way is honestly
recorded as an emergency session rather than as you personally, because the site
cannot prove it was you — only that it was somebody with access to the server. That
is the correct behaviour and nothing is wrong.

**This is not a back door.** Anyone who can run that command can already read and
change the database directly. It gives no power to anyone who does not already have
it — it just does the fiddly part correctly. That is why it exists as a command on
the server and **not** as a page on the website, and it must never become one.

---

## If you cannot do this yourself

If you do not have `flyctl`, or the command does not work, **you cannot recover on
your own and you will need whoever maintains the site.**

That is worth knowing in advance rather than discovering it on the day. If you want
to be able to do this yourself, the time to set up `flyctl` on your computer is
**now**, while everything is working — not when you are locked out.

Meanwhile, customers are unaffected. Requests keep arriving and are waiting for you
when you get back in. Nothing is lost.

---

## For whoever maintains the site

The procedure above is verified working against a server in the current production
shape — Google configured, `KMT_OWNER_PASSWORD` unset. Confirmed end to end:
`scripts/mint-session.mjs` runs, the cookie authenticates, `/owner` renders the
workspace, and an approval made under it records
`decidedBy: "owner:minted-session"` rather than a person.

`mint-session.mjs` requires `KMT_SESSION_SECRET` to match the running server, which
is why the command runs **inside** the machine via `flyctl ssh console` rather than
locally — the environment is already correct there. Running it locally against a
different secret produces a token that looks real and authenticates nothing.

**The script must never get an HTTP route**, under any condition, behind any flag.
Its entire safety argument is that reaching it requires machine access, which
already implies database access. A route removes that and makes it a second way in.
