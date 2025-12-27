// worker.js — Telegram Worker (full, stateless callbacks, admin approve/reject, cancel by ID)
// Env required: BOT_TOKEN, ADMIN_CHAT_ID (chat id where admin will get notifications)
// Optional: ADMIN_USER_ID (telegram numeric id for admin user, used for permission checking)

const USER_STATE = new Map(); // temporary per-user flow (safe to use for in-flow, but not for final confirm)
const ORDERS = new Map(); // invoiceId -> order object (in-memory)

// CONFIG
const MENU_IMAGE = "https://lh3.googleusercontent.com/86arOE_jc_FYR6_mPbeXrzWB4LwvgCRWPGXbbftgG4_zAjY05ajbmq3xiG0Xc_uYCoTccikGvLdo5WIlofH5pmySn1VRejqngh2pwDLquiLJYayCOJKUrZKFnOwmSxKzQqqOM1y5o42TPk6LYR1vbPjrEPx3dQIUEwS4IPRjzt3JdPZT32TkqCECm-PoQtsBAPnyN6g46PbiyD9fblgzuBcT2xuO1AaZgOkR53bom8ATCBkDgcYT_mnsxWuxLGp6cNFUR4lWBFKyYkYJWJY--KmIVCWDDoJ3SxwjimGjwRG-X2Qu3AP4wa6tRazHuBo3a8IOofm6f5arSRdpVy4AaXoacTPz8TSkcofA0YaIttHpek1Gi5v1yMSbi5mHV6Mfv4lyczXPp8c5iNR7IFPvgMz1BiCETTxNwSvDjb2JCN94_256Fzejrs-Dk-kMYeCCYQh2Zd_lt9xiEQDgZ5gufdpxxM9xDiP447vrOqKbBMcAS_6hu43EwRi97ILAhBpS3QLP-4WhKf4GHauWqML_EcBvhszB-6T1iGeCWvpAT9jZVDVgekalBvLZiZNoy5Ow9QlnHA=w1827-h711-no";

const PRODUCTS = {
  premium: {
    key: "premium",
    name: "Roti Premium",
    desc: "Roti premium tanpa kulit dengan topping coklat & keju",
    price: 12000,
    image: MENU_IMAGE
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
    // swallow; caller can ignore or handle
    return null;
  }
}

