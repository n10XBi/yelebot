// worker-updated.js — Telegram Worker (with admin product management) // Env required: BOT_TOKEN, ADMIN_CHAT_ID (chat id where admin will get notifications) // Optional: ADMIN_USER_ID (telegram numeric id for admin user, used for permission checking)

let USER_STATE = new Map(); // temporary per-user flow let ORDERS = new Map(); // invoiceId -> order object (in-memory)
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

    // check stock
    if ((p.stock ?? 0) < qty) {
      await tg(env, "sendMessage", { chat_id, text: `Maaf, stok untuk *${p.name}* tidak mencukupi. Stok saat ini: ${p.stock ?? 0}.`, parse_mode: "Markdown" });
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
      // reduce stock when approving
      const prod = PRODUCTS[order.product];
      if (!prod) {
        await tg(env, "sendMessage", { chat_id, text: `Produk untuk order ${invId} tidak ditemukan.` });
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
        await tg(env, "sendMessage", { chat_id: cb.message.chat.id, text: `Order ${invId} rejected due to insufficient stock.` });
        return new Response("OK");
      }

      prod.stock = (prod.stock ?? 0) - order.qty;
      order.status = "approved";
      ORDERS.set(invId, order);

      // notify user
      await tg(env, "sendMessage", {
        chat_id: order.chatId,
        text: `✅ Pesanan Anda (ID: ${invId}) telah *DISETUJUI* oleh admin.\nAdmin akan menghubungi untuk konfirmasi selanjutnya.\nSisa stok ${prod.name}: *${prod.stock}*`,
        parse_mode: "Markdown"
      });
      await tg(env, "sendMessage", { chat_id: cb.message.chat.id, text: `Order ${invId} approved.` });
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

// Admin-only helpers via text commands
// /addproduct key|name|desc|price|stock|image(optional)
if (text.startsWith("/addproduct")) {
  if (!isAdmin(fromId, env)) {
    await tg(env, "sendMessage", { chat_id, text: "Hanya admin yang dapat menambah produk." });
    return new Response("OK");
  }
  const payload = text.replace(/\/addproduct\s*/i, "").trim();
  const parts = payload.split("|").map(s=>s.trim());
  if (parts.length < 5) {
    await tg(env, "sendMessage", { chat_id, text: "Format: /addproduct key|Nama Produk|Deskripsi|harga|stok|image(optional)" });
    return new Response("OK");
  }
  const [key, name, desc, priceStr, stockStr, image] = parts;
  const price = Number(priceStr.replace(/[^0-9]/g, "")) || 0;
  const stock = Number(stockStr) || 0;
  PRODUCTS[key] = { key, name, desc, price, image: image || MENU_IMAGE, stock };
  await tg(env, "sendMessage", { chat_id, text: `Produk *${name}* berhasil ditambahkan (key: ${key}).`, parse_mode: "Markdown" });
  return new Response("OK");
}

// /addstock key qty  -> menambah stok
if (text.startsWith("/addstock")) {
  if (!isAdmin(fromId, env)) {
    await tg(env, "sendMessage", { chat_id, text: "Hanya admin yang dapat mengubah stok." });
    return new Response("OK");
  }
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await tg(env, "sendMessage", { chat_id, text: "Format: /addstock <key> <qty>" });
    return new Response("OK");
  }
  const key = parts[1];
  const qty = Number(parts[2]);
  const p = PRODUCTS[key];
  if (!p) {
    await tg(env, "sendMessage", { chat_id, text: `Produk dengan key ${key} tidak ditemukan.` });
    return new Response("OK");
  }
  p.stock = (p.stock ?? 0) + qty;
  await tg(env, "sendMessage", { chat_id, text: `Stok ${p.name} berhasil ditambah. Stok sekarang: ${p.stock}.` });
  return new Response("OK");
}

