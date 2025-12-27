/**
 * worker.js
 * Full Telegram worker with GROQ intent integration (intent-only).
 *
 * ENV required:
 *  - BOT_TOKEN
 *  - GROQ_API_KEY
 *  - ADMIN_CHAT_ID
 *
 * Notes:
 *  - Commands (start with "/") are NOT sent to GROQ.
 *  - GROQ is used only to detect intent and extract a few fields.
 *  - If GROQ fails, fallback ke simple keyword matching.
 */

// --- imports / fetch compatibility ---
const { URLSearchParams } = require("url");
const fetch = global.fetch || require("node-fetch");

// --- env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID && Number(process.env.ADMIN_CHAT_ID);

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env"); process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY env"); process.exit(1);
}

// Telegram base
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- in-memory stores (replace with DB for production) ---
const USER_STATE = new Map(); // per-user flow if needed
const PRODUCTS = new Map(); // key -> { key, name, desc, price, stock }
const ORDERS = new Map(); // orderId -> { id, chatId, productKey, qty, status, createdAt }

// seed product
PRODUCTS.set("premium", {
  key: "premium",
  name: "Roti Premium",
  desc: "Roti lembut isi",
  price: 12000,
  stock: 10
});

// util: sendMessage
async function sendMessage(chatId, text, useMarkdown = true) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };
  if (useMarkdown) body.parse_mode = "Markdown";
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("sendMessage error:", err);
  }
}

// util: sendProducts (human-friendly)
function formatProductsMessage() {
  let msg = "🍞 *Menu Roti Hari Ini*\n\n";
  for (const [, p] of PRODUCTS) {
    msg += `• *${p.name}* (key: ${p.key})\n`;
    if (p.desc) msg += `  _${p.desc}_\n`;
    msg += `  Harga: Rp${Number(p.price).toLocaleString()}\n`;
    msg += `  Stok: ${p.stock}\n\n`;
  }
  msg += "Ketik: `pesan <key> <jumlah>` atau gunakan perintah `/products`.\n";
  return msg;
}

async function sendProducts(chatId) {
  return sendMessage(chatId, formatProductsMessage(), true);
}

// analyser: call GROQ for intent classification (intent-only)
const GROQ_MODEL = "llama-3.1-8b-instant"; // recommended model
async function analyzeIntent(text) {
  // quick local fallback rules (very fast)
  const kw = text.toLowerCase();
  if (kw === "menu" || kw === "roti" || kw === "menu roti" || kw.includes("lihat menu")) {
    return { intent: "list_products" };
  }
  // If short command-like "pesan roti premium 2" parse simple
  const orderMatch = kw.match(/pesan\s+([a-z0-9_\- ]+)\s+(\d+)/i);
  if (orderMatch) {
    return { intent: "order", product: orderMatch[1].trim(), qty: Number(orderMatch[2]) };
  }

  // Build prompt: keep it strict and small
  const prompt = `
Kamu adalah AI untuk bot Telegram toko roti.
Tugas:
- Tentukan intent user salah satu dari: list_products, order, ask_stock, unknown
- Jika intent = order, berikan product (key atau nama pendek) dan qty (angka)
Balas HANYA JSON tanpa teks lain.

Contoh:
User: apa ada roti
{"intent":"list_products"}

User: pesan roti premium 2
{"intent":"order","product":"premium","qty":2}

User sekarang: ${text}
`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150
      })
    });

    if (!res.ok) {
      console.warn("GROQ non-ok:", res.status, await res.text());
      return { intent: "unknown" };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("GROQ no content");
      return { intent: "unknown" };
    }

    // Try parse JSON strictly
    try {
      const parsed = JSON.parse(content.trim());
      return parsed;
    } catch (e) {
      // If model returned backticks or stray text, try to extract first JSON block
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch {}
      }
      console.warn("GROQ parse fail:", e, "raw:", content);
      return { intent: "unknown" };
    }
  } catch (err) {
    console.error("analyzeIntent error:", err);
    return { intent: "unknown" };
  }
}

