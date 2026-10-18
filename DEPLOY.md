# Deploying GeneralForces

Step by step for **Ubuntu 22.04** and **generalforces.com**, with the code in **`/var/www/html`**. It takes about 15 minutes. The scripts are in [`deploy/`](deploy).

## What you end up with

- The game is pulled from GitHub into `/var/www/html` and runs as a background service (`eliteforces`) that starts on boot and restarts if it crashes.
- nginx sits in front with free HTTPS from Let's Encrypt, which renews itself. `www.generalforces.com` redirects to `https://generalforces.com`.
- The database lives in `/var/lib/eliteforces`, settings and secrets in `/etc/eliteforces`, and backups run every night to `/var/backups/eliteforces` (kept for 14 days).
- A firewall allows only SSH, HTTP and HTTPS.

> **Why nothing is served straight from `/var/www/html`:** Ubuntu's default nginx site serves that folder as plain files, which would let anyone download the code, its git history and the database. The setup turns the default site off and sends every request to the game instead. That's also why the database and secrets live in other folders.

## Before you start

1. **A server** running Ubuntu 22.04 with at least 1 GB of RAM. You can log in as `root` or as a user who can use `sudo`. Logged in as root, the installer creates a normal user, `eliteadmin`, to own the code (so `git pull` never runs as root) and gives it the deploy key you make in step 2.
2. **DNS:** at your domain registrar, point both names at the server's IP address:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` (generalforces.com) | your server's IPv4 address |
   | A | `www` | your server's IPv4 address |

   Add matching `AAAA` records too if the server has IPv6. DNS can take a few minutes to an hour to spread. HTTPS can only be set up once `ping generalforces.com` answers from your server's IP.

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
2. Title it `generalforces.com server`, paste the key, and **leave "Allow write access" unticked**.
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

Use your real email for certificate expiry notices. It takes a few minutes, and when it's done it prints **"GeneralForces is live at https://generalforces.com"**.

If `/var/www/html` already has files in it (Ubuntu puts a placeholder page there), they're moved to `/var/www/html.before-eliteforces.<date>` rather than deleted.

The defaults match your setup, so you shouldn't need any settings. If you ever do, put them before `bash`:

| Setting | Default |
|---|---|
| `DOMAIN` | `generalforces.com` |
| `APP_DIR` | `/var/www/html` |
| `BRANCH` | `claude/determined-keller-i7bgjo` (change to `main` if you merge into it) |
| `REPO` | `git@github.com:HullAdam38/army.git` |

After it finishes you can delete the setup copy: `rm -rf ~/eliteforces-setup`.

## Step 4: make yourself an admin

1. Open **https://generalforces.com** and register your account.
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

When there's new code on GitHub, run this as root or as a user who can use sudo:

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

Every night's backup is also **test-restored**: the copy is opened, checked for damage and its players counted. If anything's wrong, Admin › Launch checklist says so.

## Off-site backups

Backups on the game server are lost with the server. Set up an off-site copy once and every nightly backup is sent there too (kept 30 days):

1. Get somewhere to keep them. **Backblaze B2** is cheap and simple (the first 10 GB are free); Google Drive, Dropbox, OneDrive or any S3 storage work too.
2. On the server, connect it (rclone is installed by the update script; if not, `sudo apt install rclone`):

   ```bash
   sudo rclone config
   ```

   Choose `n` (new remote), give it a short name such as `b2`, pick your storage from the list and follow the questions. For Backblaze, make an application key in the Backblaze dashboard first and paste its key ID and key when asked.
