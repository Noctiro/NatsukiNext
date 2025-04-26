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
 *        needsRedirection: false,                  // 是否需要重定向解析
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
 *        needsRedirection: false,
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
 *        needsRedirection: false,
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
 * 4. 短链接处理规则 - 需要解析重定向:
 *    ```typescript
 *    {
 *        name: "短链接平台",
 *        pattern: /https?:\/\/(?:www\.)?t\.co\/[a-zA-Z0-9]+/,
 *        description: "解析短链接并清理参数",
 *        needsRedirection: true,  // 表示需要解析重定向
 *        transform: (url, match, redirectResult) => { // 第三个参数为重定向结果
 *            if (redirectResult) {
 *                // 处理重定向后的URL
 *                return CommonTransforms.removeAllParams(redirectResult, null);
 *            }
 *            return url; // 默认返回原始URL
 *        }
 *    }
 *    ```
 * 
 * 可用的通用转换函数:
 * ---------------
 * - CommonTransforms.removeAllParams: 移除所有URL参数
 * - CommonTransforms.keepOnlyParams(['param1', 'param2']): 仅保留指定参数
 * - CommonTransforms.removeParams(['param1', 'param2']): 移除指定参数，保留其他参数
 * - CommonTransforms.removeTrackingParams: 移除常见跟踪参数
 * - CommonTransforms.buildFromMatch('template'): 使用模板和正则匹配结果构建URL
 */

import { html, BotKeyboard, TelegramClient } from "@mtcute/bun";
import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from "../features";
import { generateRandomUserAgent } from "../utils/UserAgent";
import { CallbackDataBuilder } from "../utils/callback";

