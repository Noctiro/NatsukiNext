import type { BotPlugin, CommandContext, MessageEventContext } from "../features";
import { log } from "../log";
import { generateRandomUserAgent } from "../utils/UserAgent";

/**
 * 增强的短链接正则表达式
 * 匹配常见的中文和国际平台短链接
 */
const shortLinkPatterns = {
    // 中文平台
    b23: /https?:\/\/b23\.tv\/[\w-]+/g,                    // 哔哩哔哩
    xhs: /https?:\/\/xhslink\.com\/[\w-]+/g,               // 小红书
    weibo: /https?:\/\/t\.cn\/[\w-]+/g,                    // 微博
    douyin: /https?:\/\/v\.douyin\.com\/[\w-]+/g,          // 抖音
    kuaishou: /https?:\/\/v\.kuaishou\.com\/[\w-]+/g,      // 快手
    zhihu: /https?:\/\/link\.zhihu\.com\/\?[\w&=]+/g,      // 知乎
    jd: /https?:\/\/u\.jd\.com\/[\w-]+/g,                  // 京东
    tb: /https?:\/\/m\.tb\.cn\/[\w-]+/g,                   // 淘宝

    // 国际平台
    youtu: /https?:\/\/youtu\.be\/[\w-]+/g,                // YouTube短链
    twitter: /https?:\/\/(t\.co|x\.com)\/[\w-]+/g,         // Twitter/X
    ig: /https?:\/\/instagram\.com\/p\/[\w-]+/g,           // Instagram
    bit: /https?:\/\/bit\.ly\/[\w-]+/g,                    // Bitly
    tinyurl: /https?:\/\/tinyurl\.com\/[\w-]+/g,           // TinyURL
    goo: /https?:\/\/goo\.gl\/[\w-]+/g,                    // Google短链
    amzn: /https?:\/\/amzn\.(to|com)\/[\w-]+/g,            // Amazon
    link: /https?:\/\/link\.in\/[\w-]+/g,                  // LinkedIn分享链接
    tiktok: /https?:\/\/vm\.tiktok\.com\/[\w-]+/g,         // TikTok
    fb: /https?:\/\/(fb\.me|on\.fb\.me)\/[\w-]+/g,         // Facebook
    spotify: /https?:\/\/open\.spotify\.com\/[\w-]+/g       // Spotify
};

// 合并所有正则表达式以进行单次扫描 - Bun 的正则引擎很高效
const combinedLinkPattern = new RegExp(
    Object.values(shortLinkPatterns)
        .map(pattern => pattern.source.replace(/^\/|\/g$/g, ''))
        .join('|'),
    'g'
);

// 预编译正则表达式转义函数所需的正则
const regexEscapePattern = /[.*+?^${}()|[\]\\]/g;

/**
 * URL处理结果
 */
interface UrlProcessingResult {
    original: string;
    resolved: string;
}

/**
 * 清理URL函数 - 移除所有参数，提供最大隐私保护
 * @param url 原始URL
 * @returns 清理后的URL
 */
function cleanUrl(url: string): string {
    try {
        const parsedUrl = new URL(url);

        // 直接返回不带任何参数的URL
        return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    } catch (error) {
        log.error(`清理URL出错: ${error}`);
        return url; // 出错时返回原始URL
    }
}

/**
 * 解析短链接为原始URL
 * @param shortUrl 短链接
 * @returns 解析后的URL
 */
async function resolveUrl(shortUrl: string): Promise<string> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

        // 使用随机UA避免被封禁
        const response = await fetch(shortUrl, {
            method: 'GET',
            headers: {
                'User-Agent': generateRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': 'https://www.google.com/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site'
            },
            redirect: 'follow',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // 获取最终URL
        const finalUrl = response.url || shortUrl;

        // 清理URL并返回结果
        return cleanUrl(finalUrl);
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            log.warn(`解析URL超时 ${shortUrl}`);
        } else {
            log.error(`解析URL失败 ${shortUrl}: ${error}`);
        }
        return shortUrl; // 解析失败时返回原始URL
    }
}

/**
 * 处理消息中的所有短链接
 * @param messageText 消息文本
 * @returns 处理结果
 */
