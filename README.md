# db-access-mcp

MCP (Model Context Protocol) stdio server that gives AI agents (Claude Code, Claude
Desktop, any MCP client) access to configured databases:

- **PostgreSQL** (≥ 10)
- **MySQL** (≥ 5; read-only sessions require ≥ 5.6)
- **Amazon Redshift**
- **Microsoft SQL Server** (via [tedious](https://github.com/tediousjs/node-mssql))

with **SSH / AWS SSM tunnels**, pluggable **secret providers** (env vars, HashiCorp
Vault, AWS Secrets Manager) and strict **per-instance isolation** — many MCP
instances can run concurrently on one machine without sharing connections or
tunnels, and crashed instances never leave orphaned tunnel processes behind.

## Quick start

```jsonc
// Claude Code / Claude Desktop MCP config
{
  "mcpServers": {
    "db-access-mcp": {
      "command": "npx",
      "args": ["-y", "@rheopyrin/db-access-mcp"]
    }
  }
}
```

On first start the server creates the working directory `~/.db_acess_mcp`
(intentional spelling — it is the product contract) with an empty `config.json`, an
empty `conf.d/` directory and a full `config.example.json` covering every dialect,
secret provider and tunnel type. The export directory (default
`/tmp/db-access-mcp/exports`) is **not** created up front — `query_to_file` makes it
on demand on the first export. Edit `~/.db_acess_mcp/config.json`, restart the MCP
server, done.

## Integrating the MCP

The server speaks MCP over **stdio**: any client that can spawn
`npx -y @rheopyrin/db-access-mcp` (or `node <path>/dist/cli.js` for a local build) can use it.
Every spawned instance is fully isolated — its own pools, tunnels and idle timers —
so it is safe to register it in several clients/sessions at once.

### Claude Code

```bash
# current project only (writes .mcp.json in the project root)
claude mcp add db-access-mcp -- npx -y @rheopyrin/db-access-mcp

# for all your projects
claude mcp add --scope user db-access-mcp -- npx -y @rheopyrin/db-access-mcp

# with options (custom config dir, verbose logs, extra env file)
claude mcp add db-access-mcp -- npx -y @rheopyrin/db-access-mcp --workdir ~/.db_acess_mcp --log-level debug --env-file ~/.db_acess_mcp/secrets.env
```

Check with `/mcp` inside a session (server status, reconnect). Server stderr logs
land in `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-db-access-mcp/`
(macOS). After editing `config.json`, reconnect the server (`/mcp`) — the config
is read at startup only.

Or declare it in the project's `.mcp.json` directly:

```json
{
  "mcpServers": {
    "db-access-mcp": { "command": "npx", "args": ["-y", "@rheopyrin/db-access-mcp"] }
  }
}
```

### Claude Desktop

Add the same `mcpServers` block to the config file and restart the app:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor / other MCP clients

Any stdio-capable client works with the same shape — command `npx`,
args `["-y", "@rheopyrin/db-access-mcp"]` (Cursor: `~/.cursor/mcp.json`, same `mcpServers`
format). Two things to know:

- **stdout is the protocol** — if your client shows a JSON-RPC parse error, make
  sure nothing wraps the command with extra output; all server logs go to stderr.
- Pass CLI options via `args`, e.g.
  `["-y", "@rheopyrin/db-access-mcp", "--workdir", "/opt/mcp-db", "--log-level", "warn"]`.

### Local build (development)

```bash
git clone <repo> && cd db_access_mcp && npm ci && npm run build
claude mcp add db-access-mcp-dev -- node /abs/path/db_access_mcp/dist/cli.js --log-level debug
```

### Trying it without a client

```bash
npx -y @modelcontextprotocol/inspector npx -y @rheopyrin/db-access-mcp
```

opens a web UI listing all tools with call forms and live stderr. A sensible
first-session sequence: `dialect_list` → `connection_list` →
`connection_test` on one connection → `query`.

### Requirements on the host

- Node.js ≥ 20.19.
- For **ssm tunnels**: AWS CLI + [session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) on PATH; for the SSO bootstrap a browser (login opens interactively).
- For **ssh tunnels**: nothing extra (in-process ssh2 client).

### CLI options

```
db-access-mcp [workdir] [exportdir] [--workdir <dir>] [--exportdir <dir>] [--config <file>] [--env-file <file>]... [--log-level <level>]
```

| Option | Env var | Default |
|---|---|---|
| `--workdir` (or first positional) | `DB_ACCESS_MCP_WORKDIR` | `~/.db_acess_mcp` |
| `--exportdir` (or second positional) | `DB_ACCESS_MCP_EXPORTDIR` | `/tmp/db-access-mcp/exports` |
| `--config` | `DB_ACCESS_MCP_CONFIG` | discovery: `<workdir>/config.json` + `<workdir>/conf.d/*.json` |
| `--env-file` (repeatable) | — | none |
| `--log-level` (`debug`\|`info`\|`warn`\|`error`\|`silent`) | `DB_ACCESS_MCP_LOG_LEVEL` | `info` |

The **workdir** holds `config.json`, `conf.d/`, `config.example.json` and the
runtime `instances/` and `sso/` state (unchanged from earlier releases). The
**exportdir** is where `query_to_file` writes exports (created on demand, not at
startup); `allow_export_paths` adds extra writable roots.

All logs are JSON lines on **stderr** (stdout belongs to the MCP protocol). Values
of keys matching `password`, `token`, `secret`, `privateKey` etc. are redacted.

## MCP tools

| Tool | What it does |
|---|---|
| `dialect_list` | Lists the supported database dialects: name (the `type` value for connections), default port and the plan format `query_plan` produces. |
| `connection_list` | Lists configured connections: key, type, description, `read_only`, host/port/database, tunnel name, metadata. Credentials are **never** returned (allowlist-based sanitization; connection strings are parsed only for host/port/database). |
| `connection_find` | Finds connections by `host`, `port`, `database`, `type`, `read_only` and/or `metadata` key-value pairs. All filters are combined with **AND**. `user`/`password` filters are ignored (and noted in the response). |
| `connection_test` | End-to-end health check: secrets → tunnel → pool → one-row server-info query. Returns `ok: true` with server version/user/database/latency, or `ok: false` with the failure code and hint (an unreachable DB is a valid result, not a tool error). |
| `query` | Executes SQL on a connection. Accepts `connection`, `query`, optional `database` (see multi-database connections), `max_rows` and `timeout_ms` overrides. Results are truncated to the row cap with `truncated: true`. |
| `query_to_file` | Executes a query and writes the result to a file (`csv`/`jsonl`, inferred from the extension) instead of the model context. `file_path` is relative to the export dir (default `/tmp/db-access-mcp/exports`, created on demand), or an absolute/`~` path **under** the export dir or a configured `allow_export_paths` root — writes outside are rejected. Existing files require `overwrite: true`. postgres/mysql **stream** rows (no cap by default); redshift/mssql buffer and are capped at 100k rows. |
| `query_plan` | Returns the execution plan without running the query: `EXPLAIN (FORMAT JSON)` for postgres, `EXPLAIN FORMAT=JSON` for mysql, text `EXPLAIN` for redshift, `SHOWPLAN_XML` for mssql. |
| `up_tunnel` | Opens (or reuses) the tunnel configured for a connection and returns `{host, port, tunnel_id, reused}`. Optional `local_port` binds an exact local port; if the tunnel is already open on a different port or the port is taken, the call fails with the current port in the error. |
| `down_tunnel` | Closes a tunnel by `tunnel_id`. By default only the up_tunnel pin is released — if query pools still hold the tunnel it stays open (`remaining_holders`); `force: true` drains the holder pools and closes it unconditionally. |
| `tunnel_list` | Lists the tunnels currently open in this MCP instance with a live health probe: `tunnel_id`, tunnel name/type, local and remote endpoints, `healthy`, holder pools (`connections`), up_tunnel `pins`, external PIDs. |

Security note for `query_to_file`: writes are confined to the export dir (default
`/tmp/db-access-mcp/exports`) plus any roots listed in `allow_export_paths` (e.g.
`["/tmp", "~/data_files"]`) — every subpath below a listed root is allowed, anything
else is rejected, so the tool cannot clobber `~/.ssh`, dotfiles or the workdir. It
only ever creates files (no reads, no appends) and refuses to overwrite without an
explicit `overwrite: true`. Cells are written verbatim; be mindful of CSV-injection
when opening exports in Excel.

## Configuration reference

The schema is **strict** — unknown keys are rejected at startup with a readable
error (typo protection). Everything inside a connection's `options` is passed
through to the database driver as-is.

```jsonc
{
  "vault":               { /* named Vault servers */ },
  "aws_secret_profiles": { /* named AWS Secrets Manager profiles */ },
  "env_files":           [ /* extra .env files applied at startup */ ],
  "pool":                { /* global pool defaults */ },
  "limits":              { /* global query limits */ },
  "tunnels":             { /* named tunnel definitions */ },
  "connections":         { /* named connections */ }
}
```

### Config files: single or split (`conf.d`)

Without `--config`, the server loads `<workdir>/config.json` (optional) **plus**
every `<workdir>/conf.d/*.json` (sorted by name, non-recursive, dotfiles ignored)
and merges them:

- Named-record sections (`vault`, `aws_secret_profiles`, `tunnels`, `connections`)
  are unioned across files. The **same name in two files is a startup error**
  naming both files — no silent overrides.
- Scalar sections (`pool`, `limits`, `env_files`) may appear in **at most one** file.
- `--config <file>` loads exactly that file; `conf.d` is not scanned.

Everything can live in a single `config.json` (that is what the example shows) —
`conf.d` is for splitting per team/project when the config grows.

### Env-ref values

Wherever noted below, a config value can be an inline string or a reference to an
environment variable, resolved lazily at the moment it is needed:

```jsonc
"token": "hvs.inline"            // inline
"token": { "env": "VAULT_2_TOKEN" }  // read from the environment at use time
```

A missing variable fails only the connections that actually need it, with an
error naming the variable.

### `connections.<key>`

| Field | Required | Description |
|---|---|---|
| `type` | yes | `postgres` \| `mysql` \| `redshift` \| `mssql` |
| `options` | yes | Driver passthrough options (see per-dialect notes below). May contain `${provider.path}` secret placeholders in any string value. Must declare `database` and/or a non-empty `databases` list (connectionString/uri connections carry the database inside the string). |
| `description` | no | Free-text description shown by `connection_list`. |
| `read_only` | no | Session-level read-only enforcement (see semantics below). Default `false`. |
| `metadata` | no | Flat map (`string`/`number`/`boolean` values) used by `connection_find`. |
| `pool` | no | Per-connection pool overrides. |
| `limits` | no | Per-connection limit overrides. |
| `tunnel` | no | `{ "target": "<tunnel name>", "localPort": 25432? }`. Without `localPort` a random free port from 20000–45000 is picked. |
| `secrets` | no | Exactly **one** provider per connection: `{ "<provider>": <spec> }`. |

#### Per-dialect `options`

- **postgres / redshift** — anything [node-postgres](https://node-postgres.com/apis/client) accepts:
  `host`, `port`, `database`, `user`, `password`, `ssl`, … or a single
  `connectionString` (`postgres://user:pass@host:5432/db`).
- **mysql** — anything [mysql2](https://sidorares.github.io/node-mysql2/docs) accepts:
  `host`, `port`, `database`, `user`, `password`, or `uri` (`mysql://…`).
  `multipleStatements` follows the shared rule below.
- **mssql** — anything [mssql](https://github.com/tediousjs/node-mssql#configuration) accepts:
  `server` (or `host` alias), `port`, `database`, `user`, `password`,
  `options: { encrypt, trustServerCertificate, … }`, or `connectionString`
  (`mssql://…` URL or ADO style `Server=…;Database=…`).

#### `options.multipleStatements` (default off)

By default a `query` call runs a **single** statement. Set
`"multipleStatements": true` in a connection's `options` to allow several
`;`-separated statements in one call. Enforced by the engine, not by parsing SQL:

- **mysql** — the driver's native `multipleStatements` flag.
- **postgres / redshift** — with it off, queries run over the extended protocol,
  so the server itself rejects a second statement (`42601`); no SQL splitting.
- **mssql** — cannot be enforced at the protocol level (T-SQL batches), so
  multi-statement is always allowed here; rely on a read-only DB user.

Leaving it off also closes the `SET session-read-only off; INSERT …` bypass of a
`read_only` connection (the write can't ride along in a second statement). Like
`read_only`, this is a seatbelt — the real guarantee is a read-only DB user.

### Multi-database connections (`options.databases`)

One server often hosts many databases. Instead of duplicating the connection,
declare them all:

```jsonc
"shared-mysql": {
  "type": "mysql",
  "options": { "host": "...", "port": 3306,
               "databases": ["app", "reporting", "audit"],
               "user": "...", "password": "..." }
}
```

Rules (`query`, `query_plan`, `query_to_file`, `connection_test` accept an
optional `database` parameter):

- no `database` parameter → `options.database` is used; when the connection
  declares only a `databases` list there is **no implicit default** — the call
  fails with `DATABASE_NOT_FOUND` listing the available names;
- a passed `database` must equal `options.database` or be a member of
  `options.databases`, otherwise `DATABASE_NOT_FOUND`;
- `database` and `databases` may be declared together; every connection must
  declare at least one of them (config error otherwise);
- each (connection, database) pair gets its own pool; all pools of a connection
  share one tunnel, released when the last pool closes;
- `connection_list`/`connection_find` expose `databases`, and the `database`
  find-filter matches either the single property or any list member;
- `databases` cannot be combined with `connectionString`/`uri`.

### `pool` (global and per-connection)

| Field | Default | Meaning |
|---|---|---|
| `max` | 5 | Max connections in the pool. |
| `min` | 0 | Min idle connections kept. |
| `idle_timeout_ms` | 30000 | Driver-level idle client timeout inside the pool. |
| `connection_timeout_ms` | 10000 | Time to wait for a new connection. |

### `limits` (global, per-connection, per-call)

| Field | Default | Meaning |
|---|---|---|
| `max_rows` | 1000 | Row cap per result set; exceeded → rows are cut and `truncated: true`. Overridable per `query` call. |
| `query_timeout_ms` | 30000 | Query timeout. postgres/redshift: server-side `statement_timeout`; mysql: client-side inactivity timeout (connection is destroyed, the server may finish the statement); mssql: client-side `request.cancel()`. Overridable per `query` call. |
| `idle_close_ms` | 600000 | Per-instance idle timer: a connection unused this long gets its pool closed **and** its tunnel released. |

Resolution order: tool-call argument → connection `limits` → global `limits` → defaults.

### `read_only` semantics by dialect

| Dialect | Mechanism | Enforcement |
|---|---|---|
| postgres | `SET default_transaction_read_only = on` per checkout | Hard — the server rejects writes (`25006`). |
| mysql ≥ 5.6 | `SET SESSION TRANSACTION READ ONLY` per checkout | Hard. On 5.5 the statement fails → warning logged, no enforcement. |
| redshift | attempted, but Redshift does not support it | Best-effort: warning logged. Use a read-only DB user. |
| mssql | `readOnlyIntent` connection option | Only effective on Availability Group read replicas; warning logged. Use a read-only DB user. |

**For real guarantees always prefer a read-only database user.** `read_only` is a
seatbelt, not a security boundary.

## Secrets

One provider per connection; placeholders are namespaced by the provider name and
resolved against the parsed secret object: `${env.userName}`, `${vault.data.password}`,
`${aws.password}`. A placeholder that is the **whole** string keeps the raw value
type (numbers stay numbers); embedded placeholders are string-substituted. Mismatched
namespaces are rejected at config load.

### `env` — environment variables

```jsonc
"options": { "user": "${env.userName}", "password": "${env.password}" },
"secrets": { "env": { "userName": "PG_USER_ENV_VAR", "password": "PG_PASSWORD_ENV_VAR" } }
```

The spec maps placeholder keys to environment variable names. Missing variables
fail with the exact list of what is missing. Static — never reloaded.

### `vault` — HashiCorp Vault (multiple servers)

```jsonc
"vault": {
  "vault-main": { "address": "https://vault.example.com:8200", "token": "hvs...." },
  "vault-dr":   { "address": { "env": "VAULT_DR_ADDR" }, "token": { "env": "VAULT_DR_TOKEN" } }
},
...
"secrets": { "vault": { "target": "vault-dr", "path": "secret/data/databases/db4" } }
```

- `vault` is a map of **named servers**; `address`/`token`/`namespace` accept
  env-refs, extra keys are passed through to
  [node-vault](https://github.com/nodevault/node-vault).
- `secrets.vault.target` picks the server. **Without `target`** the implicit
  default client is used, built purely from `VAULT_ADDR`/`VAULT_TOKEN`
  (/`VAULT_NAMESPACE`) — node-vault's standard variables. The implicit default is
  *not* part of the named map: an entry you name `"default"` is just a regular
  named entry.
- KV v2 responses are unwrapped: placeholders address the secret payload directly.
- **Dynamic secrets** (e.g. `database/creds/<role>`) carry a lease: the lease is
  renewed at ~80% of its TTL (with jitter). When renewal fails (max TTL reached),
  fresh credentials are requested; if they differ, the connection pool is swapped
  atomically (new queries use the new pool immediately, in-flight queries finish on
  the old one, which is then drained).
- If Vault is unreachable past the lease deadline, the secret is marked stale and
  re-resolved lazily on next use; an auth failure with a stale secret triggers one
  forced re-resolve + reconnect.

### `aws` — AWS Secrets Manager (named profiles)

```jsonc
"aws_secret_profiles": {
  "aws-prod": { "aws_profile": "prod", "aws_region": "us-east-1", "reload_interval_ms": 3600000 },
  "aws-dev":  { "aws_profile": { "env": "AWS_DEV_PROFILE" }, "aws_region": { "env": "AWS_DEV_REGION" } }
},
...
"secrets": {
  "aws": {
    "secret_id": "prod/erp/mssql",       // name or full ARN
    "target": "aws-prod",                 // optional: aws_secret_profiles entry
    "version_stage": "AWSCURRENT"         // optional
  }
}
```

`aws_profile`, `aws_region` and `reload_interval_ms` live in named
`aws_secret_profiles` entries (values accept env-refs). **Without `target`** the
default AWS SDK credential chain is used (env, shared config, SSO, IMDS…) and the
secret is static. The secret value must be a **JSON object** (`SecretString`); its
keys become the `${aws.*}` namespace. AWS Secrets Manager has no leases, so
reloading is opt-in via the profile's `reload_interval_ms` (min 10s): the secret is
re-fetched on that interval and rotation is picked up with the same atomic pool
swap as Vault.

### `env_files` — extra .env files

```jsonc
"env_files": ["~/.db_acess_mcp/secrets.env"]
```

Applied at startup, before any secret resolution; `--env-file <file>` (repeatable)
appends to the config list. Files use standard dotenv syntax. Rules (security):

| Rule | Why |
|---|---|
| The **real environment always wins** — variables present at process start are never overridden by a file. | An env file must not be able to repoint `VAULT_ADDR`/`AWS_*` of a running setup. |
| `PATH`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `LD_*`/`DYLD_*` are **skipped** with a warning. | Prevents binary/loader/TLS-trust hijack for the processes we spawn (aws CLI). |
| Later files override earlier ones (config `env_files` first, then `--env-file` in order). | Deterministic precedence. |
| A group/other-readable env file logs a warning on POSIX (`chmod 600` recommended). | Secrets hygiene. |
| Values are never logged; keys only at `debug` level. | Secrets hygiene. |

### `aws_iam` — passwordless RDS/Aurora (IAM auth tokens)

```jsonc
"options": {
  "host": "pg.abc.us-east-1.rds.amazonaws.com", "port": 5432, "database": "appdb",
  "user": "${aws_iam.username}", "password": "${aws_iam.token}",
  "ssl": { "rejectUnauthorized": false }          // SSL is MANDATORY for IAM auth
},
"secrets": { "aws_iam": { "username": "readonly", "target": "aws-prod" } }
```

No password is stored anywhere: a 15-minute SigV4 auth token is generated
locally and used as the password; the standard refresh pipeline re-signs it
before expiry and swaps the pools atomically. Tokens are always signed for the
**real RDS host/port** from `options` (never the tunnel's 127.0.0.1), so
tunnels work unchanged; connection strings are not supported here. Optional
`host`/`port` in the spec override the endpoint (e.g. a reader endpoint).

AWS-side prerequisites:

- IAM auth enabled on the instance/cluster (`IAMDatabaseAuthenticationEnabled`);
- the DB user is IAM-bound — postgres: `GRANT rds_iam TO readonly;`
  mysql: `CREATE USER readonly IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';`
- the caller has `rds-db:connect` on `arn:aws:rds-db:<region>:<acct>:dbuser:<resource-id>/readonly`;
- **not supported** by RDS for SQL Server. Every connect is auditable in CloudTrail.

### `aws_redshift_creds` — temporary Redshift credentials

```jsonc
"options": { "host": "cluster....redshift.amazonaws.com", "port": 5439, "database": "dwh",
             "user": "${aws_redshift_creds.username}", "password": "${aws_redshift_creds.password}" },
"secrets": { "aws_redshift_creds": { "cluster_id": "my-cluster", "db_user": "readonly",
                                     "target": "aws-prod", "duration_seconds": 3600 } }
```

`redshift:GetClusterCredentials` issues a temporary user+password pair
(900–3600s); the returned username carries the `IAM:` prefix and is sent to the
server verbatim. TTL comes from the API's expiration and feeds the same
auto-refresh + pool-swap pipeline.

### SSO bootstrap for AWS profiles

An `aws_secret_profiles` entry may carry the same `sso` block as ssm tunnels:

```jsonc
"aws_secret_profiles": {
  "aws-prod": { "aws_profile": "my-profile", "aws_region": "us-east-1",
                "sso": { "session": "my-sso-session", "timeout_ms": 300000 } }
}
```

Before any provider referencing the profile (`aws`, `aws_iam`,
`aws_redshift_creds`) uses credentials, the session is verified with
`aws sts get-caller-identity`; an expired session triggers `aws sso login`
(browser) and the resolution waits up to `timeout_ms`. `sso.profile` defaults
to the entry's `aws_profile`. Login dedup is by session name — a tunnel and a
secret resolution on the same session share one browser login.

### Adding a provider

Implement `SecretProvider` (`src/interfaces/secret-provider.ts`) and add one binding
line in `src/composition/modules/secrets.module.ts`. The provider `name` is both the
config key under `secrets` and the placeholder namespace.

## Tunnels

```jsonc
"tunnels": {
  "bastion-ssm": { "type": "ssm", "options": { "target": "i-0123...", "region": "us-east-1", "profile": "default" } },
  "bastion-ssh": { "type": "ssh", "options": { "host": "bastion", "port": 22, "username": "ec2-user", "privateKey": "~/.ssh/id_ed25519" } }
}
```

- **ssh** — runs **inside** the MCP process (via the `ssh2` library): a local
  listener forwards TCP through the SSH channel. Because it is in-process it dies
  with the process even on SIGKILL — orphaned ports are impossible. Options:
  `host`, `port` (22), `username`, `password`, `privateKey` (file path, `~` ok),
  `passphrase`, `agent` (`true` = platform default agent, or an explicit
  socket/pipe path), `ready_timeout_ms`.
  The bastion **host key is verified** (MITM defence): by default against
  `~/.ssh/known_hosts` (plaintext and hashed entries, and `[host]:port` for
  non-standard ports). Pin it explicitly with `host_key_sha256` (the
  `ssh-keygen -lf` fingerprint, with or without the `SHA256:` prefix), point
  `known_hosts` at another file, or set `strict_host_key: false` to accept any
  key (**insecure — opt-out only**). An unknown or changed key is rejected.
- **ssm** — spawns `aws ssm start-session --document-name
  AWS-StartPortForwardingSessionToRemoteHost` under a tiny **watchdog** process.
  The watchdog holds a stdin pipe from the MCP process: if the MCP process dies for
  *any* reason (including SIGKILL), the OS closes the pipe and the watchdog kills
  the whole aws/session-manager-plugin tree (`taskkill /T /F` on Windows, process
  group kill on POSIX). Requires the AWS CLI and
  [session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  on PATH. Options: `target` (instance id), `region`, `profile`, `document_name`.

### AWS SSO bootstrap (ssm tunnels)

```jsonc
"bastion-ssm": {
  "type": "ssm",
  "options": { "target": "i-...", "region": "us-east-1", "profile": "prod" },
  "sso": { "session": "my-sso", "profile": "prod", "timeout_ms": 300000 }   // all fields optional
}
```

When a tunnel has an `sso` block, the session is verified with
`aws sts get-caller-identity --profile <profile>` **before** the tunnel opens.
If it is missing or expired, a login is started (browser flow): with
`sso.session` set it runs `aws sso login --sso-session <name>` (the canonical
IAM Identity Center form — one session may back several profiles); otherwise
`aws sso login --profile <profile>`. The tunnel waits, polling every 3s, until
the session works or `timeout_ms` (default 5 minutes) elapses — then
`TUNNEL_FAILED` with a hint containing the exact manual command. `sso.profile`
defaults to the tunnel's `options.profile`; the dedup/marker key is the session
name when present.

- The SSO session is **never closed** by this server; the login process is not
  watchdog-wrapped, is never killed and survives the MCP instance.
- Concurrent logins are deduplicated: within an instance by profile; across
  instances via a `<workdir>/sso/<profile>.login.json` marker — a second instance
  waits for the first login instead of opening another browser tab (markers of
  dead processes are ignored via PID + start-time checks).
- SSO tokens and `~/.aws/sso/cache` are never read, parsed or logged — only
  fixed-argument aws CLI invocations, no shell.

Behavior:

- The tunnel's **remote endpoint** is taken from the connection's `options`
  (host/port as seen *from the bastion*).
- Tunnels are cached per instance and keyed by `(tunnel name, remote host:port)` —
  connections through the same bastion to the same database share one tunnel;
  `query`/`up_tunnel` reuse an already-open healthy tunnel.
- Reference counting: the tunnel closes when the last connection using it is closed
  (including by the idle timer).
- Every instance writes `<workdir>/instances/<pid>-<startTime>.json` with its tunnel
  PIDs. At startup (and every 10 minutes) each instance sweeps files of dead
  instances: PID liveness check, PID-reuse protection via OS process start time,
  and a command-line sanity check before killing anything.
- On a connection error during `query`, the tunnel is health-checked, reopened if
  needed, the pool is rebuilt, and the query is retried — up to 3 attempts with
  exponential backoff. Auth errors are never retried.

## Isolation model

Every `npx -y @rheopyrin/db-access-mcp` process is fully isolated: its own config snapshot,
connection pools, tunnels and idle timers. Nothing is shared between instances; the
per-instance registry files exist only so that *later* instances can clean up after
a crashed one. Two instances talking to the same database simply hold independent
pools (mind your database `max_connections`; the default pool `max` is 5 per
connection per instance).

## Error codes

Tools return `isError: true` with a structured payload — never raw stacks or credentials:

| Code | Meaning |
|---|---|
| `CONFIG_INVALID` | Config schema/semantic violation (bad tunnel ref, placeholder namespace, …). |
| `CONNECTION_NOT_FOUND` | Unknown connection key. |
| `DATABASE_NOT_FOUND` | The requested database is not declared for the connection, or a multi-database connection was called without the `database` parameter (available names are in the hint). |
| `SECRET_RESOLUTION_FAILED` | Provider could not produce the secret (missing env var, Vault/AWS error, bad path). |
| `TUNNEL_FAILED` | Tunnel could not be opened / port busy / CLI missing. |
| `CONNECTION_FAILED` | Database unreachable after retries, or auth failed. |
| `QUERY_FAILED` | SQL error. |
| `QUERY_TIMEOUT` | Query exceeded `timeout_ms`. |

## Windows notes

- Paths use `os.homedir()`; `~` in CLI args and `privateKey` is expanded manually.
- Tunnel trees are killed with `taskkill /T /F`; process inspection uses PowerShell
  (`wmic` is gone from Windows 11).
- AWS CLI v2 (`aws.exe`) and v1 (`aws.cmd`) are both handled.
- Default SSH agent pipe: `\\.\pipe\openssh-ssh-agent`.

## Development

```bash
npm ci
npm run lint        # eslint (typescript-eslint, type-checked)
npm run typecheck   # tsc --noEmit
npm test            # unit tests (fast, no docker)
npm run test:integration  # requires Docker: postgres:16, mysql:8, testcontainers/sshd
npm run test:e2e    # builds, then drives dist/cli.js over real stdio MCP
npm run build       # tsup -> dist/cli.js + dist/watchdog.js
```

Architecture: inversify DI container; every extension point (dialect drivers,
secret providers, tunnel providers, MCP tools) is a multi-bound interface collected
into a registry — adding an implementation is one class + one binding line. See
`src/composition/`.

Not covered by automated integration tests (unit-tested with mocks; verify manually):
Redshift specifics, SSM tunnels (needs real AWS), MSSQL against a live server,
Vault/AWS Secrets Manager against live services.

## Manual verification checklist

1. `npx -y @rheopyrin/db-access-mcp` first run → workdir, `config.json`, `config.example.json` created.
2. Add a real connection → `connection_list`, `query` (`SELECT 1`), `query_plan`.
3. Tunneled connection → `up_tunnel` returns `127.0.0.1:<port>`; `psql -h 127.0.0.1 -p <port>` works.
4. `kill -9 <mcp pid>` → tunnel process disappears within seconds (watchdog); next
   start removes the stale instance file.
5. Vault dynamic creds: watch the log for `secret refreshed` / `pool swapped after
   credential rotation` around 80% of the lease TTL.
