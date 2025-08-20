
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const smartsheetSDK = require('smartsheet');

const app = express();
app.use(bodyParser.json({ type: '*/*' }));

// --- Clients ---
const smartsheet = smartsheetSDK.createClient({ accessToken: process.env.SMARTSHEET_ACCESS_TOKEN });

const TRELLO = axios.create({
  baseURL: 'https://api.trello.com/1',
  params: { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN }
});

const PORT = process.env.PORT || 10000;
const SHEET_ID = Number(process.env.SMARTSHEET_SHEET_ID);
let CF_ROWID = process.env.TRELLO_CUSTOM_FIELD_SMARTSHEET_ROW_ID; // filled during register step

// --- Helpers ---
async function getSheetColumns() {
  const sheet = await smartsheet.sheets.getSheet({ id: SHEET_ID, include: 'columns' });
  const cols = {};
  for (const c of sheet.columns) cols[c.title] = c.id;
  return cols;
}

async function findRowByTrelloId(trelloId) {
  const cols = await getSheetColumns();
  const trelloColId = cols['Trello Card ID'];
  const sheet = await smartsheet.sheets.getSheet({ id: SHEET_ID });
  return sheet.rows.find(r => r.cells.some(cell => cell.columnId === trelloColId && cell.value === trelloId));
}

async function findCardBySmartsheetRowId(rowId) {
  const { data: cards } = await TRELLO.get(`/boards/${process.env.TRELLO_BOARD_ID}/cards`);
  for (const card of cards) {
    const { data: items } = await TRELLO.get(`/cards/${card.id}/customFieldItems`);
    const match = items.find(i => i.idCustomField === CF_ROWID && i.value && i.value.text === String(rowId));
    if (match) return card;
  }
  return null;
}

async function getDefaultList() {
  const { data: lists } = await TRELLO.get(`/boards/${process.env.TRELLO_BOARD_ID}/lists`, { params: { cards: 'none' } });
  const open = lists.find(l => !l.closed) || lists[0];
  return open.id;
}

async function upsertRowFromCard(card) {
  const cols = await getSheetColumns();
  const primaryColId = Object.values(cols)[0]; // primary (leftmost) column id
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
    await smartsheet.sheets.updateRows({ sheetId: SHEET_ID, body: [{ id: existing.id, cells }] });
    return existing.id;
  } else {
    const added = await smartsheet.sheets.addRows({ sheetId: SHEET_ID, body: [{ toTop: true, cells }] });
    return added.result[0].id;
  }
}

async function upsertCardFromRow(row, columnsMap) {
  const byIdToTitle = Object.fromEntries(Object.entries(columnsMap).map(([title, id]) => [id, title]));
  const title = row.cells.find(c => c.columnId === Object.values(columnsMap)[0])?.value || '(no title)';
  const desc = row.cells.find(c => byIdToTitle[c.columnId] === 'Description')?.value || '';
  const due  = row.cells.find(c => byIdToTitle[c.columnId] === 'Due Date')?.value || null;
  const trelloId = row.cells.find(c => byIdToTitle[c.columnId] === 'Trello Card ID')?.value;

  if (trelloId) {
    await TRELLO.put(`/cards/${trelloId}`, { name: title, desc, due });
    if (CF_ROWID) {
      await TRELLO.put(`/cards/${trelloId}/customField/${CF_ROWID}/item`, { value: { text: String(row.id) } });
    }
    return trelloId;
  } else {
    const idList = await getDefaultList();
    const { data: card } = await TRELLO.post(`/cards`, { idList, name: title, desc, due });
    if (CF_ROWID) {
      await TRELLO.put(`/cards/${card.id}/customField/${CF_ROWID}/item`, { value: { text: String(row.id) } });
    }
    const cols = await getSheetColumns();
    await smartsheet.sheets.updateRows({
      sheetId: SHEET_ID,
      body: [{ id: row.id, cells: [{ columnId: cols['Trello Card ID'], value: card.id }] }]
    });
    return card.id;
  }
}

// --- Trello webhook endpoints ---
app.head('/webhooks/trello', (req, res) => res.sendStatus(200));
app.post('/webhooks/trello', async (req, res) => {
  res.sendStatus(200);
  try {
    const action = req.body?.action?.type;
    const card = req.body?.action?.data?.card;
    if (!card) return;

    if (['createCard', 'updateCard', 'copyCard', 'moveCardToBoard'].includes(action)) {
      const { data: full } = await TRELLO.get(`/cards/${card.id}`);
      await upsertRowFromCard(full);
    } else if (action === 'deleteCard' || action === 'moveCardFromBoard') {
      const row = await findRowByTrelloId(card.id);
      if (row) await smartsheet.sheets.deleteRows({ sheetId: SHEET_ID, rowIds: [row.id] });
    }
  } catch (e) {
    console.error('Trello webhook error:', e.response?.data || e.message);
  }
});

// --- Smartsheet webhook endpoint ---
app.post('/webhooks/smartsheet', async (req, res) => {
  // Verification handshake
  const challenge = req.headers['smartsheet-hook-challenge'];
  if (challenge) {
    res.set('Smartsheet-Hook-Response', challenge);
    return res.sendStatus(200);
  }

  // Optional HMAC verification for production
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
        const row = await smartsheet.sheets.getRow({ sheetId: SHEET_ID, rowId: ev.id, include: 'cells' });
        await upsertCardFromRow(row, cols);
      } else if (ev.eventType === 'DELETED') {
        const card = await findCardBySmartsheetRowId(ev.id);
        if (card) await TRELLO.delete(`/cards/${card.id}`);
      }
    }
  } catch (e) {
    console.error('Smartsheet webhook error:', e.response?.data || e.message);
  }
});

app.get('/', (req, res) => res.send('✅ Trello ⇄ Smartsheet sync is running'));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
