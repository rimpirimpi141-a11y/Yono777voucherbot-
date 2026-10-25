import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Copy,
  Check,
  Download,
  Send,
  Database,
  Code2,
  Smartphone,
  Terminal,
  Trash2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  KeyRound,
  SlidersHorizontal,
} from 'lucide-react';
import { WORKER_JS_SOURCE, WRANGLER_TOML_SOURCE } from './workerSource';
import {
  SimulatedCloudflareKV,
  SimulatedTelegramMessage,
  ReplyMarkup,
  KvOperationLog,
  dispatchSimulatedTelegramUpdate,
} from './workerSimulator';

interface SimPersona {
  id: string;
  firstName: string;
  username: string;
  label: string;
  roleHint: string;
}

const PERSONAS: SimPersona[] = [
  {
    id: '100000001',
    firstName: 'Vikram (Admin)',
    username: 'vikram_admin',
    label: 'Primary Admin',
    roleHint: 'Matches env.ADMIN_ID',
  },
  {
    id: '200000055',
    firstName: 'Ananya',
    username: 'ananya_user',
    label: 'User A',
    roleHint: 'Standard Telegram User',
  },
  {
    id: '200000088',
    firstName: 'Rohan',
    username: 'rohan_dev',
    label: 'User B',
    roleHint: 'Standard Telegram User',
  },
];

const INITIAL_KV_SEED: Record<string, string> = {
  'config:support': '@VoucherHelpDesk',
  'vouch:1729800001000': JSON.stringify({
    id: 'vouch:1729800001000',
    title: 'Flat ₹500 Bonus Code',
    code: 'CF-WORKER-500-ALPHA',
    instructions:
      '1. Open the official app and go to Rewards.\n2. Enter code CF-WORKER-500-ALPHA at checkout.\n3. Instant ₹500 credit will be applied to your wallet.',
    createdAt: '2026-10-25T01:10:00.000Z',
  }),
  'vouch:1729800002000': JSON.stringify({
    id: 'vouch:1729800002000',
    title: 'Pro Cloud Credits $25 Gift Link',
    code: 'https://t.me/VoucherRedeemBot?start=GIFT25PRO',
    instructions:
      '1. Open the activation link above.\n2. Confirm your email address.\n3. Your $25 credit activates within 60 seconds.',
    createdAt: '2026-10-25T01:15:00.000Z',
  }),
};

