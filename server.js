
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ type: '*/*' }));

function has(v){ return !!(v && String(v).trim().length); }
function flag(name){ return has(process.env[name]) ? '✅' : '❌'; }
console.log('[BOOT] Env check:',
  `PORT=${process.env.PORT||'10000'}`,
  `PUBLIC_BASE_URL=${flag('PUBLIC_BASE_URL')}`,
  `SMARTSHEET_ACCESS_TOKEN=${flag('SMARTSHEET_ACCESS_TOKEN')}`,
  `SMARTSHEET_SHEET_ID=${flag('SMARTSHEET_SHEET_ID')}`,
  `SMARTSHEET_WEBHOOK_SHARED_SECRET=${flag('SMARTSHEET_WEBHOOK_SHARED_SECRET')}`,
  `TRELLO_KEY=${flag('TRELLO_KEY')}`,
  `TRELLO_TOKEN=${flag('TRELLO_TOKEN')}`,
  `TRELLO_BOARD_ID=${flag('TRELLO_BOARD_ID')}`,
  `TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID=${flag('TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID')}`,
  `ADMIN_SECRET=${flag('ADMIN_SECRET')}`
);

let smartsheet = null;
function getSmartsheet() {
  if (smartsheet) return smartsheet;
  const token = process.env.SMARTSHEET_ACCESS_TOKEN;
  if (!has(token)) {
    console.warn('[WARN] SMARTSHEET_ACCESS_TOKEN missing; Smartsheet actions disabled.');
    return null;
  }
  try {
    const sdk = require('smartsheet');
    smartsheet = sdk.createClient({ accessToken: token });
    return smartsheet;
  } catch (e) {
    console.error('[ERROR] Creating Smartsheet client failed:', e.message);
    return null;
  }
}

function trelloClient() {
  return axios.create({
    baseURL: 'https://api.trello.com/1',
    params: { key: process.env.TRELLO_KEY || '', token: process.env.TRELLO_TOKEN || '' }
  });
}

async function getSheetColumns() {
  const ss = getSmartsheet();
  if (!ss) throw new Error('Smartsheet client not initialized');
  const id = Number(process.env.SMARTSHEET_SHEET_ID);
  if (!id) throw new Error('SMARTSHEET_SHEET_ID missing/invalid');
  const sheet = await ss.sheets.getSheet({ id, include: 'columns' });
  const cols = {};
  for (const c of sheet.columns) cols[c.title] = c.id;
  return cols;
}

async function findRowByTrelloId(trelloId) {
  const ss = getSmartsheet();
  const id = Number(process.env.SMARTSHEET_SHEET_ID);
  const cols = await getSheetColumns();
  const trelloColId = cols['Trello Card ID'];
  const sheet = await ss.sheets.getSheet({ id });
  return sheet.rows.find(r => r.cells.some(cell => cell.columnId === trelloColId && cell.value === trelloId));
}

async function findCardBySmartsheetRowId(rowId) {
  const T = trelloClient();
  const { data: cards } = await T.get(`/boards/${process.env.TRELLO_BOARD_ID}/cards`);
  const cfId = process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID;
  for (const card of cards) {
    const { data: items } = await T.get(`/cards/${card.id}/customFieldItems`);
    const match = items.find(i => i.idCustomField === cfId && i.value && i.value.text === String(rowId));
    if (match) return card;
  }
  return null;
}

async function getDefaultList() {
  const T = trelloClient();
  const { data: lists } = await T.get(`/boards/${process.env.TRELLO_BOARD_ID}/lists`, { params: { cards: 'none' } });
  const open = lists.find(l => !l.closed) || lists[0];
  return open.id;
}

async function upsertRowFromCard(card) {
  const ss = getSmartsheet();
  const id = Number(process.env.SMARTSHEET_SHEET_ID);
  const cols = await getSheetColumns();
  const primaryColId = Object.values(cols)[0];
  const descColId = cols['Description'];
  const dueColId  = cols['Due Date'];
  const trelloColId = cols['Trello Card ID'];

  const existing = await findRowByTrelloId(card.id);
  const cells = [
    { columnId: primaryColId, value: card.name || '' },
    ...(descColId ? [{ columnId: descColId, value: card.desc || '' }] : []),
    { columnId: trelloColId, value: card.id }
  ];
  if (dueColId) cells.push({ columnId: dueColId, value: card.due ? new Date(card.due).toISOString() : null });

  if (existing) {
    await ss.sheets.updateRows({ sheetId: id, body: [{ id: existing.id, cells }] });
    return existing.id;
  } else {
    const added = await ss.sheets.addRows({ sheetId: id, body: [{ toTop: true, cells }] });
    return added.result[0].id;
  }
}

async function upsertCardFromRow(row, columnsMap) {
  const T = trelloClient();
  const byIdToTitle = Object.fromEntries(Object.entries(columnsMap).map(([title, id]) => [id, title]));
  const title = row.cells.find(c => c.columnId === Object.values(columnsMap)[0])?.value || '(no title)';
  const desc = row.cells.find(c => byIdToTitle[c.columnId] === 'Description')?.value || '';
  const due  = row.cells.find(c => byIdToTitle[c.columnId] === 'Due Date')?.value || null;
  const trelloId = row.cells.find(c => byIdToTitle[c.columnId] === 'Trello Card ID')?.value;

  if (trelloId) {
    await T.put(`/cards/${trelloId}`, { name: title, desc, due });
    const cfId = process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID;
    if (cfId) {
      await T.put(`/cards/${trelloId}/customField/${cfId}/item`, { value: { text: String(row.id) } });
    }
    return trelloId;
  } else {
    const idList = await getDefaultList();
    const { data: card } = await T.post(`/cards`, { idList, name: title, desc, due });
    const cfId = process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID;
    if (cfId) {
      await T.put(`/cards/${card.id}/customField/${cfId}/item`, { value: { text: String(row.id) } });
    }
    const cols = await getSheetColumns();
    await getSmartsheet().sheets.updateRows({
      sheetId: Number(process.env.SMARTSHEET_SHEET_ID),
      body: [{ id: row.id, cells: [{ columnId: cols['Trello Card ID'], value: card.id }] }]
    });
    return card.id;
  }
}

