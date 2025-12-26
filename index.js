// worker.js — Telegram worker (full)
// Features:
// - Menu image + inline buttons
// - answerCallbackQuery for every callback (fix tombol)
// - Konfirmasi sebelum invoice
// - Invoice ID otomatis (INV...)
// - ORDERS map: /status <id>, /cancel <id>
// - Jam kerja strict (WIB)

const USER_STATE = new Map(); // per-user interaction state
const ORDERS = new Map(); // invoiceId -> order object

// CONFIG
const MENU_IMAGE = "https://lh3.googleusercontent.com/86arOE_jc_FYR6_mPbeXrzWB4LwvgCRWPGXbbftgG4_zAjY05ajbmq3xiG0Xc_uYCoTccikGvLdo5WIlofH5pmySn1VRejqngh2pwDLquiLJYayCOJKUrZKFnOwmSxKzQqqOM1y5o42TPk6LYR1vbPjrEPx3dQIUEwS4IPRjzt3JdPZT32TkqCECm-PoQtsBAPnyN6g46PbiyD9fblgzuBcT2xuO1AaZgOkR53bom8ATCBkDgcYT_mnsxWuxLGp6cNFUR4lWBFKyYkYJWJY--KmIVCWDDoJ3SxwjimGjwRG-X2Qu3AP4wa6tRazHuBo3a8IOofm6f5arSRdpVy4AaXoacTPz8TSkcofA0YaIttHpek1Gi5v1yMSbi5mHV6Mfv4lyczXPp8c5iNR7IFPvgMz1BiCETTxNwSvDjb2JCN94_256Fzejrs-Dk-kMYeCCYQh2Zd_lt9xiEQDgZ5gufdpxxM9xDiP447vrOqKbBMcAS_6hu43EwRi97ILAhBpS3QLP-4WhKf4GHauWqML_EcBvhszB-6T1iGeCWvpAT9jZVDVgekalBvLZiZNoy5Ow9QlnHA=w1827-h711-no";

const PRODUCTS = {
  premium: {
    key: "premium",
    name: "Roti Premium",
    desc: "Roti premium tanpa kulit dengan topping coklat & keju",
    price: 12000,
    image: MENU_IMAGE // reuse or put specific image
  }
};

// Working hours (WIB)
const WORK_START = 8; // 08:00
const WORK_END = 17;  // 17:00
const TZ_OFFSET = 7;  // WIB = UTC+7

// Helper: get current date in WIB
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

