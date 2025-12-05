# DATABASE TUNNEL GUIDE (MySQL over SSH)

This document explains how to securely connect from your local machine to the MySQL server running on a remote Linux server (EC2) using an SSH tunnel. This avoids exposing MySQL (port 3306) to the public internet.

## When to use
- You need to query/inspect the remote database from your laptop or a GUI client (DBeaver, TablePlus, Workbench).
- You want to run migrations or import/export data safely without opening MySQL to the world.

## Prerequisites
- SSH access to the server using a key (PEM): `bot.pem`
- The server runs MySQL and is reachable via SSH (port 22 allowed in Security Group)
- Your local machine has the MySQL client (`mysql`) installed

## Notation used in examples
- SSH user/host: `ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com`
- Remote MySQL port: `3306` (default)
- Local tunnel port: `3307` (can be any free local port)
- Example DB name: `bot_oc`
- Example app user (on server MySQL): `botoc`

Replace values with your real ones as needed.

---

## 1) Open the SSH tunnel

One-shot foreground (good for testing):

```bash
ssh -i ~/Downloads/bot.pem -o StrictHostKeyChecking=accept-new \
    -L 3307:127.0.0.1:3306 \
    ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com
```

Background (recommended for day-to-day use):

```bash
ssh -i ~/Downloads/bot.pem -o StrictHostKeyChecking=accept-new \
    -N -L 3307:127.0.0.1:3306 \
    ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com -f
```

Verify the tunnel is listening locally:

```bash
lsof -iTCP:3307 -sTCP:LISTEN -n -P
```

Close the tunnel (if needed):

```bash
pkill -f "ssh .* -L 3307:127.0.0.1:3306"
```

---

## 2) Test the connection via tunnel

Using the MySQL CLI from your local machine:

```bash
mysql -h 127.0.0.1 -P 3307 -u <USER> -p -e "SELECT @@version, @@hostname;"
```

Notes:
- If `root` is configured with `auth_socket` or limited host patterns, you may see `Access denied for user 'root'@'localhost'`. In that case, create a dedicated user for tunnel access (see below).

---

## 3) Create a dedicated MySQL user for tunnel access (on the server)

Login to the server and run:

```bash
sudo mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS bot_oc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Create users bound to local/loopback only
CREATE USER IF NOT EXISTS 'botoc'@'localhost' IDENTIFIED BY '<STRONG_PASSWORD>';
CREATE USER IF NOT EXISTS 'botoc'@'127.0.0.1' IDENTIFIED BY '<STRONG_PASSWORD>';
-- Grant privileges for the application (adjust as needed)
GRANT ALL PRIVILEGES ON bot_oc.* TO 'botoc'@'localhost';
GRANT ALL PRIVILEGES ON bot_oc.* TO 'botoc'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

Security tips:
- Use a strong password and DO NOT commit it to Git.
- You can replace `ALL PRIVILEGES` with a more restrictive set if the app does not need DDL permissions.

---

## 4) Configure the app locally to use the tunnel

Edit `.env` in your project on the local machine:

```bash
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=botoc
DB_PASSWORD=<STRONG_PASSWORD>
DB_NAME=bot_oc
```

The app (using `src/config/database.js`) will read these values to connect through the tunnel.

---

## 5) Use the tunnel in GUI tools

- Host: `127.0.0.1`
- Port: `3307`
- User: `botoc`
- Password: `<STRONG_PASSWORD>`
- Database: `bot_oc`
- SSL: not required (the SSH tunnel already encrypts the connection)

---

## 6) Optional: Make the tunnel persistent

Using `autossh` (restarts the tunnel if it drops):

```bash
# Install autossh if needed
# macOS: brew install autossh
# Ubuntu: sudo apt-get install autossh

AUTOSSH_GATETIME=0 autossh \
  -i ~/Downloads/bot.pem -M 0 \
  -N -L 3307:127.0.0.1:3306 \
  ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com -f
```

Using a systemd user service (Linux):

```ini
# ~/.config/systemd/user/mysql-tunnel.service
[Unit]
Description=SSH Tunnel to Remote MySQL
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -i %h/Downloads/bot.pem -N -L 3307:127.0.0.1:3306 ubuntu@ec2-18-143-194-141.ap-southeast-1.compute.amazonaws.com
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now mysql-tunnel.service
```

---

## 7) Troubleshooting

- Access denied for 'root'@'localhost':
  - Root may be using `auth_socket` or restricted host patterns. Use a dedicated user like `botoc` bound to `localhost`/`127.0.0.1`.

- Connection refused on 127.0.0.1:3307:
  - The tunnel isn’t running. Start it again or check for port conflicts.

- Hanging connection / timeouts:
  - Verify the server Security Group allows SSH (22). MySQL (3306) does NOT need to be exposed.
  - Ensure MySQL is running on the server: `systemctl status mysql`.

- GUI client tries UNIX socket instead of TCP:
  - Always specify host as `127.0.0.1` (not `localhost`) and the custom port `3307`.

---

## Appendix A – Import filtered data over the tunnel

If you have a large dump but want to import only selected tables’ data and keep other tables’ schema only (e.g., no data for `candles`):

1) Prepare a filtered SQL on your local machine (remove `INSERT` lines for `candles`):

```bash
# Remove only the data lines for candles
grep -Fv "INSERT INTO \`candles\` " data.sql > data_filtered.sql
```

2) Import over the tunnel:

```bash
# Recreate the database (CAUTION: destructive)
mysql -h 127.0.0.1 -P 3307 -u botoc -p -e \
  "DROP DATABASE IF EXISTS bot_oc; CREATE DATABASE bot_oc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Import the filtered dump
mysql -h 127.0.0.1 -P 3307 -u botoc -p bot_oc < data_filtered.sql
```

This keeps the `candles` schema (table and indexes) but with zero rows, while importing data for other tables.

---

## Security reminders
- Never commit credentials or dumps into Git.
- Keep the SSH key (`bot.pem`) protected (0600 permissions).
- Do not open MySQL (3306) to the internet; use SSH tunneling instead.