// send admin notification (with approve/reject)
async function notifyAdmin(env, order) {
  const adminChat = env.ADMIN_CHAT_ID;
  if (!adminChat) return;
  const text =
    `🔔 *New Order* (ID: ${order.id})\n\n` +
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

      // Always answer to avoid "dead" buttons
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
          chat_id,
          photo: p.image,
          caption: `🥖 *${p.name}*\n\n${p.desc}\n\n💰 *${formatRupiah(p.price)}*\n\nApakah Anda ingin memesan?`,
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
        await tg(env, "sendMessage", { chat_id, text: "Mau pesan berapa buah?" });
        return new Response("OK");
      }

      // no_interest -> cancel
      if (data === "no_interest") {
        USER_STATE.delete(fromId);
        await tg(env, "sendMessage", { chat_id, text: "Siap kak 🙏 Kalau butuh silakan chat lagi." });
        return new Response("OK");
      }

      // confirm_order encoded: confirm_order|product|qty|userId
      if (data.startsWith("confirm_order|")) {
        // parse tokens
        const tokens = data.split("|");
        // expected [confirm_order, productKey, qty, userId]
        const productKey = tokens[1];
        const qty = Number(tokens[2]);
        const origUserId = Number(tokens[3]);

        const p = PRODUCTS[productKey];
        if (!p || !qty || !origUserId) {
          await tg(env, "sendMessage", { chat_id, text: "Maaf, data pesanan tidak valid. Silakan mulai ulang." });
          return new Response("OK");
        }

        // create order
        const invId = generateInvoiceId();
        const now = getWIBDate().toISOString();
        const total = p.price * qty;
        const order = {
          id: invId,
          userId: origUserId,
          chatId: chatId, // chat where confirmed (user chat)
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

        // notify user invoice created
        if (isWorkingHour()) {
          await tg(env, "sendMessage", {
            chat_id,
            text:
              `🧾 *Invoice Sementara* (ID: *${invId}*)\n\n` +
              `Produk: *${order.name}*\nJumlah: ${order.qty}\nHarga satuan: ${formatRupiah(order.price)}\n\n*Total: ${formatRupiah(order.total)}*\n\n` +
              `⏳ Pesanan Anda akan segera dikonfirmasi oleh admin.`,
            parse_mode: "Markdown"
          });
        } else {
          // compute next work start
          const nowDate = getWIBDate();
          let confirmAt = new Date(nowDate);
          if (nowDate.getHours() >= WORK_END) confirmAt.setDate(confirmAt.getDate() + 1);
          confirmAt.setHours(WORK_START, 0, 0, 0);
          const confirmAtStr = confirmAt.toLocaleString("id-ID");
          await tg(env, "sendMessage", {
            chat_id,
            text:
              `🧾 *Invoice Sementara* (ID: *${invId}*)\n\n` +
              `Produk: *${order.name}*\nJumlah: ${order.qty}\nHarga satuan: ${formatRupiah(order.price)}\n\n*Total: ${formatRupiah(order.total)}*\n\n` +
              `⚠️ Saat ini di luar jam kerja. Admin akan mengonfirmasi pesanan Anda pada *${confirmAtStr}* (WIB).`,
            parse_mode: "Markdown"
          });
        }

        // notify admin (with approve/reject)
        await notifyAdmin(env, order).catch(()=>{});

        // clear any user state (we already stored order)
        USER_STATE.delete(origUserId);

        return new Response("OK");
      }

      // cancel_order (user clicked cancel on confirmation)
      if (data === "cancel_order") {
        USER_STATE.delete(fromId);
        await tg(env, "sendMessage", { chat_id, text: "Pesanan dibatalkan 🙏 Jika ingin pesan ulang, silakan chat lagi." });
        return new Response("OK");
      }

      // ADMIN callbacks: admin_approve|INV, admin_reject|INV, admin_cancel|INV
      if (data.startsWith("admin_approve|") || data.startsWith("admin_reject|") || data.startsWith("admin_cancel|")) {
        const [cmd, invId] = data.split("|");
        const order = ORDERS.get(invId);
        if (!order) {
          await tg(env, "sendMessage", { chat_id, text: `Order ${invId} tidak ditemukan atau sudah diproses.` });
          return new Response("OK");
        }

        // Only allow admin (simple check). Admin user id can be provided via ADMIN_USER_ID env (optional).
        const adminUserId = env.ADMIN_USER_ID ? Number(env.ADMIN_USER_ID) : null;
        if (adminUserId && Number(fromId) !== adminUserId) {
          await tg(env, "sendMessage", { chat_id, text: "Anda tidak punya izin untuk melakukan aksi ini." });
          return new Response("OK");
        }

        if (cmd === "admin_approve") {
          order.status = "approved";
          ORDERS.set(invId, order);
          // notify user
          await tg(env, "sendMessage", {
            chat_id: order.chatId,
            text: `✅ Pesanan Anda (ID: ${invId}) telah *DISETUJUI* oleh admin.\nAdmin akan menghubungi untuk konfirmasi selanjutnya.`,
            parse_mode: "Markdown"
          });
          await tg(env, "sendMessage", { chat_id, cb.message.chat.id, text: `Order ${invId} approved.` });
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
          await tg(env, "sendMessage", { chat_id: cb.message.chat.id, text: `Order ${invId} rejected.` });
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
          await tg(env, "sendMessage", { chat_id: cb.message.chat.id, text: `Order ${invId} cancelled by admin.` });
          return new Response("OK");
        }
      }

      return new Response("OK");
    } // end callback_query

    // MESSAGE handler
    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const text = msg.text.trim();

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
      // only owner or admin (ADMIN_USER_ID) can view details
      const adminUserId = env.ADMIN_USER_ID ? Number(env.ADMIN_USER_ID) : null;
      if (order.userId !== fromId && adminUserId !== fromId) {
        await tg(env, "sendMessage", { chat_id, text: `Anda tidak punya izin melihat order ini.` });
        return new Response("OK");
      }
      await tg(env, "sendMessage", {
        chat_id,
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
        await tg(env, "sendMessage", { chat_id, text: "Gunakan: /cancel <INVOICE_ID>\nContoh: /cancel INVXXXX" });
        return new Response("OK");
      }
      const order = ORDERS.get(id);
      if (!order) {
        await tg(env, "sendMessage", { chat_id, text: `Order dengan ID ${id} tidak ditemukan.` });
        return new Response("OK");
      }
      const adminUserId = env.ADMIN_USER_ID ? Number(env.ADMIN_USER_ID) : null;
      if (order.userId !== fromId && adminUserId !== fromId) {
        await tg(env, "sendMessage", { chat_id, text: `Anda tidak punya izin membatalkan order ini.` });
        return new Response("OK");
      }
      if (order.status === "cancelled") {
        await tg(env, "sendMessage", { chat_id, text: `Order ${id} sudah dibatalkan sebelumnya.` });
        return new Response("OK");
      }
      order.status = "cancelled";
      ORDERS.set(id, order);
      await tg(env, "sendMessage", { chat_id, text: `Order ${id} berhasil dibatalkan.` });
      // notify admin optionally
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
        await tg(env, "sendMessage", { chat_id, text: "Produk tidak ditemukan. Silakan mulai ulang." });
        return new Response("OK");
      }

      // Create confirmation buttons that encode all needed data in callback_data
      // Format: confirm_order|productKey|qty|userId
      const callbackData = `confirm_order|${productKey}|${qty}|${fromId}`;

      // show confirmation
      await tg(env, "sendMessage", {
        chat_id,
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

      // keep small state if you want; not required for final confirmation
      USER_STATE.set(fromId, { step: "confirm_qty", product: productKey, qty });
      return new Response("OK");
    }

    // General inquiry: show menu (image + buttons)
    const lower = text.toLowerCase();
    if (lower.includes("roti") || lower.includes("menu") || lower.includes("ada")) {
      const buttons = Object.values(PRODUCTS).map(p => [{ text: p.name, callback_data: `menu_${p.key}` }]);
      await tg(env, "sendPhoto", {
        chat_id,
        photo: MENU_IMAGE,
        caption: "🍞 *Menu Roti Hari Ini*\nSilakan pilih roti di bawah 👇",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      });
      return new Response("OK");
    }

    // Default fallback (human)
    await tg(env, "sendMessage", {
      chat_id,
      text: "Terima kasih kak 🙏\nPesan ini akan dibantu admin secara manual. Untuk memeriksa pesanan: /status <ID> atau batalkan /cancel <ID>."
    });

    return new Response("OK");
  }
};
