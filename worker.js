/**
 * Cloudflare Workers - Serverless Telegram Voucher & Reward Bot
 * Zero external dependencies. Uses native Fetch API and Cloudflare KV (BOT_KV).
 *
 * Environment Bindings Required:
 * - BOT_KV: Cloudflare KV Namespace binding
 * - BOT_TOKEN: Telegram Bot API Token from @BotFather
 * - ADMIN_ID: Primary Admin numeric Telegram User ID (e.g., "123456789")
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Convenience webhook registration endpoint: GET /setWebhook
      if (request.method === "GET" && url.pathname === "/setWebhook") {
        if (!env.BOT_TOKEN) {
          return new Response("Missing BOT_TOKEN secret.", { status: 500 });
        }
        const webhookUrl = `${url.protocol}//${url.host}/`;
        const tgRes = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
        );
        const result = await tgRes.json();
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Health check endpoint for GET requests
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            status: "ok",
            service: "Telegram Voucher Bot Worker",
            kvBound: Boolean(env.BOT_KV),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Parse incoming Telegram Webhook Update
      const update = await request.json();
      await handleTelegramUpdate(update, env);

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Worker Execution Error:", error);
      // Return 200 OK to prevent Telegram from infinitely retrying malformed updates
      return new Response("OK", { status: 200 });
    }
  },
};

/* ==========================================================================
   KEYBOARD LAYOUTS (ReplyKeyboardMarkup & Force Join InlineKeyboardMarkup)
   ========================================================================== */