// 插件配置
const config = {
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
    needsRedirection?: boolean;   // 是否需要解析重定向（如短链接）
    transform?: (url: string, match: RegExpMatchArray | null, redirectResult?: string) => string; // 转换函数，第三个参数为重定向结果
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
        try {
            const patterns = platformRules.map(rule => {
                // 移除开始/结束标记并提取正则源代码
                const pattern = rule.pattern.source.replace(/^\/|\/[gimsuy]*$/g, '');

                // 用命名捕获组包装每个规则，确保规则名称是有效的正则命名捕获组名
                // 命名捕获组名只能包含字母、数字和下划线，不能以数字开头
                const safeName = rule.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

                return `(?<${safeName}>${pattern})`;
            });

            // 使用|组合所有模式，并创建全局正则
            return new RegExp(patterns.join('|'), 'g');
        } catch (e) {
            // 如果正则表达式过于复杂，创建失败，打印详细错误并返回null
            plugin.logger?.error(`创建组合正则表达式失败: ${e}`);
            return null;
        }
    }
};

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
     * 例如将www.example.com转换为https://www.example.com
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
        pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)(?:\?[^&]+(?:&[^&]+)*)?/,
        description: "将YouTube短链接转换为标准格式",
        needsRedirection: true,
        transform: (url, match) => {
            if (match && match[1]) {
                const videoId = match[1];

                // 直接使用视频ID构建标准YouTube链接
                let result = `https://www.youtube.com/watch?v=${videoId}`;

                try {
                    // 使用URL对象解析参数
                    const parsedUrl = new URL(url);
                    // 提取时间参数
                    const timeParam = parsedUrl.searchParams.get('t');

                    // 如果有时间参数，加入到结果链接
                    if (timeParam) {
                        result = `https://www.youtube.com/watch?v=${videoId}&t=${timeParam}`;
                    }
                } catch (e) {
                    // 解析URL失败时，使用正则表达式提取时间参数
                    const timeMatch = url.match(/[?&]t=([^&]+)/);
                    if (timeMatch && timeMatch[1]) {
                        result = `https://www.youtube.com/watch?v=${videoId}&t=${timeMatch[1]}`;
                    }
                }

                return result;
            }
            return url;
        }
    },
    {
        name: "YouTube标准链接",
        pattern: /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]+)(?:&.*)?/,
        description: "保留YouTube视频ID和时间戳，移除跟踪参数",
        needsRedirection: false,
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
        needsRedirection: false,
        transform: (url, match) => {
            if (match && match[1]) {
                return `https://www.youtube.com/watch?v=${match[1]}`;
            }
            return url;
        }
    },

    {
        name: "YouTube Posts",
        pattern: /https?:\/\/(?:www\.)?youtube\.com\/post\/([\w-]+)(?:\?.*)?/,
        description: "去除Youtube Posts的跟踪参数",
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.removeAllParams
    },

    // 哔哩哔哩 - 需要保留时间戳参数，去除其他跟踪参数
    {
        name: "哔哩哔哩视频",
        pattern: /https?:\/\/(?:www\.)?bilibili\.com\/video\/(?:[Bb][Vv][\w-]+|[Aa][Vv]\d+)(?:\/?\?.*)?/i,
        description: "保留哔哩哔哩视频ID和时间戳，移除其他跟踪参数",
        needsRedirection: false,
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
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.removeAllParams
    },

    // Instagram - 完整支持，包括多种内容格式
    {
        name: "Instagram帖子",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)(?:\?.*)?/,
        description: "清理Instagram帖子链接，移除igsh等跟踪参数",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.removeAllParams
    },
    {
        name: "Instagram Reels",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/reel\/([\w-]+)(?:\?.*)?/,
        description: "统一Instagram Reels格式",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.removeAllParams
    },
    {
        name: "Instagram Stories",
        pattern: /https?:\/\/(?:www\.)?instagram\.com\/stories\/([^\/]+)\/(\d+)(?:\?.*)?/,
        description: "清理Instagram Stories链接",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.removeAllParams
    },

    // Facebook - 提取视频ID和帖子ID
    {
        name: "Facebook视频",
        pattern: /https?:\/\/(?:www\.)?facebook\.com\/(?:watch\/\?v=|[\w.]+\/videos\/)(\d+)(?:\?.*)?/,
        description: "统一Facebook视频格式，移除跟踪参数",
        needsRedirection: false,
        shouldTransform: (url) => {
            // 如果是watch/?v=格式，检查是否有其他参数
            if (url.includes('/watch/?v=')) {
                try {
                    const parsedUrl = new URL(url);
                    // 如果只有v参数，则不需要转换
                    return !(parsedUrl.searchParams.size === 1 && parsedUrl.searchParams.has('v'));
                } catch (e) {
                    return true; // 解析失败时默认转换
                }
            }
            // 其他格式（如/videos/）都需要转换
            return true;
        },
        transform: CommonTransforms.buildFromMatch('https://www.facebook.com/watch/?v=$1')
    },
    {
        name: "Facebook帖子",
        pattern: /https?:\/\/(?:www\.)?facebook\.com\/(?:[\w.]+\/posts\/|permalink\.php\?story_fbid=)(\d+)(?:&|\?)?(?:.*)?/,
        description: "清理Facebook帖子链接",
        needsRedirection: false,
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
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.buildFromMatch('https://www.tiktok.com/@$1/video/$2')
    },

    {
        name: "Reddit",
        pattern: /https?:\/\/(?:www\.)?reddit\.com\/r\/([^\/]+)\/comments\/([^\/]+)(?:\/[^\/]+)?(?:\/)?(?:\?.*)?/,
        description: "清理Reddit帖子链接",
        needsRedirection: false,
        transform: CommonTransforms.buildFromMatch('https://www.reddit.com/r/$1/comments/$2')
    },

    {
        name: "LinkedIn",
        pattern: /https?:\/\/(?:www\.)?linkedin\.com\/(?:posts|feed\/update)(?:\/|\?)(?:.*?)(?:activity:|id=)([\w-]+)(?:&.*)?/,
        description: "清理LinkedIn帖子链接",
        needsRedirection: false,
        transform: CommonTransforms.buildFromMatch('https://www.linkedin.com/feed/update/urn:li:activity:$1')
    },

    {
        name: "Pinterest",
        pattern: /https?:\/\/(?:www\.)?pinterest\.(?:com|[a-z]{2})\/pin\/(\d+)(?:\?.*)?/,
        description: "清理Pinterest图钉链接",
        needsRedirection: false,
        transform: CommonTransforms.buildFromMatch('https://www.pinterest.com/pin/$1')
    },

    {
        name: "Spotify",
        pattern: /https?:\/\/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)(?:\?.*)?/,
        description: "清理Spotify链接",
        needsRedirection: false,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "SoundCloud",
        pattern: /https?:\/\/(?:www\.)?soundcloud\.com\/([^\/]+)\/([^\/\?]+)(?:\?.*)?/,
        description: "清理SoundCloud链接",
        needsRedirection: false,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "Medium",
        pattern: /https?:\/\/(?:www\.)?medium\.com\/(?:@?[^\/]+\/)?([^\/\?]+)(?:\?.*)?/,
        description: "清理Medium文章链接",
        needsRedirection: false,
        transform: CommonTransforms.removeAllParams
    },

    {
        name: "哔哩哔哩短链接",
        pattern: /https?:\/\/b23\.tv\/[\w-]+/,
        description: "解析哔哩哔哩短链接并清理参数",
        needsRedirection: true,
        transform: (url, match, redirectResult) => {
            // 如果是重定向结果处理
            if (redirectResult) {
                try {
                    const parsedUrl = new URL(redirectResult);
                    // 如果是哔哩哔哩视频链接，只保留t和p参数
                    if (parsedUrl.hostname.includes('bilibili.com') &&
                        (parsedUrl.pathname.includes('/video/') || /[Bb][Vv]\w+/.test(parsedUrl.pathname))) {
                        return CommonTransforms.keepOnlyParams(['t', 'p'])(redirectResult, null);
                    }
                } catch (e) {
                    // 解析失败则使用默认清理
                }
                // 默认情况下移除所有参数
                return CommonTransforms.removeAllParams(redirectResult, null);
            }

            // 默认返回原URL（重定向前）
            return url;
        }
    },
    {
        name: "小红书短链接",
        pattern: /https?:\/\/xhslink\.com\/[\w-]+/,
        description: "解析小红书链接并清理参数",
        needsRedirection: true,
        transform: (url, match, redirectResult) => {
            // 如果是重定向结果处理
            if (redirectResult) {
                // 如果解析到小红书链接，保持简洁格式
                try {
                    if (redirectResult.includes('xiaohongshu.com')) {
                        const parsedUrl = new URL(redirectResult);
                        // 小红书笔记链接特殊处理
                        if (parsedUrl.pathname.includes('/explore/')) {
                            const noteIdMatch = parsedUrl.pathname.match(/\/explore\/(\w+)/);
                            if (noteIdMatch && noteIdMatch[1]) {
                                return `https://www.xiaohongshu.com/explore/${noteIdMatch[1]}`;
                            }
                        }
                    }
                } catch (e) {
                    // 处理失败，使用默认清理
                }
                // 默认清理所有参数
                return CommonTransforms.removeAllParams(redirectResult, null);
            }

            // 默认返回原URL（重定向前）
            return url;
        }
    },
    {
        name: "微博短链接",
        pattern: /https?:\/\/t\.cn\/[\w-]+/,
        description: "解析微博短链接并清理参数",
        needsRedirection: true,
        transform: (url, match, redirectResult) => {
            // 如果是重定向结果处理
            if (redirectResult) {
                // 微博链接特殊处理
                try {
                    const parsedUrl = new URL(redirectResult);
                    // 如果是微博域名
                    if (parsedUrl.hostname.includes('weibo.com') || parsedUrl.hostname.includes('weibo.cn')) {
                        // 对微博详情页特殊处理
                        if (parsedUrl.pathname.includes('/detail/')) {
                            const detailIdMatch = parsedUrl.pathname.match(/\/detail\/(\w+)/);
                            if (detailIdMatch && detailIdMatch[1]) {
                                // 构建干净的微博详情页链接
                                return `https://weibo.com/detail/${detailIdMatch[1]}`;
                            }
                        }
                        // 对用户主页特殊处理
                        else if (parsedUrl.pathname.match(/\/u\/\d+/)) {
                            const userIdMatch = parsedUrl.pathname.match(/\/u\/(\d+)/);
                            if (userIdMatch && userIdMatch[1]) {
                                return `https://weibo.com/u/${userIdMatch[1]}`;
                            }
                        }
                    }
                } catch (e) {
                    // 处理失败，使用默认清理
                }
                // 默认清理所有参数
                return CommonTransforms.removeAllParams(redirectResult, null);
            }

            // 默认返回原URL（重定向前）
            return url;
        }
    },
    {
        name: "抖音短链接",
        pattern: /https?:\/\/v\.douyin\.com\/[\w-]+/,
        description: "解析抖音短链接并清理参数",
        needsRedirection: true,
        transform: (url, match, redirectResult) => {
            // 如果是重定向结果处理
            if (redirectResult) {
                // 如果解析到了抖音视频网页版，提取视频ID并构建干净链接
                try {
                    if (redirectResult.includes('douyin.com/video/')) {
                        const match = redirectResult.match(/\/video\/(\d+)/);
                        if (match && match[1]) {
                            return `https://www.douyin.com/video/${match[1]}`;
                        }
                    }
                } catch (e) {
                    // 处理失败，返回默认清理
                }
                // 默认情况下移除所有参数
                return CommonTransforms.removeAllParams(redirectResult, null);
            }

            // 默认返回原URL（重定向前）
            return url;
        }
    },
    {
        name: "知乎外链",
        pattern: /https?:\/\/link\.zhihu\.com\/\?(?:target|url)=([^&]+)(?:&.*)?/,
        description: "解析知乎外链",
        needsRedirection: false,
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
        needsRedirection: false,
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
        name: "微信公众号文章",
        pattern: /https?:\/\/mp\.weixin\.qq\.com\/s\/([a-zA-Z0-9_-]+)(?:\?.*)?/,
        description: "清理微信公众号文章链接",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'), // 只有有参数时才转换
        transform: CommonTransforms.buildFromMatch('https://mp.weixin.qq.com/s/$1')
    },
    {
        name: "亚马逊产品",
        pattern: /https?:\/\/(?:www\.)?amazon\.(?:com|co\.jp|co\.uk|de|fr|it|es|cn)\/(?:.*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/.*)?(?:\?.*)?/,
        description: "清理亚马逊产品链接",
        needsRedirection: false,
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
        needsRedirection: false,
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
        name: "Apple Music",
        pattern: /https?:\/\/music\.apple\.com\/(?:[a-z]{2}\/)?(?:album|playlist|artist)\/(?:[^\/]+)\/(?:[^\/\?]+)(?:\?.*)?/,
        description: "清理Apple Music链接，移除跟踪参数",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'),
        transform: CommonTransforms.removeAllParams
    },
    {
        name: "Telegram公开链接",
        pattern: /https?:\/\/(?:t\.me|telegram\.me)\/([^\/\?]+)(?:\/\d+)?(?:\?.*)?/,
        description: "清理Telegram公开链接参数",
        needsRedirection: false,
        shouldTransform: (url) => url.includes('?'),
        transform: CommonTransforms.removeAllParams
    }
];

