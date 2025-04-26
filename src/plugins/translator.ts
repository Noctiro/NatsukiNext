import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from "../features";
import { getFastAI } from "../ai/AiManager";
import { md } from "@mtcute/markdown-parser";
import { BotKeyboard, TelegramClient } from '@mtcute/bun';
import { CallbackDataBuilder } from "../utils/callback";

// ===== 配置项说明 =====
// DEFAULT_LANG: 翻译目标语言（Google 翻译的 tl 参数）
const DEFAULT_LANG = "zh_CN";

// STREAM: 流式翻译相关阈值
// chars: 每次更新最小字符差
// minLength: 启用流式翻译的文本最小长度
// intervalMs: 更新间隔最小毫秒数
const STREAM = { chars: 15, minLength: 50, intervalMs: 500 };

// SHORT: 简短消息排除规则
// length: 简短消息最大字符数
// words: 简短消息最大单词数
const SHORT = { length: 15, words: 3 };

// RETRY: Google 翻译重试配置
// times: 最大重试次数
// delay: 重试延迟（毫秒）
const RETRY = { times: 3, delay: 1000 };

// THR: 语言检测阈值
// text: 原始文本最小长度
// clean: 清理非语言字符后最小长度
// chinese: 中文字符比例阈值，超过不翻译
// foreign: 非中文字符比例阈值，超过考虑翻译
// dominance: 非中文主导比例阈值（>dominance）
// total: 中文+非中文总语言字符比例阈值
const THR = { text: 5, clean: 5, chinese: 0.4, foreign: 0.4, dominance: 0.5, total: 0.6 };

// AI翻译提示词
const DEFAULT_PROMPT = `请将以下文本翻译成简体中文，要求译文忠实、流畅、优雅（信达雅）。译文需以"翻译: "开头，仅在遇到明显的歧义或中文母语者大多都不知道的文化背景需要澄清时，另起一行以"补充: "进行简短明了的说明，在翻译措辞上等等不必要的内容不要进行补充。`;

// ===== 正则说明 =====
// URL_RE: 匹配 URL 或常见域名
const URL_RE = /(?:https?:\/\/|www\.)\S+|[\w-]+\.(?:com|org|net|io|gov|edu|info|me|app|dev|co|ai)\S*/gi;
// REMOVABLE_RE 使用 Unicode 分类 \p{P} (标点) 和 \p{S} (符号) 覆盖 Emoji
const REMOVABLE_RE = /[\s\d\p{P}\p{S}]/gu;
// SKIP_EXACT: 精确匹配无需翻译的短语或模式（邮箱、常见简短词）
const SKIP_EXACT = [
  /^[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}$/, // 邮箱地址
  /^(?:ok|yes|no|hi|hey|thanks|thx|ty)$/i    // 简短常见词
];
// LANG_RE: 匹配不同语言字符范围
const LANG_RE = {
  cn: /[\u4e00-\u9fa5]/g,
  nonCn: /[\u3040-\u30ff\uac00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0370-\u03FF\u0E00-\u0E7F\u0900-\u097F\u0590-\u05FF\u0530-\u058FA-Za-zÀ-ž]/g
};

// 回调构建器
const DelCB = new CallbackDataBuilder<{ initiator: number; original?: number }>('tr', 'del', ['initiator', 'original']);

// 清理文本
function cleanText(s: string): string {
  return s.replace(URL_RE, '').replace(REMOVABLE_RE, '');
}

// 判断是否需要翻译
function needsTranslation(s: string): boolean {
  if (s.length < THR.text) return false;
  const cleaned = cleanText(s);
  if (cleaned.length < THR.clean) return false;
  if (s.length <= SHORT.length) {
    if (s.trim().split(/\s+/).length <= SHORT.words) return false;
    if (SKIP_EXACT.some(r => r.test(s.trim()))) return false;
  }
  const total = cleaned.length;
  const cnCount = (cleaned.match(LANG_RE.cn) || []).length;
  const fnCount = (cleaned.match(LANG_RE.nonCn) || []).length;
  const cnRatio = cnCount / total;
  const fnRatio = fnCount / total;
  const totRatio = (cnCount + fnCount) / total;
  if (cnRatio >= THR.chinese) return false;
  if (fnRatio >= THR.foreign && (fnRatio >= THR.dominance || fnRatio > cnRatio * 2)) return true;
  if (fnRatio >= THR.foreign && totRatio >= THR.total) return true;
  return false;
}

// 前缀
const pfx = (t = ''): string => t.startsWith('翻译:') ? t : `翻译: ${t}`;