function getUserKeyboard(isAdmin = false) {
  const bottomRow = isAdmin
    ? [{ text: "🏠 Main Menu" }, { text: "🛠 Admin Panel" }]
    : [{ text: "🏠 Main Menu" }];

  return {
    keyboard: [
      [{ text: "🎁 Claim Voucher" }],
      [{ text: "📦 Check Stock" }, { text: "📞 Support" }],
      bottomRow,
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getAdminKeyboard() {
  return {
    keyboard: [
      [{ text: "➕ Add Force Channel" }, { text: "👤 Add Admin" }],
      [{ text: "🎟 Add Voucher" }, { text: "🗑 Clear Stock" }],
      [{ text: "📊 Bot Stats" }, { text: "💬 Set Support" }],
      [{ text: "🔙 Back to User Menu" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getCancelKeyboard() {
  return {
    keyboard: [[{ text: "❌ Cancel" }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getForceJoinInlineKeyboard(channelLink) {
  return {
    inline_keyboard: [
      [{ text: "📢 Join Official Channel", url: channelLink }],
      [{ text: "✅ Verify Membership", callback_data: "verify_join" }],
    ],
  };
}

/* ==========================================================================
   CORE UPDATE ROUTER
   ========================================================================== */

async function handleTelegramUpdate(update, env) {
  // 1. Handle Inline Callback Queries (Only used for Force Channel Join verification)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  // 2. Handle Standard Text Messages & ReplyKeyboard Clicks
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const firstName = escapeHtml(message.from.first_name || "User");
  const text = (message.text || "").trim();

  if (!text) return;

  // Track unique user in KV for Bot Stats
  await registerUserIfNeeded(userId, message.from, env);

  // Check if user has Admin privileges
  const isAdmin = await checkIsAdmin(userId, env);

  // 3. Enforce Force Channel Join Gate before menu or voucher access
  const joinCheck = await verifyForceChannelMembership(userId, env);
  if (!joinCheck.allowed) {
    await sendForceJoinPrompt(chatId, joinCheck.channel, env);
    return;
  }

  // 4. Handle Admin Multi-Step State Machine if an interactive state is active
  if (isAdmin) {
    const rawState = await env.BOT_KV.get(`state:${userId}`);
    if (rawState) {
      let stateObj = null;
      try {
        stateObj = JSON.parse(rawState);
      } catch {
        await env.BOT_KV.delete(`state:${userId}`);
      }

      if (stateObj) {
        // Universal Cancel handler at any point in the multi-step flow
        if (text === "❌ Cancel" || text === "/cancel") {
          await env.BOT_KV.delete(`state:${userId}`);
          await sendMessage(
            chatId,
            "🚫 <b>Operation Cancelled</b>\nReturned to the Admin Control Center.",
            getAdminKeyboard(),
            env
          );
          return;
        }

        await processAdminStep(chatId, userId, text, stateObj, env);
        return;
      }
    }
  }

  // 5. Route Role-Based Navigation & Action Buttons
  switch (text) {
    case "/start":
    case "🏠 Main Menu":
    case "🔙 Back to User Menu": {
      // Clear any lingering state if admin switches back
      if (isAdmin) {
        await env.BOT_KV.delete(`state:${userId}`);
      }
      await sendMessage(
        chatId,
        `👋 Welcome, <b>${firstName}</b>!\n\nUse the menu below to claim your exclusive voucher, check live stock availability, or reach out to support.`,
        getUserKeyboard(isAdmin),
        env
      );
      break;
    }

    /* ---------------- USER PANEL ACTIONS ---------------- */
    case "🎁 Claim Voucher": {
      await handleClaimVoucher(chatId, userId, isAdmin, env);
      break;
    }

    case "📦 Check Stock": {
      const stockKeys = await listAllKeysByPrefix("vouch:", env);
      const count = stockKeys.length;
      const statusText =
        count > 0
          ? `📦 <b>Live Voucher Stock</b>\n\nCurrently Available: <b>${count}</b> voucher(s) ready to claim!\n\nTap <b>🎁 Claim Voucher</b> below to grab yours.`
          : `⚠️ <b>Out of Stock</b>\n\nAll vouchers have been claimed for now. Please check back soon!`;

      await sendMessage(chatId, statusText, getUserKeyboard(isAdmin), env);
      break;
    }

    case "📞 Support": {
      const supportContact = (await env.BOT_KV.get("config:support")) || "@Support";
      await sendMessage(
        chatId,
        `📞 <b>Customer Support</b>\n\nNeed help redeeming your voucher or have a question?\nContact our official support representative: <b>${escapeHtml(supportContact)}</b>`,
        getUserKeyboard(isAdmin),
        env
      );
      break;
    }

    /* ---------------- ADMIN CONTROL CENTER ACTIONS ---------------- */
    case "🛠 Admin Panel": {
      if (!isAdmin) {
        await sendMessage(chatId, "⛔ Unauthorized access.", getUserKeyboard(false), env);
        return;
      }
      await sendMessage(
        chatId,
        "🛠 <b>Admin Control Center</b>\n\nSelect an action from the control keyboard below:",
        getAdminKeyboard(),
        env
      );
      break;
    }

    case "➕ Add Force Channel": {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: "AWAIT_FORCE_CHANNEL" })
      );
      const currentChannelRaw = await env.BOT_KV.get("config:force_channel");
      let currentInfo = "None configured";
      if (currentChannelRaw) {
        try {
          const parsed = JSON.parse(currentChannelRaw);
          currentInfo = `<code>${escapeHtml(parsed.id)}</code> (${escapeHtml(parsed.link)})`;
        } catch {
          currentInfo = "None configured";
        }
      }
      await sendMessage(
        chatId,
        `📢 <b>Configure Force Channel Join</b>\n\nCurrent Channel: ${currentInfo}\n\nPlease send the <b>Channel ID</b> and <b>Invite Link</b> separated by a space in this exact format:\n<code>-1001234567890 https://t.me/yourchannel</code>\n\n<i>Tip: Make sure this bot is an Admin in your channel so it can verify members. Send <code>disable</code> to turn off Force Join.</i>`,
        getCancelKeyboard(),
        env
      );
      break;
    }

    case "👤 Add Admin": {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: "AWAIT_ADD_ADMIN" })
      );
      await sendMessage(
        chatId,
        "👤 <b>Add New Administrator</b>\n\nPlease send the numeric <b>Telegram User ID</b> of the new admin (e.g., <code>987654321</code>):",
        getCancelKeyboard(),
        env
      );
      break;
    }

    case "💬 Set Support": {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: "AWAIT_SET_SUPPORT" })
      );
      const currentSupport = (await env.BOT_KV.get("config:support")) || "Not set";
      await sendMessage(
        chatId,
        `💬 <b>Set Support Contact</b>\n\nCurrent Support: <b>${escapeHtml(currentSupport)}</b>\n\nPlease send the new support Telegram username or link (e.g., <code>@MyBotSupport</code>):`,
        getCancelKeyboard(),
        env
      );
      break;
    }

    case "🎟 Add Voucher": {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: "AWAIT_VOUCHER_TITLE", data: {} })
      );
      await sendMessage(
        chatId,
        "🎟 <b>Add New Voucher (Step 1 of 3)</b>\n\nPlease enter the <b>Voucher Title</b>:\n<i>Example: Flat ₹500 Bonus Code</i>",
        getCancelKeyboard(),
        env
      );
      break;
    }

    case "🗑 Clear Stock": {
      if (!isAdmin) return;
      const keys = await listAllKeysByPrefix("vouch:", env);
      for (const k of keys) {
        await env.BOT_KV.delete(k.name);
      }
      await sendMessage(
        chatId,
        `🗑 <b>Stock Cleared</b>\n\nSuccessfully removed <b>${keys.length}</b> unclaimed voucher(s) from stock.`,
        getAdminKeyboard(),
        env
      );
      break;
    }

    case "📊 Bot Stats": {
      if (!isAdmin) return;
      await handleBotStats(chatId, env);
      break;
    }

    default: {
      await sendMessage(
        chatId,
        "ℹ️ Please use the menu buttons at the bottom of your screen to navigate.",
        getUserKeyboard(isAdmin),
        env
      );
      break;
    }
  }
}

