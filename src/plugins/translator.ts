import type { BotPlugin, CommandContext, MessageEventContext } from "../features";
import { log } from "../log";
import { getFastAI } from "../ai/AiManager";
import { md } from "@mtcute/markdown-parser";

// 常量定义
const DEFAULT_LANG = "zh_CN";
const STREAM_UPDATE_THRESHOLD = 15;    // 流式输出的字符更新阈值
const STREAM_MIN_LENGTH = 50;          // 启用流式输出的最小文本长度
const MIN_TEXT_LENGTH = 5;             // 最小可检测文本长度
const TRANSLATING_SUFFIX = " ...(翻译中)";
const CHINESE_THRESHOLD = 0.4;         // 中文字符比例阈值
const OTHER_LANG_THRESHOLD = 0.15;     // 其他语言字符比例阈值
const UPDATE_INTERVAL_MS = 500;        // 流式更新最小间隔(ms)
const MAX_RETRY_COUNT = 3;             // 最大重试次数
const RETRY_DELAY_MS = 1000;           // 重试延迟(ms)
// 新增通用字符占比阈值
const MAX_COMMON_CHAR_RATIO = 0.6;     // 通用字符最大比例阈值
const DIGITS_ONLY_THRESHOLD = 0.85;    // 纯数字消息阈值

// 简短语句的阈值定义
const SHORT_MSG_MAX_LENGTH = 15;       // 简短消息的最大长度
const SHORT_MSG_MAX_WORDS = 3;         // 简短消息的最大单词数

// 常见不需要翻译的短语或模式
const SKIP_TRANSLATION_PATTERNS = [
    /^[0-9\s.,+\-*/=]{3,}$/,          // 纯数学表达式
    /^https?:\/\//i,                   // URL链接
    /^[0-9]+(\.[0-9]+)?$/,             // 纯数字和小数
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/i, // 电子邮件
    /^#[0-9a-fA-F]{3,6}$/,            // 颜色代码
    /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/, // IP地址
    /^(ok|yes|no|hi|hey|thanks|thx|ty)$/i, // 简单常见词
    /^(\+[0-9]{1,2})?[0-9]{5,}$/      // 电话号码
];

// 常见简短的外语词汇或短语（不需要翻译）
const COMMON_SHORT_PHRASES = [
    /^(hello|hi|hey|bye|ok|okay|yes|no|thanks|thank you|sorry|please|excuse me)$/i,
    /^(good morning|good night|good afternoon|good evening)$/i,
    /^(lol|omg|wtf|btw|afk|brb|asap|imo|imho|fyi)$/i,
    /^(haha|hehe|wow|cool|nice|great|awesome|amazing|perfect|excellent)$/i
];

// 美化的帮助信息
const HELP_TEXT =
    '✨ **翻译助手** ✨\n\n' +
    '📝 **使用方式**\n' +
    '/tr [文本] - 翻译指定文本\n' +
    '/tr (回复消息) - 翻译被回复的消息\n\n' +
    '🌍 **支持语言**\n' +
    '英语、日语、韩语、俄语、法语、德语、西班牙语等\n\n' +
    '💡 发送非中文消息时会自动翻译';

// AI翻译提示词
const DEFAULT_PROMPT = `将以下文本翻译成简体中文，注重捕捉原文的含义和语气。

翻译规则:
1. 输出必须以"翻译: "开头
2. 提供准确、地道的中文翻译
3. 如果存在明显的歧义或需要补充的文化背景，请在翻译后另起一行，添加"补充: "说明

例如，如果原文是"She saw him with binoculars"，应输出:
翻译: 她用望远镜看见了他
补充: 此句可能有歧义，亦可理解为"她看见了带着望远镜的他"，需根据上下文判断

如无需补充说明，只需给出翻译即可。`;

// 类型定义
interface GoogleTranslateResponse {
    [0]: Array<[string, string]>;
}