// Google 翻译
async function gTrans(txt: string): Promise<string> {
  if (!txt) return pfx('无文本');
  if (txt.length >= 5000) return pfx('文本过长，无法翻译');
  for (let i = 0; i < RETRY.times; i++) {
    try {
      const res = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${DEFAULT_LANG}&q=${encodeURIComponent(txt)}`
      );
      if (!res.ok) throw new Error(res.statusText);
      // 明确 JSON 类型为 any 并进行转换
      const data: any = await res.json();
      const first: any[] = Array.isArray(data[0]) ? data[0] : [];
      const result = first.map((d: any) => d[0]).join('');
      return pfx(result);
    } catch (e) {
      if (i === RETRY.times - 1) return pfx(`翻译失败: ${e}`);
      await new Promise(r => setTimeout(r, RETRY.delay));
    }
  }
  return pfx('服务不可用');
}

// AI 翻译
async function aiTrans(txt: string): Promise<string> {
  const ai = getFastAI();
  const out: string = await ai.get(`${DEFAULT_PROMPT}\n\n${txt}`);
  return pfx(out);
}

// 流式翻译
async function streamTrans(ctx: any, txt: string, orig = 0) {
  const wait = await ctx.message.replyText('正在翻译...');
  let prev = '', time = Date.now(), final = '';
  await getFastAI().stream((chunk: string, done: boolean) => {
    const nowTxt = pfx(chunk);
    if (done || (nowTxt.length - prev.length > STREAM.chars && Date.now() - time > STREAM.intervalMs)) {
      final = nowTxt;
      ctx.client
        .editMessage({ chatId: ctx.chatId, message: wait.id, text: done ? nowTxt : nowTxt + ' ...(翻译中)' })
        .catch(() => {});
      prev = nowTxt;
      time = Date.now();
    }
  }, `${DEFAULT_PROMPT}\n\n${txt}`);
  const kb = BotKeyboard.inline([
    [BotKeyboard.callback('🗑️ 删除', DelCB.build({ initiator: ctx.message.sender.id, original: orig }))]
  ]);
  ctx.client
    .editMessage({ chatId: ctx.chatId, message: wait.id, text: final, replyMarkup: kb })
    .catch(() => {});
}

// 管理员检测
async function isAdmin(client: TelegramClient, chatId: number, uid: number): Promise<boolean> {
  try {
    const m = await client.getChatMember({ chatId, userId: uid });
    if (!m) return false;
    return ['creator', 'administrator'].includes(m.status);
  } catch {
    return false;
  }
}

// 插件定义
const plugin: BotPlugin = {
  name: 'translator',
  description: '✨ 翻译助手 | 自动 & 命令',
  version: '1.3.1',
  commands: [
    {
      name: 'translate',
      aliases: ['tr'],
      cooldown: 3,
      description: '翻译文本或回复',
      handler: async (ctx: CommandContext) => {
        const replyMsg = await ctx.client.getReplyTo(ctx.message);

        const txt = ctx.content || replyMsg?.text || '';
        const orig = replyMsg?.id || 0;
        if (!txt.trim()) {
          ctx.message.replyText(
            md('✨ **翻译助手** ✨\n\n📝 **用法**：/tr [文本] 或回复消息'),
          );
          return;
        }
        if (txt.length > STREAM.minLength) return streamTrans(ctx, txt, orig);
        const wait = await ctx.message.replyText('正在翻译...');
        try {
          const res = await aiTrans(txt);
          await ctx.client.editMessage({
            chatId: ctx.chatId,
            message: wait.id,
            text: res,
            replyMarkup: BotKeyboard.inline([
              [BotKeyboard.callback('🗑️ 删除', DelCB.build({ initiator: ctx.message.sender.id, original: orig }))]
            ])
          });
        } catch {
          await ctx.message.replyText(await gTrans(txt));
        }
      }
    }
  ],
  events: [
    {
      type: 'message',
      filter: (ctx): ctx is MessageEventContext =>
        ctx.type === 'message' &&
        !!ctx.message.text &&
        !ctx.message.text.startsWith('/') &&
        needsTranslation(ctx.message.text!),
      handler: async ctx => {
        const txt = ctx.message.text!;
        if (txt.length > STREAM.minLength) return streamTrans(ctx, txt);
        try {
          const out = await aiTrans(txt);
          const kb = BotKeyboard.inline([
            [BotKeyboard.callback('🗑️ 删除', DelCB.build({ initiator: 0, original: ctx.message.sender.id }))]
          ]);
          await ctx.message.replyText(out, { replyMarkup: kb });
        } catch {
          await ctx.message.replyText(await gTrans(txt));
        }
      }
    },
    {
      type: 'callback',
      name: 'del',
      handler: async (ctx: CallbackEventContext) => {
        const { initiator, original = 0 } = ctx.match || {};
        const uid = ctx.query.user.id;
        const can =
          [initiator, original].includes(uid) ||
          (await ctx.hasPermission('admin')) ||
          (await isAdmin(ctx.client, ctx.chatId, uid));
        if (!can) return ctx.query.answer({ text: '无权限', alert: true });
        await ctx.client.deleteMessagesById(ctx.chatId, [ctx.query.messageId]);
        ctx.query.answer({ text: '已删除' });
      }
    }
  ]
};

export default plugin;