/* ==========================================================================
   MULTI-STEP ADMIN STATE MACHINE PROCESSOR
   ========================================================================== */

async function processAdminStep(chatId, userId, text, stateObj, env) {
  const { step, data = {} } = stateObj;

  switch (step) {
    // 1. Force Channel Configuration
    case "AWAIT_FORCE_CHANNEL": {
      if (text.toLowerCase() === "disable" || text.toLowerCase() === "off") {
        await env.BOT_KV.delete("config:force_channel");
        await env.BOT_KV.delete(`state:${userId}`);
        await sendMessage(
          chatId,
          "✅ <b>Force Channel Gate Disabled</b>\nUsers can now access the bot without a channel check.",
          getAdminKeyboard(),
          env
        );
        return;
      }

      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(
          chatId,
          "⚠️ <b>Invalid Format</b>\n\nPlease provide both the Channel ID and Link separated by a space:\n<code>-1001234567890 https://t.me/channel</code>\n\nOr tap <b>❌ Cancel</b> below.",
          getCancelKeyboard(),
          env
        );
        return;
      }

      const channelId = parts[0].trim();
      const channelLink = parts.slice(1).join(" ").trim();

      if (
        (!channelId.startsWith("-100") && !channelId.startsWith("@")) ||
        !channelLink.startsWith("http")
      ) {
        await sendMessage(
          chatId,
          "⚠️ <b>Validation Error</b>\n\n• Channel ID must start with <code>-100</code> (or <code>@username</code>)\n• Link must start with <code>https://t.me/...</code>\n\nExample:\n<code>-100192837465 https://t.me/myofficialchannel</code>",
          getCancelKeyboard(),
          env
        );
        return;
      }

      await env.BOT_KV.put(
        "config:force_channel",
        JSON.stringify({ id: channelId, link: channelLink })
      );
      await env.BOT_KV.delete(`state:${userId}`);

      await sendMessage(
        chatId,
        `✅ <b>Force Channel Updated!</b>\n\n• <b>Channel ID:</b> <code>${escapeHtml(channelId)}</code>\n• <b>Invite Link:</b> ${escapeHtml(channelLink)}`,
        getAdminKeyboard(),
        env
      );
      break;
    }

    // 2. Add New Admin
    case "AWAIT_ADD_ADMIN": {
      if (!/^\d{5,15}$/.test(text)) {
        await sendMessage(
          chatId,
          "⚠️ <b>Invalid Telegram ID</b>\n\nPlease send a valid numeric Telegram User ID (digits only, e.g. <code>123456789</code>) or tap <b>❌ Cancel</b>.",
          getCancelKeyboard(),
          env
        );
        return;
      }

      const admins = await getAdminList(env);
      if (!admins.includes(text)) {
        admins.push(text);
        await env.BOT_KV.put("config:admins", JSON.stringify(admins));
      }

      await env.BOT_KV.delete(`state:${userId}`);
      await sendMessage(
        chatId,
        `✅ <b>Admin Added Successfully!</b>\n\nUser ID <code>${escapeHtml(text)}</code> now has full access to the Admin Control Center.`,
        getAdminKeyboard(),
        env
      );
      break;
    }

    // 3. Set Support Username
    case "AWAIT_SET_SUPPORT": {
      if (text.length < 2 || text.length > 100) {
        await sendMessage(
          chatId,
          "⚠️ Please enter a valid support username or link (e.g. <code>@SupportHandle</code>).",
          getCancelKeyboard(),
          env
        );
        return;
      }

      await env.BOT_KV.put("config:support", text);
      await env.BOT_KV.delete(`state:${userId}`);
      await sendMessage(
        chatId,
        `✅ <b>Support Contact Updated!</b>\n\nNew Support Contact: <b>${escapeHtml(text)}</b>`,
        getAdminKeyboard(),
        env
      );
      break;
    }

    // 4. Add Voucher - Step 1: Title
    case "AWAIT_VOUCHER_TITLE": {
      const updatedState = {
        step: "AWAIT_VOUCHER_CODE",
        data: { title: text },
      };
      await env.BOT_KV.put(`state:${userId}`, JSON.stringify(updatedState));
      await sendMessage(
        chatId,
        `🎟 <b>Add New Voucher (Step 2 of 3)</b>\n\n• <b>Title:</b> ${escapeHtml(text)}\n\nNow send the <b>Voucher Code or Claim Link</b>:`,
        getCancelKeyboard(),
        env
      );
      break;
    }

    // 5. Add Voucher - Step 2: Code / Link
    case "AWAIT_VOUCHER_CODE": {
      const updatedState = {
        step: "AWAIT_VOUCHER_PROCESS",
        data: { ...data, code: text },
      };
      await env.BOT_KV.put(`state:${userId}`, JSON.stringify(updatedState));
      await sendMessage(
        chatId,
        `🎟 <b>Add New Voucher (Step 3 of 3)</b>\n\n• <b>Title:</b> ${escapeHtml(data.title)}\n• <b>Code/Link:</b> <code>${escapeHtml(text)}</code>\n\nNow send the <b>Step-by-Step Redeem Process / Instructions</b>:`,
        getCancelKeyboard(),
        env
      );
      break;
    }

    // 6. Add Voucher - Step 3: Redeem Instructions & Save to KV
    case "AWAIT_VOUCHER_PROCESS": {
      const timestamp = Date.now();
      const voucherKey = `vouch:${timestamp}`;
      const voucherPayload = {
        id: voucherKey,
        title: data.title,
        code: data.code,
        instructions: text,
        createdAt: new Date(timestamp).toISOString(),
      };

      await env.BOT_KV.put(voucherKey, JSON.stringify(voucherPayload));
      await env.BOT_KV.delete(`state:${userId}`);

      await sendMessage(
        chatId,
        `✅ <b>Voucher Saved to Stock!</b>\n\n• <b>KV Key:</b> <code>${voucherKey}</code>\n• <b>Title:</b> ${escapeHtml(voucherPayload.title)}\n• <b>Code:</b> <code>${escapeHtml(voucherPayload.code)}</code>\n• <b>Redeem Process:</b>\n${escapeHtml(voucherPayload.instructions)}`,
        getAdminKeyboard(),
        env
      );
      break;
    }

    default: {
      await env.BOT_KV.delete(`state:${userId}`);
      await sendMessage(
        chatId,
        "Returned to Admin Control Center.",
        getAdminKeyboard(),
        env
      );
      break;
    }
  }
}

