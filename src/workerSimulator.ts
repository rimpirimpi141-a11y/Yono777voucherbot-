export interface ReplyKeyboardButton {
  text: string;
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface ReplyMarkup {
  keyboard?: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  inline_keyboard?: InlineKeyboardButton[][];
}

export interface SimulatedTelegramMessage {
  id: number;
  sender: 'user' | 'bot';
  userId: string;
  text: string;
  timestamp: string;
  replyMarkup?: ReplyMarkup;
}

export interface KvOperationLog {
  id: string;
  timestamp: string;
  op: 'GET' | 'PUT' | 'DELETE' | 'LIST';
  keyOrPrefix: string;
  detail?: string;
}

export class SimulatedCloudflareKV {
  private store: Map<string, string>;
  private onLog: (log: KvOperationLog) => void;
  private onChange: () => void;

  constructor(
    initialEntries: Record<string, string>,
    onLog: (log: KvOperationLog) => void,
    onChange: () => void
  ) {
    this.store = new Map(Object.entries(initialEntries));
    this.onLog = onLog;
    this.onChange = onChange;
  }

  private emitLog(op: 'GET' | 'PUT' | 'DELETE' | 'LIST', keyOrPrefix: string, detail?: string) {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    this.onLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp,
      op,
      keyOrPrefix,
      detail,
    });
  }

  async get(key: string): Promise<string | null> {
    const val = this.store.has(key) ? this.store.get(key)! : null;
    this.emitLog('GET', key, val ? `${val.slice(0, 64)}${val.length > 64 ? '…' : ''}` : 'null');
    return val;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, String(value));
    this.emitLog('PUT', key, `${String(value).slice(0, 72)}${String(value).length > 72 ? '…' : ''}`);
    this.onChange();
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.emitLog('DELETE', key, 'Deleted key');
    this.onChange();
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix || '';
    const keys: { name: string }[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        keys.push({ name: k });
      }
    }
    this.emitLog('LIST', `prefix="${prefix}"`, `Matched ${keys.length} key(s)`);
    return {
      keys,
      list_complete: true,
    };
  }

  // Direct inspector helpers for the UI
  getSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const sortedKeys = Array.from(this.store.keys()).sort();
    for (const k of sortedKeys) {
      out[k] = this.store.get(k)!;
    }
    return out;
  }

  setDirect(key: string, value: string) {
    this.store.set(key, value);
    this.onChange();
  }

  deleteDirect(key: string) {
    this.store.delete(key);
    this.onChange();
  }

  reset(entries: Record<string, string>) {
    this.store = new Map(Object.entries(entries));
    this.onChange();
  }
}

export interface SimulationEnvContext {
  BOT_KV: SimulatedCloudflareKV;
  BOT_TOKEN: string;
  ADMIN_ID: string;
  // Simulation callbacks
  isUserMemberOfForceChannel: (userId: string) => boolean;
  onBotSendMessage: (chatId: number | string, text: string, replyMarkup?: ReplyMarkup) => number;
  onBotDeleteMessage: (chatId: number | string, messageId: number) => void;
  onBotCallbackAnswer: (text: string, showAlert: boolean) => void;
}

/* ==========================================================================
   EXACT WORKER LOGIC BOUND TO SIMULATION ENV
   ========================================================================== */