app.head('/webhooks/trello', (req, res) => res.sendStatus(200));
app.post('/webhooks/trello', async (req, res) => {
  res.sendStatus(200);
  try {
    const action = req.body?.action?.type;
    const card = req.body?.action?.data?.card;
    if (!card) return;
    const T = trelloClient();

    if (['createCard', 'updateCard', 'copyCard', 'moveCardToBoard'].includes(action)) {
      const { data: full } = await T.get(`/cards/${card.id}`);
      await upsertRowFromCard(full);
    } else if (action === 'deleteCard' || action === 'moveCardFromBoard') {
      const row = await findRowByTrelloId(card.id);
      if (row) await getSmartsheet().sheets.deleteRows({ sheetId: Number(process.env.SMARTSHEET_SHEET_ID), rowIds: [row.id] });
    }
  } catch (e) {
    console.error('[Trello webhook error]', e.response?.data || e.message);
  }
});

app.post('/webhooks/smartsheet', async (req, res) => {
  const challenge = req.headers['smartsheet-hook-challenge'];
  if (challenge) {
    res.set('Smartsheet-Hook-Response', challenge);
    return res.sendStatus(200);
  }

  const secret = process.env.SMARTSHEET_WEBHOOK_SHARED_SECRET;
  const expected = req.headers['smartsheet-hmac-sha256'];
  if (secret && expected) {
    const raw = JSON.stringify(req.body || {});
    const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (hmac !== expected) return res.status(401).send('Invalid HMAC');
  }

  res.sendStatus(200);

  try {
    const events = req.body?.events || [];
    const cols = await getSheetColumns();

    for (const ev of events) {
      if (ev.objectType !== 'ROW') continue;
      if (ev.eventType === 'CREATED' || ev.eventType === 'UPDATED') {
        const row = await getSmartsheet().sheets.getRow({ sheetId: Number(process.env.SMARTSHEET_SHEET_ID), rowId: ev.id, include: 'cells' });
        await upsertCardFromRow(row, cols);
      } else if (ev.eventType === 'DELETED') {
        const card = await findCardBySmartsheetRowId(ev.id);
        if (card) await trelloClient().delete(`/cards/${card.id}`);
      }
    }
  } catch (e) {
    console.error('[Smartsheet webhook error]', e.response?.data || e.message);
  }
});

app.get('/admin/register', async (req, res) => {
  try {
    const has = (v) => !!(v && String(v).trim().length);
    if (!has(process.env.ADMIN_SECRET) || req.query.secret !== process.env.ADMIN_SECRET) {
      return res.status(401).send('Unauthorized');
    }
    const base = process.env.PUBLIC_BASE_URL;
    if (!has(base)) return res.status(400).send('PUBLIC_BASE_URL not set');

    const ss = getSmartsheet();
    if (!ss) return res.status(400).send('Smartsheet not configured');

    const T = trelloClient();

    const { data: cfs } = await T.get(`/boards/${process.env.TRELLO_BOARD_ID}/customFields`);
    const cf = cfs.find(f => f.name === 'Smartsheet Row ID');
    if (!cf) return res.status(400).send('Create a Trello Custom Field named "Smartsheet Row ID" (Text) on your board first.');

    await T.post(`/webhooks`, { description: 'Trello→Server board webhook', callbackURL: `${base}/webhooks/trello`, idModel: process.env.TRELLO_BOARD_ID });

    const create = await ss.webhooks.createWebhook({
      body: {
        name: 'Smartsheet→Server sheet webhook',
        callbackUrl: `${base}/webhooks/smartsheet`,
        scope: 'sheet',
        scopeObjectId: Number(process.env.SMARTSHEET_SHEET_ID),
        events: ['*.*'],
        version: 1,
        sharedSecret: process.env.SMARTSHEET_WEBHOOK_SHARED_SECRET
      }
    });
    const webhookId = create.result.id;
    await ss.webhooks.updateWebhook({ webhookId, body: { enabled: true } });

    res.json({ message: 'Registration complete', trelloCustomFieldId: cf.id, note: 'Set TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID to this value in Render env, then redeploy.' });
  } catch (e) {
    console.error('[Admin register error]', e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

app.get('/health', (req, res) => {
  const has = (v) => !!(v && String(v).trim().length);
  res.json({
    ok: true, uptime: process.uptime(),
    env: {
      PUBLIC_BASE_URL: has(process.env.PUBLIC_BASE_URL),
      SMARTSHEET_ACCESS_TOKEN: has(process.env.SMARTSHEET_ACCESS_TOKEN),
      SMARTSHEET_SHEET_ID: has(process.env.SMARTSHEET_SHEET_ID),
      TRELLO_KEY: has(process.env.TRELLO_KEY),
      TRELLO_TOKEN: has(process.env.TRELLO_TOKEN),
      TRELLO_BOARD_ID: has(process.env.TRELLO_BOARD_ID),
      TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID: has(process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID)
    }
  });
});

app.get('/', (req, res) => res.send('✅ Trello ⇄ Smartsheet sync is running'));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.stack || err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.stack || err));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Listening on', PORT));
