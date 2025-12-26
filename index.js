export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const update = await request.json();

    if (!update.message || !update.message.text) {
      return new Response("No message", { status: 200 });
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.toLowerCase();

    // ===============================
    // DB JSON HARD-CODE (TMP)
    // ===============================
    const PRODUCTS = {
      paket_basic: {
        name: "Paket Basic",
        price: "Rp150.000",
        desc: "Cocok untuk pemula"
      },
      paket_premium: {
        name: "Paket Premium",
        price: "Rp350.000",
        desc: "Fitur lengkap + support"
      }
    };

    // ===============================
    // KEYWORD → INTENT
    // ===============================
    let reply = null;

    if (text.includes("harga") || text.includes("price")) {
      reply =
        `📦 *Daftar Paket*\n\n` +
        Object.values(PRODUCTS)
          .map(
            p =>
              `• *${p.name}*\n  Harga: ${p.price}\n  ${p.desc}\n`
          )
          .join("\n");
    }

    else if (text.includes("premium")) {
      const p = PRODUCTS.paket_premium;
      reply =
        `✨ *${p.name}*\n` +
        `Harga: ${p.price}\n` +
        `${p.desc}\n\n` +
        `Mau lanjut order? 😊`;
    }

    else if (text.includes("basic")) {
      const p = PRODUCTS.paket_basic;
      reply =
        `✨ *${p.name}*\n` +
        `Harga: ${p.price}\n` +
        `${p.desc}\n\n` +
        `Mau lanjut order? 😊`;
    }

    // ===============================
    // FALLBACK → HUMAN
    // ===============================
    if (!reply) {
      reply =
        "Terima kasih pesannya 🙏\n" +
        "Pertanyaan ini akan kami bantu jawab secara manual ya.";
      
      // OPTIONAL: kirim notifikasi ke admin
      // (bisa via bot lain / chat ID admin)
    }

    // ===============================
    // SEND MESSAGE
    // ===============================
    const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

    await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
        parse_mode: "Markdown"
      })
    });

    return new Response("OK", { status: 200 });
  }
};
