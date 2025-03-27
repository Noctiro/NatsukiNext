import { html } from "@mtcute/bun";
import type { BotPlugin, CommandContext, MessageEventContext } from "../features";
import { log } from "../log";
import { generateRandomUserAgent } from "../utils/UserAgent";

/**
 * 特殊平台URL处理规则
 * 针对不同平台的特殊处理逻辑
 */
interface SpecialUrlRule {
    name: string;            // 平台名称
    pattern: RegExp;         // 匹配模式
    description: string;     // 规则描述
    needsSpecialHandling: boolean; // 是否需要特殊处理（不能简单移除参数）
    transform: (url: string, match: RegExpMatchArray | null) => string; // 转换函数
}

/**
 * 平台处理规则
 * 按平台类型分组，支持特殊处理和通用处理
 */
const platformRules: SpecialUrlRule[] = [
    // YouTube 系列 - 需要特殊处理，因为参数中包含视频ID
    {
        name: "YouTube短链接",
        pattern: /https?:\/\/youtu\.be\/([\w-]+)(?:\?.*)?/,
        description: "将YouTube短链接转换为标准格式",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "YouTube标准链接",
        pattern: /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]+)(?:&.*)?/,
        description: "保留YouTube视频ID，移除跟踪参数",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                // 如果已经是标准格式（只有v参数），则不再转换
                const parsedUrl = new URL(url);
                if (parsedUrl.searchParams.size === 1 && parsedUrl.searchParams.has('v')) {
                    return url;
                }
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "YouTube Shorts",
        pattern: /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]+)(?:\?.*)?/,
        description: "将YouTube Shorts转换为标准视频格式",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return url;
        }
    },
    
    // Twitter/X - 需要适当保留参数
    {
        name: "Twitter/X",
        pattern: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(\w+)\/status\/(\d+)(?:\?.*)?/,
        description: "保留推文ID，移除跟踪参数",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://twitter.com/${match[1]}/status/${match[2]}`;
            }
            return url;
        }
    },
    
    // Instagram - 简化链接形式
    {
        name: "Instagram",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([\w-]+)(?:\?.*)?/,
        description: "统一Instagram内容格式，移除跟踪参数",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.instagram.com/p/${match[1]}`;
            }
            return url;
        }
    },
    
    // Facebook - 提取视频ID
    {
        name: "Facebook视频",
        pattern: /https?:\/\/(?:www\.)?facebook\.com\/(?:watch\/\?v=|[\w.]+\/videos\/)(\d+)(?:\?.*)?/,
        description: "统一Facebook视频格式，移除跟踪参数",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.facebook.com/watch/?v=${match[1]}`;
            }
            return url;
        }
    },
    
    // 通用短链接平台 - 这些平台不需要特殊处理，只需解析为原始URL后清理参数
    {
        name: "哔哩哔哩短链接",
        pattern: /https?:\/\/b23\.tv\/[\w-]+/g,
        description: "解析哔哩哔哩短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url // 使用通用处理逻辑
    },
    {
        name: "小红书",
        pattern: /https?:\/\/xhslink\.com\/[\w-]+/g,
        description: "解析小红书链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "微博",
        pattern: /https?:\/\/t\.cn\/[\w-]+/g,
        description: "解析微博短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "抖音",
        pattern: /https?:\/\/v\.douyin\.com\/[\w-]+/g,
        description: "解析抖音短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "快手",
        pattern: /https?:\/\/v\.kuaishou\.com\/[\w-]+/g,
        description: "解析快手短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "知乎",
        pattern: /https?:\/\/link\.zhihu\.com\/\?[\w&=]+/g,
        description: "解析知乎链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "京东",
        pattern: /https?:\/\/u\.jd\.com\/[\w-]+/g,
        description: "解析京东短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "淘宝",
        pattern: /https?:\/\/m\.tb\.cn\/[\w-]+/g,
        description: "解析淘宝短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "亚马逊",
        pattern: /https?:\/\/amzn\.to\/[\w-]+/g,
        description: "解析亚马逊短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Bitly",
        pattern: /https?:\/\/bit\.ly\/[\w-]+/g,
        description: "解析Bitly短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "TinyURL",
        pattern: /https?:\/\/tinyurl\.com\/[\w-]+/g,
        description: "解析TinyURL短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Twitter短链接",
        pattern: /https?:\/\/t\.co\/[\w-]+/g,
        description: "解析Twitter短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Google短链接",
        pattern: /https?:\/\/goo\.gl\/[\w-]+/g,
        description: "解析Google短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Facebook短链接",
        pattern: /https?:\/\/fb\.me\/[\w-]+/g,
        description: "解析Facebook短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    }
];

