// worker.js — Telegram Bot with Groq AI (Intent Only)
// Env required:
// BOT_TOKEN
// ADMIN_CHAT_ID
// ADMIN_USER_ID (optional)
// GROQ_API_KEY

const API_URL = `https://api.telegram.org/bot${env.BOT_TOKEN}`
const GROQ_API_KEY = env.GROQ_API_KEY
const GROQ_MODEL = "llama-3.1-8b-instant"

// ================== STATE & DATA ==================

const USER_STATE = new Map()

const PRODUCTS = new Map([
  ["premium", {
    key: "premium",
    name: "Roti Premium",
    price: 12000,
    stock: 10
  }]
])

let ORDER_ID = 1

// ================== TELEGRAM UTILS ==================

async function sendMessage(chatId, text, markdown = false) {
  return fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined
    })
  })
}

// ================== GROQ AI ==================

async function analyzeIntent(text) {
  const prompt = `
Kamu adalah AI untuk bot Telegram toko roti.

Tugas:
- Tentukan intent user
- Ambil keyword jika ada

BALAS HANYA JSON.

Intent:
- list_products
- order
- ask_stock
- unknown

Contoh:
User: apa ada roti
{"intent":"list_products"}

User: pesan roti premium 2
{"intent":"order","product":"premium","qty":2}

User sekarang:
${text}
`

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }]
    })
  })

  const data = await res.json()

  try {
    return JSON.parse(data.choices[0].message.content)
  } catch {
    return { intent: "unknown" }
  }
}

// ================== BOT LOGIC ==================

function sendProducts(chatId) {
  let msg = "🍞 *Menu Roti Hari Ini*\n\n"

  for (const p of PRODUCTS.values()) {
    msg += `• *${p.name}*\n`
    msg += `  Harga: Rp${p.price}\n`
    msg += `  Stok: ${p.stock}\n\n`
  }

  msg += "Ketik:\n*pesan roti premium 2*"

  return sendMessage(chatId, msg, true)
}

function checkStock(chatId, key) {
  const p = PRODUCTS.get(key)
  if (!p) {
    return sendMessage(chatId, "Produk tidak ditemukan ❌")
  }
  return sendMessage(
    chatId,
    `${p.name}\nStok tersedia: ${p.stock}`
  )
}

function createOrder(chatId, productKey, qty) {
  const p = PRODUCTS.get(productKey)
  if (!p) {
    return sendMessage(chatId, "Produk tidak ditemukan ❌")
  }

  if (p.stock < qty) {
    return sendMessage(chatId, "Stok tidak mencukupi ❌")
  }

  p.stock -= qty

  const id = ORDER_ID++
  USER_STATE.set(id, { chatId, productKey, qty })

  sendMessage(
    env.ADMIN_CHAT_ID,
    `🧾 *Order Baru*\nID: ${id}\nProduk: ${p.name}\nJumlah: ${qty}`,
    true
  )

  return sendMessage(
    chatId,
    `✅ Pesanan diterima\nID: ${id}\nAdmin akan memproses.`,
    true
  )
}

// ================== COMMAND HANDLER ==================

function handleCommand(text, chatId) {
  const [cmd, ...args] = text.split(" ")

  switch (cmd) {
    case "/products":
      return sendProducts(chatId)

    case "/addproduct":
      if (String(chatId) !== String(env.ADMIN_USER_ID)) {
        return sendMessage(chatId, "❌ Bukan admin")
      }

      // /addproduct key|Nama|Harga|Stok
      const raw = args.join(" ").split("|")
      if (raw.length < 4) {
        return sendMessage(chatId, "Format salah ❌")
      }

      const [key, name, price, stock] = raw
      PRODUCTS.set(key, {
        key,
        name,
        price: Number(price),
        stock: Number(stock)
      })

      return sendMessage(chatId, "✅ Produk ditambahkan")

    default:
      return sendMessage(chatId, "Perintah tidak dikenal ❓")
  }
}

// ================== AI ROUTER ==================

async function handleAI(text, chatId) {
  const ai = await analyzeIntent(text)

  switch (ai.intent) {
    case "list_products":
      return sendProducts(chatId)

    case "order":
      return createOrder(
        chatId,
        ai.product,
        ai.qty || 1
      )

    case "ask_stock":
      return checkStock(chatId, ai.product)

    default:
      return sendMessage(
        chatId,
        "Maaf kak 🙏\nKetik *menu* atau *roti* untuk melihat produk.",
        true
      )
  }
}

// ================== MESSAGE HANDLER ==================

async function onMessage(message) {
  const chatId = message.chat.id
  const text = message.text?.toLowerCase().trim()

  if (!text) return

  // COMMAND TIDAK LEWAT AI
  if (text.startsWith("/")) {
    return handleCommand(text, chatId)
  }

  // FAST KEYWORD (NO AI)
  if (
    text === "menu" ||
    text === "roti" ||
    text === "menu roti"
  ) {
    return sendProducts(chatId)
  }

  // AI FALLBACK
  return handleAI(text, chatId)
}

// ================== FETCH EVENT ==================

export default {
  async fetch(req) {
    const update = await req.json()

    if (update.message) {
      await onMessage(update.message)
    }

    return new Response("ok")
  }
      }
