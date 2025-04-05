/**
 * 隐私保护插件 - 移除URL跟踪参数
 * 
 * 功能简介:
 * ---------------
 * 此插件自动检测消息中的链接，并移除跟踪参数，保护用户隐私。
 * 支持常见社交媒体、视频平台、电商网站等多种平台的特殊处理。
 * 
 * 规则开发指南:
 * ---------------
 * 1. 通用参数移除规则 - 完全清理URL参数:
 *    ```typescript
 *    {
 *        name: "平台名称",                             // 规则名称，简短描述
 *        pattern: /https?:\/\/(?:www\.)?example\.com\/path\/(.+?)(?:\?.*)?/, // 匹配模式
 *        description: "清理示例链接",                  // 详细说明
 *        needsSpecialHandling: true,                  // 需要特殊处理
 *        transform: CommonTransforms.removeAllParams  // 使用预定义的转换函数
 *    }
 *    ```
 * 
 * 2. 保留特定参数规则 - 仅保留重要参数:
 *    ```typescript
 *    {
 *        name: "视频平台",
 *        pattern: /https?:\/\/(?:www\.)?example\.com\/watch\?v=([\w-]+)(?:&.*)?/,
 *        description: "保留视频ID和时间戳参数",
 *        needsSpecialHandling: true,
 *        shouldTransform: (url, match) => {           // 可选：检查是否需要转换
 *            try {
 *                const parsedUrl = new URL(url);
 *                // 如果已经是干净格式（只有需要的参数），则不转换
 *                return !(parsedUrl.searchParams.size === 1 && 
 *                         parsedUrl.searchParams.has('v'));
 *            } catch (e) {
 *                return true; // 解析失败时默认转换
 *            }
 *        },
 *        transform: CommonTransforms.keepOnlyParams(['v', 'time'])  // 仅保留特定参数
 *    }
 *    ```
 * 
 * 3. 自定义处理规则 - 完全自定义处理逻辑:
 *    ```typescript
 *    {
 *        name: "重定向处理",
 *        pattern: /https?:\/\/(?:www\.)?example\.com\/redirect\?url=([^&]+)(?:&.*)?/,
 *        description: "提取并解码重定向链接",
 *        needsSpecialHandling: true,
 *        transform: (url, match) => {
 *            if (match && match[1]) {
 *                try {
 *                    // 解码URL参数
 *                    return decodeURIComponent(match[1]);
 *                } catch (e) {
 *                    return url;  // 解码失败返回原始URL
 *                }
 *            }
 *            return url;
 *        }
 *    }
 *    ```
 * 
 * 4. 域名规范化规则 - 统一不同子域名:
 *    ```typescript
 *    {
 *        name: "移动站点规范化",
 *        pattern: /https?:\/\/(?:m|mobile|app)\.example\.com\/([^?]+)(?:\?.*)?/,
 *        description: "将移动版网站链接转换为桌面版",
 *        needsSpecialHandling: true,
 *        transform: CommonTransforms.standardizeDomain('www.example.com')
 *    }
 *    ```
 * 
 * 5. 路径重构规则 - 使用模板重建URL:
 *    ```typescript
 *    {
 *        name: "新版本路径",
 *        pattern: /https?:\/\/(?:www\.)?example\.com\/old\/(\w+)\/(\d+)(?:\?.*)?/,
 *        description: "将旧版路径转换为新版格式",
 *        needsSpecialHandling: true,
 *        transform: CommonTransforms.buildFromMatch('https://example.com/new/$1/item/$2')
 *    }
 *    ```
 * 
 * 可用的通用转换函数:
 * ---------------
 * - CommonTransforms.removeAllParams: 移除所有URL参数
 * - CommonTransforms.keepOnlyParams(['param1', 'param2']): 仅保留指定参数
 * - CommonTransforms.removeParams(['param1', 'param2']): 移除指定参数，保留其他参数
 * - CommonTransforms.removeTrackingParams: 移除常见跟踪参数
 * - CommonTransforms.standardizeDomain('domain.com'): 统一域名
 * - CommonTransforms.buildFromMatch('template'): 使用模板和正则匹配结果构建URL
 */

import { html, BotKeyboard, TelegramClient } from "@mtcute/bun";
import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from "../features";
import { generateRandomUserAgent } from "../utils/UserAgent";
import { CallbackDataBuilder } from "../utils/callback";

// 插件配置
const config = {
    debug: false,  // 默认禁用调试模式
    enableTLS: true, // 强制使用TLS
    textSeparator: '...', // 用于显示的文本分隔符
    maxConcurrentRequests: 5, // 最大并发请求数
    requestTimeout: 5000, // 请求超时时间(毫秒)
    minUrlLength: 4, // 最小URL长度
    processingCheckInterval: 50, // 并发处理检查间隔(毫秒)
};

/**
 * 特殊平台URL处理规则
 * 针对不同平台的特殊处理逻辑
 */
interface SpecialUrlRule {
    name: string;            // 平台名称
    pattern: RegExp;         // 匹配模式
    description: string;     // 规则描述
    needsSpecialHandling: boolean; // 是否需要特殊处理（不能简单移除参数）
    transform?: (url: string, match: RegExpMatchArray | null) => string; // 转换函数，needsSpecialHandling为false时可选
    shouldTransform?: (url: string, match: RegExpMatchArray | null) => boolean; // 是否应该转换的条件函数
}

