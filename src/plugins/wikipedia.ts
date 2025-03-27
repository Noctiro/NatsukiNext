import { md } from "@mtcute/markdown-parser";
import type { BotPlugin, CommandContext } from "../features";
import { log } from "../log";

// 类型定义
type WikiLang = 'zh' | 'en' | 'jp' | 'kr' | 'fr' | 'de' | 'ru';
type WikiApiInfo = {
    search: string;
    lang: string;
    flag: string;
};
type WikiResponse = {
    query?: {
        pages?: Record<string, WikiPage>;
    };
};
type WikiPage = {
    pageid: number;
    title: string;
    extract?: string;
    fullurl?: string;
    langlinks?: Array<{
        lang: string;
        url: string;
        '*': string;
    }>;
    [key: string]: any;
};

// 维基百科API终端点和语言配置
const WIKI_API: Record<WikiLang, WikiApiInfo> = {
    zh: {
        search: "https://zh.wikipedia.org/w/api.php",
        lang: "中文",
        flag: "🇨🇳"
    },
    en: {
        search: "https://en.wikipedia.org/w/api.php",
        lang: "English",
        flag: "🇬🇧"
    },
    jp: {
        search: "https://ja.wikipedia.org/w/api.php",
        lang: "日本語",
        flag: "🇯🇵"
    },
    kr: {
        search: "https://ko.wikipedia.org/w/api.php",
        lang: "한국어",
        flag: "🇰🇷"
    },
    fr: {
        search: "https://fr.wikipedia.org/w/api.php",
        lang: "Français",
        flag: "🇫🇷"
    },
    de: {
        search: "https://de.wikipedia.org/w/api.php",
        lang: "Deutsch",
        flag: "🇩🇪"
    },
    ru: {
        search: "https://ru.wikipedia.org/w/api.php",
        lang: "Русский",
        flag: "🇷🇺"
    }
};

// 常量定义
const DEFAULT_LANG: WikiLang = 'zh';
const MAX_RESULTS = 5;

// 帮助信息
const HELP_TEXT = md`
📚 **维基百科查询工具**

**基本用法：**
\`/wiki <关键词>\` - 搜索维基百科
\`/wiki -l <语言代码> <关键词>\` - 指定语言搜索

**高级选项：**
\`-p <页数>\`: 显示更多结果 (最多${MAX_RESULTS}条)
\`-r\`: 随机条目
\`-i\`: 显示其他语言版本链接

**示例：**
\`/wiki 太阳\`
\`/wiki -l jp 太陽\`
\`/wiki -l en -i Sun\`
\`/wiki -p 2 历史\`
\`/wiki -r\`

**支持语言：**
${Object.entries(WIKI_API).map(([code, info]) =>
    `${info.flag} ${info.lang}(${code})`
).join(' | ')}`;

// 插件定义
const plugin: BotPlugin = {
    name: 'wikipedia',
    description: '维基百科查询工具',
    version: '1.0.0',

    commands: [
        {
            name: 'wiki',
            description: '查询维基百科',
            cooldown: 5,
            async handler(ctx: CommandContext) {
                // 如果没有内容或是help命令，显示帮助
                if (!ctx.content || ctx.content.trim().toLowerCase() === 'help') {
                    await ctx.message.replyText(HELP_TEXT);
                    return;
                }

                // 回复等待消息
                const waitMsg = await ctx.message.replyText("🔍 正在查询中...");
                if (!waitMsg?.id) {
                    log.error("无法发送等待消息");
                    return;
                }

                try {
                    // 解析命令参数
                    const args = ctx.args;
                    // 获取语言选项，确保是有效的WikiLang
                    const langIdx = args.indexOf('-l');
                    const langInput = langIdx !== -1 && args.length > langIdx + 1 ?
                        String(args[langIdx + 1]) : DEFAULT_LANG;
                    const selectedLang = isValidWikiLang(langInput) ? langInput : DEFAULT_LANG;

                    const options = {
                        lang: selectedLang,
                        limit: args.includes('-p') ?
                            Math.min(parseInt(args[args.indexOf('-p') + 1] || '1'), MAX_RESULTS) : 1,
                        random: args.includes('-r'),
                        interwiki: args.includes('-i')
                    };

                    // 检查语言是否支持
                    if (!isValidWikiLang(options.lang)) {
                        const supportedLangs = Object.keys(WIKI_API)
                            .map(code => `${WIKI_API[code as WikiLang].flag}${code}`)
                            .join(', ');

                        await ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: waitMsg.id,
                            text: `❌ 不支持的语言代码\n支持的语言：${supportedLangs}`
                        });
                        return;
                    }

                    let responseText: string[] = [];

                    if (options.random) {
                        // 获取随机条目
                        try {
                            const article = await getRandomArticle(options.lang);
                            responseText = [
                                `📎 随机条目：\n`,
                                formatSearchResult(article, options.lang, options.interwiki)
                            ];
                        } catch (err) {
                            throw new Error(`${WIKI_API[options.lang].flag} 随机条目获取失败: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    } else {
                        // 关键词搜索
                        const cleanedKeyword = cleanKeyword(ctx.content, args);
                        if (!cleanedKeyword.trim()) {
                            await ctx.client.editMessage({
                                chatId: ctx.chatId,
                                message: waitMsg.id,
                                text: `❌ 请提供有效的搜索关键词`
                            });
                            return;
                        }

                        try {
                            const results = await searchWiki(cleanedKeyword, options.lang, options.limit, options.interwiki);

                            responseText = [
                                `📚 维基百科搜索结果 (${WIKI_API[options.lang].lang})：`,
                                `🔍 关键词: ${cleanedKeyword}`,
                                ''
                            ];

                            results.forEach((result, i) => {
                                responseText.push(formatSearchResult(result, options.lang, options.interwiki));
                                if (i < results.length - 1) responseText.push('\n──────────\n');
                            });
                        } catch (err) {
                            throw new Error(`${WIKI_API[options.lang].flag} 搜索失败: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }

                    // 更新等待消息
                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: waitMsg.id,
                        text: responseText.join('\n')
                    });
                } catch (error) {
                    const errorMsg = [
                        '❌ 查询失败',
                        error instanceof Error ? error.message : String(error),
                        '',
                        '💡 提示：使用 /wiki help 查看帮助'
                    ];

                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: waitMsg.id,
                        text: errorMsg.join('\n')
                    }).catch(e => {
                        log.error(`无法更新错误消息: ${e}`);
                    });
                }
            }
        }
    ]
};

