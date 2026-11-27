# Fed — deploy to a new Heaven Cloud (Pterodactyl) server

## What's in the zip
| File | Purpose |
|---|---|
| index.js | Fed (v14 stable) |
| package.json | tells the panel to install discord.js, dotenv, node-fetch@2 |
| .env.example | template for your secrets -> rename to `.env` |
| fed_identity.json | the 9 people Fed knows (names, nicknames, timezone) |
| fed_memory / vault / rules / shared / relationships / lang_lock .json | empty starter data files |

## 0. Before you touch anything — save your live data from the OLD server
Old server -> Files -> download these (they hold Fed's memory, vault, rules and any identity edits you made with commands):
`fed_identity.json  fed_memory.json  fed_vault.json  fed_rules.json  fed_shared.json  fed_lang_lock.json  fed_daily_rating.json  fed_relationships.json  .env`
(.env is the hidden-looking file with all your keys — you need it for step 3.)
If you skip this, the new Fed starts with a blank memory and the identity list from the zip.

## 1. Discord Developer Portal (only if something fails to connect)
discord.com/developers/applications -> your bot -> **Bot** tab:
- **Message Content Intent = ON** (Fed cannot read messages without it).
- You can reuse the same bot token. No re-invite needed if the bot is already in the server.
- Bot needs these permissions in the Fed channel: View Channel, Send Messages, Read Message History, Add Reactions, Embed Links (for GIF previews).

## 2. Create the new server
Create/deploy a new **Node.js** server on Heaven Cloud the same way you made the first one (Node 20 is what you ran before).

## 3. Upload the files
1. Open the new server -> **Files**.
2. Upload `fed_deploy.zip` (Upload button), then right-click it -> **Unarchive**. Everything lands in the root (`/home/container`), next to each other. Delete the zip afterwards.
   - If unarchive isn't offered, upload the files one by one — all in the root folder, no subfolders.
3. Rename `.env.example` -> `.env` and fill it in (copy values from your old `.env`).
   `CHANNEL_ID` is pre-filled with your federico-ai channel (1495295260518252635) — verify it: Discord -> Settings -> Advanced -> Developer Mode, right-click the channel -> Copy Channel ID.
4. To keep Fed's memory: upload your saved data files from step 0 and **overwrite** the empty ones.

## 4. Startup settings
Server -> **Startup** (in the Configuration section of the sidebar). Set **Main file = `index.js`**. Leave Node packages / auto-update empty — the panel runs `npm install` itself because package.json exists.

## 5. Switch over (order matters)
1. **Stop the OLD server first.** Same bot token on two servers = every message answered twice.
2. Start the new server and watch **Console**.

## 6. What a healthy start looks like
```
Identity loaded — 9 entries, known: Rose, Neeraj, Dayana, Akshat, Pho, Dark, Lizz, Gajju, Diven
Memory loaded — N users
...
Fed 13.0 live.
```
A first `Daily rating` post can appear ~1 hour after boot if you didn't upload your old `fed_daily_rating.json` — harmless.
Occasional `Groq key N rate limited (429)` followed by another key responding is normal.

## 7. Troubleshooting
| Console says | Fix |
|---|---|
| `Login failed: An invalid token was provided` | wrong `DISCORD_TOKEN` in `.env` |
| `Used disallowed intents` | turn on Message Content Intent (step 1) |
| Starts fine but Fed never answers | wrong `CHANNEL_ID`, or you are not typing in that channel |
| `Cannot find module 'node-fetch'` (etc.) | package.json missing from the root folder; upload it and restart |
| `Identity file error` | `fed_identity.json` missing or edited into invalid JSON |
| Replies come twice | old server still running — stop it |

## Commands (admins / creator only, typed in the Fed channel)
```
!roast @u   !unroast @u   !fedmood   !rate now   !identity cleanup
!vault add <fact> | !vault show | !vault clear N
!rule add <rule>  | !rule show  | !rule clear N
!bio set @u <text> | !bio clear @u
!lang hindi | !lang english | !lang auto
!location ...   !know show | !know remove ...   !rel ...   !reset memory
```

## Tuning knobs inside index.js
- per-user memory depth: search `user.history.length > 40` and `slice(-40)`
- reply length caps: search `const maxTok`
- Groq key cooldown: `function coolKey(key, ms = 5000)`