function getUserKeyboard(isAdmin = false): ReplyMarkup {
  const bottomRow = isAdmin
    ? [{ text: '🏠 Main Menu' }, { text: '🛠 Admin Panel' }]
    : [{ text: '🏠 Main Menu' }];

  return {
    keyboard: [
      [{ text: '🎁 Claim Voucher' }],
      [{ text: '📦 Check Stock' }, { text: '📞 Support' }],
      bottomRow,
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getAdminKeyboard(): ReplyMarkup {
  return {
    keyboard: [
      [{ text: '➕ Add Force Channel' }, { text: '👤 Add Admin' }],
      [{ text: '🎟 Add Voucher' }, { text: '🗑 Clear Stock' }],
      [{ text: '📊 Bot Stats' }, { text: '💬 Set Support' }],
      [{ text: '🔙 Back to User Menu' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getCancelKeyboard(): ReplyMarkup {
  return {
    keyboard: [[{ text: '❌ Cancel' }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getForceJoinInlineKeyboard(channelLink: string): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: '📢 Join Official Channel', url: channelLink }],
      [{ text: '✅ Verify Membership', callback_data: 'verify_join' }],
    ],
  };
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function listAllKeysByPrefix(prefix: string, env: SimulationEnvContext) {
  const res = await env.BOT_KV.list({ prefix });
  return res.keys;
}

async function getAdminList(env: SimulationEnvContext): Promise<string[]> {
  const list: string[] = [];
  const primaryAdmin = String(env.ADMIN_ID || '').trim();
  if (primaryAdmin) {
    list.push(primaryAdmin);
  }

  const rawAdmins = await env.BOT_KV.get('config:admins');
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

async function checkIsAdmin(userId: string, env: SimulationEnvContext): Promise<boolean> {
  const primaryAdmin = String(env.ADMIN_ID || '').trim();
  if (primaryAdmin && String(userId) === primaryAdmin) {
    return true;
  }
  const admins = await getAdminList(env);
  return admins.includes(String(userId));
}

async function verifyForceChannelMembership(
  userId: string,
  env: SimulationEnvContext
): Promise<{ allowed: boolean; channel: { id: string; link: string } | null }> {
  const rawConfig = await env.BOT_KV.get('config:force_channel');
  if (!rawConfig) {
    return { allowed: true, channel: null };
  }

  let channel: { id: string; link: string } | null = null;
  try {
    channel = JSON.parse(rawConfig);
  } catch {
    return { allowed: true, channel: null };
  }

  if (!channel || !channel.id || !channel.link) {
    return { allowed: true, channel: null };
  }

  const isAdmin = await checkIsAdmin(userId, env);
  if (isAdmin) {
    return { allowed: true, channel };
  }

  const isMember = env.isUserMemberOfForceChannel(userId);
  return { allowed: isMember, channel };
}

export async function dispatchSimulatedTelegramUpdate(
  update: {
    message?: {
      message_id: number;
      from: { id: string | number; first_name: string; username?: string };
      chat: { id: string | number };
      text: string;
    };
    callback_query?: {
      id: string;
      from: { id: string | number; first_name: string; username?: string };
      message: { message_id: number; chat: { id: string | number } };
      data: string;
    };
  },
  env: SimulationEnvContext
) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const userId = String(cb.from.id);
    const firstName = escapeHtml(cb.from.first_name || 'User');
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;

    if (cb.data !== 'verify_join') {
      env.onBotCallbackAnswer('Unknown action.', false);
      return;
    }

    const joinCheck = await verifyForceChannelMembership(userId, env);
    if (!joinCheck.allowed) {
      env.onBotCallbackAnswer(
        "❌ You haven't joined the channel yet! Toggle 'Joined Force Channel' in the simulator bar or join the channel first.",
        true
      );
      return;
    }

    env.onBotCallbackAnswer('✅ Membership verified! Welcome!', false);
    if (messageId) {
      env.onBotDeleteMessage(chatId, messageId);
    }

    const isAdmin = await checkIsAdmin(userId, env);
    env.onBotSendMessage(
      chatId,
      `✅ <b>Verification Successful!</b>\n\nWelcome, <b>${firstName}</b>! Your bottom navigation menu is now unlocked. Choose an option below:`,
      getUserKeyboard(isAdmin)
    );
    return;
  }

  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const firstName = escapeHtml(message.from.first_name || 'User');
  const text = (message.text || '').trim();
  if (!text) return;

  // Register user in BOT_KV if new
  const userKey = `user:${userId}`;
  const existingUser = await env.BOT_KV.get(userKey);
  if (!existingUser) {
    await env.BOT_KV.put(
      userKey,
      JSON.stringify({
        id: userId,
        firstName: message.from.first_name || '',
        username: message.from.username || '',
        joinedAt: new Date().toISOString(),
      })
    );
  }

  const isAdmin = await checkIsAdmin(userId, env);

  // Force Join check
  const joinCheck = await verifyForceChannelMembership(userId, env);
  if (!joinCheck.allowed && joinCheck.channel) {
    env.onBotSendMessage(
      chatId,
      `🔒 <b>Channel Membership Required</b>\n\nTo access the menu and claim free vouchers, you must first join our official Telegram channel.\n\n1️⃣ Tap <b>📢 Join Official Channel</b> below.\n2️⃣ After joining, tap <b>✅ Verify Membership</b>.`,
      getForceJoinInlineKeyboard(joinCheck.channel.link)
    );
    return;
  }

  // Multi-Step Admin State Machine
  if (isAdmin) {
    const rawState = await env.BOT_KV.get(`state:${userId}`);
    if (rawState) {
      let stateObj: { step: string; data?: Record<string, string> } | null = null;
      try {
        stateObj = JSON.parse(rawState);
      } catch {
        await env.BOT_KV.delete(`state:${userId}`);
      }

      if (stateObj) {
        if (text === '❌ Cancel' || text === '/cancel') {
          await env.BOT_KV.delete(`state:${userId}`);
          env.onBotSendMessage(
            chatId,
            '🚫 <b>Operation Cancelled</b>\nReturned to the Admin Control Center.',
            getAdminKeyboard()
          );
          return;
        }

        await processSimulatedAdminStep(chatId, userId, text, stateObj, env);
        return;
      }
    }
  }

  // Standard button & command routing
  switch (text) {
    case '/start':
    case '🏠 Main Menu':
    case '🔙 Back to User Menu': {
      if (isAdmin) {
        await env.BOT_KV.delete(`state:${userId}`);
      }
      env.onBotSendMessage(
        chatId,
        `👋 Welcome, <b>${firstName}</b>!\n\nUse the menu below to claim your exclusive voucher, check live stock availability, or reach out to support.`,
        getUserKeyboard(isAdmin)
      );
      break;
    }

    case '🎁 Claim Voucher': {
      const existingClaimRaw = await env.BOT_KV.get(`claimed:${userId}`);
      if (existingClaimRaw) {
        try {
          const claimed = JSON.parse(existingClaimRaw);
          env.onBotSendMessage(
            chatId,
            `ℹ️ <b>You Have Already Claimed Your Voucher!</b>\n\nHere are your previously claimed voucher details:\n\n🎁 <b>Title:</b> ${escapeHtml(claimed.title)}\n🔑 <b>Code / Link:</b> <code>${escapeHtml(claimed.code)}</code>\n\n📋 <b>Redeem Process:</b>\n${escapeHtml(claimed.instructions)}\n\n🕒 <i>Claimed on: ${escapeHtml(claimed.claimedAt || claimed.createdAt || 'Recorded')}</i>`,
            getUserKeyboard(isAdmin)
          );
          return;
        } catch {
          // continue
        }
      }

      const voucherKeys = await listAllKeysByPrefix('vouch:', env);
      if (!voucherKeys || voucherKeys.length === 0) {
        env.onBotSendMessage(
          chatId,
          '😔 <b>Out of Stock Alert</b>\n\nAll vouchers have currently been claimed! Please check back later or tap <b>📦 Check Stock</b> for updates.',
          getUserKeyboard(isAdmin)
        );
        return;
      }

      voucherKeys.sort((a, b) => a.name.localeCompare(b.name));

      let selectedVoucher: { title: string; code: string; instructions: string; createdAt?: string } | null = null;
      let selectedKeyName: string | null = null;

      for (const keyItem of voucherKeys) {
        const rawVoucher = await env.BOT_KV.get(keyItem.name);
        if (rawVoucher) {
          try {
            selectedVoucher = JSON.parse(rawVoucher);
            selectedKeyName = keyItem.name;
            break;
          } catch {
            await env.BOT_KV.delete(keyItem.name);
          }
        }
      }

      if (!selectedVoucher || !selectedKeyName) {
        env.onBotSendMessage(
          chatId,
          '😔 <b>Out of Stock Alert</b>\n\nAll vouchers have currently been claimed! Please check back later.',
          getUserKeyboard(isAdmin)
        );
        return;
      }

      const claimedRecord = {
        ...selectedVoucher,
        claimedBy: userId,
        claimedAt: new Date().toISOString(),
      };

      await env.BOT_KV.put(`claimed:${userId}`, JSON.stringify(claimedRecord));
      await env.BOT_KV.delete(selectedKeyName);

      env.onBotSendMessage(
        chatId,
        `🎉 <b>Congratulations! Voucher Claimed Successfully!</b>\n\n🎁 <b>Voucher Title:</b>\n${escapeHtml(claimedRecord.title)}\n\n🔑 <b>Voucher Code / Link:</b>\n<code>${escapeHtml(claimedRecord.code)}</code>\n\n📋 <b>Step-by-Step Redeem Process:</b>\n${escapeHtml(claimedRecord.instructions)}\n\n<i>💡 Tip: Tap on the code above to copy it to your clipboard.</i>`,
        getUserKeyboard(isAdmin)
      );
      break;
    }

    case '📦 Check Stock': {
      const stockKeys = await listAllKeysByPrefix('vouch:', env);
      const count = stockKeys.length;
      const statusText =
        count > 0
          ? `📦 <b>Live Voucher Stock</b>\n\nCurrently Available: <b>${count}</b> voucher(s) ready to claim!\n\nTap <b>🎁 Claim Voucher</b> below to grab yours.`
          : `⚠️ <b>Out of Stock</b>\n\nAll vouchers have been claimed for now. Please check back soon!`;

      env.onBotSendMessage(chatId, statusText, getUserKeyboard(isAdmin));
      break;
    }

    case '📞 Support': {
      const supportContact = (await env.BOT_KV.get('config:support')) || '@Support';
      env.onBotSendMessage(
        chatId,
        `📞 <b>Customer Support</b>\n\nNeed help redeeming your voucher or have a question?\nContact our official support representative: <b>${escapeHtml(supportContact)}</b>`,
        getUserKeyboard(isAdmin)
      );
      break;
    }

    case '🛠 Admin Panel': {
      if (!isAdmin) {
        env.onBotSendMessage(chatId, '⛔ Unauthorized access.', getUserKeyboard(false));
        return;
      }
      env.onBotSendMessage(
        chatId,
        '🛠 <b>Admin Control Center</b>\n\nSelect an action from the control keyboard below:',
        getAdminKeyboard()
      );
      break;
    }

    case '➕ Add Force Channel': {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: 'AWAIT_FORCE_CHANNEL' })
      );
      const currentChannelRaw = await env.BOT_KV.get('config:force_channel');
      let currentInfo = 'None configured';
      if (currentChannelRaw) {
        try {
          const parsed = JSON.parse(currentChannelRaw);
          currentInfo = `<code>${escapeHtml(parsed.id)}</code> (${escapeHtml(parsed.link)})`;
        } catch {
          currentInfo = 'None configured';
        }
      }
      env.onBotSendMessage(
        chatId,
        `📢 <b>Configure Force Channel Join</b>\n\nCurrent Channel: ${currentInfo}\n\nPlease send the <b>Channel ID</b> and <b>Invite Link</b> separated by a space in this exact format:\n<code>-1001234567890 https://t.me/yourchannel</code>\n\n<i>Tip: Make sure this bot is an Admin in your channel so it can verify members. Send <code>disable</code> to turn off Force Join.</i>`,
        getCancelKeyboard()
      );
      break;
    }

    case '👤 Add Admin': {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: 'AWAIT_ADD_ADMIN' })
      );
      env.onBotSendMessage(
        chatId,
        '👤 <b>Add New Administrator</b>\n\nPlease send the numeric <b>Telegram User ID</b> of the new admin (e.g., <code>987654321</code>):',
        getCancelKeyboard()
      );
      break;
    }

    case '💬 Set Support': {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: 'AWAIT_SET_SUPPORT' })
      );
      const currentSupport = (await env.BOT_KV.get('config:support')) || 'Not set';
      env.onBotSendMessage(
        chatId,
        `💬 <b>Set Support Contact</b>\n\nCurrent Support: <b>${escapeHtml(currentSupport)}</b>\n\nPlease send the new support Telegram username or link (e.g., <code>@MyBotSupport</code>):`,
        getCancelKeyboard()
      );
      break;
    }

    case '🎟 Add Voucher': {
      if (!isAdmin) return;
      await env.BOT_KV.put(
        `state:${userId}`,
        JSON.stringify({ step: 'AWAIT_VOUCHER_TITLE', data: {} })
      );
      env.onBotSendMessage(
        chatId,
        '🎟 <b>Add New Voucher (Step 1 of 3)</b>\n\nPlease enter the <b>Voucher Title</b>:\n<i>Example: Flat ₹500 Bonus Code</i>',
        getCancelKeyboard()
      );
      break;
    }

    case '🗑 Clear Stock': {
      if (!isAdmin) return;
      const keys = await listAllKeysByPrefix('vouch:', env);
      for (const k of keys) {
        await env.BOT_KV.delete(k.name);
      }
      env.onBotSendMessage(
        chatId,
        `🗑 <b>Stock Cleared</b>\n\nSuccessfully removed <b>${keys.length}</b> unclaimed voucher(s) from stock.`,
        getAdminKeyboard()
      );
      break;
    }

    case '📊 Bot Stats': {
      if (!isAdmin) return;
      const [stockKeys, claimedKeys, userKeys, admins, rawChannel, support] =
        await Promise.all([
          listAllKeysByPrefix('vouch:', env),
          listAllKeysByPrefix('claimed:', env),
          listAllKeysByPrefix('user:', env),
          getAdminList(env),
          env.BOT_KV.get('config:force_channel'),
          env.BOT_KV.get('config:support'),
        ]);

      let channelDisplay = 'Not Configured (Open Access)';
      if (rawChannel) {
        try {
          const parsed = JSON.parse(rawChannel);
          channelDisplay = `<code>${escapeHtml(parsed.id)}</code> (${escapeHtml(parsed.link)})`;
        } catch {
          channelDisplay = 'Not Configured';
        }
      }

      const statsMessage = [
        '📊 <b>Bot Live Statistics</b>',
        '',
        `🎟 <b>Available Stock:</b> ${stockKeys.length} voucher(s)`,
        `✅ <b>Total Claimed:</b> ${claimedKeys.length} voucher(s)`,
        `👥 <b>Total Users:</b> ${userKeys.length}`,
        `🛡 <b>Total Admins:</b> ${admins.length}`,
        `📢 <b>Force Channel:</b> ${channelDisplay}`,
        `💬 <b>Support Contact:</b> ${escapeHtml(support || '@Support (Default)')}`,
      ].join('\n');

      env.onBotSendMessage(chatId, statsMessage, getAdminKeyboard());
      break;
    }

    default: {
      env.onBotSendMessage(
        chatId,
        'ℹ️ Please use the menu buttons at the bottom of your screen to navigate.',
        getUserKeyboard(isAdmin)
      );
      break;
    }
  }
}