// 预编译正则表达式常量
const URL_PATTERNS = {
    // 带协议的URL模式
    PROTOCOL_URL: /(https?:\/\/[^\s]+)/g,
    // 带@符号的特殊格式链接
    AT_SIGN_LINK: /@(https?:\/\/[^\s]+)/g,
    // 无协议前缀的链接（经过优化的正则）
    NO_PROTOCOL_URL: /(?<![:/a-zA-Z0-9@])([a-zA-Z0-9][-a-zA-Z0-9@:%_\+~#=]{0,256}\.[a-zA-Z0-9]{1,63}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*?))/g,
    // 链接末尾的标点符号
    END_PUNCTUATION: /[,.;!?，。；！？、\]）)>】》]$/,
    // 构建合并规则的正则表达式
    buildCombinedRulePattern: () => {
        // 从platformRules中提取所有模式并合并成一个大正则表达式
        const patterns = platformRules.map(rule => {
            // 移除开始/结束标记并提取正则源代码
            const pattern = rule.pattern.source.replace(/^\/|\/[gimsuy]*$/g, '');
            // 用命名捕获组包装每个规则，以便识别匹配了哪个规则
            return `(?<${rule.name.replace(/[^a-zA-Z0-9]/g, '_')}>${pattern})`;
        });
        // 使用|组合所有模式，并创建全局正则
        try {
            return new RegExp(patterns.join('|'), 'g');
        } catch (e) {
            // 如果正则表达式过于复杂，创建失败，返回null
            plugin.logger?.error(`创建组合正则表达式失败: ${e}`);
            return null;
        }
    }
};

// 存储规则名称到规则对象的映射，用于快速查找
const RULE_MAP = new Map<string, SpecialUrlRule>();

// 通用URL转换函数 - 在UrlUtils之前定义
const CommonTransforms = {
    /**
     * 移除URL参数，保留路径
     */
    removeAllParams: (url: string, _match: RegExpMatchArray | null): string => {
        try {
            const parsedUrl = new URL(url.includes('://') ? url : `https://${url}`);
            return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
        } catch {
            return url;
        }
    },

    /**
     * 仅保留指定参数
     */
    keepOnlyParams: (paramsToKeep: string[]) => {
        return (url: string, _match: RegExpMatchArray | null): string => {
            try {
                const parsedUrl = new URL(url.includes('://') ? url : `https://${url}`);
                const params = new URLSearchParams();

                // 只保留指定的参数
                for (const param of paramsToKeep) {
                    const value = parsedUrl.searchParams.get(param);
                    if (value) params.append(param, value);
                }

                // 构建新URL
                return UrlUtils.buildUrl(parsedUrl, params);
            } catch {
                return url;
            }
        };
    },

    /**
     * 移除指定参数，保留其他参数
     */
    removeParams: (paramsToRemove: string[]) => {
        return (url: string, _match: RegExpMatchArray | null): string => {
            try {
                const parsedUrl = new URL(url.includes('://') ? url : `https://${url}`);
                // 创建一个新的URL搜索参数对象
                const params = new URLSearchParams();

                // 复制所有参数，除了要移除的
                parsedUrl.searchParams.forEach((value, key) => {
                    if (!paramsToRemove.includes(key)) {
                        params.append(key, value);
                    }
                });

                // 构建新URL
                return UrlUtils.buildUrl(parsedUrl, params);
            } catch {
                return url;
            }
        };
    },

    /**
     * 移除常见的跟踪参数
     * 预定义了大多数网站常用的跟踪参数
     */
    removeTrackingParams: (url: string, _match: RegExpMatchArray | null): string => {
        try {
            const parsedUrl = new URL(url.includes('://') ? url : `https://${url}`);

            // 常见跟踪参数列表
            const commonTrackingParams = [
                // Google Analytics & AdWords
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'gclsrc',
                // Facebook
                'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
                // 其他社交媒体
                'igshid', 'twclid', 'ocid', 'ncid',
                // 电子邮件营销
                'mc_cid', 'mc_eid', 'hsCtaTracking', 'hsenc',
                // 其他常见跟踪
                'ref', 'source', 'trk', 'trkCampaign', '_hsenc', '_hsmi', 'oly_enc_id',
                'oly_anon_id', '_ga', '_gl', 'yclid', 'vero_id', 'vero_conv',
                // 阿里系跟踪
                'ali_trackid', 'spm', 'scm', 'scene', 'clickid',
                // 百度系跟踪
                'bd_vid', 'bd_sid', 'bd_source',
                // 字节跳动
                'tt_from', 'enter_from', 'enter_method'
            ];

            // 创建一个新的URL搜索参数对象
            const params = new URLSearchParams();

            // 复制非跟踪参数
            parsedUrl.searchParams.forEach((value, key) => {
                if (!commonTrackingParams.includes(key)) {
                    params.append(key, value);
                }
            });

            // 构建新URL
            return UrlUtils.buildUrl(parsedUrl, params);
        } catch {
            return url;
        }
    },

    /**
     * 转换路径和域名为标准格式
     * 例如将m.example.com转换为www.example.com
     */
    standardizeDomain: (targetDomain: string) => {
        return (url: string, _match: RegExpMatchArray | null): string => {
            try {
                const parsedUrl = new URL(url.includes('://') ? url : `https://${url}`);
                parsedUrl.hostname = targetDomain;
                return parsedUrl.toString();
            } catch {
                return url;
            }
        };
    },

    /**
     * 从匹配结果创建一个新的URL
     * 适用于需要从多个匹配组构建URL的情况
     */
    buildFromMatch: (template: string) => {
        return (url: string, match: RegExpMatchArray | null): string => {
            if (!match) return url;

            try {
                // 替换模板中的$1, $2等为匹配组的值
                let result = template;
                for (let i = 1; i < match.length; i++) {
                    const value = match[i];
                    if (value) {
                        const placeholder = `$${i}`;
                        result = result.split(placeholder).join(value);
                    }
                }
                return result;
            } catch {
                return url;
            }
        };
    }
};

