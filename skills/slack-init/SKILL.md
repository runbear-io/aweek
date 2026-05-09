---
name: slack-init
description: Bootstrap an aweek-branded Slack app and persist its credentials so the embedded SlackAdapter inside `aweek serve` can chat with the project's Claude through Slack
trigger: aweek slack-init, slack init, init slack, configure slack, set up slack, install slack bot, slack credentials, /aweek:slack-init
---

# aweek:slack-init

Bootstrap a Slack app for this project and wire its credentials into
`aweek serve` so users can chat with the project-level Claude through
Slack. The flow has two phases — both are destructive and confirmation-gated:

1. **Provision** — call Slack's `apps.manifest.create` + `apps.token.create`
   with the aweek-branded manifest. This creates a real Slack app inside
   the user's workspace, returns the Socket-Mode app-level token
   (`xapp-…`), the OAuth client credentials, and the OAuth authorize URL
   the human has to visit to install the app and obtain the bot token
   (`xoxb-…`).
2. **Persist** — merge the resulting credentials into
   `.aweek/channels/slack/config.json` so the embedded listener loads them
   on the next `aweek serve` start. The bot token is paste-back from the
   workspace OAuth install (which is interactive and lives outside this
   skill).

This skill is a thin UX wrapper on top of `src/skills/slack-init.ts`. All
remote Slack writes and disk writes go through the dispatcher — never
shell out to Slack APIs or write `.aweek/channels/slack/config.json`
directly from the markdown.

The persisted file is gitignored under the repo's `.aweek/` rule. The
embedded Slack listener still reads `process.env` first
(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, optional `SLACK_SIGNING_SECRET`)
and only falls back to the file — so this skill is only needed when the
user wants on-disk credentials rather than environment-variable injection.

v1 scope: project-level Claude proxy only. Per-subagent Slack apps,
slash commands, file uploads, channel-per-agent routing, and direct
subagent addressing are explicitly out of scope.

## Destructive operation policy

Per project policy, every destructive surface requires explicit
`AskUserQuestion` confirmation before `confirmed: true` is passed to the
dispatcher. Both underlying primitives (`provisionSlackApp` and
`persistSlackCredentials`) refuse to run without it — do not bypass the
gate.