async function processSimulatedAdminStep(
  chatId: string | number,
  userId: string,
  text: string,
  stateObj: { step: string; data?: Record<string, string> },
  env: SimulationEnvContext
) {
  const { step, data = {} } = stateObj;

  switch (step) {
    case 'AWAIT_FORCE_CHANNEL': {
      if (text.toLowerCase() === 'disable' || text.toLowerCase() === 'off') {
        await env.BOT_KV.delete('config:force_channel');
        await env.BOT_KV.delete(`state:${userId}`);
        env.onBotSendMessage(
          chatId,
          '✅ <b>Force Channel Gate Disabled</b>\nUsers can now access the bot without a channel check.',
          getAdminKeyboard()
        );
        return;
      }

      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        env.onBotSendMessage(
          chatId,
          '⚠️ <b>Invalid Format</b>\n\nPlease provide both the Channel ID and Link separated by a space:\n<code>-1001234567890 https://t.me/channel</code>\n\nOr tap <b>❌ Cancel</b> below.',
          getCancelKeyboard()
        );
        return;
      }

      const channelId = parts[0].trim();
      const channelLink = parts.slice(1).join(' ').trim();

      if (
        (!channelId.startsWith('-100') && !channelId.startsWith('@')) ||
        !channelLink.startsWith('http')
      ) {
        env.onBotSendMessage(
          chatId,
          '⚠️ <b>Validation Error</b>\n\n• Channel ID must start with <code>-100</code> (or <code>@username</code>)\n• Link must start with <code>https://t.me/...</code>\n\nExample:\n<code>-100192837465 https://t.me/myofficialchannel</code>',
          getCancelKeyboard()
        );
        return;
      }

      await env.BOT_KV.put(
        'config:force_channel',
        JSON.stringify({ id: channelId, link: channelLink })
      );
      await env.BOT_KV.delete(`state:${userId}`);

      env.onBotSendMessage(
        chatId,
        `✅ <b>Force Channel Updated!</b>\n\n• <b>Channel ID:</b> <code>${escapeHtml(channelId)}</code>\n• <b>Invite Link:</b> ${escapeHtml(channelLink)}`,
        getAdminKeyboard()
      );
      break;
    }

    case 'AWAIT_ADD_ADMIN': {
      if (!/^\d{5,15}$/.test(text)) {
        env.onBotSendMessage(
          chatId,
          '⚠️ <b>Invalid Telegram ID</b>\n\nPlease send a valid numeric Telegram User ID (digits only, e.g. <code>123456789</code>) or tap <b>❌ Cancel</b>.',
          getCancelKeyboard()
        );
        return;
      }

      const admins = await getAdminList(env);
      if (!admins.includes(text)) {
        admins.push(text);
        await env.BOT_KV.put('config:admins', JSON.stringify(admins));
      }

      await env.BOT_KV.delete(`state:${userId}`);
      env.onBotSendMessage(
        chatId,
        `✅ <b>Admin Added Successfully!</b>\n\nUser ID <code>${escapeHtml(text)}</code> now has full access to the Admin Control Center.`,
        getAdminKeyboard()
      );
      break;
    }

    case 'AWAIT_SET_SUPPORT': {
      if (text.length < 2 || text.length > 100) {
        env.onBotSendMessage(
          chatId,
          '⚠️ Please enter a valid support username or link (e.g. <code>@SupportHandle</code>).',
          getCancelKeyboard()
        );
        return;
      }

      await env.BOT_KV.put('config:support', text);
      await env.BOT_KV.delete(`state:${userId}`);
      env.onBotSendMessage(
        chatId,
        `✅ <b>Support Contact Updated!</b>\n\nNew Support Contact: <b>${escapeHtml(text)}</b>`,
        getAdminKeyboard()
      );
      break;
    }

    case 'AWAIT_VOUCHER_TITLE': {
      const updatedState = {
        step: 'AWAIT_VOUCHER_CODE',
        data: { title: text },
      };
      await env.BOT_KV.put(`state:${userId}`, JSON.stringify(updatedState));
      env.onBotSendMessage(
        chatId,
        `🎟 <b>Add New Voucher (Step 2 of 3)</b>\n\n• <b>Title:</b> ${escapeHtml(text)}\n\nNow send the <b>Voucher Code or Claim Link</b>:`,
        getCancelKeyboard()
      );
      break;
    }

    case 'AWAIT_VOUCHER_CODE': {
      const updatedState = {
        step: 'AWAIT_VOUCHER_PROCESS',
        data: { ...data, code: text },
      };
      await env.BOT_KV.put(`state:${userId}`, JSON.stringify(updatedState));
      env.onBotSendMessage(
        chatId,
        `🎟 <b>Add New Voucher (Step 3 of 3)</b>\n\n• <b>Title:</b> ${escapeHtml(data.title || '')}\n• <b>Code/Link:</b> <code>${escapeHtml(text)}</code>\n\nNow send the <b>Step-by-Step Redeem Process / Instructions</b>:`,
        getCancelKeyboard()
      );
      break;
    }

    case 'AWAIT_VOUCHER_PROCESS': {
      const timestamp = Date.now();
      const voucherKey = `vouch:${timestamp}`;
      const voucherPayload = {
        id: voucherKey,
        title: data.title || 'Voucher',
        code: data.code || '',
        instructions: text,
        createdAt: new Date(timestamp).toISOString(),
      };

      await env.BOT_KV.put(voucherKey, JSON.stringify(voucherPayload));
      await env.BOT_KV.delete(`state:${userId}`);

      env.onBotSendMessage(
        chatId,
        `✅ <b>Voucher Saved to Stock!</b>\n\n• <b>KV Key:</b> <code>${voucherKey}</code>\n• <b>Title:</b> ${escapeHtml(voucherPayload.title)}\n• <b>Code:</b> <code>${escapeHtml(voucherPayload.code)}</code>\n• <b>Redeem Process:</b>\n${escapeHtml(voucherPayload.instructions)}`,
        getAdminKeyboard()
      );
      break;
    }

    default: {
      await env.BOT_KV.delete(`state:${userId}`);
      env.onBotSendMessage(
        chatId,
        'Returned to Admin Control Center.',
        getAdminKeyboard()
      );
      break;
    }
  }
}
