# Trello ⇄ Smartsheet 2‑Way Sync (Render-ready, no coding required)

This small app keeps **one Trello board** and **one Smartsheet sheet** in sync (create/update/delete both ways).

## What you need beforehand
- Trello **Key** and **Token**
- Smartsheet **Access Token**
- Your **Trello Board ID** and **Smartsheet Sheet ID**
- In Smartsheet: a Text column named **"Trello Card ID"**
- In Trello: a **Custom Field** named **"Smartsheet Row ID"** (Text)

## 1) Deploy on Render
1. Create a **new GitHub repo** and upload these files, or use the ZIP I shared.
2. In Render: **New → Web Service → Connect your repo**.
3. Environment:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the following **Environment Variables** (from `.env.example`):
   - `PORT=10000`
   - `PUBLIC_BASE_URL=https://<your-service>.onrender.com` (after first deploy, you can edit this to match your actual URL)
   - `SMARTSHEET_ACCESS_TOKEN=...`
   - `SMARTSHEET_SHEET_ID=...`
   - `SMARTSHEET_WEBHOOK_SHARED_SECRET=` set a long random string
   - `TRELLO_KEY=...`
   - `TRELLO_TOKEN=...`
   - `TRELLO_BOARD_ID=...`
   - `TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID=` (leave blank for now; we'll print it for you)

> Tip: Deploy once so you get your Render URL, then set `PUBLIC_BASE_URL` to that URL and redeploy.

## 2) One-time registration
Open a Render Shell or use a one-off command:
```
npm run register
```
This will:
- Print your Trello **"Smartsheet Row ID"** **Custom Field ID** → copy that value into your Render env var `TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID` and redeploy.
- Create the Trello webhook (board → your app).
- Create and **enable** the Smartsheet webhook (sheet → your app).

> Smartsheet will verify your callback by pinging `/webhooks/smartsheet`. Your app automatically echoes the challenge header back.

## 3) Test
- Create a card on the Trello board → a row should appear in Smartsheet.
- Create a row in Smartsheet → a card should appear in Trello.
- Updates and deletes should mirror both ways.

## Mapping (default)
- **Card title** ⇄ **Primary column**
- **Card description** ⇄ **"Description" column**
- **Card due date** ⇄ **"Due Date" column**
- Cross-links: **"Trello Card ID"** (Smartsheet) ⇄ **"Smartsheet Row ID"** (Trello custom field)

## Notes
- Free plans may "sleep" when idle. If verification fails the first time, hit your Render URL in a browser, then run `npm run register` again.
- You can extend the mapping (labels, lists, assignees) inside `server.js`.
