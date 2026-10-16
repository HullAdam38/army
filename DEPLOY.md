# Deploying EliteForces

Step by step for **Ubuntu 22.04** and **eliteforces.com**, with the code in **`/var/www/html`**. It takes about 15 minutes. The scripts are in [`deploy/`](deploy).

## What you end up with

- The game is pulled from GitHub into `/var/www/html` and runs as a background service (`eliteforces`) that starts on boot and restarts if it crashes.
- nginx sits in front with free HTTPS from Let's Encrypt, which renews itself. `www.eliteforces.com` redirects to `https://eliteforces.com`.
- The database lives in `/var/lib/eliteforces`, settings and secrets in `/etc/eliteforces`, and backups run every night to `/var/backups/eliteforces` (kept for 14 days).
- A firewall allows only SSH, HTTP and HTTPS.

> **Why nothing is served straight from `/var/www/html`:** Ubuntu's default nginx site serves that folder as plain files, which would let anyone download the code, its git history and the database. The setup turns the default site off and sends every request to the game instead. That's also why the database and secrets live in other folders.

## Before you start

1. **A server** running Ubuntu 22.04 with at least 1 GB of RAM, and a user account that can use `sudo`. Log in as that user, not as root.
2. **DNS:** at your domain registrar, point both names at the server's IP address:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` (eliteforces.com) | your server's IPv4 address |
   | A | `www` | your server's IPv4 address |

   Add matching `AAAA` records too if the server has IPv6. DNS can take a few minutes to an hour to spread. HTTPS can only be set up once `ping eliteforces.com` answers from your server's IP.

## Step 1: log in and install git

```bash
ssh youruser@your-server-ip
sudo apt update && sudo apt install -y git
```

## Step 2: let the server read the GitHub repository

The repository is private, so the server needs a **deploy key**: a read-only key that works for this one repository.

```bash
ssh-keygen -t ed25519 -C "eliteforces-server" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy the line it prints. Then on GitHub:

1. Open **HullAdam38/army › Settings › Deploy keys › Add deploy key**.
2. Title it `eliteforces.com server`, paste the key, and **leave "Allow write access" unticked**.
3. Click **Add key**.

Check that it works (answer `yes` the first time):

```bash
ssh -T git@github.com
# "Hi HullAdam38/army! You've successfully authenticated…" means it works.
```

## Step 3: run the installer

The installer lives in the repository, so clone a copy into your home folder just to run it. The installer then puts the real copy in `/var/www/html`.

```bash
git clone --branch claude/determined-keller-i7bgjo git@github.com:HullAdam38/army.git ~/eliteforces-setup
sudo EMAIL=you@example.com bash ~/eliteforces-setup/deploy/install.sh
```

Use your real email for certificate expiry notices. It takes a few minutes, and when it's done it prints **"EliteForces is live at https://eliteforces.com"**.

If `/var/www/html` already has files in it (Ubuntu puts a placeholder page there), they're moved to `/var/www/html.before-eliteforces.<date>` rather than deleted.

The defaults match your setup, so you shouldn't need any settings. If you ever do, put them before `bash`:

| Setting | Default |
|---|---|
| `DOMAIN` | `eliteforces.com` |
| `APP_DIR` | `/var/www/html` |
| `BRANCH` | `claude/determined-keller-i7bgjo` (change to `main` if you merge into it) |
| `REPO` | `git@github.com:HullAdam38/army.git` |

After it finishes you can delete the setup copy: `rm -rf ~/eliteforces-setup`.

## Step 4: make yourself an admin

1. Open **https://eliteforces.com** and register your account.
2. Then on the server:

   ```bash
   sudo bash /var/www/html/deploy/admin.sh grant YourCallsign
   ```

3. Reload the site and you'll see the **Admin** link. Admin › Game settings is where you tune the economy, and New sign-ups lets you close registration while you test.

## Step 5: fill in your details for the Terms of Service

```bash
sudo nano /etc/eliteforces/eliteforces.env
```

Set `LEGAL_OPERATOR` (your name or company), `LEGAL_CONTACT_EMAIL` and `LEGAL_JURISDICTION`. Save with Ctrl+O, Enter, Ctrl+X, then restart:

```bash
sudo systemctl restart eliteforces
```

## Updating the game

When there's new code on GitHub, run this as the same user:

```bash
bash /var/www/html/deploy/update.sh
```

The script:
1. backs up the database;
2. pulls the latest code and lists what changed;
3. installs packages;
4. restarts the game and checks it came back up.

If the game doesn't come back, it prints the log and the exact command to return to the previous version.

## Everyday commands

| What | Command |
|---|---|
| Is it running? | `sudo systemctl status eliteforces` |
| Live log | `sudo journalctl -u eliteforces -f` |
| Restart | `sudo systemctl restart eliteforces` |
| Back up now | `sudo eliteforces-backup` |
| List backups | `ls -lh /var/backups/eliteforces` |
| Admins | `sudo bash /var/www/html/deploy/admin.sh list` |

## Restoring a backup

```bash
sudo systemctl stop eliteforces
gunzip -c /var/backups/eliteforces/eliteforces-YYYY-MM-DD-HHMM.db.gz | sudo tee /var/lib/eliteforces/eliteforces.db >/dev/null
sudo rm -f /var/lib/eliteforces/eliteforces.db-wal /var/lib/eliteforces/eliteforces.db-shm
sudo chown eliteforces:eliteforces /var/lib/eliteforces/eliteforces.db
sudo systemctl start eliteforces
```

Backups stay on the same server. For real safety, copy `/var/backups/eliteforces` somewhere else now and then, for example with your host's snapshot feature or by downloading it with `scp`.

## Troubleshooting

- **HTTPS failed during install.** DNS usually doesn't point at the server yet. Check with `ping eliteforces.com`, then run:
  `sudo certbot --nginx -d eliteforces.com -d www.eliteforces.com --redirect --agree-tos -m you@example.com`
- **Can't sign up or log in ("session expired"), or forms don't work.** The site has to be opened over **https://**. In production, login cookies are only sent over HTTPS, so plain http won't keep you signed in. Finish the HTTPS step above.
- **"Apache is running" during install.** Something else is using port 80. If Apache only shows the default page, run `sudo systemctl disable --now apache2` and run the installer again.
- **Clone failed during install.** The deploy key isn't set up yet (step 2). Check with `ssh -T git@github.com`.
- **The game won't start.** Read the log with `sudo journalctl -u eliteforces -n 50`. The installer and the update script both show it when something goes wrong.
- **502 Bad Gateway.** nginx is up but the game isn't. Run `sudo systemctl restart eliteforces`, then check the log.

## Where everything is

| Path | What |
|---|---|
| `/var/www/html` | the code (a git checkout, owned by your user) |
| `/var/lib/eliteforces/eliteforces.db` | the database (owned by the `eliteforces` system user) |
| `/etc/eliteforces/eliteforces.env` | settings and secrets, including the session secret |
| `/etc/systemd/system/eliteforces.service` | the service |
| `/etc/nginx/sites-available/eliteforces` | nginx site (certbot adds the HTTPS parts) |
| `/var/backups/eliteforces` | nightly backups |
| `/etc/cron.d/eliteforces-backup` | backup schedule (03:17 every night) |
