import type { BotPlugin, CommandContext, MessageEventContext } from "../features";
import { log } from "../log";
import { generateRandomUserAgent } from "../utils/UserAgent";

/**
 * 增强的短链接正则表达式
 * 匹配常见的中文和国际平台短链接
 */
const shortLinkPatterns = {
    // 中文平台
    b23: /https?:\/\/b23\.tv\/\w+/g,                    // 哔哩哔哩
    xhs: /https?:\/\/xhslink\.com\/[A-Za-z0-9]+/g,       // 小红书
    weibo: /https?:\/\/t\.cn\/\w+/g,                     // 微博
    douyin: /https?:\/\/v\.douyin\.com\/\w+/g,           // 抖音
    kuaishou: /https?:\/\/v\.kuaishou\.com\/\w+/g,       // 快手
    zhihu: /https?:\/\/link\.zhihu\.com\/\?\w+=\w+/g,    // 知乎
    jd: /https?:\/\/u\.jd\.com\/\w+/g,                   // 京东
    tb: /https?:\/\/m\.tb\.cn\/\w+/g,                    // 淘宝

    // 国际平台
    youtu: /https?:\/\/youtu\.be\/[A-Za-z0-9_-]+/g,      // YouTube短链
    twitter: /https?:\/\/(t\.co|x\.com)\/[A-Za-z0-9_-]+/g, // Twitter/X
    ig: /https?:\/\/instagram\.com\/p\/[A-Za-z0-9_-]+/g,  // Instagram
    bit: /https?:\/\/bit\.ly\/[A-Za-z0-9_-]+/g,          // Bitly
    tinyurl: /https?:\/\/tinyurl\.com\/[A-Za-z0-9_-]+/g, // TinyURL
    goo: /https?:\/\/goo\.gl\/[A-Za-z0-9_-]+/g,          // Google短链
    amzn: /https?:\/\/amzn\.(to|com)\/[A-Za-z0-9_-]+/g,  // Amazon
    link: /https?:\/\/link\.in\/[A-Za-z0-9_-]+/g,        // LinkedIn分享链接
    tiktok: /https?:\/\/vm\.tiktok\.com\/[A-Za-z0-9_-]+/g, // TikTok
    fb: /https?:\/\/(fb\.me|on\.fb\.me)\/[A-Za-z0-9_-]+/g, // Facebook
    spotify: /https?:\/\/open\.spotify\.com\/[A-Za-z0-9_-]+/g  // Spotify
};

/**
 * URL处理结果
 */
interface UrlProcessingResult {
    original: string;
    resolved: string;
}

// 简单转义MD文本中的特殊字符
function escapeMarkdownV2(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
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
        log.error(`解析URL失败 ${shortUrl}: ${error}`);
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
    let text = messageText;
    let foundLinks = false;
    const replacements: UrlProcessingResult[] = [];

    // 检查所有平台的短链接
    for (const [platform, pattern] of Object.entries(shortLinkPatterns)) {
        const matches = [...text.matchAll(pattern)];
        if (matches.length > 0) {
            foundLinks = true;

            // 收集所有链接以进行批量处理
            for (const linkMatch of matches) {
                const link = linkMatch[0];
                try {
                    replacements.push({
                        original: link,
                        resolved: await resolveUrl(link)
                    });
                } catch (error) {
                    log.error(`处理链接失败 ${link}: ${error}`);
                    replacements.push({
                        original: link,
                        resolved: link
                    });
                }
            }
        }
    }

    // 如果找到链接，则替换所有链接
    if (foundLinks && replacements.length > 0) {
        // 对替换项进行排序（长的先替换，避免子字符串问题）
        replacements.sort((a, b) => b.original.length - a.original.length);

        // 应用所有替换
        for (const { original, resolved } of replacements) {
            // 只有当解析的URL和原始URL不同时才替换
            if (original !== resolved) {
                text = text.replace(original, ` ${resolved} `);
            }
        }
    }

    return { text: text.trim(), foundLinks };
}

/**
 * 隐私插件主体
 */
const plugin: BotPlugin = {
    name: 'privacy',
    description: '防跟踪链接处理插件',
    version: '1.2.0',

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
                // 获取子命令
                const subCommand = ctx.args[0]?.toLowerCase();

                if (!subCommand || subCommand === 'help') {
                    await ctx.message.replyText(`
🔒 **隐私保护插件**

此插件会自动检测常见平台的短链接，解析为完整URL并移除所有URL参数。

支持的平台：
- 哔哩哔哩 (b23.tv)
- 小红书 (xhslink.com)
- 微博 (t.cn)
- 抖音 (v.douyin.com)
- 快手 (v.kuaishou.com)
- 知乎 (link.zhihu.com)
- 京东 (u.jd.com)
- 淘宝 (m.tb.cn)
- YouTube (youtu.be)
- Twitter/X (t.co, x.com)
- Instagram (instagram.com)
- TikTok (vm.tiktok.com)
- Facebook (fb.me)
- 等20多个平台

**命令：**
/privacy status - 查看插件状态
                    `);
                    return;
                }

                switch (subCommand) {
                    case 'status':
                        // 显示插件状态
                        await ctx.message.replyText(`
🔒 **隐私保护插件状态**

- 版本: 1.2.0
- 支持平台数量: ${Object.keys(shortLinkPatterns).length}
- 活跃状态: ✅ 运行中
                        `);
                        break;

                    default:
                        await ctx.message.replyText(`❌ 未知的子命令: ${subCommand}\n使用 /privacy help 查看帮助`);
                }
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