/* ==========================================================================
   USER VOUCHER CLAIM FLOW
   ========================================================================== */

async function handleClaimVoucher(chatId, userId, isAdmin, env) {
  // 1. Check if user has already claimed a voucher
  const existingClaimRaw = await env.BOT_KV.get(`claimed:${userId}`);
  if (existingClaimRaw) {
    try {
      const claimed = JSON.parse(existingClaimRaw);
      await sendMessage(
        chatId,
        `ℹ️ <b>You Have Already Claimed Your Voucher!</b>\n\nHere are your previously claimed voucher details:\n\n🎁 <b>Title:</b> ${escapeHtml(claimed.title)}\n🔑 <b>Code / Link:</b> <code>${escapeHtml(claimed.code)}</code>\n\n📋 <b>Redeem Process:</b>\n${escapeHtml(claimed.instructions)}\n\n🕒 <i>Claimed on: ${escapeHtml(claimed.claimedAt || claimed.createdAt || "Recorded")}</i>`,
        getUserKeyboard(isAdmin),
        env
      );
      return;
    } catch {
      // If corrupted JSON, allow re-evaluation
    }
  }

  // 2. Fetch available vouchers from KV under prefix `vouch:`
  const voucherKeys = await listAllKeysByPrefix("vouch:", env);
  if (!voucherKeys || voucherKeys.length === 0) {
    await sendMessage(
      chatId,
      "😔 <b>Out of Stock Alert</b>\n\nAll vouchers have currently been claimed! Please check back later or tap <b>📦 Check Stock</b> for updates.",
      getUserKeyboard(isAdmin),
      env
    );
    return;
  }

  // Sort keys lexicographically so the oldest `vouch:<timestamp>` is claimed first (FIFO)
  voucherKeys.sort((a, b) => a.name.localeCompare(b.name));

  let selectedVoucher = null;
  let selectedKeyName = null;

  for (const keyItem of voucherKeys) {
    const rawVoucher = await env.BOT_KV.get(keyItem.name);
    if (rawVoucher) {
      try {
        selectedVoucher = JSON.parse(rawVoucher);
        selectedKeyName = keyItem.name;
        break;
      } catch {
        // Delete malformed entry and continue
        await env.BOT_KV.delete(keyItem.name);
      }
    }
  }

  if (!selectedVoucher || !selectedKeyName) {
    await sendMessage(
      chatId,
      "😔 <b>Out of Stock Alert</b>\n\nAll vouchers have currently been claimed! Please check back later.",
      getUserKeyboard(isAdmin),
      env
    );
    return;
  }

  // 3. Assign voucher to `claimed:<userId>` and delete from `vouch:<timestamp>` stock
  const claimedRecord = {
    ...selectedVoucher,
    claimedBy: userId,
    claimedAt: new Date().toISOString(),
  };

  await env.BOT_KV.put(`claimed:${userId}`, JSON.stringify(claimedRecord));
  await env.BOT_KV.delete(selectedKeyName);

  // 4. Send richly formatted voucher details
  await sendMessage(
    chatId,
    `🎉 <b>Congratulations! Voucher Claimed Successfully!</b>\n\n🎁 <b>Voucher Title:</b>\n${escapeHtml(claimedRecord.title)}\n\n🔑 <b>Voucher Code / Link:</b>\n<code>${escapeHtml(claimedRecord.code)}</code>\n\n📋 <b>Step-by-Step Redeem Process:</b>\n${escapeHtml(claimedRecord.instructions)}\n\n<i>💡 Tip: Tap on the code above to copy it to your clipboard.</i>`,
    getUserKeyboard(isAdmin),
    env
  );
}

