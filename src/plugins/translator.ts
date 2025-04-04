import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from "../features";
import { getFastAI } from "../ai/AiManager";
import { md } from "@mtcute/markdown-parser";
import { BotKeyboard, TelegramClient } from '@mtcute/bun';
import { CallbackDataBuilder } from "../utils/callback";

// 常量定义
const DEFAULT_LANG = "zh_CN";
const STREAM_UPDATE_THRESHOLD = 15;    // 流式输出的字符更新阈值
const STREAM_MIN_LENGTH = 50;          // 启用流式输出的最小文本长度
const MIN_TEXT_LENGTH = 5;             // 最小可检测文本长度
const TRANSLATING_SUFFIX = " ...(翻译中)";
const CHINESE_THRESHOLD = 0.4;         // 中文字符比例阈值
const UPDATE_INTERVAL_MS = 500;        // 流式更新最小间隔(ms)
const MAX_RETRY_COUNT = 3;             // 最大重试次数
const RETRY_DELAY_MS = 1000;           // 重试延迟(ms)

// 简短语句的阈值定义
const SHORT_MSG_MAX_LENGTH = 10;      // 简短消息的最大长度
const SHORT_MSG_MAX_WORDS = 3;         // 简短消息的最大单词数

// Define combined URL pattern globally for reuse
const COMBINED_URL_PATTERN = new RegExp(
    "https?:\\/\\/[^\\s]+|" +                // HTTP/HTTPS链接
    "www\\.[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+[^\\s]*|" + // www开头链接
    "[a-zA-Z0-9-]+\\.(com|org|net|io|gov|edu|info|me|app|dev|co|ai)[^\\s\\.,:]*|" + // 常见顶级域名
    "t\\.me\\/[a-zA-Z0-9_]+|" +             // Telegram链接
    "github\\.com\\/[^\\s]+|" +             // GitHub链接
    "youtube\\.com\\/[^\\s]+|youtu\\.be\\/[^\\s]+" // YouTube链接
    , "gi");

