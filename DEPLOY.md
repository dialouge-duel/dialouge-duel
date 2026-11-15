# Deploying Dialogue Duel

Camera recording only works over https, so deploy to a host that gives you a TLS certificate. Keep one running instance with a persistent disk, because videos and `db.json` are stored on disk.

## Option A: Render (easiest, no command line)

1. Push this folder to a GitHub repository.
2. In Render, choose New > Blueprint and select the repository. It reads `render.yaml`.
3. When asked, paste your `RESEND_API_KEY` and `MAIL_FROM` (email sign-in) and, optionally, your `ANTHROPIC_API_KEY` (AI scene scoring). See "Sign-in setup" below.
4. Deploy. Render gives you an `https://...onrender.com` address. The persistent disk needs a paid plan.
5. Open Render's Environment tab and copy the generated `ADMIN_TOKEN`. You need it to remove clips.

## Option B: Fly.io (has a Mumbai region)

    fly launch --no-deploy --copy-config
    fly volumes create data --size 10 --region bom
    fly secrets set RESEND_API_KEY=re_... MAIL_FROM="Dialogue Duel <login@yourdomain.com>" ANTHROPIC_API_KEY=sk-ant-... ADMIN_TOKEN=$(openssl rand -hex 16)
    fly deploy

## Option C: Any VPS with Docker

    docker build -t dialogue-duel .
    docker run -d --restart unless-stopped -p 3000:3000 -v dd-data:/data \
      -e AUTH_METHODS=email -e RESEND_API_KEY=re_... -e MAIL_FROM="Dialogue Duel <login@yourdomain.com>" \
      -e ANTHROPIC_API_KEY=sk-ant-... -e ADMIN_TOKEN=change-me dialogue-duel

Put Caddy or nginx in front for https. A Caddyfile is two lines:

    yourdomain.com {
      reverse_proxy localhost:3000
    }

Set the proxy's upload limit to at least 150 MB, because videos are sent as raw uploads.

## Sign-in setup

Users choose email or phone at sign-in. You turn on the methods you can send for, using `AUTH_METHODS`.

**Email (start here, it is quick)**
1. Make a free account at resend.com and verify your sending domain.
2. Set `RESEND_API_KEY` and `MAIL_FROM` (an address on that domain).
3. Keep `AUTH_METHODS=email`.

**Phone (add when ready)**
1. Make a Twilio account and buy or verify a sending number, or create a Messaging Service.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`).
3. Set `AUTH_METHODS=email,phone`.
4. Sending SMS to Indian numbers needs sender and template registration under India's telecom (DLT) rules. Start this early, because approval can take days, and until it is approved texts to Indian numbers may not arrive. Twilio's India SMS guide explains the steps.
5. SMS costs money per message. `SMS_DAILY_CAP` (default 500) stops abuse from running up your bill.

If a method is on but its keys are missing, the server prints a warning at startup and codes only appear in the server log, so real users cannot sign in with it.

## After it is live

- Visit `/healthz`. It should return `{"ok":true}`.
- Record a take on your phone to confirm the camera works over https.
- Back up the `/data` volume. It holds everything.
- Remove a clip: `curl -X DELETE https://yourdomain.com/api/clips/<id> -H "x-admin-token: <ADMIN_TOKEN>"`.

## Before you invite the public

- Publish a contact address for takedown requests and respond to them quickly. Rights holders can and will ask for movie clips to be removed.
- Sign-in is in place (one account per email or number), but a determined person can still use several numbers. Do not give out real prizes on scores alone.
- Decide whether credits can ever turn into money or prizes. In India, contests with prizes can fall under online gaming and promotion rules, so get advice first.
- Move to Postgres and object storage once you pass a few hundred active users.
