// worker-updated.js — Telegram Worker (with AI intent detection)
// Env required: BOT_TOKEN, ADMIN_CHAT_ID, GROQ_API_KEY
// Chat ID 7872093153 adalah admin

let USER_STATE = new Map(); // temporary per-user flow
let ORDERS = new Map(); // invoiceId -> order object (in-memory)

// CONFIG
const MENU_IMAGE = "https://lh3.googleusercontent.com/86arOE_jc_FYR6_mPbeXrzWB4LwvgCRWPGXbbftgG4_zAjY05ajbmq3xiG0Xc_uYCoTccikGvLdo5WIlofH5pmySn1VRejqngh2pwDLquiLJYayCOJKUrZKFnOwmSxKzQqqOM1y5o42TPk6LYR1vbPjrEPx3JdPZT32TkqCECm-PoQtsBAPnyN6g46PbiyD9fblgzuBcT2xuO1AaZgOkR53bom8ATCBkDgcYT_mnsxWuxLGp6cNFUR4lWBFKyYkYJWJY--KmIVCWDDoJ3SxwjimGjwRG-X2Qu3AP4wa6tRazHuBo3a8IOofm6f5arSRdpVy4AaXoacTPz8TSkcofA0YaIttHpek1Gi5v1yMSbi5mHV6Mfv4lyczXPp8c5iNR7IFPvgMz1BiCETTxNwSvDjb2JCN94_256Fzejrs-Dk-kMYeCCYQh2Zd_lt9xiEQDgZ5gufdpxxM9xDiP447vrOqKbBMcAS_6hu43EwRi97ILAhBpS3QLP-4WhKf4GHauWqML_EcBvhszB-6T1iGeCWvpAT9jZVDVgekalBvLZiZNoy5Ow9QlnHA=w1827-h711-no";

// Mutable product store (in-memory)
let PRODUCTS = {
  premium: {
    key: "premium",
    name: "Roti Premium",
    desc: "Roti premium tanpa kulit dengan topping coklat & keju",
    price: 12000,
    image: MENU_IMAGE,
    stock: 10
  }
};

// Working hours (WIB)
const WORK_START = 8; // 08:00
const WORK_END = 17;  // 17:00
const TZ_OFFSET = 7;  // WIB = UTC+7

// UTIL
function getWIBDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + TZ_OFFSET * 3600000);
}

function isWorkingHour() {
  const d = getWIBDate();
  const h = d.getHours();
  return h >= WORK_START && h < WORK_END;
}

function formatRupiah(num) {
  return "Rp" + Number(num).toLocaleString("id-ID");
}

function generateInvoiceId() {
  return "INV" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
}

// Admin hanya berdasarkan chat ID
function isAdminChat(chatId) {
  return Number(chatId) === 7872093153;
}

// Telegram helper
async function tg(env, method, data) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return res;
  } catch (e) {
    return null;
  }
}