// 常见不需要翻译的短语或模式 (优化后，移除已被后续清理步骤覆盖的模式)
const SKIP_TRANSLATION_PATTERNS = [
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/i, // 电子邮件 (保留，快速排除)
    /^(ok|yes|no|hi|hey|thanks|thx|ty)$/i // 简单常见词 (保留，快速排除)
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
const DEFAULT_PROMPT = `请将以下文本翻译成简体中文，要求译文忠实、流畅、优雅（信达雅）。译文需以“翻译: ”开头，仅在遇到明显的歧义或文化背景需要澄清时，另起一行以“补充: ”进行说明。`;

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

// 添加通用字符定义 (用于分析，部分也用于移除)
const COMMON_PATTERNS = {
    digits: /[0-9]/g,                  // 阿拉伯数字
    punctuation: /[.,!?;:'"()\[\]{}]/g, // 基本标点符号
    mathSymbols: /[+\-*/%=<>]/g,       // 数学符号
    // 修改表情符号检测正则，使用更兼容的Unicode范围
    emoji: /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    whitespace: /\s/g,                 // 空白字符
    commonSymbols: /[@#$%^&*_~`|\\]/g,  // 常见特殊符号
    // 合并所有需要移除的模式
    removableChars: /[\s.,!?;:'"()\[\]{}0-9+\-*/%=<>@#$%^&*_~`|\\/\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu // 空格、标点、数字、数学、符号、Emoji
};

// --- Pre-compiled Regex for Optimization ---

// Combine all non-Chinese language patterns
const ALL_NON_CHINESE_LANG_SOURCES = Object.entries(LANGUAGE_RANGES)
    .filter(([key]) => key !== 'chinese')
    .map(([, regex]) => regex.source.replace(/\[|\]|\\|\//g, '')) // Get source, remove brackets/slashes
    .join('');
const COMBINED_NON_CHINESE_LANG_REGEX = new RegExp(`[${ALL_NON_CHINESE_LANG_SOURCES}]`, 'g');

// Combine all language patterns
const ALL_LANG_SOURCES = Object.values(LANGUAGE_RANGES)
    .map(regex => regex.source.replace(/\[|\]|\\|\//g, ''))
    .join('');
const COMBINED_ALL_LANG_REGEX = new RegExp(`[${ALL_LANG_SOURCES}]`, 'g');

// 翻译按钮回调数据前缀
const CALLBACK_PREFIX = 'tr';
const DELETE_CALLBACK_PREFIX = `${CALLBACK_PREFIX}:del`;

// 定义翻译相关回调数据构建器
// 使用新的工厂方法创建回调构建器，指定插件名和功能名
const DeleteTranslationCallback = new CallbackDataBuilder<{
    initiatorId: number;
    originalSenderId?: number;
}>('tr', 'del', ['initiatorId', 'originalSenderId']);

/**
 * 生成删除回调数据
 * @param initiatorId 翻译发起人ID
 * @param originalSenderId 原始消息发送者ID（如回复翻译时）
 */
function generateDeleteCallbackData(initiatorId: number, originalSenderId: number = 0): string {
    // 使用插件名:功能名:参数格式
    // 格式: tr:del:initiatorId:originalSenderId
    // 简化实现，确保参数值有效
    
    // 如果原始发送者与发起人相同，则不包含原始发送者ID
    if (!originalSenderId || originalSenderId === initiatorId) {
        return `tr:del:${initiatorId}`;
    }
    
    // 包含原始发送者ID
    return `tr:del:${initiatorId}:${originalSenderId}`;
}

/**
 * 移除文本中的非语言内容（URL、数字、符号、Emoji等）以进行语言分析
 */
function removeNonTranslatableContent(text: string): string {
    if (!text) return "";

    // 1. 移除URLs
    let cleaned = text.replace(COMBINED_URL_PATTERN, '');

    // 2. 移除数字、标点、符号、Emoji、空格等干扰语言分析的字符
    cleaned = cleaned.replace(COMMON_PATTERNS.removableChars, '');

    return cleaned;
}

/**
 * 判断文本是否需要翻译（非中文且不是通用内容）
 */
function isNotChinese(text: string): boolean {
    const originalText = text; // 保留原始文本用于某些检查

    // 排除太短或空消息 (基于原始文本)
    if (!originalText || originalText.length < MIN_TEXT_LENGTH) {
        plugin.logger?.debug(`原始消息太短，不翻译: "${originalText}"`);
        return false;
    }

    // 处理简短语句 (基于原始文本)
    if (originalText.length <= SHORT_MSG_MAX_LENGTH) {
        const wordCount = originalText.trim().split(/\s+/).length;
        if (wordCount <= SHORT_MSG_MAX_WORDS) {
            plugin.logger?.debug(`原始消息为简短语句 (${wordCount}个单词，${originalText.length}字符)，不翻译: "${originalText}"`);
            return false;
        }
    }

    // 检查是否匹配常见不翻译模式 (基于原始文本)
    for (const pattern of SKIP_TRANSLATION_PATTERNS) {
        if (pattern.test(originalText.trim())) {
            plugin.logger?.debug(`原始消息匹配不翻译模式，跳过翻译: "${originalText.substring(0, 15)}..."`);
            return false;
        }
    }

    // --- 从这里开始，使用清理后的文本进行分析 ---
    // removeNonTranslatableContent 会移除URL和其他干扰字符
    const cleanedText = removeNonTranslatableContent(originalText);
    const cleanedLength = cleanedText.length;

    // 如果清理后文本为空或太短，则不翻译
    const MIN_CLEANED_LENGTH = 5; // 清理后文本的最小长度要求 (Increased from 3)
    if (cleanedLength < MIN_CLEANED_LENGTH) {
        plugin.logger?.debug(`清理后文本太短 (${cleanedLength} < ${MIN_CLEANED_LENGTH})，不翻译. 原文: "${originalText.substring(0, 30)}..." 清理后: "${cleanedText}"`);
        return false;
    }
    plugin.logger?.debug(`原文长度: ${originalText.length}, 清理后长度: ${cleanedLength}. 清理后文本片段: "${cleanedText.substring(0, 30)}..."`);

    // 计算中文比例 (基于清理后文本)
    const chineseMatches = cleanedText.match(LANGUAGE_RANGES.chinese) || [];
    const chineseRatio = chineseMatches.length / cleanedLength;

    // 如果清理后文本中文比例高于阈值，不翻译
    if (chineseRatio >= CHINESE_THRESHOLD) {
        plugin.logger?.debug(`清理后文本中文比例 ${(chineseRatio * 100).toFixed(1)}% >= ${CHINESE_THRESHOLD * 100}%, 不翻译`);
        return false;
    }

    // --- Optimized Language Ratio Calculation (based on cleanedText) ---

    // Calculate Non-Chinese Language Ratio
    const otherLangMatches = cleanedText.match(COMBINED_NON_CHINESE_LANG_REGEX) || [];
    const foreignLangRatio = otherLangMatches.length / cleanedLength;

    // Calculate Total Language Ratio (All languages including Chinese)
    const totalLangMatches = cleanedText.match(COMBINED_ALL_LANG_REGEX) || [];
    const totalLangRatio = totalLangMatches.length / cleanedLength;

    // Decision Logic based on ratios

    // 1. Check if foreign language ratio is high enough
    const MIN_FOREIGN_RATIO_TO_TRANSLATE = 0.35; // Threshold for foreign language dominance
    if (foreignLangRatio >= MIN_FOREIGN_RATIO_TO_TRANSLATE) {
        plugin.logger?.debug(`清理后文本外语比例 ${(foreignLangRatio * 100).toFixed(1)}% >= ${MIN_FOREIGN_RATIO_TO_TRANSLATE * 100}%, 需要翻译`);
        return true;
    }

    // 2. Check if total language ratio is high enough (covers mixed languages)
    const MIN_TOTAL_LANG_RATIO = 0.5; // Threshold for overall language content
    if (totalLangRatio >= MIN_TOTAL_LANG_RATIO) {
        plugin.logger?.debug(`清理后文本总语言字符比例 ${(totalLangRatio * 100).toFixed(1)}% >= ${MIN_TOTAL_LANG_RATIO * 100}%, 需要翻译 (外语比例: ${(foreignLangRatio * 100).toFixed(1)}%)`);
        return true;
    }

    // If none of the conditions met, do not translate
    plugin.logger?.debug(`清理后文本不满足翻译条件: 中文比例 ${(chineseRatio * 100).toFixed(1)}%, 外语比例 ${(foreignLangRatio * 100).toFixed(1)}%, 总语言比例 ${(totalLangRatio * 100).toFixed(1)}%`);
    return false;
}

/**
 * 获取更准确的文本比较（去除标点、数字和常见字符）
 */
function getNormalizedText(text: string): string {
    return text
        .replace(/[\s.,!?;:'"()\[\]{}]/g, "")  // 去除标点和空格
        .replace(/\d+/g, "")                   // 去除数字
        .replace(/[+\-*/%=<>]/g, "")           // 去除数学符号
        .replace(/@#$%^&*_~`|\\]/g, "")        // 去除特殊符号
        .toLowerCase();                         // 转为小写
}

/**
 * 检查翻译结果是否与原文基本一致
 */
function isTranslationSimilarToOriginal(original: string, translation: string): boolean {
    if (!original || !translation) return false;

    // 提取纯翻译内容(去掉"翻译: "前缀)
    const pureTranslation = translation.replace(/^翻译:\s*/, "").trim();
    const originalText = original.trim();

    // 使用更准确的文本比较（去除标点、数字和常见字符）
    const normalizedOriginal = getNormalizedText(originalText);
    const normalizedTranslation = getNormalizedText(pureTranslation);

    // 短文本完全匹配
    if (normalizedOriginal === normalizedTranslation) {
        return true;
    }

    // 计算文本相似度 (基于包含关系和长度比例)
    if (normalizedOriginal.length > 0 && normalizedTranslation.length > 0) {
        // 检查包含关系
        const containsRelation = normalizedOriginal.includes(normalizedTranslation) || normalizedTranslation.includes(normalizedOriginal);

        if (containsRelation) {
            // 计算长度比例，防止一个短词包含在长句中被误判为相似
            const lengthRatio = Math.min(normalizedOriginal.length, normalizedTranslation.length) /
                Math.max(normalizedOriginal.length, normalizedTranslation.length);

            // 如果长度比例大于0.7，认为足够相似
            if (lengthRatio > 0.7) {
                return true;
            }

            // 处理短文本特例 (允许更宽松的包含关系)
            if (normalizedOriginal.length < 20 && normalizedTranslation.length < 20 && lengthRatio > 0.5) {
                return true;
            }
        }

        // 检测是否只有少量字母的区别（主要针对拉丁字母文本）
        if (normalizedOriginal.length > 5 && normalizedTranslation.length > 5) {
            // 提取拉丁字母
            const originalLetters = (normalizedOriginal.match(/[a-z]/g) || []).join("");
            const translationLetters = (normalizedTranslation.match(/[a-z]/g) || []).join("");

            if (originalLetters.length > 0 && translationLetters.length > 0) {
                // 如果字母部分非常相似，也认为是相似的
                if (originalLetters === translationLetters) {
                    return true;
                }

                // 计算字母部分的相似度
                const lettersSimilarity = Math.min(originalLetters.length, translationLetters.length) /
                    Math.max(originalLetters.length, translationLetters.length);

                if (lettersSimilarity > 0.9) {
                    return true;
                }
            }
        }
    }

    return false;
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
            plugin.logger?.warn(`Google翻译尝试${retryCount}/${MAX_RETRY_COUNT}次失败: ${error}`);

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
        // 确保提示词和文本拼接为一个有效字符串
        const promptText = prompt + "\n\n" + text;
        const result = await fastAI.get(promptText);
        return ensurePrefix(result);
    } catch (error) {
        plugin.logger?.error(`AI翻译失败: ${error}`);
        throw error;
    }
}

/**
 * 流式AI翻译
 */
async function streamTranslateWithAI(
    ctx: CommandContext | MessageEventContext,
    text: string,
    originalSenderId?: number
): Promise<void> {
    if (!text) {
        plugin.logger?.error('流式翻译收到空文本');
        await ctx.message.replyText('翻译失败: 文本为空');
        return;
    }

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
        // 确保提示词和文本拼接为一个有效字符串
        const promptText = DEFAULT_PROMPT + "\n\n" + text;

        // 增加类型注解，确保回调函数类型正确
        const updateCallback = (content: string, done: boolean) => {
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
                    }).catch(e => plugin.logger?.error(`更新翻译消息失败: ${e}`));

                    lastContent = displayContent;
                    lastUpdateTime = now;
                } catch (e) {
                    plugin.logger?.error(`更新消息异常: ${e}`);
                }
            }
        };

        // 调用流式请求
        await ai.stream(updateCallback, promptText);

        // 检查翻译结果是否与原文一致
        if (finalContent && isTranslationSimilarToOriginal(text, finalContent)) {
            plugin.logger?.debug(`流式翻译结果与原文基本一致，更新为提示信息`);

            // 更新最终消息为提示信息
            ctx.client.editMessage({
                chatId: ctx.chatId,
                message: waitMsg.id,
                text: "翻译结果与原文基本一致，无需翻译"
            }).catch(e => plugin.logger?.error(`更新最终翻译消息失败: ${e}`));

            return;
        }

        // 确保最终消息没有"翻译中"后缀
        if (finalContent) {
            // 获取发起人ID
            const initiatorId = ctx.message.sender.id;
            
            // 添加带有发起者和原始发送者信息的删除按钮
            // 确保originalSenderId有默认值，即使传入undefined也能正常工作
            const senderId = typeof originalSenderId === 'number' ? originalSenderId : 0;
            const callbackData = generateDeleteCallbackData(initiatorId, senderId);
            const keyboard = BotKeyboard.inline([
                [BotKeyboard.callback('🗑️ 删除', callbackData)]
            ]);
            
            ctx.client.editMessage({
                chatId: ctx.chatId,
                message: waitMsg.id,
                text: finalContent,
                replyMarkup: keyboard
            }).catch(e => plugin.logger?.error(`更新最终翻译消息失败: ${e}`));
        }
    } catch (error) {
        plugin.logger?.error(`流式AI翻译失败: ${error}`);
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

        // 检查翻译结果是否与原文一致
        if (isTranslationSimilarToOriginal(text, translatedText)) {
            plugin.logger?.debug(`翻译结果与原文基本一致，不发送翻译: "${translatedText.substring(0, 30)}..."`);
            return;
        }

        // 获取发起人ID和被翻译消息发送者ID
        // 自动翻译时，使用0作为机器人ID标识（表示系统自动触发）
        const initiatorId = 0; // 系统自动触发
        const originalSenderId = ctx.message.sender.id;
        
        // 添加带有发起者和原始发送者信息的删除按钮
        const callbackData = generateDeleteCallbackData(initiatorId, originalSenderId);
        const keyboard = BotKeyboard.inline([
            [BotKeyboard.callback('🗑️ 删除', callbackData)]
        ]);

        await ctx.message.replyText(translatedText, {
            replyMarkup: keyboard
        });
    } catch (error) {
        plugin.logger?.warn(`AI翻译失败，切换到Google翻译: ${error}`);
        try {
            const translatedText = await translateWithGoogle(text);

            // 同样检查Google翻译结果是否与原文一致
            if (isTranslationSimilarToOriginal(text, translatedText)) {
                plugin.logger?.debug(`Google翻译结果与原文基本一致，不发送翻译: "${translatedText.substring(0, 30)}..."`);
                return;
            }

            // 获取发起人ID和被翻译消息发送者ID
            // 自动翻译时，使用0作为机器人ID标识（表示系统自动触发）
            const initiatorId = 0; // 系统自动触发
            const originalSenderId = ctx.message.sender.id;
            
            // 添加带有发起者和原始发送者信息的删除按钮
            const callbackData = generateDeleteCallbackData(initiatorId, originalSenderId);
            const keyboard = BotKeyboard.inline([
                [BotKeyboard.callback('🗑️ 删除', callbackData)]
            ]);

            await ctx.message.replyText(translatedText, {
                replyMarkup: keyboard
            });
        } catch (e) {
            plugin.logger?.error(`所有翻译方式均失败: ${e}`);
            // 普通消息触发时不显示错误
        }
    }
}

/**
 * 命令触发的翻译函数（有等待消息和流式输出）
 */
async function commandTranslateText(ctx: CommandContext, text: string, originalSenderId?: number): Promise<void> {
    if (!text?.trim()) {
        await ctx.message.replyText('没有需要翻译的文本');
        return;
    }

    try {
        // 长文本使用流式输出
        if (text.length > STREAM_MIN_LENGTH) {
            await streamTranslateWithAI(ctx, text, originalSenderId);
            return;
        }

        // 短文本使用标准翻译
        try {
            const waitMsg = await ctx.message.replyText("正在翻译...");
            const translatedText = await translateWithAI(text);

            // 检查翻译结果是否与原文一致
            if (isTranslationSimilarToOriginal(text, translatedText)) {
                plugin.logger?.debug(`翻译命令结果与原文基本一致，返回提示信息`);

                if (waitMsg?.id) {
                    await ctx.message.client.editMessage({
                        chatId: ctx.chatId,
                        message: waitMsg.id,
                        text: "翻译结果与原文基本一致，无需翻译"
                    }).catch(e => plugin.logger?.error(`更新翻译消息失败: ${e}`));
                } else {
                    await ctx.message.replyText("翻译结果与原文基本一致，无需翻译");
                }
                return;
            }

            // 获取发起人ID(命令执行者)
            const initiatorId = ctx.message.sender.id;
            
            // 添加带有发起者和原始发送者信息的删除按钮
            // 确保originalSenderId有默认值
            const senderId = typeof originalSenderId === 'number' ? originalSenderId : 0;
            const callbackData = generateDeleteCallbackData(initiatorId, senderId);
            const keyboard = BotKeyboard.inline([
                [BotKeyboard.callback('🗑️ 删除', callbackData)]
            ]);

            if (waitMsg?.id) {
                // 优先尝试更新原消息
                await ctx.message.client.editMessage({
                    chatId: ctx.chatId,
                    message: waitMsg.id,
                    text: translatedText,
                    replyMarkup: keyboard
                }).catch(async e => {
                    plugin.logger?.error(`更新翻译消息失败: ${e}`);
                    // 失败时发送新消息
                    await ctx.message.replyText(translatedText, {
                        replyMarkup: keyboard
                    });
                });
            } else {
                await ctx.message.replyText(translatedText, {
                    replyMarkup: keyboard
                });
            }
        } catch (aiError) {
            plugin.logger?.warn(`AI翻译失败，切换到Google翻译: ${aiError}`);
            const translatedText = await translateWithGoogle(text);

            // 检查Google翻译结果是否与原文一致
            if (isTranslationSimilarToOriginal(text, translatedText)) {
                plugin.logger?.debug(`Google翻译命令结果与原文基本一致，返回提示信息`);
                await ctx.message.replyText("翻译结果与原文基本一致，无需翻译");
                return;
            }

            // 获取发起人ID(命令执行者)
            const initiatorId = ctx.message.sender.id;
            
            // 添加带有发起者和原始发送者信息的删除按钮
            // 确保originalSenderId有默认值
            const senderId = typeof originalSenderId === 'number' ? originalSenderId : 0;
            const callbackData = generateDeleteCallbackData(initiatorId, senderId);
            const keyboard = BotKeyboard.inline([
                [BotKeyboard.callback('🗑️ 删除', callbackData)]
            ]);

            await ctx.message.replyText(translatedText, {
                replyMarkup: keyboard
            });
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        plugin.logger?.error(`翻译出错: ${errorMsg}`);
        await ctx.message.replyText(`❌ 翻译失败: ${errorMsg}`);
    }
}

/**
 * 从回复消息中获取待翻译文本
 */
async function getTextFromReply(ctx: CommandContext): Promise<{text: string | null, senderId?: number}> {
    if (!ctx.message.replyToMessage?.id) return {text: null};

    try {
        const msgId = ctx.message.replyToMessage.id;
        const replyMsg = await ctx.client.getMessages(ctx.chatId, [msgId]);

        if (!replyMsg?.[0]?.text) {
            await ctx.message.replyText('⚠️ 只能翻译文本消息');
            return {text: null};
        }

        const text = replyMsg[0].text;
        const senderId = replyMsg[0].sender.id;
        
        plugin.logger?.debug(`从回复消息获取文本: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`);
        return {text, senderId};
    } catch (err) {
        plugin.logger?.error(`获取回复消息失败: ${err}`);
        return {text: null};
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
        const {text: textFromReply, senderId} = await getTextFromReply(ctx);

        // 如果没有回复文本，使用命令参数
        if (!textFromReply) {
            if (!ctx.content) {
                await ctx.message.replyText('请提供要翻译的文本或回复一条消息');
                return;
            }
            await commandTranslateText(ctx, ctx.content);
        } else {
            // 使用回复的文本和发送者ID
            await commandTranslateText(ctx, textFromReply, senderId);
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        plugin.logger?.error(`翻译命令处理错误: ${errorMsg}`);
        await ctx.message.replyText(`❌ 翻译失败: ${errorMsg}`);
    }
}

/**
 * 处理删除翻译消息回调
 */
async function handleDeleteCallback(ctx: CallbackEventContext): Promise<void> {
    try {
        // 获取回调数据，使用类型断言明确数据结构
        const data = ctx.match || {};
        
        // 获取参数
        const initiatorId = typeof data._param0 === 'number' ? data._param0 : 0;
        const originalSenderId = typeof data._param1 === 'number' ? data._param1 : 0;
        
        // 获取当前用户ID
        const currentUserId = ctx.query.user.id;
        
        // 检查权限：允许 (1)发起人 (2)原始消息发送者 (3)管理员 删除消息
        const isInitiator = currentUserId === initiatorId;
        const isOriginalSender = originalSenderId > 0 && currentUserId === originalSenderId;
        const isAdmin = await ctx.hasPermission('admin') || 
                       await isGroupAdmin(ctx.client, ctx.chatId, currentUserId);
        
        if (!isInitiator && !isOriginalSender && !isAdmin) {
            await ctx.query.answer({
                text: '您没有权限删除此翻译消息',
                alert: true
            });
            return;
        }

        // 删除消息
        await ctx.client.deleteMessagesById(ctx.chatId, [ctx.query.messageId]);
        
        // 操作成功反馈
        await ctx.query.answer({
            text: '已删除翻译消息'
        });
    } catch (error) {
        // 记录错误并向用户反馈
        plugin.logger?.error(`删除翻译消息失败: ${error}`);
        await ctx.query.answer({
            text: '删除失败',
            alert: true
        });
    }
}

/**
 * 检查用户是否是群组管理员
 * @param client Telegram客户端实例
 * @param chatId 聊天ID
 * @param userId 用户ID
 * @returns 是否为管理员
 */
async function isGroupAdmin(client: TelegramClient, chatId: number, userId: number): Promise<boolean> {
    try {
        // 获取用户在群组中的身份
        const chatMember = await client.getChatMember({
            chatId,
            userId
        });
        
        // 如果无法获取成员信息，默认返回false
        if (!chatMember || !chatMember.status) return false;
        
        // 检查用户角色是否为管理员或创建者
        return ['creator', 'administrator'].includes(chatMember.status);
    } catch (error) {
        // 记录错误并返回false
        plugin.logger?.error(`检查管理员权限失败: ${error}`);
        return false;
    }
}

// 定义插件
const plugin: BotPlugin = {
    name: 'translator',
    description: '提供实时翻译功能，支持自动翻译非中文消息',
    version: '1.2.0',

    // 命令和事件会在后面定义
    commands: [
        {
            name: 'translate',
            description: '翻译文本 - 支持直接文本或回复消息',
            aliases: ['tr'],
            cooldown: 3,
            async handler(ctx: CommandContext) {
                await handleTranslateCommand(ctx);
            }
        }
    ],

    // 自动翻译非中文消息
    events: [
        {
            type: 'message',
            filter: (ctx) => {
                if (ctx.type !== 'message') return false;
                if (!ctx.message.text || ctx.message.text.length > 500) return false;
                const text = ctx.message.text;
                return isNotChinese(text);
            },
            async handler(ctx: MessageEventContext) {
                const text = ctx.message.text;
                if (!text) return;

                plugin.logger?.debug(`检测到非中文消息，自动翻译: ${text.substring(0, 20)}...`);
                await simpleTranslateText(ctx, text);
            }
        },
        {
            type: 'callback',
            // 使用name属性自动匹配插件名和功能名
            name: 'del',
            async handler(ctx: CallbackEventContext) {
                await handleDeleteCallback(ctx);
            }
        }
    ]
};

export default plugin;
