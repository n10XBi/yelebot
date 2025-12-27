// worker.groq.refactor.js — Telegram Worker (refactor + Groq NLU integration) // Env required: BOT_TOKEN, ADMIN_CHAT_ID, GROQ_API_URL, GROQ_API_KEY (optional if not required) // Keeps style consistent with original worker-updated.js

let USER_STATE = new Map(); // per-user short memory: { lastIntent, lastProduct, lastAt } let ORDERS = new Map(); // invoiceId -> order object (in-memory)

// CONFIG const MENU_IMAGE = "https://lh3.googleusercontent.com/86arOE_jc_...BvhszB-6T1iGeCWvpAT9jZVDVgekalBvLZiZNoy5Ow9QlnHA=w1827-h711-no";

// In-memory products (mutable) let PRODUCTS = { premium: { key: "premium", name: "Roti Premium", desc: "Roti lembut isi coklat", price: 12000, stock: 10 }, coklat: { key: "coklat", name: "Roti Coklat", desc: "Roti isi coklat lezat", price: 15000, stock: 8 }, keju: { key: "keju", name: "Roti Keju", desc: "Roti isi keju gurih", price: 14000, stock: 5 } };

// Helpers function formatRupiah(num) { return "Rp" + Number(num).toLocaleString("id-ID"); }

function generateInvoiceId() { return "INV" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase(); }

