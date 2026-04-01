import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

const app = express();
app.use(cors());
app.use(express.json());

// ── 設定 ────────────────────────────────────────────
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD  = process.env.DASHBOARD_PASSWORD || 'igip2026';
const MEMBER_PASSWORD = process.env.MEMBER_PASSWORD    || 'igip-member';

// ── 認証ヘルパー ─────────────────────────────────────
function getCookie(req, name) {
  return req.headers.cookie?.match(new RegExp(`${name}=([^;]+)`))?.[1];
}
function isAdmin(req)  { return getCookie(req, 'dtoken') === ADMIN_PASSWORD; }
function isMember(req) { return getCookie(req, 'mtoken') === MEMBER_PASSWORD || isAdmin(req); }

// ── ルート認証ミドルウェア ───────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path === '/login' || req.path === '/member-login') return next();
  if (req.method === 'POST' && (req.path === '/login' || req.path === '/member-login')) return next();

  // /board系はメンバー以上でOK
  if (req.path.startsWith('/board') || req.path === '/api/board-data' || req.path === '/api/member-update') {
    if (isMember(req)) return next();
    if (req.headers.accept?.includes('text/html')) return res.redirect('/member-login');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // /api/sync, /api/send-remind は管理者のみ
  if (req.path.startsWith('/api/')) {
    if (isAdmin(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // その他（/ = 管理画面）
  if (isAdmin(req)) return next();
  if (req.headers.accept?.includes('text/html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Unauthorized' });
});

// ── ログインページ共通HTML ───────────────────────────
function loginHtml({ title, action, hint, err }) {
  return `<!DOCTYPE html>
<html lang="ja"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{background:#0d0f14;color:#e2e8f0;font-family:'Hiragino Sans',sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{background:#161a22;border:1px solid #252d3d;border-radius:16px;padding:40px;width:320px;}
    .logo{background:linear-gradient(135deg,#4f8ef7,#a78bfa);color:#fff;font-weight:800;
      font-size:13px;padding:5px 10px;border-radius:8px;display:inline-block;margin-bottom:20px;}
    h2{font-size:18px;margin-bottom:6px;}
    p{font-size:12px;color:#64748b;margin-bottom:24px;}
    input{width:100%;padding:11px 14px;background:#1e2330;border:1px solid #252d3d;
      border-radius:9px;color:#e2e8f0;font-size:14px;box-sizing:border-box;margin-bottom:12px;}
    button{width:100%;padding:12px;background:#4f8ef7;color:#fff;border:none;
      border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;}
    button:hover{opacity:.9;}
    .err{color:#f87171;font-size:12px;margin-top:8px;}
    .hint{font-size:11px;color:#64748b;margin-top:12px;text-align:center;}
  </style>
</head><body>
<div class="box">
  <div class="logo">i-GIP</div>
  <h2>Kanto 2026</h2>
  <p>${hint}</p>
  <form method="POST" action="${action}">
    <input type="password" name="password" placeholder="パスワード" autofocus>
    <button type="submit">ログイン</button>
    ${err ? '<div class="err">パスワードが違います</div>' : ''}
  </form>
</div>
</body></html>`;
}

app.get('/login', (req, res) => res.send(loginHtml({
  title: 'i-GIP 管理者ログイン', action: '/login',
  hint: '管理者パスワードを入力してください', err: req.query.err
})));

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `dtoken=${ADMIN_PASSWORD}; Path=/; HttpOnly; Max-Age=604800`);
    return res.redirect('/');
  }
  res.redirect('/login?err=1');
});

app.get('/member-login', (req, res) => res.send(loginHtml({
  title: 'i-GIP メンバーログイン', action: '/member-login',
  hint: 'メンバーパスワードを入力してください', err: req.query.err
})));

app.post('/member-login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === MEMBER_PASSWORD || req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `mtoken=${MEMBER_PASSWORD}; Path=/; HttpOnly; Max-Age=604800`);
    return res.redirect('/board');
  }
  res.redirect('/member-login?err=1');
});

// 静的ファイルはauth後に配信
app.use(express.static(new URL('.', import.meta.url).pathname));