// URL匹配工具函数
const UrlUtils = {
    // 检查URL是否有协议前缀
    hasProtocol: (url: string): boolean => url.includes('://'),

    // 添加协议前缀（如果需要）
    ensureProtocol: (url: string): string => url.includes('://') ? url : `https://${url}`,

    // 移除协议前缀（如果需要恢复到原始状态）
    removeProtocolIfNeeded: (originalUrl: string, processedUrl: string): string => {
        return !originalUrl.includes('://') && processedUrl.includes('://')
            ? processedUrl.replace(/^https?:\/\//, '')
            : processedUrl;
    },

    // 快速检查URL是否包含某些特征
    hasUrlCharacteristics: (text: string): boolean => {
        return text.includes('.') ||
            text.includes('://') ||
            text.includes('www.') ||
            text.includes('@http') ||
            text.includes('/');
    },

    // 快速检查URL是否需要处理
    shouldProcess: (url: string): boolean => {
        // 跳过无效、太短或无参数的URL
        return !!url && url.length >= config.minUrlLength && url.includes('?');
    },

    // 清理URL末尾的标点符号
    cleanUrlEnding: (url: string): string => {
        let cleaned = url;
        while (URL_PATTERNS.END_PUNCTUATION.test(cleaned)) {
            cleaned = cleaned.slice(0, -1);
        }
        return cleaned;
    },

    // 从URL中提取域名
    extractDomain: (url: string): string | null => {
        try {
            const urlObj = new URL(UrlUtils.ensureProtocol(url));
            return urlObj.hostname;
        } catch {
            return null;
        }
    },

    // 规范化URL（移除参数和片段）
    normalizeUrl: (url: string): string => {
        try {
            const urlObj = new URL(UrlUtils.ensureProtocol(url));
            return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
        } catch {
            return url;
        }
    },

    // 构建URL字符串
    buildUrl: (parsedUrl: URL, params?: URLSearchParams): string => {
        const paramString = params?.toString() || '';
        return paramString
            ? `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}?${paramString}`
            : `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    },

    // 引用预定义的转换函数
    transforms: CommonTransforms
};

/**
 * 平台处理规则
 * 按平台类型分组，支持特殊处理和通用处理
 */
const platformRules: SpecialUrlRule[] = [
    // YouTube 系列 - 需要特殊处理，因为参数中包含视频ID
    {
        name: "YouTube短链接",
        pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)\?.+/,
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
        transform: CommonTransforms.keepOnlyParams(['v', 't'])
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
        transform: CommonTransforms.keepOnlyParams(['t', 'p'])
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
        transform: CommonTransforms.removeAllParams
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
        transform: CommonTransforms.removeAllParams
    },
    {
        name: "Instagram Reels",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/reel\/([\w-]+)(?:\?.*)?/,
        description: "统一Instagram Reels格式",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
    },
    {
        name: "Instagram Stories",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/stories\/([^\/]+)\/(\d+)(?:\?.*)?/,
        description: "清理Instagram Stories链接",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
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

    {
        name: "Spotify",
        pattern: /https?:\/\/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)(?:\?.*)?/,
        description: "清理Spotify链接",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "SoundCloud",
        pattern: /https?:\/\/(?:www\.)?soundcloud\.com\/([^\/]+)\/([^\/\?]+)(?:\?.*)?/,
        description: "清理SoundCloud链接",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "Medium",
        pattern: /https?:\/\/(?:www\.)?medium\.com\/(?:@?[^\/]+\/)?([^\/\?]+)(?:\?.*)?/,
        description: "清理Medium文章链接",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "哔哩哔哩短链接",
        pattern: /https?:\/\/b23\.tv\/[\w-]+/,
        description: "解析哔哩哔哩短链接并清理参数",
        needsSpecialHandling: false // 使用通用解析方式，让程序自动处理重定向
    },
    {
        name: "小红书短链接",
        pattern: /https?:\/\/xhslink\.com\/[\w-]+/,
        description: "解析小红书链接并清理参数",
        needsSpecialHandling: false
    },
    {
        name: "微博短链接",
        pattern: /https?:\/\/t\.cn\/[\w-]+/,
        description: "解析微博短链接并清理参数",
        needsSpecialHandling: false
    },
    {
        name: "抖音短链接",
        pattern: /https?:\/\/v\.douyin\.com\/[\w-]+/,
        description: "解析抖音短链接并清理参数",
        needsSpecialHandling: false
    },
    {
        name: "知乎外链",
        pattern: /https?:\/\/link\.zhihu\.com\/\?(?:target|url)=([^&]+)(?:&.*)?/,
        description: "解析知乎外链",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                try {
                    // 知乎链接通常经过URL编码，需要解码
                    return decodeURIComponent(match[1]);
                } catch (e) {
                    return url;
                }
            }
            return url;
        }
    },
    {
        name: "360搜索",
        pattern: /https?:\/\/(?:www\.)?so\.com\/link\?(?:url|m)=([^&]+)(?:&.*)?/,
        description: "解析360搜索跟踪链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                try {
                    // 360搜索链接通常经过URL编码，需要解码
                    return decodeURIComponent(match[1]);
                } catch (e) {
                    return url;
                }
            }
            return url;
        }
    },
    {
        name: "YouTube短链接",
        pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(?:\?.+)?/,
        description: "将YouTube短链接转换为标准格式",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                // 尝试提取时间戳参数
                const timeMatch = url.match(/[?&]t=([^&]+)/);
                if (timeMatch && timeMatch[1]) {
                    return `https://www.youtube.com/watch?v=${match[1]}&t=${timeMatch[1]}`;
                }
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "微信公众号文章",
        pattern: /https?:\/\/mp\.weixin\.qq\.com\/s\/([a-zA-Z0-9_-]+)(?:\?.*)?/,
        description: "清理微信公众号文章链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://mp.weixin.qq.com/s/${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "亚马逊产品",
        pattern: /https?:\/\/(?:www\.)?amazon\.(?:com|co\.jp|co\.uk|de|fr|it|es|cn)\/(?:.*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/.*)?(?:\?.*)?/,
        description: "清理亚马逊产品链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                try {
                    const parsedUrl = new URL(url);
                    const domain = parsedUrl.hostname;
                    return `https://${domain}/dp/${match[1]}`;
                } catch (e) {
                    // 提取域名
                    const domainMatch = url.match(/amazon\.(com|co\.jp|co\.uk|de|fr|it|es|cn)/);
                    if (domainMatch && domainMatch[1]) {
                        return `https://www.amazon.${domainMatch[1]}/dp/${match[1]}`;
                    }
                    return `https://www.amazon.com/dp/${match[1]}`;
                }
            }
            return url;
        }
    },
    {
        name: "淘宝/天猫商品",
        pattern: /https?:\/\/(?:item|detail)\.(?:taobao|tmall)\.com\/item\.htm\?id=(\d+)(?:&.*)?/,
        description: "清理淘宝/天猫商品链接",
        needsSpecialHandling: true,
        transform: (url, match) => {
            if (match && match[1]) {
                // 判断是淘宝还是天猫
                const isTmall = url.includes('tmall.com');
                const domain = isTmall ? 'detail.tmall.com' : 'item.taobao.com';
                return `https://${domain}/item.htm?id=${match[1]}`;
            }
            return url;
        }
    },
    {
        name: "Instagram带igsh参数",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)\/?\?(?:igsh|utm_source)=[^&\s]+(?:&.*)?/,
        description: "清理Instagram带跟踪参数的链接",
        needsSpecialHandling: true,
        transform: CommonTransforms.removeAllParams
    }
];