/**
 * 应用特殊平台规则
 * @param url 原始URL
 * @returns 处理后的URL和平台名称
 */
async function applySpecialRules(url: string): Promise<{ url: string, platformName?: string }> {
    // 为无协议前缀的URL添加临时前缀以便匹配规则
    const hasProtocol = UrlUtils.hasProtocol(url);
    const urlWithProtocol = UrlUtils.ensureProtocol(url);

    try {
        // 使用统一方法匹配规则
        const matchedRule = findMatchingPlatformRule(url, urlWithProtocol);
        if (matchedRule) {
            const { rule, match } = matchedRule;

            if (!rule.needsRedirection && rule.transform) {
                try {
                    // 检查是否需要转换
                    if (rule.shouldTransform && !rule.shouldTransform(urlWithProtocol, match)) {
                        return { url, platformName: rule.name };
                    }

                    // 应用转换
                    const transformedUrl = rule.transform(url, match);
                    if (transformedUrl && transformedUrl !== url) {
                        // 保持原始URL的协议风格
                        const finalUrl = UrlUtils.removeProtocolIfNeeded(url, transformedUrl);
                        return { url: finalUrl, platformName: rule.name };
                    }
                } catch (transformError) {
                    // 转换过程中出现错误，记录并返回原始URL
                    plugin.logger?.warn(`规则 ${rule.name} 转换失败: ${transformError}`);
                    return { url, platformName: rule.name };
                }
            } else if (rule.needsRedirection) {
                // 短链接平台，进行网络请求解析
                try {
                    return await resolveAndCleanShortUrl(url, urlWithProtocol, rule.name);
                } catch (error) {
                    plugin.logger?.warn(`解析短链接 ${url} 失败: ${error}`);
                    return { url, platformName: rule.name };
                }
            }
        }

        return { url };
    } catch (error) {
        plugin.logger?.error(`应用特殊规则时出错: ${error}`);
        return { url };
    }
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
        const matchedRule = findMatchingPlatformRule(url, urlWithProtocol);
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
 * 检查URL是否需要参数清理处理
 * 判断URL是否包含需要清理的参数，避免处理已经干净的URL
 */
function needsTrackingParamsCleaning(url: string): boolean {
    // 直接使用旧的函数实现，保持一致性
    return shouldProcessUrl(url);
}

/**
 * 应用通用清理规则 - 移除常见跟踪参数
 * @param url 原始URL
 * @returns 清理后的URL和平台信息
 */
async function applyGeneralTrackingCleanRules(url: string): Promise<{ url: string, platformName?: string }> {
    if (!url) return { url: '' };

    try {
        // 处理特定平台的特殊规则
        const specialResult = await applySpecialRules(url);

        // 如果有特殊处理结果，直接返回
        if (specialResult.url !== url) {
            plugin.logger?.debug(`应用了特殊规则: ${specialResult.platformName} - ${specialResult.url}`);
            return specialResult;
        }

        // 对于一般URL，仅移除常见跟踪参数，而不是移除全部参数
        const cleanedUrl = CommonTransforms.removeTrackingParams(url, null);

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
    // 检查规则定义是否正确
    for (const rule of platformRules) {
        // 检查转换规则是否具有转换函数
        if (!rule.transform) {
            plugin.logger?.warn(`规则"${rule.name}"没有提供transform函数`);
        }
    }

    // 统计不同类型的规则数量
    const redirectionRules = platformRules.filter(rule => rule.needsRedirection).length;
    const directTransformRules = platformRules.filter(rule => !rule.needsRedirection).length;

    // 日志输出
    plugin.logger?.debug(`初始化了 ${platformRules.length} 个平台规则，其中 ${redirectionRules} 个需要重定向解析，${directTransformRules} 个直接转换`);
}

// 初始化特殊规则标识
let combinedRulePattern: RegExp | null = null;

/**
 * 智能处理链接 - 应用平台规则或解析短链接
 * @param shortUrl 原始链接或短链接
 * @returns 处理后的URL和平台信息
 */
async function processUrlWithRules(shortUrl: string): Promise<{ url: string, platformName?: string }> {
    try {
        // 快速检查
        if (!shortUrl || shortUrl.length < config.minUrlLength) {
            return { url: shortUrl };
        }

        // 准备URL
        const urlWithProtocol = UrlUtils.ensureProtocol(shortUrl);

        // 使用统一方法匹配规则
        const matchedRule = findMatchingPlatformRule(shortUrl, urlWithProtocol);
        if (matchedRule) {
            const { rule, match } = matchedRule;

            if (!rule.needsRedirection && rule.transform) {
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
            } else if (rule.needsRedirection) {
                // 短链接平台，进行网络请求解析
                return await resolveAndCleanShortUrl(shortUrl, urlWithProtocol, rule.name);
            }
        }

        // 检查是否需要清理参数
        if (needsTrackingParamsCleaning(shortUrl)) {
            // 一般URL清理
            const { url: cleanedUrl, platformName } = await applyGeneralTrackingCleanRules(shortUrl);
            if (cleanedUrl !== shortUrl) {
                return { url: cleanedUrl, platformName };
            }
        }

        // 如果上述处理都没效果，尝试网络请求
        return await resolveAndCleanShortUrl(shortUrl, urlWithProtocol);
    } catch (error) {
        plugin.logger?.error(`解析链接出现意外错误: ${error}`);
        return { url: shortUrl };
    }
}

/**
 * 查找URL匹配的平台处理规则
 * 尝试使用组合正则表达式或单独规则进行匹配
 */
function findMatchingPlatformRule(url: string, urlWithProtocol: string): { rule: SpecialUrlRule, match: RegExpMatchArray } | null {
    // 先尝试使用组合正则表达式匹配
    if (combinedRulePattern) {
        combinedRulePattern.lastIndex = 0; // 重置正则状态

        const match = combinedRulePattern.exec(url) || combinedRulePattern.exec(urlWithProtocol);
        if (match && match.groups) {
            // 找到匹配的规则名称
            for (const [key, value] of Object.entries(match.groups)) {
                if (value) {
                    // 查找对应的规则
                    for (const rule of platformRules) {
                        // 生成与buildCombinedRulePattern中相同的安全名称
                        const safeName = rule.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
                        if (safeName === key) {
                            // 使用原始规则的pattern重新匹配，以获取正确的捕获组
                            const originalMatch = value.match(rule.pattern);
                            if (originalMatch) {
                                return { rule, match: originalMatch };
                            }
                            // 如果重新匹配失败，创建一个简单的匹配结果
                            const simpleMatch = [value, value.match(rule.pattern)?.[1] || ''];
                            return { rule, match: simpleMatch as RegExpMatchArray };
                        }
                    }
                }
            }
        }
    }

    // 回退到单独规则匹配
    const originalHasProtocol = UrlUtils.hasProtocol(url);
    for (const rule of platformRules) {
        // 重置正则状态
        if (rule.pattern.global) {
            rule.pattern.lastIndex = 0;
        }

        // 尝试匹配
        let match = url.match(rule.pattern);
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
 * 执行GET请求，支持重定向
 * @param url 要访问的URL
 * @returns 重定向后的URL（如果有重定向）或者原URL
 */
async function performGetRequest(url: string): Promise<{ url: string }> {
    try {
        // 对于无法解析的链接，提前返回
        if (!url.includes("http")) {
            return { url };
        }

        // 检查是否是需要处理的短链接
        const matchedRule = findMatchingPlatformRule("", url);
        if (matchedRule && matchedRule.rule.needsRedirection) {
            const response = await fetch(url, {
                method: "GET",
                redirect: "follow",
                headers: {
                    "User-Agent": generateRandomUserAgent(),
                },
            });

            // 检查是否成功响应
            if (!response.ok) {
                return { url };
            }

            // 获取最终URL
            const finalUrl = response.url;
            return { url: finalUrl };
        }

        // 非短链接或未匹配规则，返回原URL
        return { url };
    } catch (e) {
        plugin.logger?.debug(`GET请求失败: ${e}`);
        return { url };
    }
}

/**
 * 专门处理短链接解析的辅助函数 - 通过网络请求解析短链接
 */
async function resolveAndCleanShortUrl(
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
                // 查找匹配的规则
                const matchedRule = findMatchingPlatformRule(originalUrl, urlWithProtocol);
                if (matchedRule && matchedRule.rule.needsRedirection && matchedRule.rule.transform) {
                    // 使用原始规则的transform方法处理重定向结果
                    const cleanedUrl = matchedRule.rule.transform(originalUrl, matchedRule.match, resolvedUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName: matchedRule.rule.name
                    };
                }

                // 检查解析后的URL是否匹配特定平台规则
                for (const rule of platformRules) {
                    if (rule.pattern.global) {
                        rule.pattern.lastIndex = 0;
                    }

                    // 只检查需要特殊处理的平台规则
                    if (!rule.needsRedirection && rule.transform) {
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
                if (needsTrackingParamsCleaning(resolvedUrl)) {
                    const { url: cleanedUrl } = await applyGeneralTrackingCleanRules(resolvedUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                } else {
                    // 不需要处理的URL，标准化后返回
                    const cleanedUrl = CommonTransforms.removeTrackingParams(resolvedUrl, null);
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
                // 查找匹配的规则
                const matchedRule = findMatchingPlatformRule(originalUrl, urlWithProtocol);
                if (matchedRule && matchedRule.rule.needsRedirection && matchedRule.rule.transform) {
                    // 使用原始规则的transform方法处理重定向结果
                    const cleanedUrl = matchedRule.rule.transform(originalUrl, matchedRule.match, getUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName: matchedRule.rule.name
                    };
                }

                // 检查解析后的URL是否匹配特定平台规则
                for (const rule of platformRules) {
                    if (rule.pattern.global) {
                        rule.pattern.lastIndex = 0;
                    }

                    // 只检查需要特殊处理的平台规则
                    if (!rule.needsRedirection && rule.transform) {
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
                if (needsTrackingParamsCleaning(getUrl)) {
                    const { url: cleanedUrl } = await applyGeneralTrackingCleanRules(getUrl);
                    return {
                        url: UrlUtils.removeProtocolIfNeeded(originalUrl, cleanedUrl),
                        platformName
                    };
                } else {
                    // 不需要处理的URL，标准化后返回
                    const cleanedUrl = CommonTransforms.removeTrackingParams(getUrl, null);
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
    originalSenderId: number;
}>('privacy', 'del', ['originalSenderId']);

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
            const { url: processedUrl, platformName } = await processUrlWithRules(link);

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
    processedCount: number,
    hasChanges: boolean  // 添加一个明确表示文本是否有变化的标志
}> {
    let processedCount = 0;

    // 快速检查：消息中是否可能包含URL
    if (!UrlUtils.hasUrlCharacteristics(messageText)) {
        return { text: messageText, foundLinks: false, processedCount: 0, hasChanges: false };
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

    // 如果没有找到任何链接，直接返回原始文本
    if (foundLinks.length === 0) {
        return { text: messageText, foundLinks: false, processedCount: 0, hasChanges: false };
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
        return { text: messageText, foundLinks: true, processedCount: 0, hasChanges: false };
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
    const finalText = result.trim();
    
    // 明确比较处理后的文本与原文本是否相同
    const hasChanges = result.trim() !== messageText.trim();

    // 在结果返回前添加日志
    plugin.logger?.debug(`处理完成, 共处理了 ${processedCount} 个链接, 文本${hasChanges ? '有' : '无'}变化`);

    return {
        text: finalText,
        foundLinks: true,
        processedCount,
        hasChanges
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
                await ctx.message.replyText(html`
                    🔒 <b>隐私保护插件状态</b><br>
<br>
- 版本: 2.3.0<br>
- 已支持平台: ${platformRules.length}<br>
- 活跃状态: ✅ 运行中<br>
<br>
<b>支持类型:</b> ${platformRules.map(p => p.name).join(', ')}`);
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
                    const { text: processedText, foundLinks, processedCount, hasChanges } = await processLinksInMessage(messageText);

                    // 简化条件判断，只检查处理数量和是否有变化
                    if (processedCount > 0 && hasChanges) {
                        plugin.logger?.debug(`处理链接有效，将替换消息`);
                        
                        const content = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 分享内容（隐私保护，已移除跟踪参数）:\n${processedText}`;

                        // 添加删除按钮
                        const callbackData = DeletePrivacyCallback.build({
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
                    } else if (foundLinks) {
                        // 发现链接但不需要替换消息的情况
                        const reason = processedCount === 0 ? "未处理任何链接" : "文本无变化";
                        plugin.logger?.debug(`发现链接但不替换消息: ${reason}`);
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
            plugin.logger?.info("成功构建组合正则表达式");
        } else {
            plugin.logger?.warn("无法构建组合正则表达式，将使用传统匹配方式");
        }
    }
};

export default plugin; 