// --- Order helpers ---
let orderCounter = 1;
function createOrderRecord(chatId, productKey, qty) {
  const id = `${Date.now()}-${orderCounter++}`;
  const rec = {
    id,
    chatId,
    productKey,
    qty,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  ORDERS.set(id, rec);
  return rec;
}

async function createOrder(chatId, productKeyRaw, qtyRaw) {
  const productKey = (productKeyRaw || "").toLowerCase().trim();
  const qty = qtyRaw ? Number(qtyRaw) : 1;

  // try exact key
  let product = PRODUCTS.get(productKey);

  // if not found, try fuzzy name match by name
  if (!product) {
    for (const [, p] of PRODUCTS) {
      if (p.name.toLowerCase().includes(productKey)) {
        product = p; break;
      }
    }
  }

  if (!product) {
    return sendMessage(chatId, "Maaf, produk tidak ditemukan. Ketik *menu* untuk melihat daftar produk.", true);
  }

  if (product.stock < qty) {
    return sendMessage(chatId, `Maaf, stok *${product.name}* hanya ${product.stock}.`, true);
  }

  // create order (manual admin assisted)
  const order = createOrderRecord(chatId, product.key, qty);

  // notify admin
  const adminMsg = `🆕 *Order Baru* (id: ${order.id})\n` +
    `User: ${chatId}\n` +
    `Produk: *${product.name}* (key: ${product.key})\n` +
    `Jumlah: ${qty}\n\n` +
    `Gunakan /approve ${order.id} atau /cancel ${order.id}`;
  if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, adminMsg, true);

  // confirmation to user
  const userMsg = `Terima kasih kak 🙏\nPesananmu akan dibantu admin secara manual.\n\n` +
    `• Produk: *${product.name}*\n• Jumlah: ${qty}\n• ID pesanan: \`${order.id}\`\n\n` +
    `Ketik /status ${order.id} untuk memeriksa status.`;
  await sendMessage(chatId, userMsg, true);

  return order;
}

// checkStock
async function checkStock(chatId, productKeyRaw) {
  const key = (productKeyRaw || "").toLowerCase().trim();
  let p = PRODUCTS.get(key);
  if (!p) {
    for (const [, pr] of PRODUCTS) {
      if (pr.name.toLowerCase().includes(key)) {
        p = pr; break;
      }
    }
  }
  if (!p) {
    return sendMessage(chatId, "Produk tidak ditemukan. Ketik *menu* untuk melihat produk.", true);
  }
  return sendMessage(chatId, `Stok *${p.name}*: ${p.stock}`, true);
}

// handle admin addproduct
function parseAddProductPayload(text) {
  // expected: /addproduct key|Name|desc|price|stock
  const payload = text.replace(/^\/addproduct\s+/i, "").trim();
  const parts = payload.split("|").map(s => s.trim());
  if (parts.length < 5) return null;
  const [key, name, desc, price, stock] = parts;
  return { key: key.toLowerCase(), name, desc, price: Number(price), stock: Number(stock) };
}

async function handleAdminAddProduct(chatId, text) {
  if (!ADMIN_CHAT_ID || Number(chatId) !== Number(ADMIN_CHAT_ID)) {
    return sendMessage(chatId, "Perintah ini hanya untuk admin.", true);
  }
  const parsed = parseAddProductPayload(text);
  if (!parsed) {
    return sendMessage(chatId, "Format salah. Gunakan: /addproduct key|Nama|Desc|price|stock", true);
  }
  PRODUCTS.set(parsed.key, {
    key: parsed.key, name: parsed.name, desc: parsed.desc, price: parsed.price, stock: parsed.stock
  });
  return sendMessage(chatId, `Produk *${parsed.name}* berhasil ditambahkan (key: ${parsed.key}).`, true);
}