/**
 * 应用特殊平台规则
 * @param url 原始URL
 * @returns 处理后的URL和平台名称
 */
function applySpecialRules(url: string): { url: string, platformName?: string } {
    // 为无协议前缀的URL添加临时前缀以便匹配规则
    const hasProtocol = UrlUtils.hasProtocol(url);
    const urlWithProtocol = UrlUtils.ensureProtocol(url);

    for (const rule of platformRules) {
        // 对于全局正则模式，需要重置lastIndex
        if (rule.pattern.global) {
            rule.pattern.lastIndex = 0;
        }

        // 尝试匹配URL（带协议和不带协议的都尝试）
        const match = url.match(rule.pattern) ||
            (!hasProtocol ? urlWithProtocol.match(rule.pattern) : null);

        if (match) {
            if (rule.needsSpecialHandling && rule.transform) {
                // 检查是否需要转换
                if (rule.shouldTransform && !rule.shouldTransform(urlWithProtocol, match)) {
                    return { url, platformName: rule.name };
                }

                // 应用转换
                const transformedUrl = rule.transform(url, match);

                // 如果原始URL没有协议前缀，且转换后有了前缀，则根据需求移除
                const finalUrl = UrlUtils.removeProtocolIfNeeded(url, transformedUrl);

                return {
                    url: finalUrl,
                    platformName: rule.name
                };
            } else {
                // 不需要特殊处理的平台，仅记录平台名
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
    // 快速检查：如果URL无效、太短或无参数，不需要处理
    if (!url || url.length < config.minUrlLength || !url.includes('?')) {
        return false;
    }

    try {
        // 确保URL有协议前缀进行解析
        const urlWithProtocol = UrlUtils.ensureProtocol(url);
        const parsedUrl = new URL(urlWithProtocol);

        // 如果URL没有参数，则不需要处理
        if (parsedUrl.search === '') {
            return false;
        }

        // 检查是否匹配特定平台规则的标准格式
        const matchedRule = findMatchingRule(url, urlWithProtocol);
        if (matchedRule && matchedRule.rule.shouldTransform) {
            // 如果规则指定不需要转换，则不处理
            if (!matchedRule.rule.shouldTransform(urlWithProtocol, matchedRule.match)) {
                return false;
            }
        }

        return true;
    } catch (e) {
        return false; // 解析URL失败或其他错误，不需要处理
    }
}

/**
 * 清理URL函数 - 移除所有参数，提供最大隐私保护
 * @param url 原始URL
 * @returns 清理后的URL和平台信息
 */
function cleanUrl(url: string): { url: string, platformName?: string } {
    if (!url) return { url: '' };

    try {
        // 处理特定平台的特殊规则
        const specialResult = applySpecialRules(url);

        // 如果有特殊处理结果，直接返回
        if (specialResult.url !== url) {
            plugin.logger?.debug(`应用了特殊规则: ${specialResult.platformName} - ${specialResult.url}`);
            return specialResult;
        }

        // 尝试解析URL
        const urlObj = new URL(UrlUtils.ensureProtocol(url));

        // 对于一般URL，移除全部参数
        const cleanedUrl = UrlUtils.normalizeUrl(url);

        return {
            url: UrlUtils.removeProtocolIfNeeded(url, cleanedUrl),
            platformName: specialResult.platformName
        };
    } catch (parseError) {
        // 处理无法解析的URL
        plugin.logger?.warn(`解析URL失败: ${url}, 错误: ${parseError}`);
        return { url }; // 返回原始URL
    }
}

// 初始化函数 - 在插件加载时调用
function initializeUrlPatterns(): void {
    // 清理并填充规则映射
    RULE_MAP.clear();

    // 检查规则定义是否正确
    for (const rule of platformRules) {
        // 检查特殊处理规则是否具有转换函数
        if (rule.needsSpecialHandling && !rule.transform) {
            plugin.logger?.warn(`规则"${rule.name}"被标记为需要特殊处理，但没有提供transform函数`);
        }

        // 注册规则到Map
        const normalizedName = rule.name.replace(/[^a-zA-Z0-9]/g, '_');
        RULE_MAP.set(normalizedName, rule);
    }

    // 日志输出
    plugin.logger?.debug(`初始化了 ${RULE_MAP.size} 个平台规则映射`);
}

// 初始化特殊规则标识
let combinedRulePattern: RegExp | null = null;

/**
 * 解析链接为原始URL - 优化版本
 * @param shortUrl 短链接
 * @returns 解析后的URL和平台信息
 */
async function resolveUrl(shortUrl: string): Promise<{ url: string, platformName?: string }> {
    try {
        // 快速检查
        if (!shortUrl || shortUrl.length < config.minUrlLength) {
            return { url: shortUrl };
        }

        // 准备URL（添加协议前缀如果需要）
        const originalHasProtocol = UrlUtils.hasProtocol(shortUrl);
        const urlWithProtocol = UrlUtils.ensureProtocol(shortUrl);

        // 使用统一方法匹配规则
        const matchedRule = findMatchingRule(shortUrl, urlWithProtocol);
        if (matchedRule) {
            const { rule, match } = matchedRule;

            if (rule.needsSpecialHandling && rule.transform) {
                // 检查是否需要转换
                if (rule.shouldTransform && !rule.shouldTransform(urlWithProtocol, match)) {
                    return { url: shortUrl, platformName: rule.name };
                }

                // 应用转换
                const transformedUrl = rule.transform(shortUrl, match);
                if (transformedUrl !== shortUrl) {
                    // 保持原始URL的协议风格
                    const finalUrl = UrlUtils.removeProtocolIfNeeded(shortUrl, transformedUrl);
                    return { url: finalUrl, platformName: rule.name };
                }
            } else if (!rule.needsSpecialHandling) {
                // 短链接平台，进行网络请求解析
                return await resolveShortUrl(shortUrl, urlWithProtocol, rule.name);
            }
        }

        // 检查是否需要清理参数
        if (shouldProcessUrl(shortUrl)) {
            // 一般URL清理
            const { url: cleanedUrl, platformName } = cleanUrl(shortUrl);
            if (cleanedUrl !== shortUrl) {
                return { url: cleanedUrl, platformName };
            }
        }

        // 如果上述处理都没效果，尝试网络请求
        return await resolveShortUrl(shortUrl, urlWithProtocol);
    } catch (error) {
        plugin.logger?.error(`解析链接出现意外错误: ${error}`);
        return { url: shortUrl };
    }
}

/**
 * 查找匹配规则的辅助函数
 */
function findMatchingRule(shortUrl: string, urlWithProtocol: string): { rule: SpecialUrlRule, match: RegExpMatchArray } | null {
    // 先尝试使用组合正则表达式匹配
    if (combinedRulePattern) {
        combinedRulePattern.lastIndex = 0; // 重置正则状态

        const match = combinedRulePattern.exec(shortUrl) || combinedRulePattern.exec(urlWithProtocol);
        if (match && match.groups) {
            // 找到匹配的规则名称
            const matchedRuleName = Object.keys(match.groups).find(key => match.groups![key]);

            if (matchedRuleName && RULE_MAP.has(matchedRuleName)) {
                return {
                    rule: RULE_MAP.get(matchedRuleName)!,
                    match
                };
            }
        }
    }

    // 回退到单独规则匹配
    const originalHasProtocol = UrlUtils.hasProtocol(shortUrl);
    for (const rule of platformRules) {
        // 重置正则状态
        if (rule.pattern.global) {
            rule.pattern.lastIndex = 0;
        }

        // 尝试匹配
        let match = shortUrl.match(rule.pattern);
        if (!match && !originalHasProtocol) {
            match = urlWithProtocol.match(rule.pattern);
        }

        if (match) {
            return { rule, match };
        }
    }

    return null;
}

/**
 * 执行HEAD请求的辅助函数
 */
async function performHeadRequest(url: string): Promise<{ url: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.requestTimeout);

    try {
        const response = await fetch(url, {
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
        return { url: response.url || url };
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * 执行GET请求的辅助函数 - 改进版
 */
async function performGetRequest(url: string): Promise<{ url: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.requestTimeout);

    try {
        const response = await fetch(url, {
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

        // 对于短链接特殊处理，有时候HTTP重定向不完整
        // 从响应中尝试提取可能的最终URL
        const urlRule = platformRules.find(rule =>
            rule.pattern.test(url) && !rule.needsSpecialHandling
        );

        if (urlRule) {
            const respUrl = response.url || url;

            // 如果已通过HTTP重定向获得新URL，直接返回
            if (respUrl !== url) {
                plugin.logger?.debug(`短链接平台 ${urlRule.name} 解析成功: ${respUrl}`);
                return { url: respUrl };
            }

            // 尝试从响应体中提取最终URL
            try {
                const text = await response.text();

                // 常见重定向方式1: HTML meta刷新
                const metaMatch = text.match(/<meta\s+http-equiv=["']refresh["']\s+content=["']0;\s*url=(https?:\/\/[^"']+)["']/i);
                if (metaMatch && metaMatch[1]) {
                    plugin.logger?.debug(`从响应体中提取最终链接(meta刷新): ${metaMatch[1]}`);
                    return { url: metaMatch[1] };
                }

                // 常见重定向方式2: JavaScript变量
                const shareMatch = text.match(/shareUrl\s*=\s*["'](https?:\/\/[^"']+)["']/);
                if (shareMatch && shareMatch[1]) {
                    plugin.logger?.debug(`从响应体中提取最终链接(JS变量): ${shareMatch[1]}`);
                    return { url: shareMatch[1] };
                }

                // 常见重定向方式3: Open Graph协议URL
                const ogUrlMatch = text.match(/<meta\s+property=["']og:url["']\s+content=["'](https?:\/\/[^"']+)["']/i);
                if (ogUrlMatch && ogUrlMatch[1]) {
                    plugin.logger?.debug(`从响应体中提取最终链接(OG标签): ${ogUrlMatch[1]}`);
                    return { url: ogUrlMatch[1] };
                }

                // 常见重定向方式4: 规范链接
                const canonicalMatch = text.match(/<link\s+rel=["']canonical["']\s+href=["'](https?:\/\/[^"']+)["']/i);
                if (canonicalMatch && canonicalMatch[1]) {
                    plugin.logger?.debug(`从响应体中提取最终链接(规范链接): ${canonicalMatch[1]}`);
                    return { url: canonicalMatch[1] };
                }
            } catch (e) {
                plugin.logger?.debug(`解析响应体失败: ${e}`);
            }
        }

        return { url: response.url || url };
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * 专门处理短链接解析的辅助函数
 */
async function resolveShortUrl(
    originalUrl: string,
    urlWithProtocol: string,
    platformName?: string
): Promise<{ url: string, platformName?: string }> {
    try {
        // 首先尝试HEAD请求，支持重定向
        try {
            const { url: resolvedUrl } = await performHeadRequest(urlWithProtocol);

            // 如果解析成功且获得不同URL，清理并返回
            if (resolvedUrl && resolvedUrl !== urlWithProtocol) {
                // 检查解析后的URL是否匹配特定平台规则
                for (const rule of platformRules) {
                    if (rule.pattern.global) {
                        rule.pattern.lastIndex = 0;
                    }

                    // 只检查需要特殊处理的平台规则
                    if (rule.needsSpecialHandling && rule.transform) {
                        const match = resolvedUrl.match(rule.pattern);
                        if (match) {
                            // 找到匹配的平台规则，应用规则转换
                            platformName = rule.name;

                            // 检查是否需要应用转换
                            if (rule.shouldTransform && !rule.shouldTransform(resolvedUrl, match)) {
                                return {
                                    url: UrlUtils.removeProtocolIfNeeded(originalUrl, resolvedUrl),
                                    platformName
                                };
                            }

                            // 应用转换
                            const cleanedUrl = rule.transform(resolvedUrl, match);
                            return {
                                url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                                platformName
                            };
                        }
                    }
                }

                // 如果没有匹配特定规则，返回清理后的URL
                // 根据标准规则清理参数
                if (shouldProcessUrl(resolvedUrl)) {
                    const { url: cleanedUrl } = cleanUrl(resolvedUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                } else {
                    // 不需要处理的URL，标准化后返回
                    const cleanedUrl = UrlUtils.normalizeUrl(resolvedUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                }
            }
        } catch (headError) {
            // HEAD请求失败，尝试GET
            plugin.logger?.debug(`HEAD请求失败 ${urlWithProtocol}: ${headError}`);
        }

        // 如果HEAD请求未成功，尝试GET请求
        try {
            const { url: getUrl } = await performGetRequest(urlWithProtocol);
            if (getUrl && getUrl !== urlWithProtocol) {
                // 检查解析后的URL是否匹配特定平台规则
                for (const rule of platformRules) {
                    if (rule.pattern.global) {
                        rule.pattern.lastIndex = 0;
                    }

                    // 只检查需要特殊处理的平台规则
                    if (rule.needsSpecialHandling && rule.transform) {
                        const match = getUrl.match(rule.pattern);
                        if (match) {
                            // 找到匹配的平台规则，应用规则转换
                            platformName = rule.name;

                            // 检查是否需要应用转换
                            if (rule.shouldTransform && !rule.shouldTransform(getUrl, match)) {
                                return {
                                    url: UrlUtils.removeProtocolIfNeeded(originalUrl, getUrl),
                                    platformName
                                };
                            }

                            // 应用转换
                            const cleanedUrl = rule.transform(getUrl, match);
                            return {
                                url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                                platformName
                            };
                        }
                    }
                }

                // 如果没有匹配特定规则，返回清理后的URL
                // 根据标准规则清理参数
                if (shouldProcessUrl(getUrl)) {
                    const { url: cleanedUrl } = cleanUrl(getUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                } else {
                    // 不需要处理的URL，标准化后返回
                    const cleanedUrl = UrlUtils.normalizeUrl(getUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                }
            }
        } catch (getError) {
            plugin.logger?.debug(`GET请求失败 ${urlWithProtocol}: ${getError}`);
        }

        // 所有方法都失败，返回原始URL
        return { url: originalUrl, platformName };
    } catch (e) {
        plugin.logger?.warn(`解析短链接失败: ${originalUrl}, 错误: ${e}`);
        return { url: originalUrl, platformName };
    }
}

// 定义删除回调数据构建器
const DeletePrivacyCallback = new CallbackDataBuilder<{
    initiatorId: number;
    originalSenderId: number;
}>('privacy', 'del', ['initiatorId', 'originalSenderId']);

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

/**
 * 处理删除隐私保护消息回调
 */
async function handleDeleteCallback(ctx: CallbackEventContext): Promise<void> {
    try {
        // 获取回调数据参数
        const data = ctx.match || {};
        const initiatorId = typeof data._param0 === 'number' ? data._param0 : 0;
        const originalSenderId = typeof data._param1 === 'number' ? data._param1 : 0;
        const currentUserId = ctx.query.user.id;

        // 检查权限: 发起人、原始发送者或管理员可以删除消息
        const canDelete =
            currentUserId === initiatorId ||
            (originalSenderId > 0 && currentUserId === originalSenderId) ||
            await ctx.hasPermission('admin') ||
            await isGroupAdmin(ctx.client, ctx.chatId, currentUserId);

        if (!canDelete) {
            await ctx.query.answer({
                text: '您没有权限删除此隐私保护消息',
                alert: true
            });
            return;
        }

        // 删除消息并反馈
        await ctx.client.deleteMessagesById(ctx.chatId, [ctx.query.messageId]);
        await ctx.query.answer({ text: '已删除隐私保护消息' });
    } catch (error) {
        plugin.logger?.error(`删除隐私保护消息失败: ${error}`);
        await ctx.query.answer({
            text: '删除失败',
            alert: true
        });
    }
}

// 存储链接信息的数据结构
interface LinkInfo {
    original: string;      // 原始链接
    originalWithAt?: string; // 带@前缀的原始形式（如果有）
    start: number;         // 起始位置
    end: number;           // 结束位置
    resolved?: string;     // 处理后的链接
    platformName?: string; // 平台名称
    processed?: boolean;   // 是否实际发生了处理
}

/**
 * 实际处理链接的函数
 */
async function processLinkInfo(linkInfo: LinkInfo): Promise<LinkInfo> {
    try {
        const link = linkInfo.original;

        // 跳过空链接
        if (!link) return linkInfo;

        // 根据链接类型（普通链接或特殊格式）决定处理方式
        const isSpecialFormat = !!linkInfo.originalWithAt;

        // 检查是否需要特殊处理
        const needsProcessing = isSpecialFormat || (() => {
            // 检查是否匹配任何特殊平台规则
            for (const rule of platformRules) {
                if (rule.pattern.global) {
                    rule.pattern.lastIndex = 0;
                }

                if (rule.pattern.test(link)) {
                    // 匹配规则，需要处理
                    return true;
                }
            }

            // 是否包含参数，通用URL处理条件
            return UrlUtils.shouldProcess(link);
        })();

        // 如果不需要处理，直接返回原始链接
        if (!needsProcessing) {
            linkInfo.resolved = isSpecialFormat ? linkInfo.originalWithAt : link;
            return linkInfo;
        }

        try {
            // 应用链接处理
            const { url: processedUrl, platformName } = await resolveUrl(link);

            // 根据链接类型（特殊格式或普通链接）构建返回结果
            if (isSpecialFormat) {
                // 特殊格式（如@前缀）链接处理
                // 移除协议前缀，保持与原始格式一致
                let finalUrl = processedUrl;
                if (!link.includes('://') && finalUrl.includes('://')) {
                    finalUrl = finalUrl.replace(/^https?:\/\//, '');
                }

                // 重建带有原始前缀的链接
                const prefix = linkInfo.originalWithAt?.substring(0, linkInfo.originalWithAt.indexOf(link.replace(/^https?:\/\//, '')));
                linkInfo.resolved = prefix + finalUrl;

                // 检测链接是否实际发生了处理
                if (finalUrl !== link.replace(/^https?:\/\//, '')) {
                    linkInfo.processed = true;
                }
            } else if (processedUrl !== link) {
                // 普通链接处理
                linkInfo.resolved = processedUrl;
                linkInfo.platformName = platformName;
                linkInfo.processed = true;
            } else {
                // 没有实际变化
                linkInfo.resolved = link;
            }
        } catch (error) {
            plugin.logger?.error(`处理链接失败: ${link}, 错误: ${error}`);
            // 保留原始格式
            linkInfo.resolved = isSpecialFormat ? linkInfo.originalWithAt : link;
        }

        return linkInfo;
    } catch (error) {
        plugin.logger?.error(`处理链接流程错误: ${linkInfo.original}, 错误: ${error}`);
        // 出错时保留原始格式
        linkInfo.resolved = linkInfo.originalWithAt || linkInfo.original;
        return linkInfo;
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

    // 快速检查：消息中是否可能包含URL
    if (!UrlUtils.hasUrlCharacteristics(messageText)) {
        return { text: messageText, foundLinks: false, processedCount: 0 };
    }

    // 存储所有发现的链接
    const foundLinks: LinkInfo[] = [];

    // 处理带@符号的特殊格式链接
    let atSignMatch;
    // 优化的正则表达式，匹配带@前缀的链接
    const atSignPattern = /@(https?:\/\/[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9@:%_\+~#=]{0,256}\.[a-zA-Z0-9]{1,63}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*?))/g;

    while ((atSignMatch = atSignPattern.exec(messageText)) !== null) {
        if (atSignMatch && atSignMatch[1]) {
            const fullWithAt = atSignMatch[0]; // 完整匹配，包括@符号
            let actualLink = atSignMatch[1]; // 不包括@符号的URL部分

            // 清理URL末尾的标点符号
            actualLink = UrlUtils.cleanUrlEnding(actualLink);

            // 处理无协议前缀的链接
            const urlWithProtocol = UrlUtils.ensureProtocol(actualLink);

            foundLinks.push({
                original: urlWithProtocol, // 使用带协议的URL进行处理
                originalWithAt: '@' + actualLink, // 保存原始形式用于匹配
                start: atSignMatch.index,
                end: atSignMatch.index + fullWithAt.length // 使用原始长度保持文本位置正确
            });
        }
    }

    // 重置正则表达式状态
    atSignPattern.lastIndex = 0;

    // 查找普通链接（不带@前缀）
    let urlMatch;
    while ((urlMatch = URL_PATTERNS.PROTOCOL_URL.exec(messageText)) !== null) {
        const fullMatch = urlMatch[0];
        // 清理URL末尾的标点符号
        const link = UrlUtils.cleanUrlEnding(fullMatch);

        const start = urlMatch.index;
        const end = start + fullMatch.length; // 保持原始长度以维持正确的文本位置

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

    // 重置正则表达式状态
    URL_PATTERNS.PROTOCOL_URL.lastIndex = 0;

    // 匹配无协议前缀的链接
    let noProtocolMatch;
    while ((noProtocolMatch = URL_PATTERNS.NO_PROTOCOL_URL.exec(messageText)) !== null) {
        if (noProtocolMatch && noProtocolMatch[1]) {
            const link = noProtocolMatch[1];
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

    // 重置正则表达式状态
    URL_PATTERNS.NO_PROTOCOL_URL.lastIndex = 0;

    // 在链接识别完成后添加日志
    plugin.logger?.debug(`共找到 ${foundLinks.length} 个链接`);
    if (config.debug) {
        for (let i = 0; i < foundLinks.length; i++) {
            const link = foundLinks[i];
            if (link && link.original) {
                plugin.logger?.debug(`链接 ${i + 1}: ${link.original} (${link.start}-${link.end}) ${link.originalWithAt ? '带@前缀' : ''}`);
            }
        }
    }

    // 如果没有找到任何链接，直接返回原始文本
    if (foundLinks.length === 0) {
        return { text: messageText, foundLinks: false, processedCount: 0 };
    }

    // 批量处理URL - 使用Promise.all并限制并发请求数
    // 使用信号量控制并发
    let runningRequests = 0;
    const maxConcurrentRequests = config.maxConcurrentRequests;

    // 控制并发的辅助函数
    async function processWithConcurrencyLimit(linkInfo: LinkInfo): Promise<LinkInfo> {
        // 等待有空闲槽位
        while (runningRequests >= maxConcurrentRequests) {
            await new Promise(resolve => setTimeout(resolve, config.processingCheckInterval));
        }

        runningRequests++;
        try {
            return await processLinkInfo(linkInfo);
        } finally {
            runningRequests--;
        }
    }

    // 对所有链接进行处理，使用有限并发
    const processedLinks = await Promise.all(
        foundLinks.map(linkInfo => processWithConcurrencyLimit(linkInfo))
    ).then(links => links.filter(info => info.resolved !== undefined));

    // 计算实际处理的链接数量
    processedCount = processedLinks.filter(link => link.processed).length;

    // 如果没有处理任何链接，直接返回原始文本
    if (processedCount === 0) {
        return { text: messageText, foundLinks: true, processedCount: 0 };
    }

    // 按照位置从后往前排序，以便从后向前替换不影响前面的位置
    processedLinks.sort((a, b) => b.start - a.start);

    // 优化替换逻辑，一次性构建新字符串而不是多次替换
    let lastEnd = messageText.length;
    let parts: string[] = [];

    for (const linkInfo of processedLinks) {
        if (linkInfo.resolved && (linkInfo.originalWithAt || linkInfo.processed)) {
            // 添加当前链接后面的文本
            if (linkInfo.end < lastEnd) {
                parts.unshift(messageText.substring(linkInfo.end, lastEnd));
            }

            // 添加处理后的链接
            parts.unshift(linkInfo.resolved);

            // 更新lastEnd为当前链接的开始位置
            lastEnd = linkInfo.start;
        }
    }

    // 添加最前面的文本
    if (lastEnd > 0) {
        parts.unshift(messageText.substring(0, lastEnd));
    }

    // 组合成最终文本
    const result = parts.join('');

    // 在结果返回前添加日志
    plugin.logger?.debug(`处理完成, 共处理了 ${processedCount} 个链接`);

    return {
        text: result.trim(),
        foundLinks: true,
        processedCount
    };
}

/**
 * 隐私插件主体
 */
const plugin: BotPlugin = {
    name: 'privacy',
    description: '防跟踪链接处理插件',
    version: '2.3.0',

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
                    plugin.logger?.debug(`测试处理链接: ${testUrl}`);

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
- 版本: 2.3.0<br>
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

                // 快速检查：消息是否为空、太短或不包含可能的URL特征
                if (messageText.length < config.minUrlLength || !UrlUtils.hasUrlCharacteristics(messageText)) {
                    return;
                }

                try {
                    const { text: processedText, foundLinks, processedCount } = await processLinksInMessage(messageText);

                    // 只有在找到链接并且实际处理了链接（有变化）时才替换消息
                    if (foundLinks && processedCount > 0 && processedText !== messageText) {
                        const content = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 分享内容（隐私保护，已移除跟踪参数）:\n${processedText}`;

                        // 添加删除按钮（系统自动触发使用0作为发起人ID）
                        const callbackData = DeletePrivacyCallback.build({
                            initiatorId: 0,
                            originalSenderId: ctx.message.sender.id
                        });

                        const keyboard = BotKeyboard.inline([[
                            BotKeyboard.callback('🗑️ 删除', callbackData)
                        ]]);

                        try {
                            // 发送替换后的消息
                            await ctx.message.answerText(content, { replyMarkup: keyboard });

                            // 删除原消息
                            await ctx.message.delete().catch(error => {
                                plugin.logger?.error(`删除原消息失败: ${error}`);
                            });
                        } catch (sendError) {
                            plugin.logger?.error(`发送替换消息失败: ${sendError}`);
                        }
                    }
                } catch (error) {
                    plugin.logger?.error(`处理消息错误: ${error}`);
                }
            }
        },
        // 添加删除回调处理事件
        {
            type: 'callback',
            name: 'del',
            async handler(ctx: CallbackEventContext) {
                await handleDeleteCallback(ctx);
            }
        }
    ],

    // 添加初始化函数
    async onLoad(): Promise<void> {
        initializeUrlPatterns();

        // 尝试构建组合正则表达式
        combinedRulePattern = URL_PATTERNS.buildCombinedRulePattern();
        if (combinedRulePattern) {
            plugin.logger?.debug("成功构建组合正则表达式");
        } else {
            plugin.logger?.debug("无法构建组合正则表达式，将使用传统匹配方式");
        }
    }
};

export default plugin; 