/**
 * 检查是否为有效的wiki语言代码
 */
function isValidWikiLang(lang: string): lang is WikiLang {
    return Object.keys(WIKI_API).includes(lang as WikiLang);
}

/**
 * 搜索维基百科
 */
async function searchWiki(keyword: string, lang: WikiLang, limit = 1, withInterwiki = false): Promise<WikiPage[]> {
    // 构建请求参数
    const params = new URLSearchParams();
    params.append('action', 'query');
    params.append('format', 'json');
    params.append('origin', '*');
    params.append('exchars', '300');
    params.append('exintro', '1');
    params.append('explaintext', '1');
    params.append('gsrlimit', limit.toString());
    params.append('gsrsearch', keyword);
    params.append('inprop', 'url');
    params.append('pithumbsize', '200');
    params.append('lllimit', '500');
    params.append('llprop', 'url|langname');

    // 确定要获取的属性
    let props = ['extracts', 'info', 'pageimages'];
    if (withInterwiki) {
        props.push('langlinks');
    }
    params.append('prop', props.join('|'));
    params.append('generator', 'search');

    // 发送请求
    const apiUrl = `${WIKI_API[lang].search}?${params.toString()}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
        throw new Error(`维基百科API请求失败: ${response.status}`);
    }

    const data = await response.json() as WikiResponse;

    if (!data.query?.pages) {
        throw new Error(`${WIKI_API[lang].flag} 未找到相关条目`);
    }

    return Object.values(data.query.pages);
}

/**
 * 获取随机维基百科条目
 */
async function getRandomArticle(lang: WikiLang): Promise<WikiPage> {
    // 构建请求参数
    const params = new URLSearchParams();
    params.append('action', 'query');
    params.append('format', 'json');
    params.append('origin', '*');
    params.append('prop', 'extracts|info|pageimages');
    params.append('generator', 'random');
    params.append('grnnamespace', '0');
    params.append('grnlimit', '1');
    params.append('exchars', '200');
    params.append('exintro', '1');
    params.append('explaintext', '1');
    params.append('inprop', 'url');
    params.append('piprop', 'thumbnail');
    params.append('pithumbsize', '100');

    // 发送请求
    const apiUrl = `${WIKI_API[lang].search}?${params.toString()}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
        throw new Error(`维基百科API请求失败: ${response.status}`);
    }

    const data = await response.json() as WikiResponse;

    if (!data.query?.pages) {
        throw new Error(`${WIKI_API[lang].flag} 获取随机条目失败`);
    }

    const pages = Object.values(data.query.pages);
    if (pages.length === 0) {
        throw new Error(`${WIKI_API[lang].flag} 获取随机条目失败`);
    }

    // 确保返回类型正确
    return pages[0] as WikiPage;
}

/**
 * 格式化搜索结果
 */
function formatSearchResult(result: WikiPage, lang: WikiLang, showInterwiki = false): string {
    const langInfo = WIKI_API[lang];
    const lines = [
        `${langInfo.flag} ${result.title}`,
        result.extract?.slice(0, 300) || '暂无简介',
        '',
        `🔗 ${result.fullurl || `https://${lang}.wikipedia.org/?curid=${result.pageid}`}`
    ];

    if (showInterwiki && result.langlinks && result.langlinks.length > 0) {
        lines.push('', '🌐 其他语言版本:');
        result.langlinks.forEach((link) => {
            const linkLang = link.lang;
            if (isValidWikiLang(linkLang)) {
                const linkInfo = WIKI_API[linkLang];
                lines.push(`${linkInfo.flag} ${link.url}`);
            }
        });
    }

    return lines.join('\n');
}

/**
 * 清理关键词，移除选项
 */
function cleanKeyword(content: string, args: string[]): string {
    let keyword = content;
    const options = ['-l', '-p', '-i', '-r'];

    for (const opt of options) {
        if (args.includes(opt)) {
            const index = args.indexOf(opt);
            // 移除选项及其值（如果有）
            if (['-l', '-p'].includes(opt) && index + 1 < args.length) {
                keyword = keyword.replace(`${opt} ${args[index + 1]}`, '').trim();
            } else {
                keyword = keyword.replace(opt, '').trim();
            }
        }
    }
    return keyword;
}

export default plugin; 