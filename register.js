
require('dotenv').config();
const axios = require('axios');
const smartsheetSDK = require('smartsheet');

const smartsheet = smartsheetSDK.createClient({ accessToken: process.env.SMARTSHEET_ACCESS_TOKEN });
const TRELLO = axios.create({ baseURL: 'https://api.trello.com/1', params: { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN } });

const BASE = process.env.PUBLIC_BASE_URL;
const SHEET_ID = Number(process.env.SMARTSHEET_SHEET_ID);

(async function run() {
  try {
    // 1) Print Trello custom field id for "Smartsheet Row ID"
    const { data: cfs } = await TRELLO.get(`/boards/${process.env.TRELLO_BOARD_ID}/customFields`);
    const cf = cfs.find(f => f.name === 'Smartsheet Row ID');
    if (!cf) {
      console.log('❌ Create a Trello Custom Field named "Smartsheet Row ID" (Text) on your board first.');
      process.exit(1);
    }
    console.log('ℹ️ Trello Custom Field "Smartsheet Row ID" id:', cf.id);
    if (!process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID) {
      console.log('👉 Add this value to your Render env var TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID after this step.');
    }

    // 2) Create Trello webhook for the board
    await TRELLO.post(`/webhooks`, {
      description: 'Trello→Server board webhook',
      callbackURL: `${BASE}/webhooks/trello`,
      idModel: process.env.TRELLO_BOARD_ID
    });
    console.log('✅ Trello webhook created →', `${BASE}/webhooks/trello`);

    // 3) Create Smartsheet webhook (disabled at first)
    const create = await smartsheet.webhooks.createWebhook({
      body: {
        name: 'Smartsheet→Server sheet webhook',
        callbackUrl: `${BASE}/webhooks/smartsheet`,
        scope: 'sheet',
        scopeObjectId: SHEET_ID,
        events: ['*.*'],
        version: 1,
        sharedSecret: process.env.SMARTSHEET_WEBHOOK_SHARED_SECRET
      }
    });
    const webhookId = create.result.id;
    console.log('✅ Smartsheet webhook created:', webhookId);

    // 4) Enable Smartsheet webhook (this triggers verification handshake)
    await smartsheet.webhooks.updateWebhook({ webhookId, body: { enabled: true } });
    console.log('⏳ Requested enable on Smartsheet webhook. Smartsheet will ping your /webhooks/smartsheet endpoint to verify.');

    console.log('\n🎉 Initial registration complete.');
    console.log('   • Paste the printed Trello custom field id into env var TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID if you left it blank.');
    console.log('   • Ensure your Smartsheet sheet has columns: Primary, Description (Text), Due Date (Date), Trello Card ID (Text).');
  } catch (e) {
    console.error('Registration error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