// AI Intent Detection using Groq
async function aiParseIntent(env, text) {
  // Default response
  const defaultResponse = {
    intent: "unknown",
    product_key: null,
    qty: null
  };
  
  // Check if API key exists
  if (!env.GROQ_API_KEY) {
    console.log("GROQ_API_KEY not set, skipping AI detection");
    return defaultResponse;
  }
  
  // Product mapping for AI reference
  const productList = Object.values(PRODUCTS).map(p => ({
    key: p.key,
    name: p.name,
    aliases: [p.name.toLowerCase(), p.key]
  }));
  
  const prompt = `Kamu adalah AI yang membantu memahami pesan pelanggan roti.
Analisis pesan ini: "${text}"

PRODUK YANG TERSEDIA:
${productList.map(p => `- ${p.name} (key: ${p.key})`).join('\n')}

TUGAS:
1. Tentukan intent: "menu" (minta menu), "order" (pesan roti), "status" (cek status), "cancel" (batalkan), "unknown" (tidak tahu)
2. Jika intent "order", identifikasi:
   - product_key (gunakan key dari produk yang tersedia, contoh: "premium")
   - qty (jumlah yang ingin dipesan, angka saja)

ATURAN:
- Jika user sebut "menu", "lihat roti", "ada apa" → intent: "menu"
- Jika user sebut "pesan", "beli", "mau" + nama produk → intent: "order"
- Jika user sebut "status", "cek pesanan" → intent: "status"
- Jika user sebut "batal", "cancel" → intent: "cancel"
- Jika ada angka dalam pesan, anggap sebagai qty
- Jika produk tidak jelas, product_key: null
- Jika tidak ada angka, qty: null

HASILKAN JSON SAJA dengan format:
{
  "intent": "menu|order|status|cancel|unknown",
  "product_key": "string|null",
  "qty": number|null
}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3-8b-8192",
        messages: [
          {
            role: "system",
            content: "Kamu hanya output JSON valid, tanpa teks lain."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0,
        max_tokens: 150
      })
    });
    
    if (!response.ok) {
      console.error("Groq API error:", await response.text());
      return defaultResponse;
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content;
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{.*\}/s);
    if (!jsonMatch) {
      console.error("No JSON found in AI response:", content);
      return defaultResponse;
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate and normalize response
    const validIntents = ["menu", "order", "status", "cancel", "unknown"];
    const result = {
      intent: validIntents.includes(parsed.intent) ? parsed.intent : "unknown",
      product_key: parsed.product_key && productList.some(p => p.key === parsed.product_key) ? parsed.product_key : null,
      qty: parsed.qty && Number.isInteger(parsed.qty) && parsed.qty > 0 ? parsed.qty : null
    };
    
    console.log("AI parsed:", text, "->", result);
    return result;
  } catch (error) {
    console.error("AI parsing error:", error);
    return defaultResponse;
  }
}

// send admin notification (with approve/reject)
async function notifyAdmin(env, order) {
  const adminChat = env.ADMIN_CHAT_ID;
  if (!adminChat) return;
  const text = `🔔 *New Order* (ID: ${order.id})\n\n` +
               `User: ${order.userId}\n` +
               `Produk: *${order.name}*\n` +
               `Jumlah: ${order.qty}\n` +
               `Total: *${formatRupiah(order.total)}*\n` +
               `Dibuat: ${order.createdAt}\n\n` +
               `Tekan Approve untuk setujui, Reject untuk tolak.`;
  await tg(env, "sendMessage", {
    chat_id: adminChat,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `admin_approve|${order.id}` },
          { text: "❌ Reject", callback_data: `admin_reject|${order.id}` }
        ],
        [
          { text: "🗑 Cancel Order", callback_data: `admin_cancel|${order.id}` }
        ]
      ]
    }
  });
}

// MAIN
export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");
    let update;
    try {
      update = await req.json();
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    // CALLBACK handler
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const fromId = cb.from.id;
      const data = cb.data || "";

      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(()=>{});

      // MENU selection (user)
      if (data.startsWith("menu_")) {
        const key = data.replace("menu_", "");
        const p = PRODUCTS[key];
        if (!p) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
          return new Response("OK");
        }
        USER_STATE.set(fromId, { step: "interest", product: key });
        await tg(env, "sendPhoto", {
          chat_id: chatId,
          photo: p.image || MENU_IMAGE,
          caption: `🥖 *${p.name}*\n\n${p.desc}\n\n💰 *${formatRupiah(p.price)}*\n\nStok: *${p.stock ?? 0}*\n\nApakah Anda ingin memesan?`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Ya", callback_data: `yes_interest|${key}` }],
              [{ text: "❌ Tidak", callback_data: `no_interest` }]
            ]
          }
        });
        return new Response("OK");
      }

      // yes_interest -> ask qty
      if (data.startsWith("yes_interest")) {
        const parts = data.split("|");
        const key = parts[1]; // product
        USER_STATE.set(fromId, { step: "qty", product: key });
        await tg(env, "sendMessage", { chat_id: chatId, text: "Mau pesan berapa buah?" });
        return new Response("OK");
      }

      // no_interest -> cancel
      if (data === "no_interest") {
        USER_STATE.delete(fromId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Siap kak 🙏 Kalau butuh silakan chat lagi." });
        return new Response("OK");
      }

      // confirm_order encoded: confirm_order|product|qty|userId
      if (data.startsWith("confirm_order|")) {
        const tokens = data.split("|");
        const productKey = tokens[1];
        const qty = Number(tokens[2]);
        const origUserId = Number(tokens[3]);

        const p = PRODUCTS[productKey];
        if (!p || !qty || !origUserId) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Maaf, data pesanan tidak valid. Silakan mulai ulang." });
          return new Response("OK");
        }

        if ((p.stock ?? 0) < qty) {
          await tg(env, "sendMessage", { 
            chat_id: chatId, 
            text: `Maaf, stok untuk *${p.name}* tidak mencukupi. Stok saat ini: ${p.stock ?? 0}.`, 
            parse_mode: "Markdown" 
          });
          return new Response("OK");
        }

        const invId = generateInvoiceId();
        const now = getWIBDate().toISOString();
        const total = p.price * qty;
        const order = {
          id: invId,
          userId: origUserId,
          chatId: chatId,
          product: p.key,
          name: p.name,
          desc: p.desc,
          price: p.price,
          qty,
          total,
          status: "pending",
          createdAt: now
        };
        ORDERS.set(invId, order);

        if (isWorkingHour()) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              `🧾 *Invoice Sementara* (ID: *${invId}*)\n\n` +
              `Produk: *${order.name}*\nJumlah: ${order.qty}\nHarga satuan: ${formatRupiah(order.price)}\n\n*Total: ${formatRupiah(order.total)}*\n\n` +
              `⏳ Pesanan Anda akan segera dikonfirmasi oleh admin.`,
            parse_mode: "Markdown"
          });
        } else {
          const nowDate = getWIBDate();
          let confirmAt = new Date(nowDate);
          if (nowDate.getHours() >= WORK_END) confirmAt.setDate(confirmAt.getDate() + 1);
          confirmAt.setHours(WORK_START, 0, 0, 0);
          const confirmAtStr = confirmAt.toLocaleString("id-ID");
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              `🧾 *Invoice Sementara* (ID: *${invId}*)\n\n` +
              `Produk: *${order.name}*\nJumlah: ${order.qty}\nHarga satuan: ${formatRupiah(order.price)}\n\n*Total: ${formatRupiah(order.total)}*\n\n` +
              `⚠️ Saat ini di luar jam kerja. Admin akan mengonfirmasi pesanan Anda pada *${confirmAtStr}* (WIB).`,
            parse_mode: "Markdown"
          });
        }

        await notifyAdmin(env, order).catch(()=>{});
        USER_STATE.delete(origUserId);
        return new Response("OK");
      }

      // cancel_order (user clicked cancel on confirmation)
      if (data === "cancel_order") {
        USER_STATE.delete(fromId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Pesanan dibatalkan 🙏 Jika ingin pesan ulang, silakan chat lagi." });
        return new Response("OK");
      }

      // ADMIN callbacks: admin_approve|INV, admin_reject|INV, admin_cancel|INV
      if (data.startsWith("admin_approve|") || data.startsWith("admin_reject|") || data.startsWith("admin_cancel|")) {
        const [cmd, invId] = data.split("|");
        const order = ORDERS.get(invId);
        if (!order) {
          await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${invId} tidak ditemukan atau sudah diproses.` });
          return new Response("OK");
        }

        if (!isAdminChat(chatId)) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Anda tidak punya izin untuk melakukan aksi ini." });
          return new Response("OK");
        }

        if (cmd === "admin_approve") {
          const prod = PRODUCTS[order.product];
          if (!prod) {
            await tg(env, "sendMessage", { chat_id: chatId, text: `Produk untuk order ${invId} tidak ditemukan.` });
            return new Response("OK");
          }
          if ((prod.stock ?? 0) < order.qty) {
            order.status = "rejected";
            ORDERS.set(invId, order);
            await tg(env, "sendMessage", {
              chat_id: order.chatId,
              text: `❌ Maaf, pesanan Anda (ID: ${invId}) tidak dapat diproses karena stok kurang. Silakan hubungi admin.`,
              parse_mode: "Markdown"
            });
            await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${invId} rejected due to insufficient stock.` });
            return new Response("OK");
          }

          prod.stock = (prod.stock ?? 0) - order.qty;
          order.status = "approved";
          ORDERS.set(invId, order);

          await tg(env, "sendMessage", {
            chat_id: order.chatId,
            text: `✅ Pesanan Anda (ID: ${invId}) telah *DISETUJUI* oleh admin.\nAdmin akan menghubungi untuk konfirmasi selanjutnya.\nSisa stok ${prod.name}: *${prod.stock}*`,
            parse_mode: "Markdown"
          });
          await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${invId} approved.` });
          return new Response("OK");
        }

        if (cmd === "admin_reject") {
          order.status = "rejected";
          ORDERS.set(invId, order);
          await tg(env, "sendMessage", {
            chat_id: order.chatId,
            text: `❌ Maaf, pesanan Anda (ID: ${invId}) *DITOLAK* oleh admin. Silakan hubungi kami jika perlu penjelasan.`,
            parse_mode: "Markdown"
          });
          await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${invId} rejected.` });
          return new Response("OK");
        }

        if (cmd === "admin_cancel") {
          order.status = "cancelled";
          ORDERS.set(invId, order);
          await tg(env, "sendMessage", {
            chat_id: order.chatId,
            text: `⚠️ Pesanan Anda (ID: ${invId}) dibatalkan oleh admin.`,
            parse_mode: "Markdown"
          });
          await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${invId} cancelled by admin.` });
          return new Response("OK");
        }
      }

      return new Response("OK");
    }

    // MESSAGE handler
    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const text = msg.text.trim();

    // Admin-only commands (no AI detection for admin commands)
    // /addproduct key|name|desc|price|stock|image(optional)
    if (text.startsWith("/addproduct")) {
      if (!isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Hanya admin yang dapat menambah produk." });
        return new Response("OK");
      }
      const payload = text.replace(/\/addproduct\s*/i, "").trim();
      const parts = payload.split("|").map(s=>s.trim());
      if (parts.length < 5) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Format: /addproduct key|Nama Produk|Deskripsi|harga|stok|image(optional)" });
        return new Response("OK");
      }
      const [key, name, desc, priceStr, stockStr, image] = parts;
      const price = Number(priceStr.replace(/[^0-9]/g, "")) || 0;
      const stock = Number(stockStr) || 0;
      PRODUCTS[key] = { key, name, desc, price, image: image || MENU_IMAGE, stock };
      await tg(env, "sendMessage", { chat_id: chatId, text: `Produk *${name}* berhasil ditambahkan (key: ${key}).`, parse_mode: "Markdown" });
      return new Response("OK");
    }

    // /addstock key qty
    if (text.startsWith("/addstock")) {
      if (!isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Hanya admin yang dapat mengubah stok." });
        return new Response("OK");
      }
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Format: /addstock <key> <qty>" });
        return new Response("OK");
      }
      const key = parts[1];
      const qty = Number(parts[2]);
      const p = PRODUCTS[key];
      if (!p) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Produk dengan key ${key} tidak ditemukan.` });
        return new Response("OK");
      }
      p.stock = (p.stock ?? 0) + qty;
      await tg(env, "sendMessage", { chat_id: chatId, text: `Stok ${p.name} berhasil ditambah. Stok sekarang: ${p.stock}.` });
      return new Response("OK");
    }

    // /editstock key qty
    if (text.startsWith("/editstock")) {
      if (!isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Hanya admin yang dapat mengubah stok." });
        return new Response("OK");
      }
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Format: /editstock <key> <qty>" });
        return new Response("OK");
      }
      const key = parts[1];
      const qty = Number(parts[2]);
      const p = PRODUCTS[key];
      if (!p) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Produk dengan key ${key} tidak ditemukan.` });
        return new Response("OK");
      }
      p.stock = qty;
      await tg(env, "sendMessage", { chat_id: chatId, text: `Stok ${p.name} diset menjadi ${p.stock}.` });
      return new Response("OK");
    }

    // /editprice key newPrice
    if (text.startsWith("/editprice")) {
      if (!isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Hanya admin yang dapat mengubah harga." });
        return new Response("OK");
      }
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Format: /editprice <key> <harga>" });
        return new Response("OK");
      }
      const key = parts[1];
      const price = Number(parts[2].replace(/[^0-9]/g, "")) || 0;
      const p = PRODUCTS[key];
      if (!p) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Produk dengan key ${key} tidak ditemukan.` });
        return new Response("OK");
      }
      p.price = price;
      await tg(env, "sendMessage", { chat_id: chatId, text: `Harga ${p.name} diset menjadi ${formatRupiah(p.price)}.` });
      return new Response("OK");
    }

    // /delproduct key
    if (text.startsWith("/delproduct")) {
      if (!isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Hanya admin yang dapat menghapus produk." });
        return new Response("OK");
      }
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Format: /delproduct <key>" });
        return new Response("OK");
      }
      const key = parts[1];
      const p = PRODUCTS[key];
      if (!p) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Produk dengan key ${key} tidak ditemukan.` });
        return new Response("OK");
      }
      delete PRODUCTS[key];
      await tg(env, "sendMessage", { chat_id: chatId, text: `Produk ${p.name} (key: ${key}) berhasil dihapus.` });
      return new Response("OK");
    }

    // User commands (non-admin)
    // /products -> daftar produk beserta stok
    if (text.startsWith("/products")) {
      const list = Object.values(PRODUCTS);
      if (!list.length) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Belum ada produk." });
        return new Response("OK");
      }
      let msg = "📦 *Daftar Produk*\n\n";
      list.forEach(p => {
        msg += `• *${p.name}* (key: ${p.key})\n  Harga: ${formatRupiah(p.price)}\n  Stok: ${p.stock ?? 0}\n\n`;
      });
      await tg(env, "sendMessage", { chat_id: chatId, text: msg, parse_mode: "Markdown" });
      return new Response("OK");
    }

    // Commands: /status <id>
    if (text.startsWith("/status")) {
      const parts = text.split(/\s+/);
      const id = parts[1];
      if (!id) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Gunakan: /status <INVOICE_ID>\nContoh: /status INVXXXX" });
        return new Response("OK");
      }
      const order = ORDERS.get(id);
      if (!order) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Order dengan ID ${id} tidak ditemukan.` });
        return new Response("OK");
      }
      if (order.userId !== fromId && !isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Anda tidak punya izin melihat order ini.` });
        return new Response("OK");
      }
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🧾 Status Order (ID: *${order.id}*)\n\n` +
          `Produk: *${order.name}*\nJumlah: ${order.qty}\nTotal: ${formatRupiah(order.total)}\nStatus: *${order.status}*\nDibuat: ${order.createdAt}`,
        parse_mode: "Markdown"
      });
      return new Response("OK");
    }

    // Commands: /cancel <id>
    if (text.startsWith("/cancel")) {
      const parts = text.split(/\s+/);
      const id = parts[1];
      if (!id) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Gunakan: /cancel <INVOICE_ID>\nContoh: /cancel INVXXXX" });
        return new Response("OK");
      }
      const order = ORDERS.get(id);
      if (!order) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Order dengan ID ${id} tidak ditemukan.` });
        return new Response("OK");
      }
      if (order.userId !== fromId && !isAdminChat(chatId)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Anda tidak punya izin membatalkan order ini.` });
        return new Response("OK");
      }
      if (order.status === "cancelled") {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${id} sudah dibatalkan sebelumnya.` });
        return new Response("OK");
      }
      order.status = "cancelled";
      ORDERS.set(id, order);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Order ${id} berhasil dibatalkan.` });
      if (env.ADMIN_CHAT_ID) {
        await tg(env, "sendMessage", { chat_id: env.ADMIN_CHAT_ID, text: `Order ${id} dibatalkan oleh ${fromId}.` }).catch(()=>{});
      }
      return new Response("OK");
    }

    // If user in flow: qty input
    const state = USER_STATE.get(fromId);
    if (state?.step === "qty" && /^\d+$/.test(text)) {
      const qty = Number(text);
      const productKey = state.product;
      const p = PRODUCTS[productKey];
      if (!p) {
        USER_STATE.delete(fromId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan. Silakan mulai ulang." });
        return new Response("OK");
      }

      if ((p.stock ?? 0) < qty) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Maaf, stok ${p.name} tidak cukup. Stok saat ini: ${p.stock ?? 0}.` });
        return new Response("OK");
      }

      const callbackData = `confirm_order|${productKey}|${qty}|${fromId}`;
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🔍 *Konfirmasi Pesanan*\n\n` +
          `Produk: *${p.name}*\n` +
          `Jumlah: ${qty}\n` +
          `Harga satuan: ${formatRupiah(p.price)}\n\n` +
          `*Total: ${formatRupiah(qty * p.price)}*\n\n` +
          `Apakah data pesanan ini sudah benar?`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Ya, Konfirmasi", callback_data: callbackData }],
            [{ text: "❌ Batal", callback_data: "cancel_order" }]
          ]
        }
      });

      USER_STATE.set(fromId, { step: "confirm_qty", product: productKey, qty });
      return new Response("OK");
    }

    // AI INTENT DETECTION (Fallback for natural language)
    // Only if not a command and not in flow
    const lower = text.toLowerCase();
    const isManualMatch = lower.includes("roti") || lower.includes("menu") || lower.includes("ada");
    
    if (!text.startsWith("/") && !state?.step && !isManualMatch) {
      // Use AI to detect intent
      const aiResult = await aiParseIntent(env, text);
      
      // Handle based on AI intent
      if (aiResult.intent === "menu") {
        const buttons = Object.values(PRODUCTS).map(p => [{ text: p.name, callback_data: `menu_${p.key}` }]);
        await tg(env, "sendPhoto", {
          chat_id: chatId,
          photo: MENU_IMAGE,
          caption: "🍞 *Menu Roti Hari Ini*\nSilakan pilih roti di bawah 👇",
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: buttons }
        });
        return new Response("OK");
      }
      
      else if (aiResult.intent === "order" && aiResult.product_key) {
        const p = PRODUCTS[aiResult.product_key];
        if (!p) {
          // Product not found, show menu
          const buttons = Object.values(PRODUCTS).map(p => [{ text: p.name, callback_data: `menu_${p.key}` }]);
          await tg(env, "sendPhoto", {
            chat_id: chatId,
            photo: MENU_IMAGE,
            caption: "🍞 *Menu Roti Hari Ini*\nSaya tidak yakin roti mana yang Anda maksud. Silakan pilih:",
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: buttons }
          });
          return new Response("OK");
        }
        
        // If qty is detected by AI, proceed to confirmation
        if (aiResult.qty) {
          if ((p.stock ?? 0) < aiResult.qty) {
            await tg(env, "sendMessage", { 
              chat_id: chatId, 
              text: `Maaf, stok ${p.name} tidak cukup. Stok saat ini: ${p.stock ?? 0}.` 
            });
            return new Response("OK");
          }
          
          const callbackData = `confirm_order|${aiResult.product_key}|${aiResult.qty}|${fromId}`;
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              `🔍 *Konfirmasi Pesanan*\n\n` +
              `Produk: *${p.name}*\n` +
              `Jumlah: ${aiResult.qty}\n` +
              `Harga satuan: ${formatRupiah(p.price)}\n\n` +
              `*Total: ${formatRupiah(aiResult.qty * p.price)}*\n\n` +
              `Apakah data pesanan ini sudah benar?`,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Ya, Konfirmasi", callback_data: callbackData }],
                [{ text: "❌ Batal", callback_data: "cancel_order" }]
              ]
            }
          });
          return new Response("OK");
        } else {
          // No qty detected, ask for quantity
          USER_STATE.set(fromId, { step: "qty", product: aiResult.product_key });
          await tg(env, "sendMessage", { 
            chat_id: chatId, 
            text: `Anda ingin memesan *${p.name}*. Mau pesan berapa buah?`,
            parse_mode: "Markdown"
          });
          return new Response("OK");
        }
      }
      
      else if (aiResult.intent === "status") {
        await tg(env, "sendMessage", { 
          chat_id: chatId, 
          text: "Untuk mengecek status pesanan, gunakan: /status <INVOICE_ID>\nContoh: /status INV1234ABCD" 
        });
        return new Response("OK");
      }
      
      else if (aiResult.intent === "cancel") {
        await tg(env, "sendMessage", { 
          chat_id: chatId, 
          text: "Untuk membatalkan pesanan, gunakan: /cancel <INVOICE_ID>\nContoh: /cancel INV1234ABCD" 
        });
        return new Response("OK");
      }
      
      // If AI returns unknown or no valid intent detected
      // Continue to manual matching
    }

    // Manual matching (original behavior - kept as fallback)
    if (lower.includes("roti") || lower.includes("menu") || lower.includes("ada")) {
      const buttons = Object.values(PRODUCTS).map(p => [{ text: p.name, callback_data: `menu_${p.key}` }]);
      await tg(env, "sendPhoto", {
        chat_id: chatId,
        photo: MENU_IMAGE,
        caption: "🍞 *Menu Roti Hari Ini*\nSilakan pilih roti di bawah 👇",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      });
      return new Response("OK");
    }

    // Default fallback
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Terima kasih kak 🙏\nPesan ini akan dibantu admin secara manual. Untuk memeriksa pesanan: /status <ID> atau batalkan /cancel <ID>.\nUntuk melihat menu, ketik 'menu' atau 'roti'."
    });

    return new Response("OK");
  }
};
