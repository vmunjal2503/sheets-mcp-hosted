# Sheets MCP — Hosted

> Open-source MCP server that lets Claude (and any MCP host) read,
> write, and **format** your Google Sheets. One-click OAuth, no
> local install.

Built by [Digiboffins](https://digiboffins.com). MIT licensed.
Live at **https://sheets-mcp.digiboffins.com**.

## What this is

The [Model Context Protocol](https://modelcontextprotocol.io) lets LLM
hosts (Claude Code, Claude Desktop, Cursor, Continue.dev, Zed, custom
agents…) call external tools through a standard JSON-RPC protocol.

This service exposes **13 Google Sheets tools** to any MCP host over
the Streamable HTTP transport. A visitor authorizes the connector
with their Google account once, copies a one-line `claude mcp add`
command, and from then on can do things like:

- *"List my Sheets matching 'budget'"*
- *"Append a row to my expense tracker: today's date, groceries, 42.50"*
- *"Beautify the Q3 roadmap tab — autofit columns, bold + freeze header, wrap text on A2:G100"*
- *"Share this sheet with priya@example.com as a commenter"*

## Architecture

```
Visitor ─┐
         │  1. visit https://sheets-mcp.digiboffins.com
         │  2. click "Connect with Google"
         │  3. Google consent → callback
         ↓
   [ Express + Mongoose on EC2 ]
         │
         ├─ encrypts refresh_token with AES-256-GCM
         ├─ mints { mcp_token, sha256_hash } pair
         └─ shows install snippet with the plaintext mcp_token

         ↓  (later)

  Claude/Cursor/… ──── POST /mcp ────►  Express
                                        │
                                        ├─ verify Bearer token (sha256 lookup)
                                        ├─ decrypt the row's google refresh_token
                                        ├─ build per-request OAuth2 client
                                        └─ Google Sheets / Drive APIs
```

## Self-host (optional)

You don't need to self-host — the hosted version at
`sheets-mcp.digiboffins.com` works for everyone. But if you'd rather
own the data plane, fork this repo and:

### 1. MongoDB Atlas (free M0)

- Create cluster → DB user with read/write
- IP allowlist: your EC2's public IP (or `0.0.0.0/0` for any-source)
- Copy the connection string

### 2. Google Cloud OAuth Web client

- Console → New project → enable **Google Sheets API** + **Google Drive API**
- OAuth consent screen: External, add your email as a test user
- Credentials → OAuth client ID → **Web application** (not Desktop)
- Authorized redirect URI: `https://YOUR_DOMAIN/auth/google/callback`
- Download JSON; keep client_id + client_secret

### 3. EC2 / VPS setup (one-time)

```bash
# As root or with sudo:
apt install -y nginx certbot python3-certbot-nginx
useradd -m mernapp
sudo -u mernapp bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
sudo -u mernapp -i bash -c '
  export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh
  nvm install 22 && nvm alias default 22
  npm i -g pm2
  mkdir -p ~/logs
'

# Clone + first build
sudo -u mernapp -i bash -c '
  cd ~
  git clone https://github.com/vmunjal2503/sheets-mcp-hosted.git
  cd sheets-mcp-hosted
  cp .env.example .env
  # … edit .env with Atlas URI, Google creds, TOKEN_ENCRYPTION_KEY …
  npm install && npm run build
  cp deploy/ecosystem.config.example.cjs deploy/ecosystem.config.cjs
  pm2 start deploy/ecosystem.config.cjs && pm2 save
'

# nginx vhost
cp deploy/nginx-sheets-mcp.example.conf /etc/nginx/sites-available/sheets-mcp.conf
# … edit server_name + proxy_pass port if changed …
ln -s /etc/nginx/sites-available/sheets-mcp.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d YOUR_DOMAIN
```

### 4. Subsequent deploys

```bash
sudo -u mernapp -i bash -c 'cd ~/sheets-mcp-hosted && ./deploy/deploy.sh'
```

## Generate the encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env` as `TOKEN_ENCRYPTION_KEY`. **Never commit this.** If
you ever rotate it, all existing tokens become unreadable and users
will need to reconnect.

## Use it from Claude Code

```bash
claude mcp add --transport http --scope user google-sheets \
  https://sheets-mcp.digiboffins.com/mcp \
  --header "Authorization: Bearer dbw_sheets_YOUR_TOKEN"
```

(Or just go to https://sheets-mcp.digiboffins.com and click
"Connect with Google" — it generates the exact command for you.)

Restart your Claude session and the 13 tools appear as
`mcp__google-sheets__*`.

## Tools

| Tool | Purpose |
|---|---|
| `list_sheets` | Drive search by spreadsheet name |
| `get_sheet_metadata` | Spreadsheet properties + tab list |
| `read_range` | Read A1 range |
| `write_range` | Overwrite A1 range |
| `append_rows` | Append rows to a tab |
| `format_header_row` | Bold + light-gray + freeze row 1 |
| `autofit_columns` | Fit columns to content |
| `freeze_rows` | Freeze top N rows |
| `wrap_text` | Enable wrap on a range |
| `set_background_color` | RGB tint a range |
| `add_sheet_tab` | New tab |
| `create_spreadsheet` | New empty spreadsheet |
| `share_with_email` | Grant Drive permission to an email |
| **`beautify`** | One-call combo: header + freeze + autofit + optional wrap |

## Security

- Google refresh tokens are encrypted with **AES-256-GCM** before
  being persisted. Key lives only in `process.env`, never in Mongo.
- MCP bearer tokens are stored as **sha256 hashes**. Plaintext is
  shown once on connect; not recoverable from the database.
- Each MCP request builds a fresh OAuth2 client, used once, discarded.
- No sheet data is ever stored on our side.

## License

[MIT](./LICENSE) — fork it, host it, change it.

## Built by

[Digiboffins](https://digiboffins.com) · we build MCP integrations
and AI agents for teams. If you need a hosted MCP for your custom
backend, get in touch.