const DEPTS = [
  { id: 'gaiko',     name: '渉外',               channelId: 'C0ADED2VBEX', driveQuery: '渉外 OR 助成金 OR スポンサー OR LINK-J' },
  { id: 'chuko',     name: '中高リク',            channelId: 'C0ADHBXKJNR', driveQuery: '中高生 OR 中高リク OR 高校生 OR フライヤー' },
  { id: 'daigaku',   name: '大学生リク',          channelId: 'C0ADED1S95Z', driveQuery: '大学生 OR 大学生リク OR リーフレット OR 説明会' },
  { id: 'kyopro',    name: '教プロ',              channelId: 'C0ADV64GY04', driveQuery: '教プロ OR プログラム OR カリキュラム' },
  { id: 'koho',      name: '広報',                channelId: 'C0ALJ7EJU4U', driveQuery: '広報 OR SNS OR インスタ OR 広報活動' },
  { id: 'research',  name: 'リサーチ',            channelId: 'C0ADZNACX4H', driveQuery: 'リサーチ OR 疾患 OR 調査' },
  { id: 'create',    name: 'クリエ',              channelId: 'C0AG0V137U7', driveQuery: 'クリエ OR デザイン OR ビジュアル' },
  { id: 'community', name: 'コミュニティデザイン', channelId: 'C0AHSLYCD1R', driveQuery: 'コミュニティ OR 交流会 OR コミュニティデザイン' },
];

// ── Google 認証（Drive + Gmail 共用）────────────────
const GOOGLE_CREDS_PATH = '/Users/60tigure/.config/gdrive-mcp/credentials.json';
const GOOGLE_TOKEN_PATH = '/Users/60tigure/.config/gdrive-mcp/token.json';

function loadGoogleCredentials() {
  // 環境変数（Railway等クラウド用）
  if (process.env.GOOGLE_CREDENTIALS_B64 && process.env.GOOGLE_TOKEN_B64) {
    const creds = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString());
    const token = JSON.parse(Buffer.from(process.env.GOOGLE_TOKEN_B64, 'base64').toString());
    return { creds, token };
  }
  // ローカルファイル
  const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH));
  const token = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH));
  return { creds, token };
}
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function getGoogleAuth() {
  try {
    const { creds, token } = loadGoogleCredentials();
    const { client_id, client_secret } = creds.installed || creds.web || creds;
    const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/auth/callback');
    auth.setCredentials(token);
    // トークン更新時に保存（ローカルのみ。クラウドはenv var経由なのでスキップ）
    auth.on('tokens', (tokens) => {
      try {
        if (fs.existsSync(GOOGLE_TOKEN_PATH)) {
          const current = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH));
          fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
        }
      } catch (_) {}
    });
    return auth;
  } catch (e) {
    console.warn('Google auth failed:', e.message);
    return null;
  }
}

function getDriveClient() {
  const auth = getGoogleAuth();
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

function getGmailClient() {
  const auth = getGoogleAuth();
  if (!auth) return null;
  return google.gmail({ version: 'v1', auth });
}

// ── Gmail OAuth フロー ───────────────────────────────
app.get('/auth/gmail', (req, res) => {
  try {
    const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH));
    const { client_id, client_secret } = creds.installed || creds.web || creds;
    const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/auth/callback');
    const url = auth.generateAuthUrl({ access_type: 'offline', scope: GOOGLE_SCOPES, prompt: 'consent' });
    res.redirect(url);
  } catch (e) {
    res.status(500).send('認証情報の読み込みに失敗: ' + e.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH));
    const { client_id, client_secret } = creds.installed || creds.web || creds;
    const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/auth/callback');
    const { tokens } = await auth.getToken(req.query.code);
    fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify(tokens));
    console.log('✅ Gmail認証完了');
    res.send('<script>window.close()</script><p>✅ Gmail連携完了！このタブを閉じてください。</p>');
  } catch (e) {
    res.status(500).send('コールバック処理失敗: ' + e.message);
  }
});

// ── Slack: チャンネル履歴を取得 ─────────────────────
async function getSlackHistory(channelId, limit = 80) {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${channelId}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.ok) return [];
  return data.messages
    .filter(m => m.text && !m.bot_id)
    .map(m => ({
      ts: new Date(parseFloat(m.ts) * 1000).toLocaleDateString('ja'),
      text: m.text.replace(/<[^>]+>/g, '').trim()
    }))
    .filter(m => m.text.length > 5);
}

// ── Slack: DM履歴を取得（守安さん宛て） ─────────────
let _myUserId = null;
async function getMyUserId() {
  if (_myUserId) return _myUserId;
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
  });
  const data = await res.json();
  _myUserId = data.user_id;
  return _myUserId;
}