/* ==========================================================================
   FORCE CHANNEL JOIN VERIFICATION & INLINE CALLBACK HANDLER
   ========================================================================== */

async function verifyForceChannelMembership(userId, env) {
  const rawConfig = await env.BOT_KV.get("config:force_channel");
  if (!rawConfig) {
    return { allowed: true, channel: null };
  }

  let channel = null;
  try {
    channel = JSON.parse(rawConfig);
  } catch {
    return { allowed: true, channel: null };
  }

  if (!channel || !channel.id || !channel.link) {
    return { allowed: true, channel: null };
  }

  // Admins bypass the lock so they never lock themselves out of fixing a bad channel ID
  const isAdmin = await checkIsAdmin(userId, env);
  if (isAdmin) {
    return { allowed: true, channel };
  }

  try {
    const apiUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(
      channel.id
    )}&user_id=${encodeURIComponent(userId)}`;
    const res = await fetch(apiUrl);
    const data = await res.json();

    if (!data.ok || !data.result) {
      return { allowed: false, channel };
    }

    const status = data.result.status;
    const isMember =
      status === "creator" ||
      status === "administrator" ||
      status === "member" ||
      (status === "restricted" && data.result.is_member === true);

    return { allowed: isMember, channel };
  } catch (err) {
    console.error("Force join verification error:", err);
    return { allowed: false, channel };
  }
}

async function sendForceJoinPrompt(chatId, channel, env) {
  await sendMessage(
    chatId,
    `🔒 <b>Channel Membership Required</b>\n\nTo access the menu and claim free vouchers, you must first join our official Telegram channel.\n\n1️⃣ Tap <b>📢 Join Official Channel</b> below.\n2️⃣ After joining, tap <b>✅ Verify Membership</b>.`,
    getForceJoinInlineKeyboard(channel.link),
    env
  );
}

async function handleCallbackQuery(callbackQuery, env) {
  const callbackId = callbackQuery.id;
  const userId = String(callbackQuery.from.id);
  const firstName = escapeHtml(callbackQuery.from.first_name || "User");
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data;

  if (data !== "verify_join" || !chatId) {
    await answerCallbackQuery(callbackId, "Unknown action.", false, env);
    return;
  }

  const joinCheck = await verifyForceChannelMembership(userId, env);
  if (!joinCheck.allowed) {
    await answerCallbackQuery(
      callbackId,
      "❌ You haven't joined the channel yet! Please join the channel first and try again.",
      true,
      env
    );
    return;
  }

  await answerCallbackQuery(
    callbackId,
    "✅ Membership verified! Welcome!",
    false,
    env
  );

  // Clean up the inline gate message if possible
  if (messageId) {
    await deleteMessage(chatId, messageId, env);
  }

  const isAdmin = await checkIsAdmin(userId, env);
  await sendMessage(
    chatId,
    `✅ <b>Verification Successful!</b>\n\nWelcome, <b>${firstName}</b>! Your bottom navigation menu is now unlocked. Choose an option below:`,
    getUserKeyboard(isAdmin),
    env
  );
}

/* ==========================================================================
   ADMIN STATS & KV HELPERS
   ========================================================================== */

async function handleBotStats(chatId, env) {
  const [stockKeys, claimedKeys, userKeys, admins, rawChannel, support] =
    await Promise.all([
      listAllKeysByPrefix("vouch:", env),
      listAllKeysByPrefix("claimed:", env),
      listAllKeysByPrefix("user:", env),
      getAdminList(env),
      env.BOT_KV.get("config:force_channel"),
      env.BOT_KV.get("config:support"),
    ]);

  let channelDisplay = "Not Configured (Open Access)";
  if (rawChannel) {
    try {
      const parsed = JSON.parse(rawChannel);
      channelDisplay = `<code>${escapeHtml(parsed.id)}</code> (${escapeHtml(parsed.link)})`;
    } catch {
      channelDisplay = "Not Configured";
    }
  }

  const statsMessage = [
    "📊 <b>Bot Live Statistics</b>",
    "",
    `🎟 <b>Available Stock:</b> ${stockKeys.length} voucher(s)`,
    `✅ <b>Total Claimed:</b> ${claimedKeys.length} voucher(s)`,
    `👥 <b>Total Users:</b> ${userKeys.length}`,
    `🛡 <b>Total Admins:</b> ${admins.length}`,
    `📢 <b>Force Channel:</b> ${channelDisplay}`,
    `💬 <b>Support Contact:</b> ${escapeHtml(support || "@Support (Default)")}`,
  ].join("\n");

  await sendMessage(chatId, statsMessage, getAdminKeyboard(), env);
}

async function checkIsAdmin(userId, env) {
  const primaryAdmin = String(env.ADMIN_ID || "").trim();
  if (primaryAdmin && String(userId) === primaryAdmin) {
    return true;
  }
  const admins = await getAdminList(env);
  return admins.includes(String(userId));
}

async function getAdminList(env) {
  const list = [];
  const primaryAdmin = String(env.ADMIN_ID || "").trim();
  if (primaryAdmin) {
    list.push(primaryAdmin);
  }

  const rawAdmins = await env.BOT_KV.get("config:admins");
  if (rawAdmins) {
    try {
      const parsed = JSON.parse(rawAdmins);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          const strId = String(id).trim();
          if (strId && !list.includes(strId)) {
            list.push(strId);
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }
  return list;
}

async function registerUserIfNeeded(userId, fromObj, env) {
  const key = `user:${userId}`;
  const existing = await env.BOT_KV.get(key);
  if (!existing) {
    await env.BOT_KV.put(
      key,
      JSON.stringify({
        id: userId,
        firstName: fromObj.first_name || "",
        username: fromObj.username || "",
        joinedAt: new Date().toISOString(),
      })
    );
  }
}

async function listAllKeysByPrefix(prefix, env) {
  const allKeys = [];
  let cursor = undefined;

  do {
    const result = await env.BOT_KV.list({ prefix, cursor });
    if (result && Array.isArray(result.keys)) {
      allKeys.push(...result.keys);
    }
    cursor = result && !result.list_complete ? result.cursor : undefined;
  } while (cursor);

  return allKeys;
}

/* ==========================================================================
   TELEGRAM API HELPERS
   ========================================================================== */

async function sendMessage(chatId, text, replyMarkup, env) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  return res.json();
}

async function answerCallbackQuery(callbackQueryId, text, showAlert, env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: Boolean(showAlert),
      }),
    }
  );
  return res.json();
}

async function deleteMessage(chatId, messageId, env) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
  } catch {
    // Ignore deletion errors if message is old
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