function isAdminChat(chatId, env) { // prefer ADMIN_CHAT_ID env but fallback to hardcoded if present in original if (env && env.ADMIN_CHAT_ID) return Number(chatId) === Number(env.ADMIN_CHAT_ID); return Number(chatId) === 7872093153; }

// Minimal Levenshtein distance for typo correction function levenshtein(a, b) { if (!a) return b.length; if (!b) return a.length; const dp = Array.from({length: a.length+1}, () => Array(b.length+1).fill(0)); for (let i=0;i<=a.length;i++) dp[i][0] = i; for (let j=0;j<=b.length;j++) dp[0][j] = j; for (let i=1;i<=a.length;i++) { for (let j=1;j<=b.length;j++) { const cost = a[i-1] === b[j-1] ? 0 : 1; dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost); } } return dp[a.length][b.length]; }

function normalizeText(s) { return (s||"").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }

function fuzzyMatchProduct(term) { // try exact key/name, then try fuzzy term = normalizeText(term); if (!term) return null; // direct key match if (PRODUCTS[term]) return PRODUCTS[term]; // name contains for (const k of Object.keys(PRODUCTS)) { if (PRODUCTS[k].name.toLowerCase().includes(term)) return PRODUCTS[k]; } // fuzzy by levenshtein on keys & names let best = null; let bestScore = Infinity; for (const k of Object.keys(PRODUCTS)) { const name = normalizeText(PRODUCTS[k].name); const s1 = levenshtein(term, k); const s2 = levenshtein(term, name); const score = Math.min(s1, s2); if (score < bestScore) { bestScore = score; best = PRODUCTS[k]; } } // threshold: allow small typos (<=3 or relative) if (bestScore <= Math.max(2, Math.floor(term.length * 0.4))) return best; return null; }

async function tg(env, method, data) { try { const res = await fetch(https://api.telegram.org/bot${env.BOT_TOKEN}/${method}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return res.json ? await res.json() : res; } catch (e) { return null; } }

// Groq NLU call — expects Groq endpoint that returns JSON like { intent: "list_products", product: "premium", qty: 2 } async function callGroq(env, userText) { const url = env.GROQ_API_URL; if (!url) return { intent: 'unknown' }; const prompt = Classify the intent and return only JSON.\nUser: "${userText.replace(/"/g, '\\"')}"\nReturn fields: intent (one of list_products, order, ask_stock, add_product, unknown), product (optional), qty (optional); try { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(env.GROQ_API_KEY ? { 'Authorization': Bearer ${env.GROQ_API_KEY} } : {}) }, body: JSON.stringify({ prompt, temperature: 0.1, max_tokens: 200 }) }); const j = await res.json(); // The Groq endpoint might return { text: '...'} or directly JSON. Try to parse. if (!j) return { intent: 'unknown' }; if (j.intent) return j; if (typeof j.text === 'string') { // try to extract JSON from text const txt = j.text.trim(); const m = txt.match(/{[\s\S]*}/); if (m) { try { return JSON.parse(m[0]); } catch(e) { } try { return eval('(' + m[0] + ')'); } catch(e) { } } } // fallback unknown return { intent: 'unknown' }; } catch (e) { return { intent: 'unknown' }; } }

function saveShortMemory(chatId, obj) { USER_STATE.set(chatId, { ...(USER_STATE.get(chatId)||{}), ...obj, lastAt: Date.now() }); }

function readShortMemory(chatId) { const s = USER_STATE.get(chatId); if (!s) return null; // expire after 5 minutes if (Date.now() - (s.lastAt || 0) > 1000 * 60 * 5) { USER_STATE.delete(chatId); return null; } return s; }

// Business logic async function showProducts(env, chatId) { const lines = ["🍞 Menu Roti Hari Ini\n"]; for (const k of Object.keys(PRODUCTS)) { const p = PRODUCTS[k]; lines.push(• *${p.name}*\n  ${p.desc}\n  Harga: ${formatRupiah(p.price)}\n  Stok: ${p.stock}\n); } const text = lines.join('\n') + "\nKetik: 'pesan <nama> <qty>' atau 'menu' untuk lihat ulang."; await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' }); }

async function suggestProducts(env, chatId, term) { // simple suggestion: if term empty show top 3, else show fuzzy matches let matches = []; if (!term) matches = Object.values(PRODUCTS).slice(0,3); else { const normalized = normalizeText(term); for (const k of Object.keys(PRODUCTS)) { const p = PRODUCTS[k]; if (p.name.toLowerCase().includes(normalized) || k.includes(normalized)) matches.push(p); } if (matches.length === 0) { const pm = fuzzyMatchProduct(term); if (pm) matches.push(pm); } } if (matches.length === 0) { await tg(env, 'sendMessage', { chat_id: chatId, text: Maaf kak, gak nemu roti yang mirip '${term}'. Ketik 'menu' untuk lihat semua. }); return; } const lines = matches.map(p => • *${p.name}* — ${formatRupiah(p.price)} — Stok: ${p.stock}); await tg(env, 'sendMessage', { chat_id: chatId, text: Saran: \n${lines.join('\n')}, parse_mode: 'Markdown' }); // save suggestions to short memory saveShortMemory(chatId, { lastSuggestions: matches.map(m => m.key) }); }

async function handleOrder(env, chatId, productKey, qty, from) { const p = PRODUCTS[productKey] || fuzzyMatchProduct(productKey); if (!p) { await suggestProducts(env, chatId, productKey); return; } qty = Number(qty) || 1; if (p.stock < qty) { await tg(env, 'sendMessage', { chat_id: chatId, text: Maaf stok *${p.name}* tinggal ${p.stock}., parse_mode: 'Markdown' }); return; } const id = generateInvoiceId(); const order = { id, chatId, productKey: p.key, productName: p.name, qty, price: p.price * qty, status: 'pending', createdAt: Date.now(), from }; ORDERS.set(id, order);

// notify admin for approval await notifyAdmin(env, order);

await tg(env, 'sendMessage', { chat_id: chatId, text: Terima kasih kak 🙏\nPesananmu diterima dan menunggu konfirmasi admin. ID: *${id}*\nProduk: *${p.name}* x${qty}\nTotal: ${formatRupiah(order.price)}, parse_mode: 'Markdown' }); }

async function notifyAdmin(env, order) { const adminChat = env.ADMIN_CHAT_ID || 7872093153; const text = 📥 Pesanan baru\nID: ${order.id}\nDari: ${order.chatId}\nProduk: ${order.productName} x${order.qty}\nTotal: ${formatRupiah(order.price)}; const reply_markup = { inline_keyboard: [ [{ text: '✅ Approve', callback_data: admin_approve|${order.id} }, { text: '❌ Reject', callback_data: admin_reject|${order.id} }], [{ text: '🗑 Cancel Order', callback_data: admin_cancel|${order.id} }] ] }; await tg(env, 'sendMessage', { chat_id: adminChat, text, reply_markup }); }

// Handle callback queries (admin actions and menu buttons) async function handleCallback(env, cb) { const chatId = cb.message.chat.id; // origin chat of the message containing button const data = cb.data || ''; await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(()=>{});

if (data.startsWith('admin_')) { const [action, id] = data.split('|'); const order = ORDERS.get(id); if (!order) { await tg(env, 'sendMessage', { chat_id: cb.from.id, text: 'Order tidak ditemukan.' }); return; } // Only admin may perform these (double-check) if (!isAdminChat(cb.from.id, env)) { await tg(env, 'sendMessage', { chat_id: cb.from.id, text: 'Kamu bukan admin.' }); return; } if (action === 'admin_approve') { order.status = 'approved'; ORDERS.set(id, order); // reduce stock if (PRODUCTS[order.productKey]) PRODUCTS[order.productKey].stock -= order.qty; await tg(env, 'sendMessage', { chat_id: order.chatId, text: ✅ Pesanan *${order.id}* disetujui oleh admin. Silakan lakukan pembayaran., parse_mode: 'Markdown' }); await tg(env, 'sendMessage', { chat_id: cb.from.id, text: Pesanan ${id} telah disetujui. }); return; } if (action === 'admin_reject') { order.status = 'rejected'; ORDERS.set(id, order); await tg(env, 'sendMessage', { chat_id: order.chatId, text: ❌ Pesanan *${order.id}* ditolak oleh admin., parse_mode: 'Markdown' }); await tg(env, 'sendMessage', { chat_id: cb.from.id, text: Pesanan ${id} telah ditolak. }); return; } if (action === 'admin_cancel') { ORDERS.delete(id); await tg(env, 'sendMessage', { chat_id: order.chatId, text: 🗑 Pesanan *${order.id}* dibatalkan oleh admin., parse_mode: 'Markdown' }); await tg(env, 'sendMessage', { chat_id: cb.from.id, text: Pesanan ${id} dibatalkan. }); return; } }

// menu buttons for users: menu_<key> if (data.startsWith('menu_')) { const key = data.replace('menu_', ''); const p = PRODUCTS[key]; if (!p) { await tg(env, 'sendMessage', { chat_id: cb.from.id, text: 'Produk tidak ditemukan.' }); return; } const text = *${p.name}*\n${p.desc}\nHarga: ${formatRupiah(p.price)}\nStok: ${p.stock}; await tg(env, 'sendMessage', { chat_id: cb.from.id, text, parse_mode: 'Markdown' }); } }

// Main text handler async function handleText(env, msg) { const chatId = msg.chat.id; const textRaw = msg.text || ''; const text = normalizeText(textRaw);

// Commands bypass NLU if (textRaw.startsWith('/')) { const parts = textRaw.split(' '); const cmd = parts[0].toLowerCase(); if (cmd === '/products' || cmd === '/menu' || cmd === '/daftar') { return await showProducts(env, chatId); } if (cmd === '/addproduct' && isAdminChat(chatId, env)) { // format: /addproduct key|Name|Desc|price|stock const payload = textRaw.replace('/addproduct','').trim(); const parts = payload.split('|').map(s=>s.trim()); if (parts.length < 5) return await tg(env, 'sendMessage', { chat_id: chatId, text: 'Format: /addproduct key|Name|Desc|price|stock' }); const [key,name,desc,price,stock] = parts; PRODUCTS[key] = { key, name, desc, price: Number(price), stock: Number(stock) }; return await tg(env, 'sendMessage', { chat_id: chatId, text: Produk ${name} ditambahkan. }); } // other commands: status, cancel if (cmd === '/status') { const id = parts[1]; const o = ORDERS.get(id); if (!o) return await tg(env, 'sendMessage', { chat_id: chatId, text: 'ID tidak ditemukan.' }); return await tg(env, 'sendMessage', { chat_id: chatId, text: Status ${id}: ${o.status} }); } }

// Quick keyword heuristics before calling NLU // common natural phrases: 'apa ada roti', 'liat menu roti', 'ada rotii' if (text.includes('apa ada') || text.includes('ada roti') || text.includes('liat menu') || text.includes('lihat menu')) { saveShortMemory(chatId, { lastIntent: 'list_products' }); return await showProducts(env, chatId); }

// Typo correction attempt for single-word 'rotii' etc. const commonTypos = { 'rotii': 'roti', 'rotiii': 'roti' }; let correctedText = textRaw; for (const t in commonTypos) { const rx = new RegExp(\\b${t}\\b, 'i'); if (rx.test(textRaw)) correctedText = textRaw.replace(rx, commonTypos[t]); }

// Call Groq NLU const nlu = await callGroq(env, correctedText); // Fallback: if Groq says unknown but message contains keyword 'roti', show menu if (!nlu || nlu.intent === 'unknown') { if (text.includes('roti')) { saveShortMemory(chatId, { lastIntent: 'list_products' }); return await showProducts(env, chatId); } // if user asks short 'pesan' and we have last suggestion, prompt if (text === 'pesan' || text === 'pesan dong') { const mem = readShortMemory(chatId); if (mem && mem.lastSuggestions && mem.lastSuggestions.length) { const p = PRODUCTS[mem.lastSuggestions[0]]; return await tg(env, 'sendMessage', { chat_id: chatId, text: Mau pesan *${p.name}*? Ketik: pesan ${p.key} 1, parse_mode: 'Markdown' }); } return await tg(env, 'sendMessage', { chat_id: chatId, text: 'Mau pesan apa? Ketik: pesan <nama> <qty>' }); } // otherwise suggest products based on the raw text return await suggestProducts(env, chatId, textRaw); }

// handle NLU intents const intent = nlu.intent; if (intent === 'list_products') { saveShortMemory(chatId, { lastIntent: 'list_products' }); return await showProducts(env, chatId); } if (intent === 'ask_stock') { const product = nlu.product || nlu.item || null; const p = product ? (PRODUCTS[product] || fuzzyMatchProduct(product)) : null; if (!p) return await suggestProducts(env, chatId, product || ''); return await tg(env, 'sendMessage', { chat_id: chatId, text: Stok *${p.name}* saat ini: ${p.stock}, parse_mode: 'Markdown' }); } if (intent === 'order') { const product = nlu.product || nlu.item || ''; const qty = nlu.qty || 1; const p = PRODUCTS[product] || fuzzyMatchProduct(product); if (!p) { await suggestProducts(env, chatId, product || ''); return; } await handleOrder(env, chatId, p.key, qty, msg.from || {}); return; }

// admin add product intent (rare because we handle /addproduct command) if (intent === 'add_product' && isAdminChat(chatId, env)) { // attempt to parse structure from nlu (depends on Groq) const key = nlu.key || normalizeText(nlu.product || 'newprod'); const name = nlu.name || nlu.product || 'New Product'; const price = Number(nlu.price) || 0; const stock = Number(nlu.stock) || 0; PRODUCTS[key] = { key, name, desc: nlu.desc || '-', price, stock }; return await tg(env, 'sendMessage', { chat_id: chatId, text: Produk ${name} telah ditambahkan. }); }

// default fallback await tg(env, 'sendMessage', { chat_id: chatId, text: "Maaf kak 🙏\nKetik 'menu' atau 'roti' untuk melihat produk, atau 'pesan <nama> <qty>' untuk pesan." }); }

// MAIN export default { async fetch(req, env) { if (req.method !== 'POST') return new Response('OK'); let update; try { update = await req.json(); } catch (e) { return new Response('Bad Request', { status: 400 }); }

// callback queries
if (update.callback_query) {
  await handleCallback(env, update.callback_query).catch(e=>{});
  return new Response(JSON.stringify({ ok: true }));
}

// message handler
if (update.message) {
  const msg = update.message;
  if (msg.text) {
    await handleText(env, msg).catch(e=>{
      console.error('handleText error', e);
    });
  }
  return new Response(JSON.stringify({ ok: true }));
}

return new Response('OK');

} };