async function getDMsForDept(deptKeywords, limit = 40) {
  try {
    // IM一覧取得
    const res = await fetch('https://slack.com/api/conversations.list?types=im&limit=100', {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const data = await res.json();
    if (!data.ok || !data.channels) return [];

    const allDMs = [];
    for (const ch of data.channels.slice(0, 20)) { // 上位20DM
      const hist = await fetch(
        `https://slack.com/api/conversations.history?channel=${ch.id}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
      );
      const hData = await hist.json();
      if (!hData.ok) continue;
      const relevant = (hData.messages || [])
        .filter(m => m.text && deptKeywords.some(k => m.text.includes(k)))
        .map(m => ({
          ts: new Date(parseFloat(m.ts) * 1000).toLocaleDateString('ja'),
          text: '[DM] ' + m.text.replace(/<[^>]+>/g, '').trim()
        }));
      allDMs.push(...relevant);
    }
    return allDMs.slice(0, 15); // 最大15件
  } catch (e) {
    return [];
  }
}

// ── Gmail: 部署関連メールを取得 ──────────────────────
async function getGmailMessages(gmail, query, maxResults = 10) {
  if (!gmail) return [];
  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
    const messages = listRes.data.messages || [];
    const results = [];
    for (const msg of messages.slice(0, 5)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const headers = detail.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      if (subject) results.push(`[Gmail ${date.slice(0,10)}] ${from.split('<')[0].trim()}: ${subject}`);
    }
    return results;
  } catch (e) {
    return [];
  }
}

// ── Drive: 関連ファイルを検索 ───────────────────────
async function getDriveFiles(drive, query) {
  if (!drive) return [];
  try {
    const res = await drive.files.list({
      q: `fullText contains '${query.split(' OR ')[0]}' and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 5,
    });
    return (res.data.files || []).map(f => f.name);
  } catch (e) {
    return [];
  }
}

// ── Claude で進捗分析 ───────────────────────────────
async function analyzeDept(dept, slackMessages, driveFiles, dmMessages = [], gmailMessages = []) {
  if (!ANTHROPIC_API_KEY) {
    return fallbackData(dept);
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const slackText = slackMessages.length
    ? slackMessages.map(m => `[${m.ts}] ${m.text}`).join('\n')
    : '（メッセージなし）';

  const driveText = driveFiles.length
    ? driveFiles.join(', ')
    : '（ファイルなし）';

  const dmText = dmMessages.length
    ? dmMessages.map(m => `[${m.ts}] ${m.text}`).join('\n')
    : '（DMなし）';

  const gmailText = gmailMessages.length
    ? gmailMessages.join('\n')
    : '（Gmailなし）';

  const prompt = `あなたはi-GIP Kanto 2026というスタートアップ育成プログラムの統括「守安巧」のアシスタントです。
以下の${dept.name}部署のSlack・DM・Gmail・Driveを分析して、JSONで回答してください。

## Slackチャンネルメッセージ（最新80件）
${slackText}

## Slack DM（守安さん宛ての関連DM）
${dmText}

## Gmail（関連メール件名）
${gmailText}

## Driveファイル
${driveText}

## 回答形式（必ずこのJSONのみ返してください）
{
  "done": ["完了した具体的なタスク（最大4件）"],
  "todo": ["次にやるべき具体的なタスク（最大4件）"],
  "blockers": ["詰まっていること・懸念事項（最大2件、なければ空配列）"],
  "status": "green または yellow または red（green=順調, yellow=要確認, red=止まってる）",
  "insight": "この部署への戦略的な洞察・面白い次の一手（2〜3文）",
  "ideas": ["次に面白そうなアクション（3件）"],
  "remind": "守安くんのSlackメッセージ風リマインド文（絵文字あり・フレンドリー・具体的な質問2〜3個含む）"
}`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return fallbackData(dept, slackMessages);
  } catch (e) {
    console.error(`Claude analysis failed for ${dept.name}:`, e.message);
    return fallbackData(dept, slackMessages);
  }
}

function fallbackData(dept, slackMessages = []) {
  // Slackメッセージからキーワードを抽出してある程度の情報を表示
  const recentMsgs = slackMessages.slice(0, 10).map(m => m.text);
  const allText = recentMsgs.join(' ');

  // 完了・進行中を簡易抽出
  const doneKeywords = ['完了', '済み', 'できた', '送った', '終わった', '提出', '確認済'];
  const blockKeywords = ['困って', '詰まって', '遅れ', '未定', 'どうしよう', '相談'];
  const hasDone = doneKeywords.some(k => allText.includes(k));
  const hasBlock = blockKeywords.some(k => allText.includes(k));

  const status = hasBlock ? 'red' : hasDone ? 'green' : 'yellow';
  const todo = recentMsgs.length > 0
    ? recentMsgs.slice(0,3).map(m => m.slice(0, 60) + (m.length > 60 ? '...' : ''))
    : ['（Slackメッセージなし）'];

  return {
    done: hasDone ? ['直近のSlackで完了報告あり（詳細はSlack参照）'] : [],
    todo,
    blockers: hasBlock ? ['直近のSlackで困りごとの投稿あり'] : [],
    status,
    insight: `${dept.name}の詳細分析にはAPIクレジットが必要です。console.anthropic.comでクレジットを追加してください。`,
    ideas: [],
    remind: `${dept.name}チーム、お疲れ様！今週の進捗を教えてください 🙏`
  };
}

// ── API: 全部署を一括同期 ───────────────────────────
app.get('/api/sync', async (req, res) => {
  console.log('🔄 Sync started (Slack + DM + Gmail + Drive)...');
  const drive = getDriveClient();
  const gmail = getGmailClient();
  const results = [];

  for (const dept of DEPTS) {
    console.log(`  → Analyzing ${dept.name}...`);
    const keywords = dept.driveQuery.split(' OR ');
    const gmailQuery = keywords.slice(0, 3).join(' OR ');

    const [slackMessages, driveFiles, dmMessages, gmailMessages] = await Promise.all([
      getSlackHistory(dept.channelId),
      getDriveFiles(drive, dept.driveQuery),
      getDMsForDept(keywords),
      getGmailMessages(gmail, gmailQuery),
    ]);

    const analysis = await analyzeDept(dept, slackMessages, driveFiles, dmMessages, gmailMessages);
    results.push({
      id: dept.id,
      name: dept.name,
      channelId: dept.channelId,
      slackCount: slackMessages.length,
      dmCount: dmMessages.length,
      gmailCount: gmailMessages.length,
      driveFiles,
      ...analysis,
    });
  }

  console.log('✅ Sync complete');
  const payload = { ok: true, updatedAt: new Date().toISOString(), depts: results };
  fs.writeFileSync(CACHE_LOCAL_PATH, JSON.stringify(payload));
  saveCacheToDrive(payload); // 非同期でDriveにバックアップ
  res.json(payload);
});

// ── Drive: キャッシュ保存・読み込み ─────────────────
const CACHE_DRIVE_FILENAME = 'igip-dashboard-cache.json';
const CACHE_LOCAL_PATH = new URL('cache.json', import.meta.url).pathname;
const MEMBER_UPDATES_DRIVE_FILENAME = 'igip-dashboard-member-updates.json';

async function saveCacheToDrive(payload) {
  try {
    const drive = getDriveClient();
    if (!drive) return;
    const content = JSON.stringify(payload);
    // 既存ファイルを検索
    const list = await drive.files.list({
      q: `name='${CACHE_DRIVE_FILENAME}' and trashed=false`,
      fields: 'files(id)',
    });
    if (list.data.files?.length) {
      await drive.files.update({
        fileId: list.data.files[0].id,
        media: { mimeType: 'application/json', body: content },
      });
    } else {
      await drive.files.create({
        requestBody: { name: CACHE_DRIVE_FILENAME, mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: content },
      });
    }
    console.log('💾 Cache saved to Drive');
  } catch (e) {
    console.warn('Drive cache save failed:', e.message);
  }
}

async function loadCacheFromDrive() {
  try {
    const drive = getDriveClient();
    if (!drive) return null;
    const list = await drive.files.list({
      q: `name='${CACHE_DRIVE_FILENAME}' and trashed=false`,
      fields: 'files(id)',
    });
    if (!list.data.files?.length) return null;
    const res = await drive.files.get(
      { fileId: list.data.files[0].id, alt: 'media' },
      { responseType: 'text' }
    );
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    // ローカルにも保存
    fs.writeFileSync(CACHE_LOCAL_PATH, JSON.stringify(data));
    console.log('📥 Cache loaded from Drive');
    return data;
  } catch (e) {
    console.warn('Drive cache load failed:', e.message);
    return null;
  }
}

async function saveMemberUpdatesToDrive(data) {
  try {
    const drive = getDriveClient();
    if (!drive) return;
    const content = JSON.stringify(data);
    const list = await drive.files.list({
      q: `name='${MEMBER_UPDATES_DRIVE_FILENAME}' and trashed=false`,
      fields: 'files(id)',
    });
    if (list.data.files?.length) {
      await drive.files.update({
        fileId: list.data.files[0].id,
        media: { mimeType: 'application/json', body: content },
      });
    } else {
      await drive.files.create({
        requestBody: { name: MEMBER_UPDATES_DRIVE_FILENAME, mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: content },
      });
    }
  } catch (e) {
    console.warn('Drive member-updates save failed:', e.message);
  }
}

async function loadMemberUpdatesFromDrive() {
  try {
    const drive = getDriveClient();
    if (!drive) return null;
    const list = await drive.files.list({
      q: `name='${MEMBER_UPDATES_DRIVE_FILENAME}' and trashed=false`,
      fields: 'files(id)',
    });
    if (!list.data.files?.length) return null;
    const res = await drive.files.get(
      { fileId: list.data.files[0].id, alt: 'media' },
      { responseType: 'text' }
    );
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    fs.writeFileSync(MEMBER_UPDATES_PATH, JSON.stringify(data));
    console.log('📥 Member updates loaded from Drive');
    return data;
  } catch (e) {
    return null;
  }
}

// ── サーバー起動時にDriveからキャッシュ復元 ──────────
async function restoreFromDrive() {
  console.log('🔄 Restoring cache from Drive...');
  await Promise.all([
    loadCacheFromDrive(),
    loadMemberUpdatesFromDrive(),
  ]);
}

// ── API: キャッシュ取得（即時表示用） ───────────────
app.get('/api/cache', (req, res) => {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_LOCAL_PATH));
    res.json(cache);
  } catch {
    res.json({ ok: false, depts: [] });
  }
});