async function tg(env, method, data) {
  return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

// Main worker
export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");
    let update;
    try {
      update = await req.json();
    } catch (e) {
      return new Response("Bad request", { status: 400 });
    }

    // CALLBACK handler (inline buttons)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const userId = cb.from.id;
      const data = cb.data;

      // MUST answer callback to avoid "dead" buttons
      await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

      // Handle menu selection
      if (data === "menu_premium") {
        USER_STATE.set(userId, { step: "interest", product: "premium" });

        const p = PRODUCTS.premium;
        await tg(env, "sendPhoto", {
          chat_id: chatId,
          photo: p.image,
          caption: `🥖 *${p.name}*\n\n${p.desc}\n\n💰 *${formatRupiah(p.price)}*\n\nApakah Anda ingin memesan?`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Ya", callback_data: "yes_interest" }],
              [{ text: "❌ Tidak", callback_data: "no_interest" }]
            ]
          }
        });
      }

      // User confirmed interest and wants to enter qty
      else if (data === "yes_interest") {
        USER_STATE.set(userId, { step: "qty", product: "premium" });
        await tg(env, "sendMessage", { chat_id: chatId, text: "Mau pesan berapa buah?" });
      }

      // User declined
      else if (data === "no_interest") {
        USER_STATE.delete(userId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Siap kak 🙏 Kalau butuh silakan chat lagi." });
      }

      // After user enters qty we will ask confirmation with buttons:
      else if (data === "confirm_order") {
        const state = USER_STATE.get(userId);
        if (!state || !state.product || !state.qty) {
          await tg(env, "sendMessage", { chat_id: chatId, text: "Maaf, data pesanan tidak ditemukan. Silakan mulai lagi." });
          USER_STATE.delete(userId);
          return new Response("OK");
        }

        // create invoice id and store order
        const p = PRODUCTS[state.product];
        const total = p.price * state.qty;
        const invId = generateInvoiceId();
        const now = getWIBDate().toISOString();

        const order = {
          id: invId,
          userId,
          chatId,
          product: p.key,
          name: p.name,
          desc: p.desc,
          price: p.price,
          qty: state.qty,
          total,
          status: "pending",
          createdAt: now
        };
        ORDERS.set(invId, order);
        USER_STATE.delete(userId);

        // Message about invoice + if outside working hours, tell when admin will confirm
        if (isWorkingHour()) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              `🧾 *Invoice Sementara* (ID: *${invId}*)\n\n` +
              `Produk: *${order.name}*\nJumlah: ${order.qty}\nHarga satuan: ${formatRupiah(order.price)}\n\n*Total: ${formatRupiah(order.total)}*\n\n` +
              `⏳ Pesanan Anda akan segera dikonfirmasi oleh admin (dalam jam kerja).`,
            parse_mode: "Markdown"
          });
        } else {
          // compute next work start time (next day's WORK_START if now past end)
          const now = getWIBDate();
          let confirmAt = new Date(now);
          if (now.getHours() >= WORK_END) {
            // next day at WORK_START
            confirmAt.setDate(confirmAt.getDate() + 1);
          }
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

        // (Optional) notify admin/chat channel here by calling env.ADMIN_CHAT_ID if set
        // if (env.ADMIN_CHAT_ID) { await tg(env, "sendMessage", { chat_id: env.ADMIN_CHAT_ID, text: `New order ${invId}` }); }

        return new Response("OK");
      }

      // Cancel order from the confirmation buttons
      else if (data === "cancel_order") {
        USER_STATE.delete(userId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Pesanan dibatalkan 🙏 Jika ingin pesan ulang, silakan chat lagi." });
        return new Response("OK");
      }

      return new Response("OK");
    } // end callback_query

    // MESSAGE handler (text commands + normal flow)
    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    // Commands: /status <id>
    if (text.startsWith("/status")) {
      const parts = text.split(/\s+/);
      const id = parts[1];
      if (!id) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "Gunakan: /status <INVOICE_ID>\nContoh: /status INVXXXXX" });
        return new Response("OK");
      }
      const order = ORDERS.get(id);
      if (!order) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Order dengan ID ${id} tidak ditemukan.` });
        return new Response("OK");
      }
      // only owner (or admin in future) can view
      if (order.userId !== userId) {
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
        await tg(env, "sendMessage", { chat_id: chatId, text: "Gunakan: /cancel <INVOICE_ID>\nContoh: /cancel INVXXXXX" });
        return new Response("OK");
      }
      const order = ORDERS.get(id);
      if (!order) {
        await tg(env, "sendMessage", { chat_id: chatId, text: `Order dengan ID ${id} tidak ditemukan.` });
        return new Response("OK");
      }
      // allow only owner to cancel (admin logic can be added)
      if (order.userId !== userId) {
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
      // (Optional) notify admin
      return new Response("OK");
    }

    // If user is in state asking quantity and message is a plain number -> go to confirmation step
    const state = USER_STATE.get(userId);
    if (state?.step === "qty" && /^\d+$/.test(text)) {
      const qty = Number(text);
      if (!state.product || !PRODUCTS[state.product]) {
        USER_STATE.delete(userId);
        await tg(env, "sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan. Silakan mulai ulang." });
        return new Response("OK");
      }
      const p = PRODUCTS[state.product];
      // save qty and go to confirm_qty
      USER_STATE.set(userId, { step: "confirm_qty", product: state.product, qty });

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
            [{ text: "✅ Ya, Konfirmasi", callback_data: "confirm_order" }],
            [{ text: "❌ Batal", callback_data: "cancel_order" }]
          ]
        }
      });
      return new Response("OK");
    }

    // General inquiry: show menu (image + buttons)
    // Trigger by keywords or any message when not mid-flow
    const lower = text.toLowerCase();
    if (lower.includes("roti") || lower.includes("menu") || lower.includes("ada")) {
      // build product buttons from PRODUCTS
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

    // Default fallback (human)
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Terima kasih kak 🙏\nPesan ini akan dibantu admin secara manual. Jika mau lihat pesanan: gunakan /status <ID> atau batalkan /cancel <ID> (jika Anda pemilik)."
    });

    return new Response("OK");
  }
};