// 构建用于识别所有支持平台链接的正则表达式
const allUrlPatternsRegex = new RegExp(
    platformRules.map(rule => 
        rule.pattern.source.replace(/^\/|\/g$/g, '')
    ).join('|'), 
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
    platformName?: string; // 可选，标识处理的平台
}

/**
 * 应用特殊平台规则
 * @param url 原始URL
 * @returns 处理后的URL和平台名称
 */
function applySpecialRules(url: string): { url: string, platformName?: string } {
    for (const rule of platformRules) {
        // 对于全局正则模式，需要重置lastIndex
        if (rule.pattern.global) {
            rule.pattern.lastIndex = 0;
        }
        
        const match = url.match(rule.pattern);
        if (match) {
            if (rule.needsSpecialHandling) {
                return { 
                    url: rule.transform(url, match),
                    platformName: rule.name 
                };
            } else {
                // 对于不需要特殊处理的平台，记录平台名但不修改URL
                return { 
                    url, 
                    platformName: rule.name 
                };
            }
        }
    }
    return { url };
}

/**
 * 清理URL函数 - 移除所有参数，提供最大隐私保护
 * @param url 原始URL
 * @returns 清理后的URL和平台信息
 */
function cleanUrl(url: string): { url: string, platformName?: string } {
    try {
        // 先应用特殊规则
        const { url: specialProcessed, platformName } = applySpecialRules(url);
        
        // 如果是需要特殊处理的平台且已处理，则直接返回
        const matchedRule = platformRules.find(rule => rule.name === platformName);
        if (matchedRule?.needsSpecialHandling && specialProcessed !== url) {
            return { url: specialProcessed, platformName };
        }
        
        // 通用处理：移除URL参数
        const parsedUrl = new URL(url);
        const cleanedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
        
        return { url: cleanedUrl, platformName };
    } catch (error) {
        log.error(`清理URL出错: ${error}`);
        return { url }; // 出错时返回原始URL
    }
}

/**
 * 解析短链接为原始URL
 * @param shortUrl 短链接
 * @returns 解析后的URL和平台信息
 */
async function resolveUrl(shortUrl: string): Promise<{ url: string, platformName?: string }> {
    // 检查是否已经是标准YouTube链接格式
    if (shortUrl.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+$/)) {
        return { url: shortUrl, platformName: "YouTube标准链接" };
    }
    
    // 先检查是否为需要特殊处理的平台链接
    const { url: specialHandled, platformName: specialPlatform } = applySpecialRules(shortUrl);
    if (specialHandled !== shortUrl) {
        return { url: specialHandled, platformName: specialPlatform };
    }

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
        
        // 清理URL
        return cleanUrl(finalUrl);
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            log.warn(`解析URL超时 ${shortUrl}`);
        } else {
            log.error(`解析URL失败 ${shortUrl}: ${error}`);
        }
        
        // 解析失败时，尝试应用特殊规则
        const { url, platformName } = applySpecialRules(shortUrl);
        if (url !== shortUrl) {
            return { url, platformName };
        }
        
        return { url: shortUrl }; // 所有处理都失败时返回原始URL
    }
}

/**
 * 处理消息中的所有短链接
 * @param messageText 消息文本
 * @returns 处理结果
 */