async function processLinksInMessage(messageText: string): Promise<{
    text: string,
    foundLinks: boolean
}> {
    // 为当前消息创建临时缓存
    const localCache = new Map<string, string>();

    let text = messageText;
    const uniqueLinks = new Set<string>();

    // 使用合并的正则表达式进行单次扫描，找出所有可能的链接
    const matches = text.match(combinedLinkPattern);
    if (!matches || matches.length === 0) {
        return { text, foundLinks: false };
    }

    // 收集所有唯一链接
    matches.forEach(link => uniqueLinks.add(link));

    // 转换为数组以便处理
    const links = Array.from(uniqueLinks);

    // 使用 Promise.allSettled 以确保即使部分链接解析失败，其他链接仍能处理
    const resolveResults = await Promise.allSettled(
        links.map(async (link) => {
            try {
                // 检查本地缓存
                if (localCache.has(link)) {
                    return { original: link, resolved: localCache.get(link)! };
                }

                // 解析链接
                const resolved = await resolveUrl(link);

                // 添加到本地缓存
                localCache.set(link, resolved);

                return { original: link, resolved };
            } catch (error) {
                log.error(`处理链接失败 ${link}: ${error}`);
                return { original: link, resolved: link };
            }
        })
    );

    // 提取成功的结果
    const replacements = resolveResults
        .filter((result): result is PromiseFulfilledResult<UrlProcessingResult> =>
            result.status === 'fulfilled')
        .map(result => result.value);

    // 对替换项进行排序（长的先替换，避免子字符串问题）
    replacements.sort((a, b) => b.original.length - a.original.length);

    // 应用所有替换
    for (const { original, resolved } of replacements) {
        // 只有当解析的URL和原始URL不同时才替换
        if (original !== resolved) {
            // 使用正则表达式全局替换所有匹配实例
            const regex = new RegExp(original.replace(regexEscapePattern, '\\$&'), 'g');
            text = text.replace(regex, resolved);
        }
    }

    return { text: text.trim(), foundLinks: true };
}

/**
 * 隐私插件主体
 * 
 * 优化说明：
 * 1. 使用本地缓存避免单次消息中重复解析相同链接
 * 2. 合并正则表达式，使用单次扫描而非多次迭代
 * 3. 使用 Promise.allSettled 进行并行链接处理，提高性能
 * 4. 添加更好的错误处理和超时管理
 * 5. 优化正则表达式，提高匹配准确性
 */
const plugin: BotPlugin = {
    name: 'privacy',
    description: '防跟踪链接处理插件',
    version: '1.3.0',

    // 插件加载时执行
    async onLoad(client) {
        log.info('隐私保护插件已加载，开始监听跟踪链接');
    },

    // 插件卸载时执行
    async onUnload() {
        log.info('隐私保护插件已卸载');
    },

    // 注册命令
    commands: [
        {
            name: 'privacy',
            description: '隐私保护和防跟踪链接处理',
            aliases: ['antitrack', 'notrack'],

            async handler(ctx: CommandContext): Promise<void> {
                await ctx.message.replyText(`
                    🔒 **隐私保护插件状态**
                    
                    - 版本: 1.3.0
                    - 支持平台数量: ${Object.keys(shortLinkPatterns).length}
                    - 活跃状态: ✅ 运行中`);
            }
        }
    ],

    // 注册消息处理事件
    events: [
        {
            type: 'message',
            // 消息处理优先级较高
            priority: 80,

            // 仅处理文本消息
            filter: (ctx) => {
                if (ctx.type !== 'message') return false;
                return !!ctx.message.text;
            },

            // 消息处理函数
            async handler(ctx: MessageEventContext): Promise<void> {
                const messageText = ctx.message.text;
                if (!messageText) return;

                try {
                    // 处理消息中的所有链接
                    const { text: processedText, foundLinks } = await processLinksInMessage(messageText);

                    // 如果找到并解析了链接，则删除原消息并发送新消息
                    if (foundLinks && processedText !== messageText) {
                        // 格式化新消息
                        const senderName = ctx.message.sender.displayName || '用户';
                        const content = `${senderName} 分享内容（已移除全部跟踪参数）:\n${processedText}`;

                        // 发送新消息（如果存在回复消息则保持回复关系）
                        if (ctx.message.replyToMessage?.id) {
                            await ctx.message.replyText(content, {
                                replyTo: ctx.message.replyToMessage.id
                            });
                        } else {
                            await ctx.message.replyText(content);
                        }

                        // 删除原消息
                        try {
                            await ctx.message.delete();
                        } catch (error) {
                            log.error(`删除原消息失败: ${error}`);
                        }
                    }
                } catch (error) {
                    log.error(`处理消息错误: ${error}`);
                }
            }
        }
    ]
};

export default plugin; 