// ── API: Gmail認証状態確認 ──────────────────────────
app.get('/api/gmail-status', (req, res) => {
  try {
    const token = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH));
    const hasGmail = token.scope?.includes('gmail');
    res.json({ connected: hasGmail });
  } catch {
    res.json({ connected: false });
  }
});

// ── API: Slackにリマインドを送信 ────────────────────
app.post('/api/send-remind', async (req, res) => {
  const { channelId, message } = req.body;
  const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text: message }),
  });
  const data = await slackRes.json();
  res.json({ ok: data.ok, error: data.error });
});

// ── メンバー更新データ管理 ───────────────────────────
const MEMBER_UPDATES_PATH = new URL('member_updates.json', import.meta.url).pathname;

function loadMemberUpdates() {
  try { return JSON.parse(fs.readFileSync(MEMBER_UPDATES_PATH)); } catch { return {}; }
}
function saveMemberUpdates(data) {
  fs.writeFileSync(MEMBER_UPDATES_PATH, JSON.stringify(data, null, 2));
}

// ── API: メンバー用ボードデータ取得 ─────────────────
app.get('/api/board-data', async (req, res) => {
  try {
    let cache;
    // ローカルキャッシュが空の場合はDriveから取得
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_LOCAL_PATH));
      if (!cache?.depts?.length) throw new Error('empty');
    } catch {
      console.log('Local cache empty, loading from Drive...');
      cache = await loadCacheFromDrive();
    }
    if (!cache?.depts?.length) return res.json({ ok: false, depts: [] });

    // メンバー更新も同様にDriveから復元
    let updates = loadMemberUpdates();
    if (!Object.keys(updates).length) {
      const driveUpdates = await loadMemberUpdatesFromDrive();
      if (driveUpdates) updates = driveUpdates;
    }

    // キャッシュにメンバー更新をマージ
    const depts = (cache.depts || []).map(d => {
      const u = updates[d.id] || {};
      return {
        id: d.id,
        name: d.name,
        status: u.status || d.status,
        done: d.done || [],
        todo: d.todo || [],
        blockers: d.blockers || [],
        insight: d.insight || '',
        ideas: d.ideas || [],
        checkedTodos: u.checkedTodos || [],
        memberNote: u.memberNote || '',
        updatedBy: u.updatedBy || null,
        updatedAt: u.updatedAt || null,
      };
    });
    res.json({ ok: true, updatedAt: cache.updatedAt, depts });
  } catch {
    res.json({ ok: false, depts: [] });
  }
});