// 语言字符范围定义
const LANGUAGE_RANGES = {
    chinese: /[\u4e00-\u9fa5]/g,       // 中文汉字
    japanese: /[\u3040-\u309f\u30a0-\u30ff]/g, // 日文(平假名、片假名)
    korean: /[\uac00-\ud7af\u1100-\u11ff]/g,   // 韩文
    cyrillic: /[\u0400-\u04FF]/g,      // 俄语西里尔字母
    arabic: /[\u0600-\u06ff]/g,        // 阿拉伯语
    greek: /[\u0370-\u03FF]/g,         // 希腊语
    thai: /[\u0E00-\u0E7F]/g,          // 泰语
    devanagari: /[\u0900-\u097F]/g,    // 印地语和梵语等
    hebrew: /[\u0590-\u05FF]/g,        // 希伯来语
    armenian: /[\u0530-\u058F]/g,      // 亚美尼亚语
    latinExt: /[À-ÿĀ-ž]/g,             // 拉丁语系扩展(法语、德语等)
    latin: /[a-zA-Z]/g                 // 基本拉丁字母(英语等)
};

// 添加通用字符定义
const COMMON_PATTERNS = {
    digits: /[0-9]/g,                  // 阿拉伯数字
    punctuation: /[.,!?;:'"()\[\]{}]/g, // 基本标点符号
    mathSymbols: /[+\-*/%=<>]/g,       // 数学符号
    // 修改表情符号检测正则，使用更兼容的Unicode范围
    emoji: /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    whitespace: /\s/g,                 // 空白字符
    commonSymbols: /[@#$%^&*_~`|\\]/g  // 常见特殊符号
};

/**
 * 判断文本是否需要翻译（非中文且不是通用内容）
 */
function isNotChinese(text: string): boolean {
    // 排除太短或空消息
    if (!text || text.length < MIN_TEXT_LENGTH) {
        log.debug(`消息太短，不翻译: "${text}"`);
        return false;
    }

    // 处理简短语句
    if (text.length <= SHORT_MSG_MAX_LENGTH) {
        // 计算单词数（粗略估计）
        const wordCount = text.trim().split(/\s+/).length;

        if (wordCount <= SHORT_MSG_MAX_WORDS) {
            log.debug(`简短语句 (${wordCount}个单词，${text.length}字符)，不翻译: "${text}"`);
            return false;
        }
    }

    // 检查是否匹配常见简短外语短语
    for (const pattern of COMMON_SHORT_PHRASES) {
        if (pattern.test(text.trim())) {
            log.debug(`匹配常见简短外语短语，不翻译: "${text}"`);
            return false;
        }
    }

    // 检查是否匹配常见不翻译模式
    for (const pattern of SKIP_TRANSLATION_PATTERNS) {
        if (pattern.test(text.trim())) {
            log.debug(`消息匹配不翻译模式，跳过翻译: "${text.substring(0, 15)}..."`);
            return false;
        }
    }

    // 计算中文比例
    const chineseMatches = text.match(LANGUAGE_RANGES.chinese) || [];
    const chineseRatio = chineseMatches.length / text.length;

    // 如果中文比例高于阈值，直接返回false（不需要翻译）
    if (chineseRatio >= CHINESE_THRESHOLD) {
        log.debug(`中文比例 ${(chineseRatio * 100).toFixed(1)}% 超过阈值，不翻译`);
        return false;
    }

    // 对于较短的消息，增加更严格的判断
    if (text.length < 30) {
        // 检查是否含有多个标点符号（可能是分隔的多个句子）
        const punctCount = (text.match(COMMON_PATTERNS.punctuation) || []).length;

        // 如果只有一个句子，且长度小于30，更倾向于不翻译
        if (punctCount <= 1) {
            log.debug(`短消息(${text.length}字符)只有一个简单句子，不翻译: "${text}"`);
            return false;
        }
    }

    // 计算通用字符比例（数字、标点、表情等）
    let commonCharCount = 0;
    const charAnalysis: Record<string, number> = {};

    for (const patternKey in COMMON_PATTERNS) {
        const pattern = COMMON_PATTERNS[patternKey as keyof typeof COMMON_PATTERNS];
        const matches = text.match(pattern) || [];
        commonCharCount += matches.length;
        charAnalysis[patternKey] = matches.length;
    }

    const commonCharRatio = commonCharCount / text.length;

    // 检测纯数字消息（例如：1234, 123.45）
    const digitsMatches = text.match(COMMON_PATTERNS.digits) || [];
    const punctMatches = text.match(COMMON_PATTERNS.punctuation) || [];
    const whitespaceMatches = text.match(COMMON_PATTERNS.whitespace) || [];
    const combinedCount = digitsMatches.length + punctMatches.length + whitespaceMatches.length;

    // 如果消息几乎只包含数字、小数点和空格，则不翻译
    if (combinedCount / text.length > DIGITS_ONLY_THRESHOLD) {
        log.debug(`检测到可能是数字格式/代码消息，不翻译: "${text.substring(0, 15)}..."`);
        return false;
    }

    // 如果通用字符占比过高，则不需要翻译
    if (commonCharRatio >= MAX_COMMON_CHAR_RATIO) {
        log.debug(`通用字符占比 ${(commonCharRatio * 100).toFixed(1)}% 过高，不翻译`);
        log.debug(`字符分析: ${JSON.stringify(charAnalysis)}`);
        return false;
    }

    // 检查其他语言特征
    let hasSignificantLanguage = false;
    let foreignLangRatio = 0;
    let detectedLang = '';

    for (const langKey in LANGUAGE_RANGES) {
        if (langKey === 'chinese') continue;

        const range = LANGUAGE_RANGES[langKey as keyof typeof LANGUAGE_RANGES];
        const matches = text.match(range) || [];
        const langRatio = matches.length / text.length;

        // 保存检测到的最主要外语
        if (langRatio > foreignLangRatio) {
            foreignLangRatio = langRatio;
            detectedLang = langKey;
        }

        if (langRatio > OTHER_LANG_THRESHOLD) {
            hasSignificantLanguage = true;
        }
    }

    // 对于主要语言占比较低的短文本，增加更严格的翻译判断
    if (hasSignificantLanguage && text.length < 25 && foreignLangRatio < 0.4) {
        log.debug(`短消息(${text.length}字符)外语占比较低(${(foreignLangRatio * 100).toFixed(1)}%)，不翻译`);
        return false;
    }

    if (hasSignificantLanguage) {
        log.debug(`检测到${detectedLang}文本，比例${(foreignLangRatio * 100).toFixed(1)}%，需要翻译`);
        return true;
    }

    // 检查是否有足够的非通用语言字符（避免纯数字、表情符号等）
    const allLangPatterns = Object.values(LANGUAGE_RANGES)
        .map(r => r.source.replace(/[\/g]/g, ''))
        .join('');
    const combinedRegex = new RegExp(`[${allLangPatterns}]`, 'g');
    const langMatches = text.match(combinedRegex) || [];
    const langRatio = langMatches.length / text.length;

    // 设置基础翻译阈值
    let langThreshold = 0.3;
    let commonThreshold = 0.55;

    // 根据消息长度动态调整阈值（短消息需要更严格的条件）
    if (text.length < 30) {
        langThreshold = 0.35;  // 更高的语言字符要求
        commonThreshold = 0.5; // 更低的通用字符容忍度
    }

    const shouldTranslate = langRatio > langThreshold && commonCharRatio < commonThreshold;

    if (shouldTranslate) {
        log.debug(`语言字符比例 ${(langRatio * 100).toFixed(1)}%，通用字符比例 ${(commonCharRatio * 100).toFixed(1)}%，需要翻译`);
    } else {
        log.debug(`不满足翻译条件：语言字符比例 ${(langRatio * 100).toFixed(1)}%，通用字符比例 ${(commonCharRatio * 100).toFixed(1)}%`);
    }

    return shouldTranslate;
}

/**
 * 确保翻译结果前缀统一
 */
function ensurePrefix(text: string): string {
    if (!text) return "翻译: ";
    return text.startsWith('翻译:') ? text : `翻译: ${text}`;
}

/**
 * 谷歌翻译API
 */
async function translateWithGoogle(text: string, targetLang: string = DEFAULT_LANG): Promise<string> {
    if (!text) return ensurePrefix("无文本");
    if (text.length >= 5000) return ensurePrefix("文本过长，无法翻译");

    let retryCount = 0;

    while (retryCount < MAX_RETRY_COUNT) {
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${targetLang}&q=${encodeURIComponent(text)}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`请求失败: ${response.status}`);
            }

            const data = await response.json() as GoogleTranslateResponse;
            if (!data?.[0]?.length) {
                throw new Error('无效的响应结构');
            }

            const translation = data[0]
                .map(item => item[0])
                .filter(Boolean)
                .join('');

            return ensurePrefix(translation);
        } catch (error) {
            retryCount++;
            log.warn(`Google翻译尝试${retryCount}/${MAX_RETRY_COUNT}次失败: ${error}`);

            if (retryCount < MAX_RETRY_COUNT) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            } else {
                return ensurePrefix(`翻译失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    return ensurePrefix("翻译服务暂不可用");
}

/**
 * AI模型翻译
 */
async function translateWithAI(text: string, prompt: string = DEFAULT_PROMPT): Promise<string> {
    if (!text) return ensurePrefix("无文本");

    try {
        const fastAI = getFastAI();
        const result = await fastAI.get(`${prompt}\n\n${text}`);
        return ensurePrefix(result);
    } catch (error) {
        log.error(`AI翻译失败: ${error}`);
        throw error;
    }
}

/**
 * 流式AI翻译
 */
async function streamTranslateWithAI(
    ctx: CommandContext | MessageEventContext,
    text: string
): Promise<void> {
    try {
        // 发送等待消息
        const waitMsg = await ctx.message.replyText("正在翻译...");
        if (!waitMsg?.id) {
            throw new Error("无法发送等待消息");
        }

        let lastContent = "";
        let lastUpdateTime = Date.now();
        let finalContent = "";

        const ai = getFastAI();

        await ai.stream(
            (content: string, done: boolean) => {
                const now = Date.now();

                // 格式处理
                const displayContent = ensurePrefix(content);
                const messageText = done ? displayContent : `${displayContent}${TRANSLATING_SUFFIX}`;

                // 仅在满足条件时更新消息
                const shouldUpdate = done || (
                    displayContent.length - lastContent.length > STREAM_UPDATE_THRESHOLD &&
                    now - lastUpdateTime > UPDATE_INTERVAL_MS
                );

                if (shouldUpdate) {
                    try {
                        finalContent = displayContent;
                        ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: waitMsg.id,
                            text: messageText
                        }).catch(e => log.error(`更新翻译消息失败: ${e}`));

                        lastContent = displayContent;
                        lastUpdateTime = now;
                    } catch (e) {
                        log.error(`更新消息异常: ${e}`);
                    }
                }
            },
            `${DEFAULT_PROMPT}\n\n${text}`
        );

        // 确保最终消息没有"翻译中"后缀
        if (finalContent) {
            ctx.client.editMessage({
                chatId: ctx.chatId,
                message: waitMsg.id,
                text: finalContent
            }).catch(e => log.error(`更新最终翻译消息失败: ${e}`));
        }
    } catch (error) {
        log.error(`流式AI翻译失败: ${error}`);
        await ctx.message.replyText(`翻译失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * 普通消息触发的简单翻译（无等待消息和流式输出）
 */
async function simpleTranslateText(ctx: MessageEventContext, text: string): Promise<void> {
    if (!text?.trim()) return;

    try {
        // 直接翻译，不显示等待消息
        const translatedText = await translateWithAI(text);
        await ctx.message.replyText(translatedText);
    } catch (error) {
        log.warn(`AI翻译失败，切换到Google翻译: ${error}`);
        try {
            const translatedText = await translateWithGoogle(text);
            await ctx.message.replyText(translatedText);
        } catch (e) {
            log.error(`所有翻译方式均失败: ${e}`);
            // 普通消息触发时不显示错误
        }
    }
}

/**
 * 命令触发的翻译函数（有等待消息和流式输出）
 */
async function commandTranslateText(ctx: CommandContext, text: string): Promise<void> {
    if (!text?.trim()) {
        await ctx.message.replyText('没有需要翻译的文本');
        return;
    }

    try {
        // 长文本使用流式输出
        if (text.length > STREAM_MIN_LENGTH) {
            await streamTranslateWithAI(ctx, text);
            return;
        }

        // 短文本使用标准翻译
        try {
            const waitMsg = await ctx.message.replyText("正在翻译...");
            const translatedText = await translateWithAI(text);

            if (waitMsg?.id) {
                // 优先尝试更新原消息
                await ctx.message.client.editMessage({
                    chatId: ctx.chatId,
                    message: waitMsg.id,
                    text: translatedText
                }).catch(async e => {
                    log.error(`更新翻译消息失败: ${e}`);
                    // 失败时发送新消息
                    await ctx.message.replyText(translatedText);
                });
            } else {
                await ctx.message.replyText(translatedText);
            }
        } catch (aiError) {
            log.warn(`AI翻译失败，切换到Google翻译: ${aiError}`);
            const translatedText = await translateWithGoogle(text);
            await ctx.message.replyText(translatedText);
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`翻译出错: ${errorMsg}`);
        await ctx.message.replyText(`❌ 翻译失败: ${errorMsg}`);
    }
}

/**
 * 从回复消息中获取待翻译文本
 */
async function getTextFromReply(ctx: CommandContext): Promise<string | null> {
    if (!ctx.message.replyToMessage?.id) return null;

    try {
        const msgId = ctx.message.replyToMessage.id;
        const replyMsg = await ctx.client.getMessages(ctx.chatId, [msgId]);

        if (!replyMsg?.[0]?.text) {
            await ctx.message.replyText('⚠️ 只能翻译文本消息');
            return null;
        }

        const text = replyMsg[0].text;
        log.debug(`从回复消息获取文本: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`);
        return text;
    } catch (err) {
        log.error(`获取回复消息失败: ${err}`);
        return null;
    }
}

/**
 * 处理翻译命令
 */
async function handleTranslateCommand(ctx: CommandContext): Promise<void> {
    // 没有参数时显示帮助
    if (!ctx.content && !ctx.message.replyToMessage) {
        await ctx.message.replyText(md(HELP_TEXT));
        return;
    }

    try {
        // 尝试从回复获取文本
        let textToTranslate = await getTextFromReply(ctx);

        // 如果没有回复文本，使用命令参数
        if (!textToTranslate) {
            if (!ctx.content) {
                await ctx.message.replyText('请提供要翻译的文本或回复一条消息');
                return;
            }
            textToTranslate = ctx.content;
        }

        await commandTranslateText(ctx, textToTranslate);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`翻译命令处理错误: ${errorMsg}`);
        await ctx.message.replyText(`❌ 翻译失败: ${errorMsg}`);
    }
}

// 定义插件
const plugin: BotPlugin = {
    name: 'translator',
    description: '提供多语言翻译功能',
    version: '1.0.2',

    // 自动翻译非中文消息
    events: [
        {
            type: 'message',
            filter: (ctx) => {
                if (ctx.type !== 'message') return false;
                if (ctx.message.text.length > 500) return false;
                const text = ctx.message.text;
                return !!text && isNotChinese(text);
            },
            handler: async (ctx: MessageEventContext) => {
                const text = ctx.message.text;
                if (!text) return;

                log.debug(`检测到非中文消息，自动翻译: ${text.substring(0, 20)}...`);
                await simpleTranslateText(ctx, text);
            }
        }
    ],

    // 翻译命令
    commands: [
        {
            name: 'translate',
            description: '翻译文本 - 支持直接文本或回复消息',
            aliases: ['tr'],
            cooldown: 3,
            async handler(ctx: CommandContext) {
                await handleTranslateCommand(ctx);
            }
        },
        {
            name: 'tr',
            description: '翻译命令的简写形式',
            cooldown: 3,
            async handler(ctx: CommandContext) {
                await handleTranslateCommand(ctx);
            }
        }
    ]
};

export default plugin; 