function renderTelegramHtml(rawHtml: string) {
  const lines = rawHtml.split('\n');
  return lines.map((line, lineIdx) => {
    const tokens = line.split(/(<b>.*?<\/b>|<i>.*?<\/i>|<code>.*?<\/code>)/g);
    return (
      <React.Fragment key={lineIdx}>
        {tokens.map((tok, tokIdx) => {
          if (tok.startsWith('<b>') && tok.endsWith('</b>')) {
            return (
              <strong key={tokIdx} className="font-semibold text-white">
                {tok.slice(3, -4)}
              </strong>
            );
          }
          if (tok.startsWith('<i>') && tok.endsWith('</i>')) {
            return (
              <em key={tokIdx} className="italic text-slate-300">
                {tok.slice(3, -4)}
              </em>
            );
          }
          if (tok.startsWith('<code>') && tok.endsWith('</code>')) {
            const codeContent = tok.slice(6, -7);
            return (
              <code
                key={tokIdx}
                onClick={() => navigator.clipboard?.writeText(codeContent)}
                title="Click to copy"
                className="font-mono text-xs bg-slate-950/90 text-amber-300 px-1.5 py-0.5 rounded border border-slate-700/80 cursor-pointer hover:border-amber-400/60 transition-colors"
              >
                {codeContent}
              </code>
            );
          }
          return (
            <span key={tokIdx}>
              {tok
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')}
            </span>
          );
        })}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'simulator' | 'code' | 'kv' | 'deploy'>('simulator');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedWrangler, setCopiedWrangler] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');

  // Simulator environment state
  const [adminIdEnv, setAdminIdEnv] = useState('100000001');
  const [activePersonaId, setActivePersonaId] = useState<string>('100000001');
  const [channelMembershipMap, setChannelMembershipMap] = useState<Record<string, boolean>>({
    '100000001': true,
    '200000055': false,
    '200000088': true,
  });

  // KV state & logs
  const [kvVersion, setKvVersion] = useState(0);
  const [kvLogs, setKvLogs] = useState<KvOperationLog[]>([]);
  const [kvFilter, setKvFilter] = useState<string>('all');
  const [newKvKey, setNewKvKey] = useState('');
  const [newKvVal, setNewKvVal] = useState('');

  const kvRef = useRef<SimulatedCloudflareKV | null>(null);
  if (!kvRef.current) {
    kvRef.current = new SimulatedCloudflareKV(
      INITIAL_KV_SEED,
      (log) => setKvLogs((prev) => [log, ...prev.slice(0, 79)]),
      () => setKvVersion((v) => v + 1)
    );
  }

  // Per-user chat history and active bottom ReplyKeyboardMarkup
  const [messagesByPersona, setMessagesByPersona] = useState<
    Record<string, SimulatedTelegramMessage[]>
  >({
    '100000001': [],
    '200000055': [],
    '200000088': [],
  });

  const [replyKeyboardByPersona, setReplyKeyboardByPersona] = useState<
    Record<string, ReplyMarkup | undefined>
  >({});

  const [toastAlert, setToastAlert] = useState<{ text: string; isError: boolean } | null>(null);
  const [inputText, setInputText] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const msgCounterRef = useRef(100);

  const activePersona = useMemo(
    () => PERSONAS.find((p) => p.id === activePersonaId) || PERSONAS[0],
    [activePersonaId]
  );

  // Snapshot of current KV entries
  const kvSnapshot = useMemo(() => {
    void kvVersion;
    return kvRef.current ? kvRef.current.getSnapshot() : {};
  }, [kvVersion]);

  // Active admin state for the current persona (for helpful UI indicator)
  const activeUserKvState = useMemo(() => {
    const raw = kvSnapshot[`state:${activePersonaId}`];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { step: string; data?: Record<string, string> };
    } catch {
      return null;
    }
  }, [kvSnapshot, activePersonaId]);

  const forceChannelConfig = useMemo(() => {
    const raw = kvSnapshot['config:force_channel'];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { id: string; link: string };
    } catch {
      return null;
    }
  }, [kvSnapshot]);

  // Send initial /start automatically on first load for primary admin
  useEffect(() => {
    void sendUserMessage('/start', '100000001');
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesByPersona, activePersonaId]);

  async function sendUserMessage(textToSend: string, targetPersonaId = activePersonaId) {
    const trimmed = textToSend.trim();
    if (!trimmed || !kvRef.current) return;

    const persona = PERSONAS.find((p) => p.id === targetPersonaId) || PERSONAS[0];
    const userMsgId = ++msgCounterRef.current;
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const userMsg: SimulatedTelegramMessage = {
      id: userMsgId,
      sender: 'user',
      userId: persona.id,
      text: trimmed,
      timestamp: nowTime,
    };

    setMessagesByPersona((prev) => ({
      ...prev,
      [persona.id]: [...(prev[persona.id] || []), userMsg],
    }));

    await dispatchSimulatedTelegramUpdate(
      {
        message: {
          message_id: userMsgId,
          from: {
            id: persona.id,
            first_name: persona.firstName,
            username: persona.username,
          },
          chat: { id: persona.id },
          text: trimmed,
        },
      },
      {
        BOT_KV: kvRef.current,
        BOT_TOKEN: 'SIMULATED_BOT_TOKEN',
        ADMIN_ID: adminIdEnv,
        isUserMemberOfForceChannel: (uid) => Boolean(channelMembershipMap[uid]),
        onBotSendMessage: (_chatId, botHtml, replyMarkup) => {
          const botMsgId = ++msgCounterRef.current;
          const botMsg: SimulatedTelegramMessage = {
            id: botMsgId,
            sender: 'bot',
            userId: persona.id,
            text: botHtml,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyMarkup,
          };

          setMessagesByPersona((prev) => ({
            ...prev,
            [persona.id]: [...(prev[persona.id] || []), botMsg],
          }));

          // If message contains a bottom ReplyKeyboardMarkup, update persistent bottom keyboard
          if (replyMarkup?.keyboard) {
            setReplyKeyboardByPersona((prev) => ({
              ...prev,
              [persona.id]: replyMarkup,
            }));
          }
          return botMsgId;
        },
        onBotDeleteMessage: (_chatId, messageId) => {
          setMessagesByPersona((prev) => ({
            ...prev,
            [persona.id]: (prev[persona.id] || []).filter((m) => m.id !== messageId),
          }));
        },
        onBotCallbackAnswer: (alertText, showAlert) => {
          setToastAlert({ text: alertText, isError: showAlert });
          setTimeout(() => setToastAlert(null), 4000);
        },
      }
    );
  }

  async function triggerInlineCallback(messageId: number, callbackData: string) {
    if (!kvRef.current) return;
    const persona = activePersona;

    await dispatchSimulatedTelegramUpdate(
      {
        callback_query: {
          id: `cb-${Date.now()}`,
          from: {
            id: persona.id,
            first_name: persona.firstName,
            username: persona.username,
          },
          message: {
            message_id: messageId,
            chat: { id: persona.id },
          },
          data: callbackData,
        },
      },
      {
        BOT_KV: kvRef.current,
        BOT_TOKEN: 'SIMULATED_BOT_TOKEN',
        ADMIN_ID: adminIdEnv,
        isUserMemberOfForceChannel: (uid) => Boolean(channelMembershipMap[uid]),
        onBotSendMessage: (_chatId, botHtml, replyMarkup) => {
          const botMsgId = ++msgCounterRef.current;
          const botMsg: SimulatedTelegramMessage = {
            id: botMsgId,
            sender: 'bot',
            userId: persona.id,
            text: botHtml,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyMarkup,
          };

          setMessagesByPersona((prev) => ({
            ...prev,
            [persona.id]: [...(prev[persona.id] || []), botMsg],
          }));

          if (replyMarkup?.keyboard) {
            setReplyKeyboardByPersona((prev) => ({
              ...prev,
              [persona.id]: replyMarkup,
            }));
          }
          return botMsgId;
        },
        onBotDeleteMessage: (_chatId, msgId) => {
          setMessagesByPersona((prev) => ({
            ...prev,
            [persona.id]: (prev[persona.id] || []).filter((m) => m.id !== msgId),
          }));
        },
        onBotCallbackAnswer: (alertText, showAlert) => {
          setToastAlert({ text: alertText, isError: showAlert });
          setTimeout(() => setToastAlert(null), 4000);
        },
      }
    );
  }

  function handleCopyWorkerCode() {
    navigator.clipboard?.writeText(WORKER_JS_SOURCE);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }

  function handleCopyWrangler() {
    navigator.clipboard?.writeText(WRANGLER_TOML_SOURCE);
    setCopiedWrangler(true);
    setTimeout(() => setCopiedWrangler(false), 2000);
  }

  function handleDownloadFile(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSwitchPersona(personaId: string) {
    setActivePersonaId(personaId);
    const existingMsgs = messagesByPersona[personaId] || [];
    if (existingMsgs.length === 0) {
      setTimeout(() => {
        void sendUserMessage('/start', personaId);
      }, 60);
    }
  }

  function handleSeedSampleVoucher() {
    if (!kvRef.current) return;
    const ts = Date.now();
    const key = `vouch:${ts}`;
    const sample = {
      id: key,
      title: `Instant ₹${Math.floor(100 + Math.random() * 900)} Cashback Voucher`,
      code: `PROMO-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      instructions:
        '1. Copy the promo code above.\n2. Open the Checkout screen in the app.\n3. Paste in Apply Coupon to unlock instant cashback.',
      createdAt: new Date(ts).toISOString(),
    };
    void kvRef.current.put(key, JSON.stringify(sample));
  }

  function handleResetSimulation() {
    if (!kvRef.current) return;
    kvRef.current.reset(INITIAL_KV_SEED);
    setKvLogs([]);
    setMessagesByPersona({
      '100000001': [],
      '200000055': [],
      '200000088': [],
    });
    setReplyKeyboardByPersona({});
    setActivePersonaId('100000001');
    setTimeout(() => {
      void sendUserMessage('/start', '100000001');
    }, 50);
  }

  const currentMessages = messagesByPersona[activePersonaId] || [];
  const currentBottomKeyboard = replyKeyboardByPersona[activePersonaId]?.keyboard || [
    [{ text: '🎁 Claim Voucher' }],
    [{ text: '📦 Check Stock' }, { text: '📞 Support' }],
    [{ text: '🏠 Main Menu' }],
  ];

  const codeLines = useMemo(() => WORKER_JS_SOURCE.split('\n'), []);
  const filteredKvEntries = useMemo(() => {
    const entries = Object.entries(kvSnapshot);
    if (kvFilter === 'all') return entries;
    return entries.filter(([k]) => k.startsWith(kvFilter));
  }, [kvSnapshot, kvFilter]);

  const stockCount = Object.keys(kvSnapshot).filter((k) => k.startsWith('vouch:')).length;
  const claimedCount = Object.keys(kvSnapshot).filter((k) => k.startsWith('claimed:')).length;

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800/90 bg-[#0f172a]">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('simulator');
          }}
          className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          WorkerBot Studio
        </a>

        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400 overflow-x-auto">
          <button
            onClick={() => setActiveTab('simulator')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'simulator'
                ? 'border-amber-400 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Interactive Simulator
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'code'
                ? 'border-amber-400 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Worker.js Source ({codeLines.length} lines)
          </button>
          <button
            onClick={() => setActiveTab('kv')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'kv'
                ? 'border-amber-400 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            BOT_KV Inspector ({Object.keys(kvSnapshot).length})
          </button>
          <button
            onClick={() => setActiveTab('deploy')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'deploy'
                ? 'border-amber-400 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Deployment Guide
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleCopyWorkerCode}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 rounded-lg hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedCode ? 'Copied worker.js' : 'Copy worker.js'}
          </button>
        </div>
      </header>

      {/* Sub-toolbar with context summary & quick download */}
      <div className="bg-[#0f172a]/60 border-b border-slate-800/80 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-200 font-medium">Serverless Cloudflare Worker</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">export default &#123; async fetch(request, env, ctx) &#125;</span>
          <span aria-hidden="true">·</span>
          <span>KV Binding: <strong className="font-mono text-slate-200">BOT_KV</strong></span>
          <span aria-hidden="true">·</span>
          <span>Secrets: <strong className="font-mono text-slate-200">BOT_TOKEN</strong>, <strong className="font-mono text-slate-200">ADMIN_ID</strong></span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleDownloadFile('worker.js', WORKER_JS_SOURCE)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800/90 hover:bg-slate-700 rounded-md border border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download worker.js
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800/90 hover:bg-slate-700 rounded-md border border-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Code2 className="w-3.5 h-3.5" />
            View Full Code
          </button>
        </div>
      </div>

      {/* Main Workspace Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6">
        {activeTab === 'simulator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Environment Controls & Multi-Step State Inspector (4 cols) */}
            <div className="lg:col-span-4 space-y-5">
              <section className="bg-[#111827] border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-amber-400" />
                    1. Active Telegram Persona
                  </h2>
                  <button
                    onClick={handleResetSimulation}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
                    title="Reset KV & chat history"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reset Sandbox
                  </button>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Switch users below to test Role-Based Navigation (`ADMIN_ID` vs standard user), per-user voucher claiming (`claimed:&lt;userId&gt;`), and the Force Channel Join gate.
                </p>

                <div className="space-y-2">
                  {PERSONAS.map((p) => {
                    const isSelected = p.id === activePersonaId;
                    const isPrimaryAdmin = p.id === adminIdEnv;
                    const extraAdmins = (() => {
                      try {
                        return JSON.parse(kvSnapshot['config:admins'] || '[]') as string[];
                      } catch {
                        return [];
                      }
                    })();
                    const isAddedAdmin = extraAdmins.includes(p.id);
                    const hasClaimed = Boolean(kvSnapshot[`claimed:${p.id}`]);

                    return (
                      <button
                        key={p.id}
                        onClick={() => handleSwitchPersona(p.id)}
                        className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'bg-slate-800/90 border-amber-400/80 text-white'
                            : 'bg-slate-900/60 border-slate-800/90 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold truncate">{p.firstName}</span>
                            <span className="text-xs font-mono text-slate-400">ID: {p.id}</span>
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5">
                            <span>{isPrimaryAdmin ? 'Primary Admin' : isAddedAdmin ? 'Promoted Admin' : 'Standard User'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{hasClaimed ? 'Voucher Claimed' : 'No Claim Yet'}</span>
                          </div>
                        </div>
                        {isPrimaryAdmin || isAddedAdmin ? (
                          <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
                        ) : (
                          <User className="w-4 h-4 text-slate-500 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Force Join Simulator Switch */}
                <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      Force Join Gate (`getChatMember` Simulator)
                    </span>
                    <span className="text-xs font-mono text-slate-400">
                      {forceChannelConfig ? forceChannelConfig.id : 'No Channel Set'}
                    </span>
                  </div>

                  <label className="flex items-center justify-between p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 cursor-pointer">
                    <span className="text-xs text-slate-300">
                      Is <strong>{activePersona.firstName}</strong> in the Force Channel?
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(channelMembershipMap[activePersonaId])}
                      onChange={(e) =>
                        setChannelMembershipMap((prev) => ({
                          ...prev,
                          [activePersonaId]: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 accent-amber-400 rounded cursor-pointer"
                    />
                  </label>

                  {!forceChannelConfig && (
                    <p className="text-[11px] text-slate-400">
                      Tip: Click <strong>🛠 Admin Panel → ➕ Add Force Channel</strong> in the bot keyboard to enable the Force Channel Join gate.
                    </p>
                  )}
                </div>
              </section>

              {/* Multi-Step Admin State Machine Helper */}
              <section className="bg-[#111827] border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-amber-400" />
                    2. Multi-Step KV State Machine
                  </h2>
                  <span className="text-xs font-mono text-slate-400">
                    state:{activePersonaId}
                  </span>
                </div>

                {activeUserKvState ? (
                  <div className="p-3 rounded-lg bg-slate-900 border border-amber-400/40 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-amber-300 font-semibold">Active Step:</span>
                      <code className="font-mono text-white bg-slate-800 px-2 py-0.5 rounded">
                        {activeUserKvState.step}
                      </code>
                    </div>
                    {activeUserKvState.data && Object.keys(activeUserKvState.data).length > 0 && (
                      <div className="text-xs text-slate-300 font-mono bg-slate-950 p-2 rounded border border-slate-800">
                        {JSON.stringify(activeUserKvState.data)}
                      </div>
                    )}

                    {/* Quick One-Click Test Inputs for the current Admin step */}
                    <div className="pt-1 space-y-1.5">
                      <div className="text-[11px] text-slate-400">
                        Quick-send valid test payload for this step:
                      </div>
                      {activeUserKvState.step === 'AWAIT_FORCE_CHANNEL' && (
                        <button
                          onClick={() =>
                            void sendUserMessage('-1001987654321 https://t.me/OfficialRewardsChannel')
                          }
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send: -1001987654321 https://t.me/OfficialRewardsChannel
                        </button>
                      )}
                      {activeUserKvState.step === 'AWAIT_ADD_ADMIN' && (
                        <button
                          onClick={() => void sendUserMessage('200000088')}
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send: 200000088 (Promote Rohan to Admin)
                        </button>
                      )}
                      {activeUserKvState.step === 'AWAIT_SET_SUPPORT' && (
                        <button
                          onClick={() => void sendUserMessage('@VIPSupportDesk_24x7')}
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send: @VIPSupportDesk_24x7
                        </button>
                      )}
                      {activeUserKvState.step === 'AWAIT_VOUCHER_TITLE' && (
                        <button
                          onClick={() => void sendUserMessage('Flat ₹1,000 Festival Gift Voucher')}
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send Title: Flat ₹1,000 Festival Gift Voucher
                        </button>
                      )}
                      {activeUserKvState.step === 'AWAIT_VOUCHER_CODE' && (
                        <button
                          onClick={() => void sendUserMessage('FESTIVAL-1000-GOLD')}
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send Code: FESTIVAL-1000-GOLD
                        </button>
                      )}
                      {activeUserKvState.step === 'AWAIT_VOUCHER_PROCESS' && (
                        <button
                          onClick={() =>
                            void sendUserMessage(
                              '1. Visit Wallet > Redeem Code.\n2. Enter FESTIVAL-1000-GOLD.\n3. Enjoy ₹1,000 instant balance!'
                            )
                          }
                          className="w-full text-left text-xs font-mono px-2.5 py-1.5 rounded bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 border border-amber-400/30 transition-colors cursor-pointer"
                        >
                          Send Step 3 Redeem Instructions
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400">
                    No active multi-step prompt for <span className="font-mono text-slate-300">{activePersona.firstName}</span>. Click an Admin button (like <strong>🎟 Add Voucher</strong> or <strong>➕ Add Force Channel</strong>) on the phone keyboard to start a multi-step flow.
                  </div>
                )}

                <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 tabular-nums">
                  <span>Stock (`vouch:*`): <strong className="text-white">{stockCount}</strong></span>
                  <span>Claimed (`claimed:*`): <strong className="text-white">{claimedCount}</strong></span>
                  <button
                    onClick={handleSeedSampleVoucher}
                    className="text-amber-400 hover:text-amber-300 font-medium cursor-pointer flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Quick Seed +1
                  </button>
                </div>
              </section>
            </div>

            {/* Center Column: Interactive Telegram Phone Simulator with Bottom ReplyKeyboardMarkup (5 cols) */}
            <div className="lg:col-span-5 flex flex-col items-center">
              <div className="w-full max-w-[430px] bg-[#0e1621] border-2 border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col h-[690px]">
                {/* Telegram Chat Header */}
                <div className="bg-[#17212b] px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-sky-500/20 border border-sky-400/40 flex items-center justify-center text-sky-300 font-bold text-sm shrink-0">
                      VB
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">
                        Cloudflare Voucher Bot
                      </div>
                      <div className="text-[11px] text-sky-400 truncate">
                        bot · Viewing as {activePersona.firstName} ({activePersona.id})
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => void sendUserMessage('/start')}
                    className="px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors cursor-pointer shrink-0"
                  >
                    /start
                  </button>
                </div>

                {/* Callback Toast Alert (simulating answerCallbackQuery) */}
                {toastAlert && (
                  <div
                    className={`px-4 py-2 text-xs font-medium border-b flex items-center justify-between ${
                      toastAlert.isError
                        ? 'bg-red-950/90 border-red-800 text-red-200'
                        : 'bg-emerald-950/90 border-emerald-800 text-emerald-200'
                    }`}
                  >
                    <span>{toastAlert.text}</span>
                    <button
                      onClick={() => setToastAlert(null)}
                      className="text-xs underline ml-2 cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Chat Message Stream */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#0e1621]">
                  {currentMessages.map((msg) => {
                    const isUser = msg.sender === 'user';
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-[86%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                            isUser
                              ? 'bg-[#2b5278] text-white rounded-br-sm'
                              : 'bg-[#182533] text-slate-100 rounded-bl-sm border border-slate-800/80'
                          }`}
                        >
                          <div className="break-words">{renderTelegramHtml(msg.text)}</div>
                          <div className="text-[10px] text-slate-400 text-right mt-1 tabular-nums">
                            {msg.timestamp}
                          </div>
                        </div>

                        {/* Inline Keyboard ONLY rendered if present (strictly used for Force Channel Join gate) */}
                        {msg.replyMarkup?.inline_keyboard && (
                          <div className="w-[86%] mt-1.5 space-y-1">
                            {msg.replyMarkup.inline_keyboard.map((row, rIdx) => (
                              <div key={rIdx} className="grid grid-cols-1 gap-1">
                                {row.map((btn, bIdx) => {
                                  if (btn.url) {
                                    return (
                                      <button
                                        key={bIdx}
                                        onClick={() => {
                                          // Simulate user clicking the Join Channel URL and joining the channel!
                                          setChannelMembershipMap((prev) => ({
                                            ...prev,
                                            [activePersonaId]: true,
                                          }));
                                          setToastAlert({
                                            text: `Opened ${btn.url} — Simulated joining ${forceChannelConfig?.id || 'channel'}! Now tap "✅ Verify Membership".`,
                                            isError: false,
                                          });
                                        }}
                                        className="w-full py-2 px-3 rounded-lg bg-[#203040]/95 hover:bg-[#283c50] text-sky-300 text-xs font-medium border border-sky-500/30 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                      >
                                        <span>{btn.text}</span>
                                        <span className="text-[10px] opacity-75">↗</span>
                                      </button>
                                    );
                                  }
                                  return (
                                    <button
                                      key={bIdx}
                                      onClick={() =>
                                        void triggerInlineCallback(
                                          msg.id,
                                          btn.callback_data || 'verify_join'
                                        )
                                      }
                                      className="w-full py-2 px-3 rounded-lg bg-[#203040]/95 hover:bg-[#283c50] text-emerald-300 text-xs font-medium border border-emerald-500/30 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                    >
                                      {btn.text}
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>

                {/* Text Input Bar */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!inputText.trim()) return;
                    const toSend = inputText;
                    setInputText('');
                    void sendUserMessage(toSend);
                  }}
                  className="bg-[#17212b] px-3 py-2 border-t border-slate-800 flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={
                      activeUserKvState
                        ? `Enter ${activeUserKvState.step.replace('AWAIT_', '').toLowerCase()}...`
                        : 'Write a message or use bottom keyboard...'
                    }
                    className="flex-1 bg-[#0e1621] text-xs text-white placeholder-slate-500 px-3 py-2 rounded-lg border border-slate-800 focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="submit"
                    className="p-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors cursor-pointer shrink-0"
                    title="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>

                {/* Bottom ReplyKeyboardMarkup Tray (CRITICAL REQUIREMENT #2 & #3) */}
                <div className="bg-[#17212b] p-2.5 border-t border-slate-800/90 space-y-1.5">
                  <div className="flex items-center justify-between px-1 pb-0.5">
                    <span className="text-[10px] font-mono text-slate-400">
                      ReplyKeyboardMarkup (resize_keyboard: true)
                    </span>
                    <span className="text-[10px] font-mono text-amber-400">
                      {currentBottomKeyboard.length === 1
                        ? 'Cancel Keyboard'
                        : currentBottomKeyboard.length === 4
                        ? 'Admin Control Center'
                        : 'User Panel Keyboard'}
                    </span>
                  </div>
                  {currentBottomKeyboard.map((row, rowIndex) => (
                    <div
                      key={rowIndex}
                      className="grid gap-1.5"
                      style={{
                        gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
                      }}
                    >
                      {row.map((btn, btnIndex) => (
                        <button
                          key={btnIndex}
                          type="button"
                          onClick={() => void sendUserMessage(btn.text)}
                          className="py-2.5 px-2 rounded-lg bg-[#232e3c] hover:bg-[#2c3a4b] active:scale-[0.99] text-white text-xs font-medium border border-slate-700/70 transition-all truncate cursor-pointer shadow-sm"
                        >
                          {btn.text}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Live BOT_KV Storage & Execution Stream (3 cols) */}
            <div className="lg:col-span-3 space-y-5">
              <section className="bg-[#111827] border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Database className="w-4 h-4 text-amber-400" />
                    Live BOT_KV Keys ({Object.keys(kvSnapshot).length})
                  </h2>
                  <button
                    onClick={() => setActiveTab('kv')}
                    className="text-xs text-amber-400 hover:underline cursor-pointer"
                  >
                    Full Editor →
                  </button>
                </div>

                <div className="space-y-2 max-h-[290px] overflow-y-auto pr-1">
                  {Object.entries(kvSnapshot).map(([key, val]) => (
                    <div
                      key={key}
                      className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800/90 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-amber-300 truncate">
                          {key}
                        </span>
                        <button
                          onClick={() => kvRef.current?.deleteDirect(key)}
                          className="text-slate-500 hover:text-red-400 transition-colors cursor-pointer"
                          title="Delete key from BOT_KV"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 break-all line-clamp-2">
                        {val}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="bg-[#111827] border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-amber-400" />
                    BOT_KV I/O Operations
                  </h2>
                  <button
                    onClick={() => setKvLogs([])}
                    className="text-xs text-slate-400 hover:text-white cursor-pointer"
                  >
                    Clear
                  </button>
                </div>

                <div className="space-y-1.5 max-h-[260px] overflow-y-auto font-mono text-[11px]">
                  {kvLogs.length === 0 ? (
                    <div className="text-slate-500 py-4 text-center">
                      Interact with the bot to see live KV reads &amp; writes.
                    </div>
                  ) : (
                    kvLogs.map((log) => (
                      <div
                        key={log.id}
                        className="p-2 rounded bg-slate-900/70 border border-slate-800/70 flex flex-col gap-0.5"
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`font-semibold ${
                              log.op === 'PUT'
                                ? 'text-emerald-400'
                                : log.op === 'DELETE'
                                ? 'text-red-400'
                                : log.op === 'LIST'
                                ? 'text-sky-400'
                                : 'text-amber-300'
                            }`}
                          >
                            env.BOT_KV.{log.op.toLowerCase()}({log.keyOrPrefix})
                          </span>
                          <span className="text-[10px] text-slate-500 tabular-nums">
                            {log.timestamp}
                          </span>
                        </div>
                        {log.detail && (
                          <div className="text-slate-400 truncate">{log.detail}</div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        )}

        {/* TAB 2: COMPLETE SINGLE-FILE WORKER.JS SOURCE CODE */}
        {activeTab === 'code' && (
          <div className="space-y-5">
            <div className="bg-[#111827] border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <h1 className="text-lg font-bold text-white">
                  Single-File Cloudflare Worker Backend (`worker.js`)
                </h1>
                <p className="text-xs text-slate-400">
                  Zero external npm dependencies · Native Fetch API · Cloudflare KV (`BOT_KV`) · Full try-catch resilience
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={codeSearch}
                    onChange={(e) => setCodeSearch(e.target.value)}
                    placeholder="Filter code lines..."
                    className="bg-slate-900 text-xs text-white pl-8 pr-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-amber-400"
                  />
                </div>

                <button
                  onClick={handleCopyWorkerCode}
                  className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 rounded-lg hover:bg-amber-300 transition-colors cursor-pointer"
                >
                  {copiedCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copiedCode ? 'Copied to Clipboard!' : 'Copy Full worker.js'}
                </button>

                <button
                  onClick={() => handleDownloadFile('worker.js', WORKER_JS_SOURCE)}
                  className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  Download worker.js
                </button>
              </div>
            </div>

            {/* Code Viewport */}
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
              <div className="bg-[#161b22] px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs font-mono text-slate-400">
                <span>/worker.js</span>
                <span>{codeLines.length} lines · Standard ES Module Worker</span>
              </div>
              <div className="overflow-x-auto max-h-[680px] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
                {codeLines.map((line, idx) => {
                  if (
                    codeSearch.trim() &&
                    !line.toLowerCase().includes(codeSearch.trim().toLowerCase())
                  ) {
                    return null;
                  }
                  return (
                    <div
                      key={idx}
                      className="flex hover:bg-slate-800/40 px-2 py-0.5 rounded"
                    >
                      <span className="w-12 shrink-0 text-slate-600 select-none text-right pr-4 tabular-nums">
                        {idx + 1}
                      </span>
                      <pre className="text-slate-200 whitespace-pre">{line || ' '}</pre>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: BOT_KV STORAGE INSPECTOR */}
        {activeTab === 'kv' && (
          <div className="space-y-6">
            <div className="bg-[#111827] border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-lg font-bold text-white">
                  Cloudflare KV Namespace Inspector (`env.BOT_KV`)
                </h1>
                <p className="text-xs text-slate-400 mt-0.5">
                  Inspect, seed, or modify keys in `BOT_KV` and immediately test the effect in the Telegram simulator.
                </p>
              </div>

              {/* Interactive Filter Controls */}
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                {[
                  { id: 'all', label: 'All Keys' },
                  { id: 'vouch:', label: 'Stock (vouch:)' },
                  { id: 'claimed:', label: 'Claimed (claimed:)' },
                  { id: 'state:', label: 'Admin State (state:)' },
                  { id: 'config:', label: 'Config (config:)' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setKvFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      kvFilter === tab.id
                        ? 'bg-amber-400 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Add / Put Custom Key Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newKvKey.trim() || !kvRef.current) return;
                void kvRef.current.put(newKvKey.trim(), newKvVal);
                setNewKvKey('');
                setNewKvVal('');
              }}
              className="bg-[#111827] border border-slate-800 rounded-xl p-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-end"
            >
              <div className="md:col-span-4 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  KV Key (e.g. `vouch:1729800099000` or `config:support`)
                </label>
                <input
                  type="text"
                  value={newKvKey}
                  onChange={(e) => setNewKvKey(e.target.value)}
                  placeholder="vouch:1729800099000"
                  className="w-full bg-slate-900 text-xs font-mono text-white px-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div className="md:col-span-6 space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  KV Value (String or JSON payload)
                </label>
                <input
                  type="text"
                  value={newKvVal}
                  onChange={(e) => setNewKvVal(e.target.value)}
                  placeholder='{"title":"₹250 Bonus","code":"BONUS250","instructions":"Redeem in app"}'
                  className="w-full bg-slate-900 text-xs font-mono text-white px-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="w-full py-2 px-4 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs rounded-lg transition-colors cursor-pointer"
                >
                  PUT Key
                </button>
              </div>
            </form>

            {/* KV Entries Table */}
            <div className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900/60">
                    <th className="py-3 px-4 font-medium w-64">Key Name</th>
                    <th className="py-3 px-4 font-medium">Stored Value (JSON / String)</th>
                    <th className="py-3 px-4 font-medium text-right w-28">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 text-xs font-mono">
                  {filteredKvEntries.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-slate-500 font-sans">
                        No keys matching filter `{kvFilter}` in `BOT_KV`.
                      </td>
                    </tr>
                  ) : (
                    filteredKvEntries.map(([k, v]) => (
                      <tr key={k} className="hover:bg-slate-900/40">
                        <td className="py-3 px-4 text-amber-300 font-semibold align-top">
                          {k}
                        </td>
                        <td className="py-3 px-4 text-slate-300 break-all align-top">
                          {v}
                        </td>
                        <td className="py-3 px-4 text-right align-top">
                          <button
                            onClick={() => kvRef.current?.deleteDirect(k)}
                            className="px-2.5 py-1 rounded bg-red-950/60 hover:bg-red-900/80 text-red-300 border border-red-800/60 transition-colors cursor-pointer"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: DEPLOYMENT GUIDE */}
        {activeTab === 'deploy' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 space-y-5">
              <section className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-4">
                <h2 className="text-base font-bold text-white">
                  01. Deploy with Cloudflare Wrangler CLI
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Save the single-file code as <code className="text-amber-300">worker.js</code> and configure your <code className="text-amber-300">BOT_KV</code> namespace and secrets using the commands below:
                </p>

                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
{`# 1. Create the Cloudflare KV Namespace
npx wrangler kv namespace create BOT_KV

# 2. Add the returned KV Namespace ID into wrangler.toml, then set secrets:
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_ID

# 3. Deploy the Worker to Cloudflare's Edge network
npx wrangler deploy

# 4. Register your Telegram Webhook automatically by visiting:
# https://telegram-voucher-bot.<your-subdomain>.workers.dev/setWebhook`}
                </pre>
              </section>

              <section className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-white">
                    02. Ready-to-Use `wrangler.toml`
                  </h2>
                  <button
                    onClick={handleCopyWrangler}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-md border border-slate-700 cursor-pointer"
                  >
                    {copiedWrangler ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedWrangler ? 'Copied' : 'Copy wrangler.toml'}
                  </button>
                </div>
                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
                  {WRANGLER_TOML_SOURCE}
                </pre>
              </section>
            </div>

            <div className="lg:col-span-5 space-y-5">
              <section className="bg-[#111827] border border-slate-800 rounded-xl p-6 space-y-4">
                <h2 className="text-base font-bold text-white">
                  03. Architecture &amp; Requirement Checklist
                </h2>
                <ul className="space-y-3 text-xs text-slate-300 leading-relaxed">
                  <li className="pb-3 border-b border-slate-800/80">
                    <strong className="text-white block">1. Platform &amp; Environment</strong>
                    Exports <code className="text-amber-300">async fetch(request, env, ctx)</code> using <code className="text-amber-300">env.BOT_KV</code>, <code className="text-amber-300">env.BOT_TOKEN</code>, and <code className="text-amber-300">env.ADMIN_ID</code> with zero external packages.
                  </li>
                  <li className="pb-3 border-b border-slate-800/80">
                    <strong className="text-white block">2. Bottom ReplyKeyboardMarkup Navigation</strong>
                    All user and admin menus use <code className="text-amber-300">reply_markup.keyboard</code> with <code className="text-amber-300">resize_keyboard: true</code>. Only the Force Channel Join gate uses an inline keyboard.
                  </li>
                  <li className="pb-3 border-b border-slate-800/80">
                    <strong className="text-white block">3. Role-Based Toggle Menus</strong>
                    Checks <code className="text-amber-300">checkIsAdmin(userId, env)</code> on <code className="text-amber-300">/start</code>. Admins get the extra <code className="text-amber-300">🛠 Admin Panel</code> button and can toggle seamlessly between the Admin Control Center and User Menu.
                  </li>
                  <li className="pb-3 border-b border-slate-800/80">
                    <strong className="text-white block">4. Multi-Step Admin State Machine in BOT_KV</strong>
                    Interactive flows for <code className="text-amber-300">➕ Add Force Channel</code>, <code className="text-amber-300">👤 Add Admin</code>, <code className="text-amber-300">💬 Set Support</code>, and 3-step <code className="text-amber-300">🎟 Add Voucher</code> stored under <code className="text-amber-300">vouch:&lt;timestamp&gt;</code>, with universal <code className="text-amber-300">❌ Cancel</code> support.
                  </li>
                  <li className="pb-3 border-b border-slate-800/80">
                    <strong className="text-white block">5. FIFO User Voucher Claim Flow</strong>
                    Verifies <code className="text-amber-300">claimed:&lt;userId&gt;</code> first. If unclaimed, selects the oldest <code className="text-amber-300">vouch:&lt;timestamp&gt;</code> key, assigns it to <code className="text-amber-300">claimed:&lt;userId&gt;</code>, deletes it from stock, and formats Title, Code, and Redeem Process.
                  </li>
                  <li>
                    <strong className="text-white block">6. Force Channel Join Verification</strong>
                    Calls Telegram <code className="text-amber-300">getChatMember</code> against <code className="text-amber-300">config:force_channel</code> in KV before menu or voucher access, falling back to open access when not yet configured.
                  </li>
                </ul>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
