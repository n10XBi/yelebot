const USER_STATE = new Map();

const MENU_IMAGE = "https://lh3.googleusercontent.com/86arOE_jc_FYR6_mPbeXrzWB4LwvgCRWPGXbbftgG4_zAjY05ajbmq3xiG0Xc_uYCoTccikGvLdo5WIlofH5pmySn1VRejqngh2pwDLquiLJYayCOJKUrZKFnOwmSxKzQqqOM1y5o42TPk6LYR1vbPjrEPx3dQIUEwS4IPRjzt3JdPZT32TkqCECm-PoQtsBAPnyN6g46PbiyD9fblgzuBcT2xuO1AaZgOkR53bom8ATCBkDgcYT_mnsxWuxLGp6cNFUR4lWBFKyYkYJWJY--KmIVCWDDoJ3SxwjimGjwRG-X2Qu3AP4wa6tRazHuBo3a8IOofm6f5arSRdpVy4AaXoacTPz8TSkcofA0YaIttHpek1Gi5v1yMSbi5mHV6Mfv4lyczXPp8c5iNR7IFPvgMz1BiCETTxNwSvDjb2JCN94_256Fzejrs-Dk-kMYeCCYQh2Zd_lt9xiEQDgZ5gufdpxxM9xDiP447vrOqKbBMcAS_6hu43EwRi97ILAhBpS3QLP-4WhKf4GHauWqML_EcBvhszB-6T1iGeCWvpAT9jZVDVgekalBvLZiZNoy5Ow9QlnHA=w1827-h711-no";

const PRODUCTS = {
  premium: {
    name: "Roti Premium",
    desc: "Roti premium tanpa kulit dengan topping coklat & keju",
    price: 12000
  }
};

async function tg(env, method, data) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");
    const update = await req.json();

    /* ================= CALLBACK ================= */
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const userId = cb.from.id;

      // WAJIB! kalau ini tidak ada → tombol mati
      await tg(env, "answerCallbackQuery", {
        callback_query_id: cb.id
      });

      if (cb.data === "menu_premium") {
        USER_STATE.set(userId, { step: "interest", product: "premium" });

        const p = PRODUCTS.premium;
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text:
            `🥖 *${p.name}*\n\n${p.desc}\n💰 Rp${p.price}\n\nApakah ingin memesan?`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Ya", callback_data: "yes" }],
              [{ text: "❌ Tidak", callback_data: "no" }]
            ]
          }
        });
      }

      if (cb.data === "yes") {
        USER_STATE.set(userId, { step: "qty", product: "premium" });
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Mau pesan berapa buah?"
        });
      }

      if (cb.data === "no") {
        USER_STATE.delete(userId);
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Siap kak 🙏 Kalau butuh silakan chat lagi."
        });
      }

      return new Response("OK");
    }

    /* ================= MESSAGE ================= */
    const msg = update.message;
    if (!msg?.text) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.toLowerCase();
    const state = USER_STATE.get(userId);

    if (state?.step === "qty" && /^\d+$/.test(text)) {
      const qty = Number(text);
      const p = PRODUCTS.premium;
      USER_STATE.delete(userId);

      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          `🧾 *Invoice Sementara*\n\nProduk: ${p.name}\nJumlah: ${qty}\nTotal: Rp${qty * p.price}\n\nAdmin akan konfirmasi 🙏`,
        parse_mode: "Markdown"
      });
      return new Response("OK");
    }

    // MENU AWAL (gambar + tombol)
    await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: MENU_IMAGE,
      caption: "🍞 *Menu Roti Hari Ini*\nSilakan pilih roti di bawah 👇",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🥖 Roti Premium", callback_data: "menu_premium" }]
        ]
      }
    });

    return new Response("OK");
  }
};
