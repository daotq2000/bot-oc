# Database Tunneling (SSH Tunnel) Guide

This guide shows how to securely connect from your local machine to the remote MySQL on the server using an SSH tunnel (no public exposure of MySQL).

## 1) Requirements
- SSH access to server (key file, e.g., `~/Downloads/bot.pem`).
- MySQL server running on the remote host (listening on 127.0.0.1:3306).
- MySQL client installed locally (Ubuntu: `sudo apt-get install mysql-client`, macOS: `brew install mysql-client`).

## 2) Open SSH tunnel (local 3307 -> remote 127.0.0.1:3306)
```bash
ssh -i ~/Downloads/bot.pem \
  -o StrictHostKeyChecking=accept-new \
  -N -L 3307:127.0.0.1:3306 \
  ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com -f
```

Verify the tunnel is listening locally:
```bash
lsof -iTCP:3307 -sTCP:LISTEN -n -P
```

## 3) Create dedicated MySQL user (on server) – recommended
```bash
cat > /tmp/create_botoc.sql <<'SQL'
CREATE DATABASE IF NOT EXISTS bot_oc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'botoc'@'localhost' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';
CREATE USER IF NOT EXISTS 'botoc'@'127.0.0.1' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';
GRANT ALL PRIVILEGES ON bot_oc.* TO 'botoc'@'localhost';
GRANT ALL PRIVILEGES ON bot_oc.* TO 'botoc'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

sudo mysql -u root -p < /tmp/create_botoc.sql
```

Notes:
- Use a long random password. Do not commit it to Git.
- You can later restrict privileges (e.g., read-only) if needed.

## 4) Test connection from local
```bash
mysql -h 127.0.0.1 -P 3307 -u botoc -p \
  -e "SELECT @@version AS mysql_version, @@hostname AS remote_host; SHOW DATABASES LIKE 'bot_oc';"
```

## 5) Configure the app (.env)
```
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=botoc
DB_PASSWORD=<STRONG_RANDOM_PASSWORD>
DB_NAME=bot_oc
```

## 6) Use with GUI tools (DBeaver / TablePlus / Workbench)
- Host: 127.0.0.1
- Port: 3307
- User: botoc
- Password: <STRONG_RANDOM_PASSWORD>
- Database: bot_oc
- SSL: Not required (traffic is inside SSH tunnel)

## 7) Manage the tunnel
- Re-open:
```bash
ssh -i ~/Downloads/bot.pem -o StrictHostKeyChecking=accept-new -N -L 3307:127.0.0.1:3306 ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com -f
```
- Check status:
```bash
lsof -iTCP:3307 -sTCP:LISTEN -n -P
```
- Close:
```bash
pkill -f "ssh .* -L 3307:127.0.0.1:3306"
```

### Optional: Persistent tunnel with autossh + systemd (local machine)
1) Install autossh: Ubuntu `sudo apt-get install autossh`, macOS `brew install autossh`.
2) Create `~/.config/systemd/user/db-tunnel.service`:
```ini
[Unit]
Description=SSH Tunnel to Remote MySQL
After=network-online.target

[Service]
ExecStart=/usr/bin/autossh -M 0 -N -L 3307:127.0.0.1:3306 ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com -i ~/Downloads/bot.pem -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```
3) Enable & start:
```bash
systemctl --user daemon-reload
systemctl --user enable db-tunnel
systemctl --user start db-tunnel
systemctl --user status db-tunnel
```

## 8) Security best practices
- Do NOT expose MySQL publicly; bind it to 127.0.0.1 on the server.
- Use dedicated DB users with strong passwords; rotate regularly.
- Keep secrets out of Git (use .env or secret manager).
- Restrict SSH access by IP where possible (security groups/firewall).
- Protect your SSH private key (chmod 600).

## 9) Troubleshooting
- Access denied for user 'root'@'localhost': use the dedicated `botoc` user and ensure grants exist for 'localhost' and '127.0.0.1'.
- Can't connect to 127.0.0.1:3307: tunnel may be down; re-open and verify with `lsof`.
- Port already in use: pick another port (e.g., 3308) and update .env.
- Publickey denied: check key path and permissions (`chmod 600 ~/Downloads/bot.pem`).
