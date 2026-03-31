import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

// ── 設定 ────────────────────────────────────────────
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'igip2026';

// ── パスワード保護ミドルウェア ───────────────────────
app.use((req, res, next) => {
  // APIとauth系はスキップ
  if (req.path.startsWith('/auth/')) return next();
  // トークン確認
  const token = req.query.t || req.headers['x-dashboard-token'] ||
    req.headers.cookie?.match(/dtoken=([^;]+)/)?.[1];
  if (token === DASHBOARD_PASSWORD) return next();
  // ログインページ
  if (req.path === '/login') return next();
  if (req.method === 'POST' && req.path === '/login') return next();
  // HTMLリクエストのみログイン画面へ
  if (req.headers.accept?.includes('text/html') && !req.path.startsWith('/api/')) {
    return res.redirect(`/login`);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── ログインページ ───────────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>i-GIP Dashboard — ログイン</title>
  <style>
    body { background:#0d0f14; color:#e2e8f0; font-family:'Hiragino Sans',sans-serif;
      display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
    .box { background:#161a22; border:1px solid #252d3d; border-radius:16px; padding:40px; width:320px; }
    .logo { background:linear-gradient(135deg,#4f8ef7,#a78bfa); color:#fff; font-weight:800;
      font-size:13px; padding:5px 10px; border-radius:8px; display:inline-block; margin-bottom:20px; }
    h2 { font-size:18px; margin-bottom:6px; }
    p { font-size:12px; color:#64748b; margin-bottom:24px; }
    input { width:100%; padding:11px 14px; background:#1e2330; border:1px solid #252d3d;
      border-radius:9px; color:#e2e8f0; font-size:14px; box-sizing:border-box; margin-bottom:12px; }
    button { width:100%; padding:12px; background:#4f8ef7; color:#fff; border:none;
      border-radius:9px; font-size:14px; font-weight:700; cursor:pointer; }
    button:hover { opacity:.9; }
    .err { color:#f87171; font-size:12px; margin-top:8px; }
  </style>
</head>
<body>
<div class="box">
  <div class="logo">i-GIP</div>
  <h2>Kanto 2026 Dashboard</h2>
  <p>アクセスにはパスワードが必要です</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="パスワード" autofocus>
    <button type="submit">ログイン</button>
    ${req.query.err ? '<div class="err">パスワードが違います</div>' : ''}
  </form>
</div>
</body>
</html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', `dtoken=${DASHBOARD_PASSWORD}; Path=/; HttpOnly; Max-Age=604800`);
    return res.redirect('/');
  }
  res.redirect('/login?err=1');
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
    // トークン更新時に保存
    auth.on('tokens', (tokens) => {
      const current = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH));
      fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
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
      model: 'claude-opus-4-5',
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
  // キャッシュ保存
  fs.writeFileSync(new URL('cache.json', import.meta.url).pathname, JSON.stringify(payload));
  res.json(payload);
});

// ── API: キャッシュ取得（即時表示用） ───────────────
app.get('/api/cache', (req, res) => {
  try {
    const cache = JSON.parse(fs.readFileSync(new URL('cache.json', import.meta.url).pathname));
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

// ── サーバー起動 ────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 i-GIP Dashboard running at http://localhost:${PORT}`);
  console.log(`   Anthropic API: ${ANTHROPIC_API_KEY ? '✅ 設定済み' : '⚠️  未設定 (ANTHROPIC_API_KEY)'}\n`);
});