async function processLinksInMessage(messageText: string): Promise<{
    text: string,
    foundLinks: boolean,
    usedSpecialRules: boolean
}> {
    // 为当前消息创建临时缓存
    const localCache = new Map<string, { url: string, platformName?: string }>();
    let usedSpecialRules = false;

    let text = messageText;
    const uniqueLinks = new Set<string>();
    const atPrefixedLinks = new Map<string, string>(); // 用于存储带@前缀的链接及其原始形式

    // 处理带@符号的特殊格式链接 (例如: @https://youtu.be/phZPdNfIzsQ?si=oV6Gr0JdmbnSEzrC)
    const atSignLinkPattern = /@(https?:\/\/\S+)/g;
    let atSignMatch;
    while ((atSignMatch = atSignLinkPattern.exec(text)) !== null) {
        if (atSignMatch && atSignMatch[1]) {
            const originalAtLink = atSignMatch[0]; // 完整匹配，包括@符号
            const actualLink = atSignMatch[1];    // 不包括@符号的URL部分
            uniqueLinks.add(actualLink);
            atPrefixedLinks.set(actualLink, originalAtLink);
        }
    }

    // 使用合并的正则表达式进行单次扫描，找出所有可能的链接
    const matches = text.match(allUrlPatternsRegex);
    if (matches && matches.length > 0) {
        matches.forEach(link => uniqueLinks.add(link));
    }

    // 如果没有找到任何链接，直接返回原始文本
    if (uniqueLinks.size === 0) {
        return { text, foundLinks: false, usedSpecialRules };
    }

    // 转换为数组以便处理
    const links = Array.from(uniqueLinks);

    // 使用 Promise.allSettled 以确保即使部分链接解析失败，其他链接仍能处理
    const resolveResults = await Promise.allSettled(
        links.map(async (link) => {
            try {
                // 检查本地缓存
                if (localCache.has(link)) {
                    const cached = localCache.get(link)!;
                    return { 
                        original: link, 
                        originalWithAt: atPrefixedLinks.get(link),  // 保存带@前缀的原始形式
                        resolved: cached.url,
                        platformName: cached.platformName
                    };
                }

                // 检查YouTube标准链接，避免不必要的转换
                if (link.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+$/)) {
                    return {
                        original: link,
                        originalWithAt: atPrefixedLinks.get(link),
                        resolved: link,  // 保持不变
                        platformName: "YouTube标准链接"
                    };
                }

                // 解析链接
                const { url: resolved, platformName } = await resolveUrl(link);

                // 添加到本地缓存
                localCache.set(link, { url: resolved, platformName });

                return { 
                    original: link,
                    originalWithAt: atPrefixedLinks.get(link),
                    resolved,
                    platformName
                };
            } catch (error) {
                log.error(`处理链接失败 ${link}: ${error}`);
                return { original: link, originalWithAt: atPrefixedLinks.get(link), resolved: link };
            }
        })
    );

    // 提取成功的结果
    const replacements = resolveResults
        .filter((result): result is PromiseFulfilledResult<any> =>
            result.status === 'fulfilled')
        .map(result => result.value);

    // 检查是否使用了特殊规则
    usedSpecialRules = replacements.some(item => {
        if (!item.platformName) return false;
        const rule = platformRules.find(r => r.name === item.platformName);
        return rule?.needsSpecialHandling === true;
    });

    // 对替换项进行排序（长的先替换，避免子字符串问题）
    replacements.sort((a, b) => b.original.length - a.original.length);

    // 应用所有替换
    for (const { original, originalWithAt, resolved } of replacements) {
        // 只有当解析的URL和原始URL不同时才替换
        if (original !== resolved) {
            // 如果是带@的链接，则替换完整形式
            if (originalWithAt) {
                const atEscaped = originalWithAt.replace(regexEscapePattern, '\\$&');
                const atRegex = new RegExp(atEscaped, 'g');
                text = text.replace(atRegex, resolved);
            } else {
                // 使用正则表达式全局替换所有匹配实例
                const regex = new RegExp(original.replace(regexEscapePattern, '\\$&'), 'g');
                text = text.replace(regex, resolved);
            }
        } else if (originalWithAt) {
            // 如果链接没有变化但有@前缀，则保留原始链接但移除@前缀
            const atEscaped = originalWithAt.replace(regexEscapePattern, '\\$&');
            const atRegex = new RegExp(atEscaped, 'g');
            text = text.replace(atRegex, original);
        }
    }

    return { 
        text: text.trim(), 
        foundLinks: true,
        usedSpecialRules
    };
}

/**
 * 隐私插件主体
 */
const plugin: BotPlugin = {
    name: 'privacy',
    description: '防跟踪链接处理插件',
    version: '2.0.0',

    // 插件加载时执行
    async onLoad(client) {
        log.info(`隐私保护插件已加载，支持 ${platformRules.length} 个平台`);
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
                // 获取需要特殊处理的平台数量
                const specialPlatforms = platformRules.filter(rule => rule.needsSpecialHandling);
                
                await ctx.message.replyText(html`
                    🔒 <b>隐私保护插件状态</b><br>
<br>
- 版本: 2.0.0<br>
- 总支持平台: ${platformRules.length}<br>
- 特殊规则平台: ${specialPlatforms.length}<br>
- 活跃状态: ✅ 运行中
<br>
<b>特殊处理平台:</b> ${specialPlatforms.map(p => p.name).join(', ')}`);
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
                    const { text: processedText, foundLinks, usedSpecialRules } = 
                        await processLinksInMessage(messageText);

                    // 如果找到并解析了链接，则删除原消息并发送新消息
                    if (foundLinks && processedText !== messageText) {
                        // 格式化新消息
                        const senderName = ctx.message.sender.displayName || '用户';
                        
                        // 添加提示消息
                        const tipMessage = usedSpecialRules
                            ? '（已应用特殊规则转换和移除跟踪参数）' 
                            : '（已移除全部跟踪参数）';
                            
                        const content = `${senderName} 分享内容${tipMessage}:\n${processedText}`;

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