// ── API: メンバーが進捗更新 ──────────────────────────
app.post('/api/member-update', (req, res) => {
  const { deptId, checkedTodos, memberNote, updatedBy } = req.body;
  if (!deptId) return res.status(400).json({ error: 'deptId required' });
  const updates = loadMemberUpdates();
  updates[deptId] = {
    ...updates[deptId],
    checkedTodos: checkedTodos ?? updates[deptId]?.checkedTodos ?? [],
    memberNote: memberNote ?? updates[deptId]?.memberNote ?? '',
    updatedBy: updatedBy || updates[deptId]?.updatedBy || '匿名',
    updatedAt: new Date().toISOString(),
  };
  saveMemberUpdates(updates);
  saveMemberUpdatesToDrive(updates); // 非同期でDriveにバックアップ
  res.json({ ok: true });
});

// ── メンバー画面 (/board) ────────────────────────────
app.get('/board', (req, res) => {
  res.send(memberBoardHtml());
});

function memberBoardHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>i-GIP Kanto 2026 — 進捗ボード</title>
  <style>
    :root {
      --bg:#0d0f14; --surface:#161a22; --surface2:#1e2330;
      --border:#252d3d; --accent:#4f8ef7; --accent2:#a78bfa;
      --green:#34d399; --yellow:#fbbf24; --red:#f87171;
      --text:#e2e8f0; --muted:#64748b; --radius:12px;
    }
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:var(--bg);color:var(--text);font-family:'Hiragino Sans','Inter',sans-serif;min-height:100vh;}

    header{display:flex;align-items:center;justify-content:space-between;
      padding:14px 24px;background:var(--surface);border-bottom:1px solid var(--border);
      position:sticky;top:0;z-index:100;}
    .logo-badge{background:linear-gradient(135deg,var(--accent),var(--accent2));
      color:#fff;font-weight:800;font-size:12px;padding:4px 10px;border-radius:7px;}
    .logo-title{font-size:14px;font-weight:700;margin-left:10px;}
    .updated{font-size:11px;color:var(--muted);}
    .archive-tag{background:rgba(167,139,250,.12);color:var(--accent2);
      font-size:11px;font-weight:600;padding:3px 10px;border-radius:99px;border:1px solid rgba(167,139,250,.2);}

    .main{max-width:800px;margin:24px auto;padding:0 16px 80px;}
    .week-banner{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;
      font-size:13px;color:var(--muted);}
    .week-banner strong{color:var(--text);}

    .dept-block{background:var(--surface);border:1px solid var(--border);
      border-radius:var(--radius);margin-bottom:10px;overflow:hidden;transition:border-color .2s;}
    .dept-block.open{border-color:var(--accent);}
    .dept-block:hover{border-color:#3a4560;}

    .dept-header{display:flex;align-items:center;padding:16px 18px;cursor:pointer;gap:12px;user-select:none;}
    .dept-header:hover{background:rgba(255,255,255,.02);}
    .chevron{font-size:10px;color:var(--muted);transition:transform .25s;width:16px;flex-shrink:0;}
    .dept-block.open .chevron{transform:rotate(90deg);}
    .status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
    .dot-green{background:var(--green);box-shadow:0 0 6px var(--green);}
    .dot-yellow{background:var(--yellow);box-shadow:0 0 6px var(--yellow);}
    .dot-red{background:var(--red);box-shadow:0 0 6px var(--red);}
    .dept-name-wrap{flex:1;}
    .dept-name{font-size:16px;font-weight:700;}
    .dept-meta{font-size:11px;color:var(--muted);margin-top:2px;}
    .badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px;}
    .badge-green{background:rgba(52,211,153,.12);color:var(--green);}
    .badge-yellow{background:rgba(251,191,36,.12);color:var(--yellow);}
    .badge-red{background:rgba(248,113,113,.12);color:var(--red);}

    .dept-body{display:none;border-top:1px solid var(--border);}
    .dept-block.open .dept-body{display:block;}

    .section{padding:14px 18px;border-bottom:1px solid var(--border);}
    .section:last-child{border-bottom:none;}
    .section-title{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;
      color:var(--muted);margin-bottom:10px;}

    /* チェックボックスタスク */
    .task-check{display:flex;align-items:flex-start;gap:10px;padding:7px 0;cursor:pointer;}
    .task-check input[type=checkbox]{
      width:17px;height:17px;border-radius:4px;accent-color:var(--green);
      cursor:pointer;flex-shrink:0;margin-top:2px;}
    .task-label{font-size:13px;line-height:1.5;transition:color .2s;}
    .task-check.checked .task-label{color:var(--muted);text-decoration:line-through;}

    /* 完了済みタスク */
    .done-item{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:13px;color:var(--muted);}
    .done-icon{color:var(--green);flex-shrink:0;margin-top:2px;}

    /* ブロッカー */
    .blocker-item{background:rgba(248,113,113,.07);border:1px solid rgba(248,113,113,.18);
      border-radius:9px;padding:9px 12px;font-size:13px;color:var(--red);margin-bottom:6px;}

    /* アイデア */
    .insight-box{background:linear-gradient(135deg,rgba(79,142,247,.07),rgba(167,139,250,.07));
      border:1px solid rgba(79,142,247,.16);border-radius:10px;padding:14px 16px;margin-bottom:10px;}
    .insight-text{font-size:13px;line-height:1.7;color:var(--text);margin-bottom:10px;}
    .idea-item{display:flex;gap:8px;font-size:12px;color:var(--muted);padding:5px 0;
      border-top:1px solid var(--border);}
    .idea-arrow{color:var(--accent2);flex-shrink:0;}

    /* メモ欄 */
    .note-wrap{margin-top:4px;}
    textarea{width:100%;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);
      border-radius:9px;color:var(--text);font-size:13px;font-family:inherit;
      resize:vertical;min-height:70px;outline:none;transition:border-color .2s;}
    textarea:focus{border-color:var(--accent);}
    .save-btn{margin-top:8px;padding:8px 18px;background:var(--accent);color:#fff;border:none;
      border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;transition:opacity .2s;}
    .save-btn:hover{opacity:.85;}
    .save-btn:disabled{opacity:.4;cursor:not-allowed;}
    .saved-msg{font-size:11px;color:var(--green);margin-left:10px;opacity:0;transition:opacity .3s;}
    .saved-msg.show{opacity:1;}
    .last-update{font-size:11px;color:var(--muted);margin-top:6px;}

    ::-webkit-scrollbar{width:5px;}
    ::-webkit-scrollbar-thumb{background:var(--border);border-radius:99px;}
  </style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;">
    <div class="logo-badge">i-GIP</div>
    <span class="logo-title">Kanto 2026 進捗ボード</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <span class="archive-tag">📅 週次アーカイブ</span>
    <span class="updated" id="updatedAt">読み込み中...</span>
  </div>