| Operation | Destructive | Confirmation required |
|-----------|-------------|-----------------------|
| `provisionSlackApp` (creates a Slack app + Socket-Mode token on Slack's side) | **Yes** — durable remote write; old refresh token is invalidated | **Yes** |
| `persistSlackCredentials` (writes `.aweek/channels/slack/config.json`) | **Yes** — overwrites credentials on disk | **Yes** |
| `slackInit` (composite — runs both stages) | **Yes** | **Yes** |

## Prerequisites

Before invoking the skill, the user needs **either**:

- A Slack **Refresh Token** (`xoxe-…`) issued at
  <https://api.slack.com/apps> → "Your Apps" → "Refresh tokens". This is
  what `provisionSlackApp` rotates into a short-lived access token in
  order to call `apps.manifest.create`. Slack invalidates the old refresh
  token on every rotation — the new value is surfaced back in the result
  so the user can re-store it.

  *or*

- An **already-existing Slack app** they want to wire into aweek. In
  that case they bring their own bot token (`xoxb-…`), app-level token
  (`xapp-…`), and (optionally) signing secret, and the skill runs in
  `skipProvision` mode — only the persistence stage executes.

In both cases the user also needs to complete the workspace **OAuth
install** to obtain the bot token. The OAuth install step is interactive
and happens *between* the provision phase (which prints the authorize
URL) and the final persistence call (which records the bot token).

## Instructions

You MUST follow this exact workflow when this skill is invoked. Use
`AskUserQuestion` for every interactive prompt. Each numbered step maps
to one or more dispatcher calls — never inline `node -e` snippets.

### Step 1: Pick the flow (provision-and-persist vs. persist-only)

Ask the user via `AskUserQuestion`:

```
Which Slack-init flow do you want to run?
  options:
    - value: provision
      label: "Create a new Slack app"
      description: "Use a Slack Refresh Token (xoxe-…) to call apps.manifest.create. Creates a real Slack app on the workspace and generates the Socket-Mode app-level token. You'll then complete the OAuth install to obtain the bot token."
    - value: persist
      label: "Use an existing Slack app"
      description: "I already have my own bot token (xoxb-…) and app-level token (xapp-…). Just persist them to .aweek/channels/slack/config.json."
    - value: cancel
      label: "Cancel"
      description: "Do nothing."
```

If the user picks `cancel`, stop here. Otherwise carry the chosen value
forward as `flow` and continue.

### Step 2: Optionally collect manifest branding (provision flow only)

When `flow === 'provision'`, optionally ask the user via
`AskUserQuestion` whether to override the default app branding. The
dispatcher accepts both fields as optional and falls back to
`DEFAULT_SLACK_APP_NAME` (`"aweek"`) and
`DEFAULT_SLACK_APP_DESCRIPTION` when omitted.

| Field | Default | Notes |
|-------|---------|-------|
| `appName` | `aweek` | Shown to humans in the Slack app directory and `@`-mention picker. Keep it short. |
| `appDescription` | "aweek project-level Claude — chat with the project Claude through Slack." | One-line description on the app's About page. |
| `appTokenName` | `aweek-socket` | Human-readable label for the Socket-Mode app-level token. Cosmetic. |
| `socketMode` | `true` | The embedded listener requires Socket Mode. **Do NOT expose this as a togglable option** — keep it `true`. |

Preview the manifest before calling Slack so the user can spot
typos:

```bash
echo '{"appName":"<NAME>","appDescription":"<DESC>","socketMode":true}' \
  | aweek exec slack-init buildAweekSlackManifest --input-json -
```

The output is the literal manifest object the dispatcher will hand to
`apps.manifest.create`. Pretty-print it for the user. Do **not**
hand-edit the manifest — extending the manifest belongs in
`buildAweekSlackManifest` (and ultimately
`agentchannels`'s `buildSlackManifest`), not in the skill markdown.

### Step 3: Collect tokens

#### 3a. Provision flow

Ask the user for the **Slack Refresh Token** (`xoxe-…`) via
`AskUserQuestion`. Validate the prefix locally:

- Reject empty input — re-prompt.
- Warn (don't reject) if the value does not start with `xoxe-` — that's
  the only Slack token shape Slack will accept here, but the user might
  still hit a typo or paste a stale value, and the dispatcher will
  surface the underlying API error verbatim if rotation fails.

Then ask for the **bot token** (`xoxb-…`). The bot token comes from the
workspace OAuth install — it does **not** exist yet at this point. Tell
the user the provision phase will print the OAuth authorize URL, and
that they should:

1. Open the URL in a browser.
2. Complete the install (pick the workspace, approve the scopes).
3. Copy the bot token Slack hands them.
4. Paste it back when prompted.

Collect the bot token via a follow-up `AskUserQuestion` **after** the
provision call has printed the URL — see Step 4.

#### 3b. Persist-only flow

Collect the three credentials the user already has via `AskUserQuestion`
prompts:

| Field | Required | Notes |
|-------|----------|-------|
| `botToken` (`xoxb-…`) | **Yes** | The embedded listener requires this to post messages. |
| `appToken` (`xapp-…`) | **Yes** | Socket-Mode WebSocket. The embedded listener will not start without it. |
| `signingSecret` | Optional | Reserved for a future HTTP-events fallback path. Socket Mode does not verify request signatures locally. |

Skip the refresh token and manifest branding — they are not needed.

### Step 4: Confirm the destructive action

> **Confirmation gate (required).** `confirmed: true` MUST NOT be set on
> any dispatcher payload until **after** the user has explicitly answered
> `yes` to the `AskUserQuestion` in this step. The dispatcher refuses to
> run otherwise (`ESLACK_INIT_NOT_CONFIRMED`), but the markdown is the
> first line of defense — never hardcode `confirmed: true` ahead of the
> human's response.

Before asking, render a **read-only preview of the on-disk credential
file** so the user can see exactly what would be overwritten. The
preview helper is non-destructive and does not require confirmation:

```bash
echo '{
  "proposed": {
    "botToken": "<BOT_TOKEN_OR_OMIT>",
    "appToken": "<APP_TOKEN_OR_OMIT>",
    "signingSecret": "<SIGNING_SECRET_OR_OMIT>"
  }
}' | aweek exec slack-init previewCredentialOverwrite --input-json -
```

The result has this shape:

```json
{
  "ok": true,
  "configPath": "/abs/path/.aweek/channels/slack/config.json",
  "fileExists": true,
  "fileMalformed": false,
  "fieldsCurrentlyPresent": ["botToken", "appToken"],
  "fieldsThatWouldBeOverwritten": ["botToken"],
  "fieldsThatWouldBeAdded": ["signingSecret"],
  "changes": [
    { "field": "botToken", "currentlyPresent": true, "wouldOverwrite": true, "wouldAdd": false },
    { "field": "signingSecret", "currentlyPresent": false, "wouldOverwrite": false, "wouldAdd": true }
  ]
}
```

Echo back to the user **as direct assistant output** (Bash blocks
collapse in the UI):

- `configPath` — the file the persistence step will write.
- `fileExists` / `fileMalformed` — whether anything is on disk and
  whether it parses. A malformed file will be replaced wholesale on
  write; mention this explicitly.
- `fieldsThatWouldBeOverwritten` — names of credentials the user is
  about to lose. Even if they don't show the values, surfacing the
  field names lets the user spot drift.
- `fieldsThatWouldBeAdded` — net-new fields.

Render the preview as **direct assistant output** (so the destructive
footprint is visible without expanding a Bash result), then collect an
explicit confirmation via `AskUserQuestion`. **Do NOT pass
`confirmed: true` to any dispatcher entry until the answer is `confirm`.**
A `cancel` answer (or anything other than `confirm`) ends the flow —
re-run `/aweek:slack-init` to retry.

**Provision flow** — the dispatcher payload that will be built next is
`slackInit { refreshToken, appName?, appDescription?, appTokenName?, confirmed: true }`,
which transitively calls `provisionSlackApp` (rotates the refresh token,
calls `apps.manifest.create`, mints the Socket-Mode token) **and**
`persistSlackCredentials` (writes `<configPath>`).

Show the user this preview, then collect the confirmation:

```
This will:
  1. Rotate your Slack Refresh Token (xoxe-…) into a short-lived access
     token. The old refresh token will be INVALIDATED — Slack returns a
     new one and we'll show it back to you so you can re-store it.
  2. Call apps.manifest.create with the aweek-branded manifest. A real
     Slack app named "<APP_NAME>" will be created on your workspace.
  3. Call apps.token.create to mint the Socket-Mode app-level token
     (xapp-…).
  4. Print the OAuth authorize URL so you can install the app.
  5. After you paste back the bot token, write all credentials to
     <configPath> (the file is gitignored under the repo's .aweek/ rule).
     Fields that would be overwritten: <fieldsThatWouldBeOverwritten>
     Fields that would be added       : <fieldsThatWouldBeAdded>
```

```
AskUserQuestion:
  "Provision a new Slack app and write its credentials to
   .aweek/channels/slack/config.json? This rotates your Slack refresh
   token (the old one is invalidated) and creates a real Slack app on
   your workspace."
  options:
    - value: confirm
      label: "Yes — provision and persist"
      description: "Run apps.manifest.create + apps.token.create, then write the merged credentials to <configPath>."
    - value: cancel
      label: "Cancel"
      description: "Do nothing. No Slack-side writes, no disk writes, no `confirmed: true` is set."
```

If the answer is anything other than `confirm`, **stop here** and do
**not** issue any dispatcher call with `confirmed: true`.

**Persist-only flow** — the dispatcher payload that will be built next is
`slackInit { skipProvision: true, botToken, credentials, confirmed: true }`,
which calls `persistSlackCredentials` only (no Slack-side writes).

Show the user this preview, then collect the confirmation:

```
This will write the bot token, app-level token, and (if provided)
signing secret to <configPath>. The file is gitignored. Existing
fields you didn't pass are merged (not clobbered).
  Fields that would be overwritten: <fieldsThatWouldBeOverwritten>
  Fields that would be added       : <fieldsThatWouldBeAdded>
```

```
AskUserQuestion:
  "Write these Slack credentials to .aweek/channels/slack/config.json?"
  options:
    - value: confirm
      label: "Yes — write credentials"
      description: "Merge the supplied tokens into <configPath> via persistSlackCredentials. No Slack-side writes."
    - value: cancel
      label: "Cancel"
      description: "Do nothing. No disk writes, no `confirmed: true` is set."
```

If the answer is anything other than `confirm`, **stop here** and do
**not** issue any dispatcher call with `confirmed: true`.

### Step 5: Run the provisioning + persistence flow

#### 5a. Provision flow

Call the composite entry `slackInit` **without** the bot token first —
the user needs to see the OAuth authorize URL before they can obtain
it. Pass `confirmed: true`, the refresh token, and any branding
overrides:

```bash
PROVISIONED=$(echo '{
  "confirmed": true,
  "refreshToken": "<REFRESH_TOKEN>",
  "appName": "<APP_NAME>",
  "appDescription": "<APP_DESCRIPTION>",
  "appTokenName": "<APP_TOKEN_NAME>"
}' | aweek exec slack-init slackInit --input-json -)
echo "$PROVISIONED"
```

The result has this shape (truncated):

```json
{
  "ok": true,
  "configPath": "/abs/path/.aweek/channels/slack/config.json",
  "provision": {
    "ok": true,
    "appId": "A0…",
    "oauthAuthorizeUrl": "https://slack.com/oauth/authorize?…",
    "signingSecret": "…",
    "clientId": "…",
    "clientSecret": "…",
    "appToken": "xapp-…",
    "refreshToken": "xoxe-… (NEW — old one is invalidated)",
    "teamId": "T0…"
  },
  "credentials": { /* same fields written to disk; botToken still absent */ },
  "outcome": "created"
}
```

Echo back to the user **inline as direct assistant output** (not just
inside a `Bash` block — Bash output collapses in the UI):

1. The OAuth authorize URL — wrap it in single backticks so the user
   can click.
2. The new refresh token (clearly labelled "save this — Slack invalidated
   the previous one").
3. The Slack app ID and team ID for sanity-checking.
4. A short instruction: "Open the URL, complete the install, paste the
   bot token (`xoxb-…`) below."

Then prompt the user via `AskUserQuestion` for the bot token. Validate
it is non-empty and warn if it does not start with `xoxb-`.

After collecting the bot token, run a **second** `slackInit` call with
`skipProvision: true` so the persistence stage merges the bot token
into the on-disk doc without re-creating the Slack app:

```bash
RESULT=$(echo '{
  "confirmed": true,
  "skipProvision": true,
  "botToken": "<BOT_TOKEN>"
}' | aweek exec slack-init slackInit --input-json -)
echo "$RESULT"
```

The merge step preserves everything the provision phase wrote (app ID,
client credentials, app token, signing secret, refresh token, OAuth URL,
team ID) and only updates the bot token + `updatedAt`. The result's
`outcome` will be `updated` (not `created`) because the file already
exists from the provision-phase write.

> **Why two calls?** The provision phase writes credentials to disk
> *before* the bot token exists, so the second call is a non-redundant
> merge — not a re-run. If the user aborts before pasting the bot token,
> the on-disk doc is still useful (the embedded listener will skip
> startup gracefully because `loadSlackCredentials` returns `null` when
> the bot token is missing).

#### 5b. Persist-only flow

Call `slackInit` with `skipProvision: true` and the supplied
credentials:

```bash
RESULT=$(echo '{
  "confirmed": true,
  "skipProvision": true,
  "botToken": "<BOT_TOKEN>",
  "credentials": {
    "appToken": "<APP_TOKEN>",
    "signingSecret": "<SIGNING_SECRET>"
  }
}' | aweek exec slack-init slackInit --input-json -)
echo "$RESULT"
```

`signingSecret` may be omitted. The `credentials` field is merged on
top of any existing on-disk document — fields not passed are preserved.

### Step 6: Summarize

Print a final summary as **direct assistant output** (mirror the
"Bash output collapses in the UI" guidance — do not rely on the user
expanding the previous Bash result):

**Provision flow:**

```
=== aweek slack-init ===
Slack app          : created (App ID A0…, Team T0…)
OAuth install      : completed (bot token saved)
Socket-Mode token  : minted (xapp-… , label "aweek-socket")
Credentials file   : /abs/path/.aweek/channels/slack/config.json (updated)

Saved fields: botToken, appToken, signingSecret, appId, clientId,
              clientSecret, refreshToken (NEW), teamId, oauthAuthorizeUrl

Next steps:
  1. Restart `aweek serve` so the embedded SlackAdapter picks up the new
     credentials. (The dashboard does NOT need a rebuild.)
  2. In Slack, DM the bot or @-mention it in a channel where it has been
     invited. Every message becomes a project-level chat turn — the bot
     proxies to the project's Claude under bypassPermissions.
  3. If you ever rotate the refresh token, re-run /aweek:slack-init —
     the old refresh token has been invalidated.
```

**Persist-only flow:**

```
=== aweek slack-init ===
Credentials file   : /abs/path/.aweek/channels/slack/config.json (created|updated)
Saved fields       : botToken, appToken[, signingSecret]

Next steps:
  1. Restart `aweek serve` so the embedded SlackAdapter picks up the
     credentials.
  2. DM the bot or @-mention it in a channel.
```

### Step 7 (optional): Inspect the persisted config

Power users sometimes want to verify the config file landed without
opening it in an editor. Offer a one-liner:

```bash
aweek exec slack-init slackConfigPath
# → /abs/path/.aweek/channels/slack/config.json
```

To pretty-print whatever is currently on disk (parsed through the same
tolerant parser the dispatcher uses — unknown keys are dropped, malformed
JSON returns `{}`):

```bash
RAW=$(cat "$(aweek exec slack-init slackConfigPath)")
echo '{"raw":'"$(printf '%s' "$RAW" | aweek json wrap)"'}' \
  | aweek exec slack-init parseSlackCredentials --input-json -
```

This is read-only and does not require `confirmed: true`.

## Resulting `.aweek/channels/slack/config.json` layout

After a successful run, the on-disk credentials document at
`<projectRoot>/.aweek/channels/slack/config.json` looks like this. Every
field is optional — partial fills (e.g. between the provision-phase
write and the bot-token paste-back, or after a persist-only run that
omits `signingSecret`) are valid, and the embedded listener simply skips
startup when the bot token or app-level token cannot be resolved. The
file is pretty-printed JSON (`JSON.stringify(merged, null, 2)`) with a
trailing newline.

**Provision flow result** — every field that `apps.manifest.create` +
`apps.token.create` returns plus the bot token from the OAuth install:

```json
{
  "botToken": "xoxb-…",
  "appToken": "xapp-1-A0…",
  "signingSecret": "…",
  "appId": "A0XXXXXXXXX",
  "clientId": "0000000000.0000000000",
  "clientSecret": "…",
  "refreshToken": "xoxe-1-…",
  "oauthAuthorizeUrl": "https://slack.com/oauth/authorize?…",
  "teamId": "T0XXXXXXXXX",
  "updatedAt": 1735689600000
}
```

**Persist-only flow result** — only the credentials the user supplied
(`signingSecret` is optional):

```json
{
  "botToken": "xoxb-…",
  "appToken": "xapp-1-A0…",
  "signingSecret": "…",
  "updatedAt": 1735689600000
}
```

| Field | Type | Required | Source | Used by |
|-------|------|----------|--------|---------|
| `botToken` | string | **Yes** | OAuth install (paste-back) or user-supplied | Embedded `SlackAdapter` — posts replies |
| `appToken` | string | **Yes** | `apps.token.create` or user-supplied | Embedded `SlackAdapter` (Socket-Mode WebSocket) |
| `signingSecret` | string | No | `apps.manifest.create` or user-supplied | Reserved for future HTTP-events fallback |
| `appId` | string | No | `apps.manifest.create` | Sanity-check / debugging |
| `clientId` | string | No | `apps.manifest.create` | OAuth install URL (already baked into `oauthAuthorizeUrl`) |
| `clientSecret` | string | No | `apps.manifest.create` | OAuth install (kept for forward-compat) |
| `refreshToken` | string | No | `auth.tokens.rotate` (newest value) | Re-run `/aweek:slack-init` after rotation |
| `oauthAuthorizeUrl` | string | No | `apps.manifest.create` | Surfaced once for the human to install the app |
| `teamId` | string | No | `auth.tokens.rotate` | Sanity-check / debugging |
| `updatedAt` | number | No | `Date.now()` at write time | Audit trail (epoch ms of the most recent merge) |

**Notes:**

- The writer (`persistSlackCredentials`) emits **camelCase** keys.
- The runtime loader (`src/storage/slack-config-store.ts` →
  `loadSlackCredentials`) is intentionally tolerant: in addition to the
  camelCase keys this skill writes, it also accepts **snake_case**
  (`bot_token`, `app_token`, `signing_secret`) and **SCREAMING_SNAKE**
  (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`) for
  hand-rolled configs.
- `process.env` **always wins on conflict** — env-set tokens override
  the same field on disk.
- The file is **gitignored** under the repo-wide `.aweek/` rule. Do not
  commit it.
- Only `botToken` + `appToken` are required for the embedded listener
  to start. `loadSlackCredentials` returns `null` (Slack disabled, not
  an error) when either is missing — so a half-completed provision flow
  is safe.
- Unknown keys are silently dropped by `parseSlackCredentials` (the
  tolerant parser the dispatcher uses).
- Malformed JSON is treated as an empty document by
  `persistSlackCredentials` (overwritten wholesale on the next write,
  which the Step 4 preview surfaces via `fileMalformed: true`) and by
  `loadSlackCredentials` (env-only fallback with a one-line warning to
  stderr).
- Subsequent runs **merge** — fields you don't pass this time are
  preserved, fields you do pass overwrite the previous value, and
  `updatedAt` is bumped on every successful write.

## Dispatcher reference

Every interaction with Slack APIs and the on-disk config goes through
one of these dispatcher entries. The skill markdown MUST NOT inline
`node -e` snippets or `cat > .aweek/channels/slack/config.json` writes.

| Entry | Confirmation gated | Purpose |
|-------|--------------------|---------|
| `slack-init buildAweekSlackManifest` | No | Render the aweek-branded manifest object for preview / inspection. |
| `slack-init provisionSlackApp` | **Yes** | Rotate the refresh token, call `apps.manifest.create`, generate the Socket-Mode app-level token. |
| `slack-init persistSlackCredentials` | **Yes** | Merge credentials into `.aweek/channels/slack/config.json`. |
| `slack-init slackInit` | **Yes** | Composite — runs `provisionSlackApp` (when a refresh token is supplied and `skipProvision !== true`) then `persistSlackCredentials`. The high-level entry the markdown calls. |
| `slack-init parseSlackCredentials` | No | Tolerant parser for the on-disk doc. Unknown keys are dropped; malformed JSON returns `{}`. |
| `slack-init slackChannelDir` | No | Absolute path to `<projectDir>/.aweek/channels/slack`. |
| `slack-init slackConfigPath` | No | Absolute path to the credentials file. |

## Validation rules

- **Refresh token** — non-empty string. The dispatcher itself does not
  enforce the `xoxe-` prefix; surface the Slack API error verbatim if
  rotation fails.
- **Bot token / app token / signing secret** — non-empty strings when
  supplied. The skill warns on prefix mismatch (`xoxb-` / `xapp-`) but
  does not reject — Slack-side errors are the source of truth.
- **`appName` / `appDescription`** — optional strings. Defaults baked
  into `buildAweekSlackManifest`.
- **`socketMode`** — always `true` for the embedded listener. Do not
  expose a toggle.
- **`confirmed`** — must be `true` for any destructive call. The
  dispatcher throws `ESLACK_INIT_NOT_CONFIRMED` otherwise.

## Error handling

- **Missing confirmation** — surface "Slack init aborted: explicit
  confirmation required" and re-run Step 4 (do not silently retry).
- **Refresh-token rotation failure** — Slack's error message names the
  exact problem (`invalid_refresh_token`, `token_expired`, …). Echo it
  verbatim and tell the user to issue a fresh refresh token at
  <https://api.slack.com/apps>.
- **`apps.manifest.create` failure** — typically a scope / workspace
  permission issue. The user has to be a workspace owner or have
  manifest-create permissions. Echo the verbatim error.
- **`apps.token.create` failure** — surface the error and tell the user
  the Slack app was created but the Socket-Mode token was not — they
  can re-mint it from the app's "Basic Information" page in the Slack
  admin UI, then re-run the skill in `persist` mode.
- **Disk write failure (`EACCES`, `EROFS`, …)** — echo the verbatim
  error. The Slack-side state has already been mutated; the user
  needs to fix the filesystem issue and re-run the persist phase only
  (use the persist-only flow with the credentials Slack returned).
- **Malformed existing config file** — `persistSlackCredentials` treats
  it as an empty doc and overwrites. Mention this in the summary so
  the user knows their previous file was clobbered.

## Data sources

- Skill module — `src/skills/slack-init.ts` (provisioning + persistence
  primitives + composite `slackInit`).
- Loader the embedded listener uses — `src/storage/slack-config-store.ts`
  (env-first, file-fallback). Reads the same file this skill writes.
- Manifest builder — `buildSlackManifest` from the local agentchannels
  workspace dep (branch `aweek-integration`). The aweek wrapper
  `buildAweekSlackManifest` only bakes in defaults.
- Path layout — `<projectDir>/.aweek/channels/slack/config.json`
  (gitignored under the repo's `.aweek/` rule).

## Related skills

- `/aweek:setup` — bootstraps `.aweek/` and the heartbeat. Run before
  `/aweek:slack-init` (the data dir must exist).
- `/aweek:teardown` — does NOT remove `.aweek/channels/slack/`
  selectively today; the full-uninstall path deletes the whole
  `.aweek/` tree, which includes Slack credentials.
- `/aweek:config` — edits `.aweek/config.json` knobs (time zone, stale
  task window, heartbeat interval). Does not touch Slack credentials.

## Out of scope (v2+)

The following are **explicitly not implemented** by this skill:

- Per-subagent Slack apps (each subagent gets its own bot identity).
- Slash commands (`/aweek-summary`, `/aweek-plan`, …).
- File uploads from Slack into the agent's workspace.
- Channel-per-agent routing or content-classification routing.
- Direct subagent addressing via `@researcher` / `@marketer-sam`. v1
  proxies every Slack message to the project-level Claude, which can
  reach subagents transitively via `Task()` / `aweek exec` under
  `bypassPermissions`.

If the user asks for any of these, point them at the v2 backlog and
do not extend the skill.
