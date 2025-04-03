import { html } from "@mtcute/bun";
import type { BotPlugin, CommandContext, MessageEventContext } from "../features";
import { generateRandomUserAgent } from "../utils/UserAgent";

// 插件配置
const config = {
    debug: false,  // 默认禁用调试模式
    enableTLS: true, // 强制使用TLS
    textSeparator: '...'  // 用于显示的文本分隔符
};

// 调试日志助手函数
// 修改为使用插件专用日志器
function debugLog(message: string): void {
    if (config.debug) {
        plugin.logger?.debug(`[Privacy] ${message}`);
    }
}

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
    shouldTransform?: (url: string, match: RegExpMatchArray | null) => boolean; // 是否应该转换的条件函数
}

/**
 * 平台处理规则
 * 按平台类型分组，支持特殊处理和通用处理
 */
const platformRules: SpecialUrlRule[] = [
    // YouTube 系列 - 需要特殊处理，因为参数中包含视频ID
    {
        name: "YouTube短链接",
        pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(?:\?.*)?/,
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
        description: "保留YouTube视频ID和时间戳，移除跟踪参数",
        needsSpecialHandling: true,
        shouldTransform: (url, match) => {
            // 如果已经是标准格式（只有v参数或v和t参数），则不转换
            try {
                const parsedUrl = new URL(url);
                return !(
                    (parsedUrl.searchParams.size === 1 && parsedUrl.searchParams.has('v')) ||
                    (parsedUrl.searchParams.size === 2 && parsedUrl.searchParams.has('v') && parsedUrl.searchParams.has('t'))
                );
            } catch (e) {
                return true; // 解析失败时默认转换
            }
        },
        transform: (url, match) => {
            if (match && match[1]) {
                try {
                    const parsedUrl = new URL(url);
                    // 提取视频ID和时间戳
                    const videoId = match[1];
                    const timeParam = parsedUrl.searchParams.get('t');

                    // 构建新URL，保留必要参数
                    if (timeParam) {
                        return `https://www.youtube.com/watch?v=${videoId}&t=${timeParam}`;
                    } else {
                        return `https://www.youtube.com/watch?v=${videoId}`;
                    }
                } catch (e) {
                    // 解析URL失败，使用基本处理
                    // 尝试提取时间戳参数
                    const timeMatch = url.match(/[?&]t=([^&]+)/);
                    if (timeMatch && timeMatch[1]) {
                        return `https://www.youtube.com/watch?v=${match[1]}&t=${timeMatch[1]}`;
                    }
                    return `https://www.youtube.com/watch?v=${match[1]}`;
                }
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

    // 哔哩哔哩 - 需要保留时间戳参数，去除其他跟踪参数
    {
        name: "哔哩哔哩视频",
        pattern: /https?:\/\/(?:www\.)?bilibili\.com\/video\/(?:[Bb][Vv][\w-]+|[Aa][Vv]\d+)(?:\/?\?.*)?/i,
        description: "保留哔哩哔哩视频ID和时间戳，移除其他跟踪参数",
        needsSpecialHandling: true,
        shouldTransform: (url, match) => {
            try {
                const parsedUrl = new URL(url);
                // 如果没有参数或只有t参数或p参数，则不需要转换
                return !(parsedUrl.search === '' ||
                    (parsedUrl.searchParams.size === 1 && (parsedUrl.searchParams.has('t') || parsedUrl.searchParams.has('p'))));
            } catch (e) {
                return true; // 解析失败时默认转换
            }
        },
        transform: (url, match) => {
            if (match && match[0]) {
                try {
                    // 提取视频ID（BV号或av号）
                    const videoIdMatch = match[0].match(/\/video\/([Bb][Vv][\w-]+|[Aa][Vv]\d+)/i);
                    if (!videoIdMatch || !videoIdMatch[1]) return url;

                    // 标准化视频ID格式 (确保BV和av的大小写统一)
                    let videoId = videoIdMatch[1];
                    if (videoId.toLowerCase().startsWith('bv')) {
                        videoId = 'BV' + videoId.substring(2);
                    } else if (videoId.toLowerCase().startsWith('av')) {
                        videoId = 'av' + videoId.substring(2);
                    }

                    const parsedUrl = new URL(url);

                    // 提取需要保留的参数：时间戳t和分P参数p
                    const timeParam = parsedUrl.searchParams.get('t');
                    const partParam = parsedUrl.searchParams.get('p');

                    // 构建新URL，保留必要参数
                    const params = new URLSearchParams();
                    if (timeParam) params.append('t', timeParam);
                    if (partParam) params.append('p', partParam);

                    const paramString = params.toString();
                    if (paramString) {
                        return `https://www.bilibili.com/video/${videoId}?${paramString}`;
                    } else {
                        return `https://www.bilibili.com/video/${videoId}`;
                    }
                } catch (e) {
                    // 提取视频ID的备用方法
                    const idMatch = url.match(/\/video\/([Bb][Vv][\w-]+|[Aa][Vv]\d+)/i);
                    if (idMatch && idMatch[1]) {
                        // 标准化视频ID格式
                        let videoId = idMatch[1];
                        if (videoId.toLowerCase().startsWith('bv')) {
                            videoId = 'BV' + videoId.substring(2);
                        } else if (videoId.toLowerCase().startsWith('av')) {
                            videoId = 'av' + videoId.substring(2);
                        }

                        // 尝试提取需要保留的参数
                        const timeMatch = url.match(/[?&]t=([^&]+)/);
                        const partMatch = url.match(/[?&]p=([^&]+)/);

                        let paramParts = [];
                        if (timeMatch && timeMatch[1]) paramParts.push(`t=${timeMatch[1]}`);
                        if (partMatch && partMatch[1]) paramParts.push(`p=${partMatch[1]}`);

                        if (paramParts.length > 0) {
                            return `https://www.bilibili.com/video/${videoId}?${paramParts.join('&')}`;
                        }
                        return `https://www.bilibili.com/video/${videoId}`;
                    }
                    return url;
                }
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
        shouldTransform: (url, match) => {
            try {
                const parsedUrl = new URL(url);
                // 如果已经是干净URL（没有参数），则不转换
                return parsedUrl.search !== '';
            } catch (e) {
                return true; // 解析失败时默认转换
            }
        },
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://twitter.com/${match[1]}/status/${match[2]}`;
            }
            return url;
        }
    },

    // Instagram - 完整支持，包括多种内容格式
    {
        name: "Instagram帖子",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)(?:\?.*)?/,
        description: "清理Instagram帖子链接，移除igsh等跟踪参数",
        needsSpecialHandling: true,
        shouldTransform: (url) => {
            // 只要有查询参数就应该转换
            return url.includes('?');
        },
        transform: (url, match) => {
            if (match && match[1]) {
                // 提取帖子ID，移除所有查询参数
                return `https://www.instagram.com/p/${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "Instagram Reels",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/reel\/([\w-]+)(?:\?.*)?/,
        description: "统一Instagram Reels格式",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.instagram.com/reel/${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "Instagram Stories",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/stories\/([^\/]+)\/(\d+)(?:\?.*)?/,
        description: "清理Instagram Stories链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://www.instagram.com/stories/${match[1]}/${match[2]}`;
            }
            return url;
        }
    },

    // Facebook - 提取视频ID和帖子ID
    {
        name: "Facebook视频",
        pattern: /https?:\/\/(?:www\.)?facebook\.com\/(?:watch\/\?v=|[\w.]+\/videos\/)(\d+)(?:\?.*)?/,
        description: "统一Facebook视频格式，移除跟踪参数",
        needsSpecialHandling: true,
        shouldTransform: (url, match) => {
            try {
                const parsedUrl = new URL(url);
                // 如果已经是标准格式（只有v参数），则不转换
                if (url.includes('/watch/?v=')) {
                    return !(parsedUrl.searchParams.size === 1 && parsedUrl.searchParams.has('v'));
                }
                return true; // 其他格式都需要转换
            } catch (e) {
                return true; // 解析失败时默认转换
            }
        },
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.facebook.com/watch/?v=${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "Facebook帖子",
        pattern: /https?:\/\/(?:www\.)?facebook\.com\/(?:[\w.]+\/posts\/|permalink\.php\?story_fbid=)(\d+)(?:&|\?)?(?:.*)?/,
        description: "清理Facebook帖子链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                // 如果是permalink.php格式，需要处理特殊情况
                if (url.includes('permalink.php')) {
                    try {
                        const parsedUrl = new URL(url);
                        const id = parsedUrl.searchParams.get('id');
                        if (id) {
                            return `https://www.facebook.com/${id}/posts/${match[1]}`;
                        }
                    } catch (e) {
                        // 解析失败，使用默认处理
                    }
                }

                // 提取用户名或页面ID
                const userMatch = url.match(/facebook\.com\/([\w.]+)\/posts\//);
                if (userMatch && userMatch[1]) {
                    return `https://www.facebook.com/${userMatch[1]}/posts/${match[1]}`;
                }

                // 如果无法提取用户名，则使用原始URL
                return url;
            }
            return url;
        }
    },

    // TikTok 支持
    {
        name: "TikTok",
        pattern: /https?:\/\/(?:www\.)?tiktok\.com\/@([\w.]+)\/video\/(\d+)(?:\?.*)?/,
        description: "清理TikTok视频链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
            }
            return url;
        }
    },

    // Reddit 支持
    {
        name: "Reddit",
        pattern: /https?:\/\/(?:www\.)?reddit\.com\/r\/([^\/]+)\/comments\/([^\/]+)(?:\/[^\/]+)?(?:\/)?(?:\?.*)?/,
        description: "清理Reddit帖子链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}`;
            }
            return url;
        }
    },

    // LinkedIn 支持
    {
        name: "LinkedIn",
        pattern: /https?:\/\/(?:www\.)?linkedin\.com\/(?:posts|feed\/update)(?:\/|\?)(?:.*?)(?:activity:|id=)([\w-]+)(?:&.*)?/,
        description: "清理LinkedIn帖子链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.linkedin.com/feed/update/urn:li:activity:${match[1]}`;
            }
            return url;
        }
    },

    // Pinterest 支持
    {
        name: "Pinterest",
        pattern: /https?:\/\/(?:www\.)?pinterest\.(?:com|[a-z]{2})\/pin\/(\d+)(?:\?.*)?/,
        description: "清理Pinterest图钉链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.pinterest.com/pin/${match[1]}`;
            }
            return url;
        }
    },

    // Spotify 支持
    {
        name: "Spotify",
        pattern: /https?:\/\/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)(?:\?.*)?/,
        description: "清理Spotify链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1] && match[2]) {
                return `https://open.spotify.com/${match[1]}/${match[2]}`;
            }
            return url;
        }
    },

    // Medium 支持
    {
        name: "Medium",
        pattern: /https?:\/\/(?:www\.)?medium\.com\/(?:@?[^\/]+\/)?([^\/\?]+)(?:\?.*)?/,
        description: "清理Medium文章链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            try {
                const parsedUrl = new URL(url);
                const path = parsedUrl.pathname;
                return `https://medium.com${path}`;
            } catch (e) {
                return url;
            }
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
    },
    {
        name: "Instagram短链接",
        pattern: /https?:\/\/instagr\.am\/[\w-]+/g,
        description: "解析Instagram短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "TikTok短链接",
        pattern: /https?:\/\/vm\.tiktok\.com\/[\w-]+/g,
        description: "解析TikTok短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Spotify短链接",
        pattern: /https?:\/\/spoti\.fi\/[\w-]+/g,
        description: "解析Spotify短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "LinkedIn短链接",
        pattern: /https?:\/\/lnkd\.in\/[\w-]+/g,
        description: "解析LinkedIn短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Pinterest短链接",
        pattern: /https?:\/\/pin\.it\/[\w-]+/g,
        description: "解析Pinterest短链接并清理参数",
        needsSpecialHandling: false,
        transform: (url) => url
    },
    {
        name: "Instagram带igsh参数",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)\/?\?igsh=[^&\s]+/,
        description: "清理Instagram带igsh跟踪参数的链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.instagram.com/p/${match[1]}`;
            }
            return url;
        }
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
    // 为无协议前缀的URL添加临时前缀以便匹配规则
    const urlWithProtocol = url.includes('://') ? url : `https://${url}`;
    const hasProtocol = url.includes('://');

    for (const rule of platformRules) {
        // 对于全局正则模式，需要重置lastIndex
        if (rule.pattern.global) {
            rule.pattern.lastIndex = 0;
        }

        // 尝试匹配原始URL（带/不带前缀的都尝试）
        let match = url.match(rule.pattern);

        // 如果原始URL没匹配到，并且是没有协议前缀的URL，尝试匹配带前缀的版本
        if (!match && !hasProtocol) {
            match = urlWithProtocol.match(rule.pattern);
        }

        if (match) {
            if (rule.needsSpecialHandling) {
                // 检查是否需要转换
                if (rule.shouldTransform && !rule.shouldTransform(urlWithProtocol, match)) {
                    return { url, platformName: rule.name };
                }

                // 应用转换
                const transformedUrl = rule.transform(url, match);

                // 如果原始URL没有协议前缀，且转换后有了前缀，则根据需求决定是否移除
                const finalUrl = !hasProtocol && transformedUrl.includes('://') ?
                    transformedUrl.replace(/^https?:\/\//, '') : transformedUrl;

                return {
                    url: finalUrl,
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
 * 检查URL是否需要处理
 * 避免处理已经干净的URL
 */
function shouldProcessUrl(url: string): boolean {
    try {
        // 快速检查：如果URL无效，不需要处理
        if (!url || url.length < 4) {
            return false;
        }

        // 快速检查：如果URL没有参数，不需要处理
        if (!url.includes('?')) {
            return false;
        }

        // 确保URL有协议前缀
        const hasProtocol = url.includes('://');
        const urlWithProtocol = hasProtocol ? url : `https://${url}`;

        try {
            const parsedUrl = new URL(urlWithProtocol);

            // 如果URL没有参数，则不需要处理
            if (parsedUrl.search === '') {
                return false;
            }

            // 对于某些平台的标准格式，不需要处理
            for (const rule of platformRules) {
                if (rule.needsSpecialHandling && rule.shouldTransform) {
                    // 尝试匹配原始URL
                    let match = url.match(rule.pattern);

                    // 如果原始URL没匹配到，并且是没有协议前缀的URL，尝试匹配带前缀的版本
                    if (!match && !hasProtocol) {
                        match = urlWithProtocol.match(rule.pattern);
                    }

                    if (match && !rule.shouldTransform(urlWithProtocol, match)) {
                        return false;
                    }
                }
            }

            return true;
        } catch (parseError) {
            return false; // 无法解析URL，不需要处理
        }
    } catch (e) {
        return false; // 任何错误发生时，不需要处理
    }
}

/**
 * 移除URL中的追踪参数
 * @param urlObj URL对象
 * @returns 清理后的URL字符串
 */
function removeTrackingParams(urlObj: URL): string {
    // 简单实现：直接返回没有参数的URL
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
}

/**
 * 清理URL函数 - 移除所有参数，提供最大隐私保护
 * @param url 原始URL
 * @returns 清理后的URL和平台信息
 */
function cleanUrl(url: string): { url: string, platformName?: string } {
    if (!url) return { url: '' };

    try {
        // 先尝试解析URL
        const urlObj = new URL(url);

        // 处理特定平台的特殊规则
        const specialResult = applySpecialRules(url);

        // 如果有特殊处理结果，直接返回
        if (specialResult.url !== url) {
            debugLog(`应用了特殊规则: ${specialResult.platformName} - ${specialResult.url}`);
            return specialResult;
        }

        // 移除常见的追踪参数
        const cleanedUrl = removeTrackingParams(urlObj);

        return { url: cleanedUrl, platformName: specialResult.platformName };
    } catch (parseError) {
        // 处理无法解析的URL
        if (parseError instanceof TypeError && parseError.message.includes('Invalid URL')) {
            plugin.logger?.warn(`解析URL失败: ${url}, 错误: ${parseError}`);
            return { url }; // 返回原始URL
        }

        plugin.logger?.error(`清理URL出错: ${parseError}, URL: ${url}`);
        return { url }; // 返回原始URL
    }
}

/**
 * 解析短链接为原始URL
 * 使用HEAD请求减少网络压力
 * @param shortUrl 短链接
 * @returns 解析后的URL和平台信息
 */
async function resolveUrl(shortUrl: string): Promise<{ url: string, platformName?: string }> {
    try {
        // 确保URL有协议前缀用于网络请求
        const hasProtocol = shortUrl.includes('://');
        const urlWithProtocol = hasProtocol ? shortUrl : `https://${shortUrl}`;

        // 优先匹配特殊平台规则
        for (const rule of platformRules) {
            if (rule.pattern.global) {
                rule.pattern.lastIndex = 0;
            }

            // 尝试匹配原始URL
            let match = shortUrl.match(rule.pattern);

            // 如果原始URL没匹配到，并且是没有协议前缀的URL，尝试匹配带前缀的版本
            if (!match && !hasProtocol) {
                match = urlWithProtocol.match(rule.pattern);
            }

            // 对于YouTube短链接的特殊处理
            if (match && rule.name === "YouTube短链接") {
                if (match[1]) {
                    const videoId = match[1];
                    const transformedUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    return { url: transformedUrl, platformName: rule.name };
                }
            }

            if (match && rule.needsSpecialHandling) {
                // 如果有shouldTransform函数，检查是否需要转换
                if (rule.shouldTransform && !rule.shouldTransform(urlWithProtocol, match)) {
                    return { url: shortUrl, platformName: rule.name };
                }

                // 应用转换
                const transformedUrl = rule.transform(shortUrl, match);
                if (transformedUrl !== shortUrl) {
                    // 如果原始URL没有协议前缀，且转换后有了前缀，则根据需求决定是否移除
                    const finalUrl = !hasProtocol && transformedUrl.includes('://') ?
                        transformedUrl.replace(/^https?:\/\//, '') : transformedUrl;

                    return { url: finalUrl, platformName: rule.name };
                }
            }

            // 特殊处理通用短链接平台
            if (match && !rule.needsSpecialHandling) {
                // 这是一个短链接平台，需要进行网络请求解析
                try {
                    // 使用HEAD请求减少网络压力 - 必须使用带协议的URL
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

                    const response = await fetch(urlWithProtocol, {
                        method: 'HEAD',
                        headers: {
                            'User-Agent': generateRandomUserAgent(),
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            'Referer': 'https://www.google.com/'
                        },
                        redirect: 'follow',
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    // 获取最终URL
                    let finalUrl = response.url || urlWithProtocol;

                    // 如果最终URL与原始URL相同或为空，尝试GET请求
                    if (finalUrl === urlWithProtocol || !finalUrl) {
                        // 尝试GET请求作为备选方案
                        const getController = new AbortController();
                        const getTimeoutId = setTimeout(() => getController.abort(), 5000);

                        const getResponse = await fetch(urlWithProtocol, {
                            method: 'GET',
                            headers: {
                                'User-Agent': generateRandomUserAgent(),
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                                'Referer': 'https://www.google.com/'
                            },
                            redirect: 'follow',
                            signal: getController.signal
                        });

                        clearTimeout(getTimeoutId);
                        finalUrl = getResponse.url || urlWithProtocol;
                    }

                    // 确保finalUrl不为空并且不同于原始URL
                    if (finalUrl && finalUrl !== urlWithProtocol) {
                        // 清理URL参数
                        try {
                            const parsedUrl = new URL(finalUrl);

                            // 生成干净的URL
                            let cleanedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

                            // 如果原始URL没有协议前缀，还原为无前缀形式
                            if (!hasProtocol) {
                                cleanedUrl = cleanedUrl.replace(/^https?:\/\//, '');
                            }

                            return { url: cleanedUrl, platformName: rule.name };
                        } catch (parseError) {
                            plugin.logger?.error(`解析最终URL失败: ${finalUrl}, 错误: ${parseError}`);
                            return { url: finalUrl, platformName: rule.name };
                        }
                    }
                } catch (fetchError) {
                    plugin.logger?.warn(`解析短链接失败: ${shortUrl}, 尝试继续处理`);
                    // 继续处理，不要直接返回
                }
            }
        }

        // 如果不是已知的短链接平台，尝试一般的链接处理

        // 检查URL是否需要清理参数
        const needsCleaning = shouldProcessUrl(shortUrl);
        if (!needsCleaning) {
            return { url: shortUrl };
        }

        // 清理URL参数
        const { url: cleanedUrl, platformName } = cleanUrl(shortUrl);
        if (cleanedUrl !== shortUrl) {
            return { url: cleanedUrl, platformName };
        }

        // 如果上述处理都没有效果，尝试使用网络请求解析
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

            // 使用HEAD请求减少网络压力 - 必须使用带协议的URL
            const response = await fetch(urlWithProtocol, {
                method: 'HEAD',
                headers: {
                    'User-Agent': generateRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Referer': 'https://www.google.com/'
                },
                redirect: 'follow',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 获取最终URL
            let finalUrl = response.url || urlWithProtocol;

            // 如果最终URL与原始URL相同，无需进一步处理
            if (finalUrl === urlWithProtocol) {
                return { url: shortUrl };
            }

            // 清理URL参数
            try {
                const parsedUrl = new URL(finalUrl);

                // 生成干净的URL
                let cleanedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

                // 如果原始URL没有协议前缀，还原为无前缀形式
                if (!hasProtocol) {
                    cleanedUrl = cleanedUrl.replace(/^https?:\/\//, '');
                }

                return { url: cleanedUrl };
            } catch (parseError) {
                plugin.logger?.error(`解析最终URL失败: ${finalUrl}, 错误: ${parseError}`);
                return { url: finalUrl };
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                plugin.logger?.warn(`解析URL超时 ${urlWithProtocol}`);
            } else {
                plugin.logger?.error(`解析URL失败 ${urlWithProtocol}: ${error}`);
            }

            // 尝试GET请求作为备选方案
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(urlWithProtocol, {
                    method: 'GET',
                    headers: {
                        'User-Agent': generateRandomUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'Referer': 'https://www.google.com/'
                    },
                    redirect: 'follow',
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                let finalUrl = response.url || urlWithProtocol;

                // 清理URL参数
                try {
                    const parsedUrl = new URL(finalUrl);

                    // 生成干净的URL
                    let cleanedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

                    // 如果原始URL没有协议前缀，还原为无前缀形式
                    if (!hasProtocol) {
                        cleanedUrl = cleanedUrl.replace(/^https?:\/\//, '');
                    }

                    return { url: cleanedUrl };
                } catch (parseError) {
                    plugin.logger?.error(`解析GET请求URL失败: ${finalUrl}, 错误: ${parseError}`);
                    return { url: finalUrl };
                }
            } catch (getError) {
                plugin.logger?.error(`GET请求也失败 ${urlWithProtocol}: ${getError}`);
                return { url: shortUrl }; // 所有处理都失败时返回原始URL
            }
        }
    } catch (error) {
        plugin.logger?.error(`解析链接出现意外错误: ${error}`);
        return { url: shortUrl }; // 任何错误发生时返回原始URL
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
    processedCount: number
}> {
    let processedCount = 0;

    // 存储链接信息的数据结构
    interface LinkInfo {
        original: string;      // 原始链接
        originalWithAt?: string; // 带@前缀的原始形式（如果有）
        start: number;         // 起始位置
        end: number;           // 结束位置
        resolved?: string;     // 处理后的链接
        platformName?: string; // 平台名称
    }

    // 存储所有发现的链接
    const foundLinks: LinkInfo[] = [];

    // 处理带@符号的特殊格式链接
    const atSignLinkPattern = /@(https?:\/\/[^\s]+)/g;
    let atSignMatch;
    while ((atSignMatch = atSignLinkPattern.exec(messageText)) !== null) {
        if (atSignMatch && atSignMatch[1]) {
            const fullWithAt = atSignMatch[0]; // 完整匹配，包括@符号

            // 清理末尾的标点符号和非URL字符
            const endPunctuationPattern = /[,.;!?，。；！？、\]）)>】》]$/;
            let actualLink = atSignMatch[1]; // 不包括@符号的URL部分
            let originalWithAt = fullWithAt;

            // 检查并清理URL末尾的标点符号
            while (endPunctuationPattern.test(actualLink)) {
                actualLink = actualLink.slice(0, -1);
                originalWithAt = '@' + actualLink;
            }

            // 特殊处理：对于@前缀Instagram链接，特殊处理
            const instagramMatch = actualLink.match(/https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)(?:\?.*)?/);
            if (instagramMatch && instagramMatch[1]) {
                // 提取Instagram帖子ID
                const postId = instagramMatch[1];

                // 如果URL包含查询参数，需要清理
                if (actualLink.includes('?')) {
                    actualLink = `https://www.instagram.com/p/${postId}`;
                    originalWithAt = '@' + actualLink;
                }
            }

            foundLinks.push({
                original: actualLink,
                originalWithAt,
                start: atSignMatch.index,
                end: atSignMatch.index + originalWithAt.length
            });
        }
    }

    // 查找普通链接（不带@前缀）
    // 改进正则表达式，确保捕获完整URL
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(messageText)) !== null) {
        const fullMatch = urlMatch[0];
        // 清理末尾的标点符号和非URL字符
        const endPunctuationPattern = /[,.;!?，。；！？、\]）)>】》]$/;
        let link = fullMatch;

        // 检查并清理URL末尾的标点符号
        while (endPunctuationPattern.test(link)) {
            link = link.slice(0, -1);
        }

        const start = urlMatch.index;
        const end = start + link.length;

        // 检查这个链接是否已经被包含在某个@前缀链接中
        const isPartOfAtLink = foundLinks.some(info =>
            info.originalWithAt && start >= info.start && end <= info.end);

        if (!isPartOfAtLink) {
            foundLinks.push({
                original: link,
                start,
                end
            });
        }
    }

    // 匹配无协议前缀的链接（如 example.com/path?query）
    // 改进正则，确保可以匹配常见域名格式
    const noProtocolUrlPattern = /(?<![:/a-zA-Z0-9@])([a-zA-Z0-9][-a-zA-Z0-9@:%_\+~#=]{0,256}\.[a-zA-Z0-9]{1,63}[^\s]+)/g;
    let noProtocolMatch;
    while ((noProtocolMatch = noProtocolUrlPattern.exec(messageText)) !== null) {
        if (noProtocolMatch && noProtocolMatch[1]) {
            const link = noProtocolMatch[1]; // 获取匹配组1，即域名部分
            const start = noProtocolMatch.index;
            const end = start + link.length;

            // 检查这个链接是否已经被包含在其他链接中
            const isPartOfOtherLink = foundLinks.some(info =>
                start >= info.start && end <= info.end);

            if (!isPartOfOtherLink) {
                foundLinks.push({
                    original: link,
                    start,
                    end
                });
            }
        }
    }

    // 在链接识别完成后添加日志，包括每个链接的详细信息
    debugLog(`共找到 ${foundLinks.length} 个链接`);
    for (let i = 0; i < foundLinks.length; i++) {
        const link = foundLinks[i];
        if (link && link.original) {
            debugLog(`链接 ${i + 1}: ${link.original} (${link.start}-${link.end})`);
        }
    }

    // 如果没有找到任何链接，直接返回原始文本
    if (foundLinks.length === 0) {
        return { text: messageText, foundLinks: false, processedCount };
    }

    // 对链接进行处理
    const resolveResults = await Promise.allSettled(
        foundLinks.map(async (linkInfo) => {
            try {
                // 获取实际要处理的链接
                const link = linkInfo.original;

                // 跳过空链接
                if (!link) {
                    return linkInfo;
                }

                // 对于带@前缀的链接，记录原始格式
                if (linkInfo.originalWithAt) {
                    linkInfo.resolved = link;
                }

                // 优先处理特殊规则
                try {
                    // 针对特殊平台进行处理，主要是清理参数或转换格式
                    const { url: processedUrl, platformName } = await resolveUrl(link);

                    // 如果处理后的链接与原始链接不同，标记为已处理
                    if (processedUrl !== link) {
                        processedCount++;
                        linkInfo.resolved = processedUrl;
                        linkInfo.platformName = platformName;
                    } else {
                        // 如果链接没有变化但需要保留
                        linkInfo.resolved = link;
                    }
                } catch (resolveError) {
                    plugin.logger?.error(`处理链接失败: ${link}, 错误: ${resolveError}`);
                    // 即使处理失败，也要保留带@前缀链接
                    if (!linkInfo.resolved && linkInfo.originalWithAt) {
                        linkInfo.resolved = link;
                    }
                }

                return linkInfo;
            } catch (error) {
                plugin.logger?.error(`处理链接流程错误: ${linkInfo.original}, 错误: ${error}`);
                if (linkInfo.originalWithAt) {
                    linkInfo.resolved = linkInfo.original;
                }
                return linkInfo;
            }
        })
    );

    // 提取成功的结果
    const processedLinks = resolveResults
        .filter((result): result is PromiseFulfilledResult<LinkInfo> =>
            result.status === 'fulfilled')
        .map(result => result.value)
        // 仅保留那些resolved字段不为空的链接信息
        .filter(info => info.resolved !== undefined);

    // 如果没有处理任何链接，直接返回原始文本
    if (processedCount === 0) {
        return { text: messageText, foundLinks: true, processedCount: 0 };
    }

    // 按照位置从后往前排序，以便从后向前替换不影响前面的位置
    processedLinks.sort((a, b) => b.start - a.start);

    // 创建一个副本并应用所有替换
    let result = messageText;

    // 优化替换逻辑，一次性构建新字符串而不是多次替换
    let lastEnd = messageText.length;
    let parts: string[] = [];

    for (const linkInfo of processedLinks) {
        if (linkInfo.resolved && (linkInfo.originalWithAt || linkInfo.resolved !== linkInfo.original)) {
            // 添加当前链接后面的文本
            if (linkInfo.end < lastEnd) {
                parts.unshift(result.substring(linkInfo.end, lastEnd));
            }

            // 添加处理后的链接
            parts.unshift(linkInfo.resolved);

            // 更新lastEnd为当前链接的开始位置
            lastEnd = linkInfo.start;
        }
    }

    // 添加最前面的文本
    if (lastEnd > 0) {
        parts.unshift(result.substring(0, lastEnd));
    }

    // 组合成最终文本
    result = parts.join('');

    // 在结果返回前添加日志
    debugLog(`处理完成, 共处理了 ${processedCount} 个链接`);

    return {
        text: result.trim(),
        foundLinks: true,
        processedCount
    };
}

/**
 * 从文本中获取非链接词语（辅助函数）
 * 仅用于诊断和调试
 */
function getNonLinkWords(text: string): string[] {
    // 移除所有链接
    let textWithoutLinks = text.replace(/(https?:\/\/[^\s]+)/g, ' ');
    // 移除@前缀
    textWithoutLinks = textWithoutLinks.replace(/@/g, ' ');
    // 分割成词语
    return textWithoutLinks.split(/\s+/).filter(word => word.trim() !== '');
}

/**
 * 隐私插件主体
 */
const plugin: BotPlugin = {
    name: 'privacy',
    description: '防跟踪链接处理插件',
    version: '2.2.0',

    // 注册命令
    commands: [
        {
            name: 'privacy',
            description: '隐私保护和防跟踪链接处理',
            aliases: ['antitrack', 'notrack'],

            async handler(ctx: CommandContext): Promise<void> {
                // 获取需要特殊处理的平台数量
                const specialPlatforms = platformRules.filter(rule => rule.needsSpecialHandling);

                // 处理调试模式切换
                if (ctx.args.length > 0 && (ctx.args[0] === 'debug' || ctx.args[0] === '调试')) {
                    config.debug = !config.debug;
                    await ctx.message.replyText(`调试模式已${config.debug ? '开启' : '关闭'}`);
                    return;
                }

                // 检查是否有参数，如果有则测试链接处理
                if (ctx.args.length > 0) {
                    const testUrl = ctx.args.join(' ');
                    await ctx.message.replyText(`开始测试处理链接：${testUrl}`);

                    // 启用调试以获取详细输出
                    const originalDebugState = config.debug;
                    config.debug = true;
                    debugLog(`测试处理链接: ${testUrl}`);

                    try {
                        // 测试URL正则匹配
                        const hasProtocol = testUrl.includes('://');
                        const urlWithProtocol = hasProtocol ? testUrl : `https://${testUrl}`;

                        // 测试链接识别
                        let identified = false;
                        for (const rule of platformRules) {
                            if (rule.pattern.global) {
                                rule.pattern.lastIndex = 0;
                            }

                            let match = testUrl.match(rule.pattern);
                            if (!match && !hasProtocol) {
                                match = urlWithProtocol.match(rule.pattern);
                            }

                            if (match) {
                                identified = true;
                                await ctx.message.replyText(`链接匹配规则: ${rule.name}\n匹配结果: ${JSON.stringify(match)}`);
                                break;
                            }
                        }

                        if (!identified) {
                            await ctx.message.replyText(`链接未匹配任何已知平台规则，将使用通用处理`);
                        }

                        // 测试链接解析结果
                        const { url: processedUrl, platformName } = await resolveUrl(testUrl);

                        // 显示处理结果
                        let result = `原始链接: ${testUrl}\n处理结果: ${processedUrl}`;
                        if (platformName) {
                            result += `\n识别平台: ${platformName}`;
                        }

                        result += `\n链接实际变化: ${processedUrl !== testUrl ? '✅ 已修改' : '❌ 无变化'}`;

                        await ctx.message.replyText(result);
                    } catch (error) {
                        plugin.logger?.error(`测试链接处理失败: ${error}`);
                        await ctx.message.replyText(`处理链接失败: ${error}`);
                    } finally {
                        // 恢复调试状态
                        config.debug = originalDebugState;
                    }

                    return;
                }

                await ctx.message.replyText(html`
                    🔒 <b>隐私保护插件状态</b><br>
<br>
- 版本: 2.2.0<br>
- 总支持平台: ${platformRules.length}<br>
- 特殊规则平台: ${specialPlatforms.length}<br>
- 活跃状态: ✅ 运行中<br>
- 调试模式: ${config.debug ? '✅ 已开启' : '❌ 已关闭'}
<br>
<b>特殊处理平台:</b> ${specialPlatforms.map(p => p.name).join(', ')}<br>
<br>
<b>使用方法:</b><br>
1. 发送带链接的消息, 插件会自动清理跟踪参数<br>
2. 使用 /privacy <链接> 测试链接处理<br>
3. 使用 /privacy debug 切换调试模式`);
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

                // 快速检查：消息是否为空或太短
                if (messageText.length < 5) {
                    return;
                }

                // 快速检查：消息中是否包含可能的URL特征
                // 检查常见URL特征：点号(.)、协议前缀(://)、常见域名标识(www)等
                const containsUrlIndicators = messageText.includes('.') ||
                    messageText.includes('://') ||
                    messageText.includes('www.') ||
                    messageText.includes('@http');

                if (!containsUrlIndicators) {
                    return;
                }

                try {
                    // 处理消息中的所有链接
                    const startTime = Date.now();

                    const { text: processedText, foundLinks, processedCount } =
                        await processLinksInMessage(messageText);

                    const processingTime = Date.now() - startTime;
                    debugLog(`处理耗时: ${processingTime}ms, 是否找到链接: ${foundLinks}, 处理数量: ${processedCount}`);

                    // 如果找到并解析了链接，且有实际修改，则删除原消息并发送新消息
                    if (foundLinks && processedText !== messageText && processedCount > 0) {
                        const content = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 分享内容（隐私保护，已移除跟踪参数）:\n${processedText}`;

                        // 发送新消息（如果存在回复消息则保持回复关系）
                        try {
                            await ctx.message.answerText(content);

                            // 删除原消息
                            try {
                                await ctx.message.delete();
                            } catch (error) {
                                plugin.logger?.error(`删除原消息失败: ${error}`);
                            }
                        } catch (sendError) {
                            plugin.logger?.error(`发送替换消息失败: ${sendError}`);
                            // 不删除原消息，以防消息丢失
                        }
                    }
                } catch (error) {
                    plugin.logger?.error(`处理消息错误: ${error}`);
                }
            }
        }
    ]
};

export default plugin; 