3. Tell the backup where to put them: on **Admin › Server settings**, set *Off-site backup destination* to `b2:your-bucket-name/generalforces` (your remote's name, a colon, then a bucket and folder). Or on the server, set `BACKUP_REMOTE=` in `/etc/eliteforces/backup.env`.
4. Run a backup to check it works: `sudo eliteforces-backup`. It should end with "copied to b2:…", and Admin › Launch checklist shows the off-site copy as done.

To restore from an off-site copy, download it first (`sudo rclone copy b2:your-bucket-name/generalforces/eliteforces-YYYY-MM-DD-HHMM.db.gz /tmp/`), then follow "Restoring a backup" above with that file.

## Uptime monitoring

The game answers `https://generalforces.com/healthz` with `ok` while it and its database are working. Point a free monitor at it, such as [UptimeRobot](https://uptimerobot.com) or [Better Stack](https://betterstack.com/uptime) (HTTP check, every 5 minutes), so you get an email when the site goes down. Server errors are already reported to admins inside the game.

## Before launch

Admin › **Launch checklist** checks most of this for you: your details in the Terms of Service, a contact email on your domain, production mode, backups and their test restores, off-site copies, server errors and the sign-up limits. Fill in what it flags. Your Terms of Service details, the site address and the off-site backup destination can all be set on **Admin › Server settings**, without touching the server. Set the site address to `https://generalforces.com` so links shared on Discord or Reddit always use it.

## Using Cloudflare

If your domain's DNS is on Cloudflare with the orange cloud (proxied):

1. **In Cloudflare, go to SSL/TLS › Overview and choose "Full (strict)".** Your server has its own valid certificate. "Flexible" causes an endless redirect loop ("The page isn't redirecting properly").
2. **Real visitor IPs.** Behind Cloudflare, every request reaches your server from Cloudflare's addresses. Left alone, anti-cheat would see all players as linked accounts on one network, and login limits would lump everyone together. The installer detects Cloudflare and sets nginx to use the real visitor IP, but only for requests that genuinely come from Cloudflare's published ranges, so it can't be faked. A monthly job keeps that list up to date. To run it yourself:

   ```bash
   sudo eliteforces-cloudflare-realip
   ```

   (It's also at `deploy/cloudflare-realip.sh`.) Turned Cloudflare on after installing? Run that command once.

## Troubleshooting

- **HTTPS failed during install.** DNS usually doesn't point at the server yet. Check with `ping generalforces.com`, then run:
  `sudo certbot --nginx -d generalforces.com -d www.generalforces.com --redirect --agree-tos -m you@example.com`
- **Can't sign up or log in ("session expired"), or forms don't work.** The site has to be opened over **https://**. In production, login cookies are only sent over HTTPS, so plain http won't keep you signed in. Finish the HTTPS step above.
- **"Apache is running" during install.** Something else is using port 80. If Apache only shows the default page, run `sudo systemctl disable --now apache2` and run the installer again.
- **Clone failed during install.** The deploy key isn't set up yet (step 2). Check with `ssh -T git@github.com`.
- **The game won't start.** Read the log with `sudo journalctl -u eliteforces -n 50`. The installer and the update script both show it when something goes wrong.
- **"nginx.service is not active" or nginx won't start.** The installer now starts nginx itself and handles servers without IPv6. If something else holds port 80 or 443, it names it. To see why nginx failed: `sudo nginx -t` and `sudo journalctl -u nginx -n 20`.
- **"The page isn't redirecting properly" (too many redirects).** Almost always Cloudflare set to "Flexible" SSL. Change it to **Full (strict)** (see Using Cloudflare above).
- **Visiting the server's IP address sends you to the domain.** That's on purpose: the game is meant to be reached at https://generalforces.com, and login only works over HTTPS on the domain. To try the site before DNS is ready, add a line `YOUR.SERVER.IP generalforces.com` to your computer's hosts file (on Windows `C:\Windows\System32\drivers\etc\hosts`; on Mac or Linux `/etc/hosts`). If your browser keeps going to an old address, it has remembered an earlier redirect: try a private window or clear its cache.
- **502 Bad Gateway.** nginx is up but the game isn't. Run `sudo systemctl restart eliteforces`, then check the log.

## Where everything is

| Path | What |
|---|---|
| `/var/www/html` | the code (a git checkout, owned by your user, or `eliteadmin` if you installed as root) |
| `/var/lib/eliteforces/eliteforces.db` | the database (owned by the `eliteforces` system user) |
| `/etc/eliteforces/eliteforces.env` | settings and secrets, including the session secret |
| `/etc/systemd/system/eliteforces.service` | the service |
| `/etc/nginx/sites-available/eliteforces` | nginx site (certbot adds the HTTPS parts) |
| `/var/backups/eliteforces` | nightly backups |
| `/etc/cron.d/eliteforces-backup` | backup schedule (03:17 every night) |
| `/etc/eliteforces/backup.env` | off-site backup settings |
| `/var/lib/eliteforces/admin-settings.env` | settings saved on Admin › Server settings (override the settings file) |
| `/var/lib/eliteforces/backup-status.json` | the last backup's report (shown on Admin › Launch checklist) |