</header>

<div class="main">
  <div class="week-banner">
    📌 このボードは<strong>毎週月曜日に自動更新</strong>されます。タスクの完了チェックとメモはリアルタイムで保存されます。
  </div>
  <div id="boardContent"></div>
</div>

<script>
let boardData = [];

async function loadBoard() {
  const res = await fetch('/api/board-data');
  const data = await res.json();
  boardData = data.depts || [];
  if (data.updatedAt) {
    const d = new Date(data.updatedAt);
    document.getElementById('updatedAt').textContent =
      d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' +
      String(d.getDate()).padStart(2,'0') + ' 取得分';
  }
  render();
}

function render() {
  const el = document.getElementById('boardContent');
  el.innerHTML = boardData.map(d => renderDept(d)).join('');
}

function renderDept(d) {
  const statusLabel = {green:'順調',yellow:'要確認',red:'止まってる'}[d.status]||'–';
  const checked = d.checkedTodos || [];
  const doneCount = checked.length;
  const totalTodo = d.todo.length;

  const todoItems = (d.todo || []).map((t, i) => {
    const isChecked = checked.includes(i);
    return \`<label class="task-check \${isChecked?'checked':''}" onclick="toggleTodo('\${d.id}',\${i})">
      <input type="checkbox" \${isChecked?'checked':''} onclick="event.preventDefault()">
      <span class="task-label">\${escHtml(t)}</span>
    </label>\`;
  }).join('');

  const doneItems = (d.done || []).map(t =>
    \`<div class="done-item"><span class="done-icon">✓</span><span>\${escHtml(t)}</span></div>\`
  ).join('');

  const lastUpdate = d.updatedAt
    ? \`最終更新: \${d.updatedBy || '匿名'} \${new Date(d.updatedAt).toLocaleDateString('ja')}\`
    : '';

  return \`
<div class="dept-block" id="dept-\${d.id}">
  <div class="dept-header" onclick="toggleDept('\${d.id}')">
    <span class="chevron">▶</span>
    <div class="status-dot dot-\${d.status}"></div>
    <div class="dept-name-wrap">
      <div class="dept-name">\${d.name}</div>
      <div class="dept-meta">Todo \${doneCount}/\${totalTodo} 完了</div>
    </div>
    <span class="badge badge-\${d.status}">\${statusLabel}</span>
  </div>
  <div class="dept-body">
    \${d.todo.length ? \`
    <div class="section">
      <div class="section-title">→ 次にやること（チェックで完了）</div>
      \${todoItems}
    </div>\` : ''}
    \${d.done.length ? \`
    <div class="section">
      <div class="section-title">✅ 完了済み</div>
      \${doneItems}
    </div>\` : ''}
    \${d.blockers && d.blockers.length ? \`
    <div class="section">
      <div class="section-title">⚠ ブロッカー・懸念事項</div>
      \${d.blockers.map(b => \`<div class="blocker-item">\${escHtml(b)}</div>\`).join('')}
    </div>\` : ''}
    \${d.insight || (d.ideas && d.ideas.length) ? \`
    <div class="section">
      <div class="section-title">💡 次に面白そうなこと</div>
      <div class="insight-box">
        \${d.insight ? \`<div class="insight-text">\${escHtml(d.insight)}</div>\` : ''}
        \${(d.ideas||[]).map(i => \`
          <div class="idea-item"><span class="idea-arrow">→</span><span>\${escHtml(i)}</span></div>
        \`).join('')}
      </div>
    </div>\` : ''}
    <div class="section">
      <div class="section-title">📝 進捗メモ・更新</div>
      <div class="note-wrap">
        <textarea id="note-\${d.id}" placeholder="今週の進捗、気になること、追加情報などを書いてください...">\${escHtml(d.memberNote||'')}</textarea>
        <div style="display:flex;align-items:center;">
          <button class="save-btn" onclick="saveNote('\${d.id}')">保存</button>
          <span class="saved-msg" id="saved-\${d.id}">✅ 保存しました</span>
        </div>
        \${lastUpdate ? \`<div class="last-update">\${lastUpdate}</div>\` : ''}
      </div>
    </div>
  </div>
</div>\`;
}

function toggleDept(id) {
  document.getElementById('dept-' + id).classList.toggle('open');
}

async function toggleTodo(deptId, idx) {
  const dept = boardData.find(d => d.id === deptId);
  if (!dept) return;
  const checked = [...(dept.checkedTodos || [])];
  const pos = checked.indexOf(idx);
  if (pos === -1) checked.push(idx); else checked.splice(pos, 1);
  dept.checkedTodos = checked;
  // UI即時更新
  const block = document.getElementById('dept-' + deptId);
  const labels = block.querySelectorAll('.task-check');
  const note = document.getElementById('note-' + deptId)?.value || '';
  await fetch('/api/member-update', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ deptId, checkedTodos: checked, memberNote: note })
  });
  render();
  // 開いた状態を維持
  document.getElementById('dept-' + deptId).classList.add('open');
}

async function saveNote(deptId) {
  const dept = boardData.find(d => d.id === deptId);
  const note = document.getElementById('note-' + deptId).value;
  const btn = document.querySelector(\`#dept-\${deptId} .save-btn\`);
  btn.disabled = true;
  await fetch('/api/member-update', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ deptId, checkedTodos: dept.checkedTodos||[], memberNote: note })
  });
  dept.memberNote = note;
  const msg = document.getElementById('saved-' + deptId);
  msg.classList.add('show');
  setTimeout(() => { msg.classList.remove('show'); btn.disabled = false; }, 2000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadBoard();
</script>
</body>
</html>`;
}

// ── 毎週月曜9時に自動同期 ───────────────────────────
async function runWeeklySync() {
  console.log('🗓 Weekly sync started...');
  const drive = getDriveClient();
  const gmail = getGmailClient();
  const results = [];
  for (const dept of DEPTS) {
    const keywords = dept.driveQuery.split(' OR ');
    const [slackMessages, driveFiles, dmMessages, gmailMessages] = await Promise.all([
      getSlackHistory(dept.channelId),
      getDriveFiles(drive, dept.driveQuery),
      getDMsForDept(keywords),
      getGmailMessages(gmail, keywords.slice(0,3).join(' OR ')),
    ]);
    const analysis = await analyzeDept(dept, slackMessages, driveFiles, dmMessages, gmailMessages);
    results.push({ id: dept.id, name: dept.name, channelId: dept.channelId,
      slackCount: slackMessages.length, driveFiles, ...analysis });
  }
  const payload = { ok: true, updatedAt: new Date().toISOString(), depts: results };
  fs.writeFileSync(new URL('cache.json', import.meta.url).pathname, JSON.stringify(payload));
  // メンバー更新（チェック・メモ）はリセットしない
  console.log('✅ Weekly sync complete');
}

// 毎週月曜9時（JST = UTC+9 → UTC 0時）
cron.schedule('0 0 * * 1', () => { runWeeklySync(); }, { timezone: 'Asia/Tokyo' });

// ── サーバー起動 ────────────────────────────────────
const PORT = process.env.PORT || 3001;
// Drive復元を先に行ってからサーバーを起動
restoreFromDrive().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 i-GIP Dashboard running at http://localhost:${PORT}`);
    console.log(`   管理者画面: /   メンバー画面: /board`);
    console.log(`   Anthropic API: ${ANTHROPIC_API_KEY ? '✅ 設定済み' : '⚠️  未設定'}\n`);
  });
}).catch(() => {
  // Drive復元が失敗してもサーバーは起動する
  app.listen(PORT, () => {
    console.log(`\n🚀 i-GIP Dashboard running (Drive restore failed) at http://localhost:${PORT}`);
  });
});