// /editstock key qty -> set stok
if (text.startsWith("/editstock")) {
  if (!isAdmin(fromId, env)) {
    await tg(env, "sendMessage", { chat_id, text: "Hanya admin yang dapat mengubah stok." });
    return new Response("OK");
  }
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await tg(env, "sendMessage", { chat_id, text: "Format: /editstock <key> <qty>" });
    return new Response("OK");
  }
  const key = parts[1];
  const qty = Number(parts[2]);
  const p = PRODUCTS[key];
  if (!p) {
    await tg(env, "sendMessage", { chat_id, text: `Produk dengan key ${key} tidak ditemukan.` });
    return new Response("OK");
  }
  p.stock = qty;
  await tg(env, "sendMessage", { chat_id, text: `Stok ${p.name} diset menjadi ${p.stock}.` });
  return new Response("OK");
}

// /editprice key newPrice
if (text.startsWith("/editprice")) {
  if (!isAdmin(fromId, env)) {
    await tg(env, "sendMessage", { chat_id, text: "Hanya admin yang dapat mengubah harga." });
    return new Response("OK");
  }
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await tg(env, "sendMessage", { chat_id, text: "Format: /editprice <key> <harga>" });
    return new Response("OK");
  }
  const key = parts[1];
  const price = Number(parts[2].replace(/[^0-9]/g, "")) || 0;
  const p = PRODUCTS[key];
  if (!p) {
    await tg(env, "sendMessage", { chat_id, text: `Produk dengan key ${key} tidak ditemukan.` });
    return new Response("OK");
  }
  p.price = price;
  await tg(env, "sendMessage", { chat_id, text: `Harga ${p.name} diset menjadi ${formatRupiah(p.price)}.` });
  return new Response("OK");
}

// /delproduct key
if (text.startsWith("/delproduct")) {
  if (!isAdmin(fromId, env)) {
    await tg(env, "sendMessage", { chat_id, text: "Hanya admin yang dapat menghapus produk." });
    return new Response("OK");
  }
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    await tg(env, "sendMessage", { chat_id, text: "Format: /delproduct <key>" });
    return new Response("OK");
  }
  const key = parts[1];
  const p = PRODUCTS[key];
  if (!p) {
    await tg(env, "sendMessage", { chat_id, text: `Produk dengan key ${key} tidak ditemukan.` });
    return new Response("OK");
  }
  delete PRODUCTS[key];
  await tg(env, "sendMessage", { chat_id, text: `Produk ${p.name} (key: ${key}) berhasil dihapus.` });
  return new Response("OK");
}

// /products -> daftar produk beserta stok
if (text.startsWith("/products")) {
  const list = Object.values(PRODUCTS);
  if (!list.length) {
    await tg(env, "sendMessage", { chat_id, text: "Belum ada produk." });
    return new Response("OK");
  }
  let msg = "📦 *Daftar Produk*\n\n";
  list.forEach(p => {
    msg += `• *${p.name}* (key: ${p.key})\n  Harga: ${formatRupiah(p.price)}\n  Stok: ${p.stock ?? 0}\n\n`;
  });
  await tg(env, "sendMessage", { chat_id, text: msg, parse_mode: "Markdown" });
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
    await tg(env, "sendMessage", { chat_id: chatId, text: "Gunakan: /cancel <INVOICE_ID>\nContoh: /cancel INVXXXX" });
    return new Response("OK");
  }
  const order = ORDERS.get(id);
  if (!order) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `Order dengan ID ${id} tidak ditemukan.` });
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

  if ((p.stock ?? 0) < qty) {
    await tg(env, "sendMessage", { chat_id, text: `Maaf, stok ${p.name} tidak cukup. Stok saat ini: ${p.stock ?? 0}.` });
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
  text: "Terima kasih kak 🙏\nPesan ini akan dibantu admin secara manual. Untuk memeriksa pesanan: /status <ID> atau batalkan /cancel <ID>.\nAdmin commands: /addproduct, /addstock, /editstock, /editprice, /delproduct, /products"
});

return new Response("OK");

} };
