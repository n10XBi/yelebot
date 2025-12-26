const USER_STATE = new Map();

// ==========================
// CONFIG
// ==========================
const WORK_START = 8;   // 08:00
const WORK_END = 17;    // 17:00
const TZ_OFFSET = 7;    // WIB

// ==========================
// DB JSON (TMP)
// ==========================
const PRODUCTS = {
  roti_coklat: {
    name: "Roti Coklat",
    desc: "Roti lembut dengan isian coklat manis",
    price: 8000,
    image: "https://via.placeholder.com/400x300?text=Roti+Coklat"
  },
  roti_keju: {
    name: "Roti Keju",
    desc: "Roti lembut dengan topping keju gurih",
    price: 9000,
    image: "https://via.placeholder.com/400x300?text=Roti+Keju"
  },
  roti_premium: {
    name: "Roti Premium",
    desc: "Roti premium tanpa kulit dengan topping coklat & keju",
    price: 12000,
    image: "https://via.placeholder.com/400x300?text=Roti+Premium"
  }
};

// ==========================
// UTIL
// ==========================
function isWorkingHour() {
  const now = new Date(Date.now() + TZ_OFFSET * 3600000);
  const h = now.getUTCHours();
  return h >= WORK_START && h < WORK_END;
}

function formatRupiah(num) {
  return "Rp" + num.toLocaleString("id-ID");
}

// ==========================
// SENDERS
// ==========================
async function sendMessage(env, chatId, text, keyboard = null) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: keyboard,
      parse_mode: "Markdown"
    })
  });
}

async function sendPhoto(env, chatId, photo, caption, keyboard = null) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo,
      caption,
      reply_markup: keyboard,
      parse_mode: "Markdown"
    })
  });
}

// ==========================
// WORKER
// ==========================
export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json();
    const msg = update.message;
    const cb = update.callback_query;

    const chatId = msg?.chat.id || cb?.message.chat.id;
    const userId = msg?.from.id || cb?.from.id;
    const text = msg?.text?.toLowerCase();

    if (!chatId || !userId) return new Response("OK");

    let state = USER_STATE.get(userId) || {};

    // ======================
    // CALLBACK HANDLER
    // ======================
    if (cb) {
      const data = cb.data;

      if (data.startsWith("select_")) {
        const key = data.replace("select_", "");
        const p = PRODUCTS[key];

        state.product = key;
        state.step = "confirm_interest";
        USER_STATE.set(userId, state);

        await sendPhoto(
          env,
          chatId,
          p.image,
          `*${p.name}*\n\n${p.desc}\n\n💰 Harga: ${formatRupiah(p.price)}\n\nApakah Anda tertarik memesan?`,
          {
            inline_keyboard: [
              [{ text: "✅ Ya", callback_data: "yes_interest" }],
              [{ text: "❌ Tidak", callback_data: "no_interest" }]
            ]
          }
        );
      }

      else if (data === "yes_interest") {
        const p = PRODUCTS[state.product];
        state.step = "confirm_order";
        USER_STATE.set(userId, state);

        await sendMessage(
          env,
          chatId,
          `Mohon konfirmasi pesanan 🙏\n\n📦 *${p.name}*\n📝 ${p.desc}\n💰 ${formatRupiah(p.price)}`,
          {
            inline_keyboard: [
              [{ text: "➡️ Lanjut", callback_data: "order_continue" }],
              [{ text: "❌ Batal", callback_data: "order_cancel" }]
            ]
          }
        );
      }

      else if (data === "order_continue") {
        state.step = "ask_qty";
        USER_STATE.set(userId, state);
        await sendMessage(env, chatId, "Mau pesan berapa buah?");
      }

      else if (data === "order_cancel" || data === "no_interest") {
        USER_STATE.delete(userId);
        await sendMessage(env, chatId, "Baik kak 🙏 Jika butuh bantuan lain, silakan chat lagi.");
      }

      return new Response("OK");
    }

    // ======================
    // TEXT HANDLER
    // ======================
    if (!isWorkingHour()) {
      await sendMessage(
        env,
        chatId,
        "⏰ Kami sedang di luar jam kerja.\nPesan akan dibalas admin pada jam *08.00 WIB* 🙏"
      );
    }

    // Step: qty
    if (state.step === "ask_qty" && /^\d+$/.test(text)) {
      const qty = parseInt(text);
      const p = PRODUCTS[state.product];
      const total = qty * p.price;

      USER_STATE.delete(userId);

      await sendMessage(
        env,
        chatId,
        `🧾 *Invoice Sementara*\n\nProduk: ${p.name}\nJumlah: ${qty}\nHarga: ${formatRupiah(p.price)}\n\n*Total: ${formatRupiah(total)}*\n\n⏳ Admin akan mengonfirmasi pesanan Anda.`
      );
      return new Response("OK");
    }

    // General inquiry
    if (text?.includes("roti") || text?.includes("ada")) {
      const buttons = Object.entries(PRODUCTS).map(([k, p]) => ([
        { text: p.name, callback_data: `select_${k}` }
      ]));

      await sendMessage(
        env,
        chatId,
        "Masih kak 😊\nRoti yang tersedia hari ini:",
        { inline_keyboard: buttons }
      );
      return new Response("OK");
    }

    // Fallback
    await sendMessage(
      env,
      chatId,
      "Terima kasih kak 🙏\nPesan ini akan dibantu admin secara manual."
    );

    return new Response("OK");
  }
};