// handle commands
async function handleCommand(text, chatId) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    return sendMessage(chatId, "Halo! Aku bot toko roti. Ketik *menu* atau *roti* untuk melihat produk. Untuk pesan: `pesan <key> <jumlah>`", true);
  }

  if (cmd === "/products") {
    return sendProducts(chatId);
  }

  if (cmd === "/addproduct") {
    return handleAdminAddProduct(chatId, text);
  }

  if (cmd === "/status") {
    const id = parts[1];
    if (!id) return sendMessage(chatId, "Ketik /status <id>", true);
    const o = ORDERS.get(id);
    if (!o) return sendMessage(chatId, "Order tidak ditemukan.", true);
    return sendMessage(chatId, `Status pesanan ${id}: ${o.status}`, true);
  }

  if (cmd === "/cancel") {
    const id = parts[1];
    if (!id) return sendMessage(chatId, "Ketik /cancel <id>", true);
    const o = ORDERS.get(id);
    if (!o) return sendMessage(chatId, "Order tidak ditemukan.", true);
    // allow admin or order owner
    if (String(chatId) !== String(o.chatId) && Number(chatId) !== Number(ADMIN_CHAT_ID)) {
      return sendMessage(chatId, "Hanya admin atau pemilik order yang bisa membatalkan.", true);
    }
    o.status = "cancelled";
    ORDERS.set(id, o);
    return sendMessage(chatId, `Order ${id} dibatalkan.`, true);
  }

  if (cmd === "/approve") {
    const id = parts[1];
    if (!id) return sendMessage(chatId, "Ketik /approve <id>", true);
    if (Number(chatId) !== Number(ADMIN_CHAT_ID)) return sendMessage(chatId, "Hanya admin.", true);
    const o = ORDERS.get(id);
    if (!o) return sendMessage(chatId, "Order tidak ditemukan.", true);
    o.status = "approved";
    ORDERS.set(id, o);
    // decrement stock
    const p = PRODUCTS.get(o.productKey);
    if (p) p.stock = Math.max(0, p.stock - o.qty);
    await sendMessage(o.chatId, `Pesanan \`${o.id}\` sudah *disetujui* oleh admin.`, true);
    return sendMessage(chatId, `Order ${id} disetujui.`, true);
  }

  // unknown command
  return sendMessage(chatId, "Perintah tidak dikenal. Ketik /help untuk bantuan.", true);
}

// handleAI route -> map intent to actions
async function handleAI(text, chatId) {
  const ai = await analyzeIntent(text);

  switch ((ai.intent || "unknown").toLowerCase()) {
    case "list_products":
      return sendProducts(chatId);

    case "order":
      // ai.product may be full name like "roti premium" or key "premium"
      return createOrder(chatId, ai.product, ai.qty);

    case "ask_stock":
      return checkStock(chatId, ai.product);

    default:
      // fallback: try simple grammar "apa ada roti" etc
      const lower = text.toLowerCase();
      if (lower.includes("ada roti") || lower.includes("menu") || lower.includes("lihat")) {
        return sendProducts(chatId);
      }
      return sendMessage(chatId, "Maaf kak 🙏\nKetik *menu* atau *roti* untuk melihat produk.", true);
  }
}

// main message handler
async function onMessage(msg) {
  try {
    const chatId = msg.chat.id;
    const textRaw = msg.text || "";
    const text = String(textRaw).trim();

    if (!text) return;

    // always prioritize commands
    if (text.startsWith("/")) {
      return handleCommand(text, chatId);
    }

    // quick keyword rules (fast, no cost)
    const quick = text.toLowerCase();
    if (["menu", "roti", "menu roti", "lihat menu"].includes(quick)) {
      return sendProducts(chatId);
    }

    // if user types "pesan <key> <qty>" allow direct parse (fast)
    const m = quick.match(/^pesan\s+([a-z0-9_\- ]+)\s+(\d+)/i);
    if (m) {
      const product = m[1].trim();
      const qty = Number(m[2]);
      return createOrder(chatId, product, qty);
    }

    // otherwise use GROQ intent classifier
    return handleAI(text, chatId);
  } catch (err) {
    console.error("onMessage error:", err);
  }
}

// ------- Polling loop (simple getUpdates) -------
let offset = 0;
async function pollUpdates() {
  try {
    const res = await fetch(`${TELEGRAM_API}/getUpdates?timeout=20&offset=${offset + 1}`);
    if (!res.ok) {
      const t = await res.text();
      console.error("getUpdates error:", res.status, t);
      return;
    }
    const json = await res.json();
    if (!Array.isArray(json.result)) return;

    for (const u of json.result) {
      offset = Math.max(offset, u.update_id);
      if (u.message) {
        onMessage(u.message);
      }
    }
  } catch (err) {
    console.error("pollUpdates error:", err);
  }
}

function startPolling() {
  console.log("Starting polling...");
  // initial run
  setInterval(pollUpdates, 1000); // poll setiap 1 detik
}

// start
startPolling();

// export for testing if required
module.exports = {
  sendMessage, analyzeIntent, createOrder, handleCommand, PRODUCTS, ORDERS
};
