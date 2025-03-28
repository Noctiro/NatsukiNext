/**
 * 高性能RSS解析器 for Bun
 * 支持 RSS 2.0、RSS 1.0、Atom、RDF 等格式
 * 优化点：类型安全、HTML清理、日期解析优化、多格式支持
 */

// 预编译正则表达式
const RSS_VERSION_REGEX = /<(?:rss|rdf:RDF|feed)[^>]+(?:version=["']([^"']+)["']|xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["'])/i;
const CHANNEL_REGEX = /<(?:channel|feed)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:channel|feed)>|<feed(?:\s+[^>]*)?\/>/i;
const ITEM_REGEX = /<(?:item|entry)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi;
const HTML_TAG_REGEX = /<\/?[a-z][^>]*>|<!--[\s\S]*?-->/gi;

// XML实体映射表 - 保留常用实体以提高性能
const XML_ENTITIES: Record<string, string> = {
    // 基本实体
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    'apos': "'",
    
    // 空格
    'nbsp': '\u00A0',
    'ensp': '\u2002',
    'emsp': '\u2003',
    'thinsp': '\u2009',
    
    // 特殊字符
    'copy': '©',
    'reg': '®',
    'trade': '™',
    'euro': '€',
    'yen': '¥',
    'pound': '£',
    'cent': '¢',
    
    // 标点符号
    'mdash': '—',
    'ndash': '–',
    'lsquo': '\'',
    'rsquo': '\'',
    'ldquo': '"',
    'rdquo': '"',
    'hellip': '…',
    'bull': '•',
    'middot': '·',
    
    // 箭头
    'larr': '←',
    'uarr': '↑',
    'rarr': '→',
    'darr': '↓',
    
    // 数学符号
    'plusmn': '±',
    'times': '×',
    'divide': '÷',
    'not': '¬',
    'micro': 'µ',
    'deg': '°',
    
    // 特殊字母
    'acute': '´',
    'uml': '¨',
    'szlig': 'ß',
    
    // 希腊字母
    'alpha': 'α',
    'beta': 'β',
    'gamma': 'γ',
    'delta': 'δ',
    'omega': 'ω'
};

// 预编译更多正则表达式以提高性能
const WHITESPACE_REGEX = /\s{2,}/g;
const URL_PROTOCOL_REGEX = /^(?!https?:\/\/)/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const NORMALIZE_SPACE_REGEX = /[\t\n\r ]+/g;
const SMART_QUOTES_REGEX = /[\u2018\u2019\u201C\u201D]/g;
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;
const TAG_CONTENT_REGEX = (tagName: string, isAll = false) =>
    new RegExp(isAll
        ? `<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`
        : `<${tagName}(?:\\s+[^>]*)?>\\s*((?:<!\\[CDATA\\[)?.*?(?:]]>)?)\\s*<\\/${tagName}>|<${tagName}(?:\\s+[^>]*)?\\/>`,
        isAll ? "gis" : "is");
const ATTRIBUTE_REGEX = (tag: string, attr: string) => new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, "i");
const ATTRIBUTE_REGEX_GLOBAL = (tag: string, attr: string) => new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, "gi");
const CDATA_REGEX = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const XML_ENTITY_REGEX = /&(#?(?:x[0-9a-f]+|\d+)|[a-z]+);/gi;

// 数据验证和清理选项接口
interface CleanOptions {
    stripHTML: boolean;
    normalizeWhitespace: boolean;
    removeControlChars: boolean;
    convertSmartQuotes: boolean;
    maxLength?: number;
    trim: boolean;
}

const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
    stripHTML: true,
    normalizeWhitespace: true,
    removeControlChars: true,
    convertSmartQuotes: true,
    trim: true
};

// 文本清理函数 - 优化后无缓存版本
function cleanText(text: string, options: Partial<CleanOptions> = {}): string {
    const opts = { ...DEFAULT_CLEAN_OPTIONS, ...options };

    if (!text) return '';

    let cleaned = text;

    // 移除控制字符
    if (opts.removeControlChars) {
        cleaned = cleaned.replace(CONTROL_CHARS_REGEX, '');
    }

    // 转换智能引号
    if (opts.convertSmartQuotes) {
        cleaned = cleaned.replace(SMART_QUOTES_REGEX, match => {
            switch (match) {
                case '\u2018': return "'";
                case '\u2019': return "'";
                case '\u201C': return '"';
                case '\u201D': return '"';
                default: return match;
            }
        });
    }

    // 规范化空白字符
    if (opts.normalizeWhitespace) {
        cleaned = cleaned
            .replace(NORMALIZE_SPACE_REGEX, ' ')
            .replace(WHITESPACE_REGEX, ' ');
    }

    // 移除HTML标签
    if (opts.stripHTML) {
        cleaned = stripHTML(cleaned);
    }

    // 截断文本
    if (opts.maxLength && cleaned.length > opts.maxLength) {
        cleaned = cleaned.slice(0, opts.maxLength).trim() + '...';
    }

    return opts.trim ? cleaned.trim() : cleaned;
}

// 内容提取函数 - 优化后无缓存版本
function safeExtract(content: string, tagName: string, options: Partial<CleanOptions> = {}): string {
    const result = extractTagContent(content, tagName);
    return result ? cleanText(result, options) : '';
}

// URL 规范化函数 - 优化后无缓存版本
function normalizeURL(url: string | undefined, baseURL?: string): string {
    if (!url) return '';

    try {
        let normalizedUrl = url;

        // 处理相对URL
        if (baseURL && URL_PROTOCOL_REGEX.test(url)) {
            normalizedUrl = new URL(url, baseURL).href;
        } else if (URL_PROTOCOL_REGEX.test(url)) {
            normalizedUrl = `https://${url}`;
        }

        // 规范化URL
        const urlObj = new URL(normalizedUrl);

        // 移除URL中的默认端口
        if ((urlObj.protocol === 'http:' && urlObj.port === '80') ||
            (urlObj.protocol === 'https:' && urlObj.port === '443')) {
            urlObj.port = '';
        }

        // 移除URL末尾的斜杠
        if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
            urlObj.pathname = urlObj.pathname.slice(0, -1);
        }

        // 规范化查询参数顺序
        const searchParams = new URLSearchParams();
        [...urlObj.searchParams.entries()].sort().forEach(([key, value]) => {
            searchParams.append(key, value);
        });
        urlObj.search = searchParams.toString();

        return urlObj.toString();
    } catch {
        return url; // 如果URL无效，返回原始URL
    }
}

// 类型定义
interface RSSItem {
    title: string;
    link: string;
    description: string;
    pubDate?: Date;
    guid?: string;
    author?: string;
    categories?: string[];
    contentEncoded?: string;
    comments?: string;
    source?: {
        title: string;
        url: string;
    };
    enclosure?: {
        url: string;
        length?: number;
        type?: string;
    };
    dcCreator?: string;
    dcDate?: Date;
    dcSubject?: string[];
    itunesDuration?: string;
    itunesExplicit?: boolean;
    itunesImage?: string;
    itunesEpisode?: number;
    itunesSeason?: number;
    mediaContent?: {
        url: string;
        type?: string;
        width?: number;
        height?: number;
        duration?: number;
    }[];
    mediaThumbnail?: string[];
    [key: string]: any;
}

interface RSSChannel {
    title: string;
    link: string;
    description: string;
    language?: string;
    copyright?: string;
    pubDate?: Date;
    lastBuildDate?: Date;
    ttl?: number;
    image?: {
        url: string;
        title?: string;
        link?: string;
        width?: number;
        height?: number;
        description?: string;
    };
    generator?: string;
    docs?: string;
    cloud?: {
        domain: string;
        port: number;
        path: string;
        registerProcedure: string;
        protocol: string;
    };
    rating?: string;
    textInput?: {
        title: string;
        description: string;
        name: string;
        link: string;
    };
    skipHours?: number[];
    skipDays?: string[];
    itunesAuthor?: string;
    itunesBlock?: boolean;
    itunesCategory?: string[];
    itunesImage?: string;
    itunesExplicit?: boolean;
    itunesComplete?: boolean;
    itunesNewFeedUrl?: string;
    items: RSSItem[];
    [key: string]: any;
}

interface RSSFeed {
    channel: RSSChannel;
    version: string;
}

// 增加 RSS 格式类型定义
type RSSFormat = 'RSS2.0' | 'RSS1.0' | 'Atom' | 'RDF' | 'JSON' | 'Unknown';

// 增加格式检测函数
function detectRSSFormat(xmlContent: string): RSSFormat {
    // 排除JSON格式(即使检测到也不支持)
    if (xmlContent.trim().startsWith('{') && xmlContent.includes('"version"')) {
        throw new Error("不支持JSON格式的RSS");
    }
    
    // RSS 2.0检测
    if (/<rss[^>]+version=["']2\.0["']/i.test(xmlContent)) return 'RSS2.0';
    // RSS 2.0但没有明确指定版本
    if (/<rss[^>]+>/i.test(xmlContent) && !/<rss[^>]+version=/i.test(xmlContent)) return 'RSS2.0';
    
    // RDF/RSS 1.0检测 
    if (/<rdf:RDF/i.test(xmlContent)) return 'RDF';
    if (/<rss[^>]+version=["']1\.0["']/i.test(xmlContent)) return 'RSS1.0';
    
    // Atom检测
    if (/<feed[^>]+xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xmlContent)) return 'Atom';
    if (/<feed[^>]*>/i.test(xmlContent)) return 'Atom'; // 简化的Atom检测
    
    // 没有匹配的格式，尝试更宽松的检测
    if (/<rss/i.test(xmlContent)) return 'RSS2.0';
    if (/<channel/i.test(xmlContent)) return 'RSS2.0';
    if (/<item/i.test(xmlContent)) return 'RSS2.0';
    if (/<entry/i.test(xmlContent)) return 'Atom';
    
    return 'Unknown';
}

// 优化后的RSS解析函数
function parseRSS(xmlContent: string): RSSFeed {
    // 基本验证
    if (!xmlContent) {
        throw new Error("Empty RSS content");
    }

    // 移除危险字符
    const cleanedContent = xmlContent.replace(INVALID_CHARS_REGEX, '');
    
    // 检查是否为JSON格式
    if (cleanedContent.trim().startsWith('{') && (
        cleanedContent.includes('"items"') || 
        cleanedContent.includes('"entries"') || 
        cleanedContent.includes('"feed"')
    )) {
        throw new Error("不支持JSON格式的RSS");
    }
    
    // 将HTML实体转换为XML实体（某些RSS源会错误地使用HTML实体）
    const normalizedContent = cleanedContent
        .replace(/&nbsp;/g, '&#160;')
        .replace(/&copy;/g, '&#169;')
        .replace(/&reg;/g, '&#174;')
        .replace(/&amp;/g, '&amp;amp;'); // 确保已转义的&amp;不被重新解释

    try {
        // 检测 RSS 格式
        const format = detectRSSFormat(normalizedContent);
        const version = RSS_VERSION_REGEX.exec(normalizedContent)?.[1] ?? format;
        
        // 根据不同格式选择解析策略
        switch (format) {
            case 'Atom':
                return parseAtom(normalizedContent);
            case 'RDF':
                return parseRDF(normalizedContent);
            case 'RSS1.0':
                return parseRDF(normalizedContent); // RSS 1.0 使用 RDF 格式
            case 'RSS2.0':
                return parseRSS2(normalizedContent, version);
            case 'Unknown':
            default:
                // 未知格式尝试检测常见的RSS元素
                if (normalizedContent.includes('<item') || normalizedContent.includes('<channel')) {
                    return parseRSS2(normalizedContent, 'RSS2.0');
                } else if (normalizedContent.includes('<entry') || normalizedContent.includes('<feed')) {
                    return parseAtom(normalizedContent);
                } else {
                    // 尝试最宽松的解析方式
                    const channel: RSSChannel = {
                        title: 'Unknown Feed',
                        link: '',
                        description: '',
                        items: []
                    };
                    
                    // 尝试从内容中直接提取标题
                    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(normalizedContent);
                    if (titleMatch && titleMatch[1]) {
                        channel.title = cleanText(titleMatch[1], { maxLength: 500 });
                    }
                    
                    // 返回默认Feed对象
                    return { channel, version: 'Unknown' };
                }
        }
    } catch (error) {
        console.error("解析RSS失败:", error);
        
        // 出错时返回最基本的Feed对象
        const channel: RSSChannel = {
            title: 'Error Parsing Feed',
            link: '',
            description: error instanceof Error ? error.message : String(error),
            items: []
        };
        
        return { channel, version: 'Error' };
    }
}

// RSS 2.0 解析函数
function parseRSS2(xmlContent: string, version: string): RSSFeed {
    const channelMatch = CHANNEL_REGEX.exec(xmlContent);
    if (!channelMatch?.[1]) {
        // 尝试使用更宽松的正则表达式
        const relaxedChannelRegex = /<channel(?:\s+[^>]*)?>([\s\S]*?)(?:<\/channel>|$)/i;
        const relaxedMatch = relaxedChannelRegex.exec(xmlContent);
        if (!relaxedMatch?.[1]) {
            // 如果仍然无法匹配，创建默认的 channel 对象
            const defaultChannel: RSSChannel = {
                title: 'Unknown Feed',
                link: '',
                description: '',
                items: []
            };
            
            // 尝试直接提取 item 标签
            const itemMatches = [...xmlContent.matchAll(/<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi)];
            if (itemMatches.length > 0) {
                defaultChannel.items = itemMatches
                    .map(match => parseItem(match[1] || ''))
                    .filter(item => item.title && item.link);
            }
            
            return { channel: defaultChannel, version };
        }
        
        // 使用放宽的匹配结果
        const channelContent = relaxedMatch[1];
        const baseURL = safeExtract(channelContent, "link");
        
        const channel: RSSChannel = {
            title: cleanText(safeExtract(channelContent, "title"), { maxLength: 500 }) || 'Unknown Feed',
            link: normalizeURL(baseURL) || '',
            description: cleanText(safeExtract(channelContent, "description"), { maxLength: 2000 }),
            items: []
        };
        
        // 解析频道元数据
        channel.language = safeExtract(channelContent, "language", { stripHTML: true });
        channel.copyright = safeExtract(channelContent, "copyright", { stripHTML: true });
        channel.pubDate = parseDate(safeExtract(channelContent, "pubDate", { stripHTML: true }));
        channel.lastBuildDate = parseDate(safeExtract(channelContent, "lastBuildDate", { stripHTML: true }));
        channel.generator = safeExtract(channelContent, "generator", { stripHTML: true });
        
        // 批量解析 items
        const itemMatches = [...channelContent.matchAll(/<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi)];
        channel.items = itemMatches
            .map(match => parseItem(match[1] || '', baseURL))
            .filter(item => item.title && item.link);
            
        return { channel, version };
    }

    const channelContent = channelMatch[1];
    const baseURL = safeExtract(channelContent, "link");

    const channel: RSSChannel = {
        title: cleanText(safeExtract(channelContent, "title"), { maxLength: 500 }) || 'Unknown Feed',
        link: normalizeURL(baseURL) || '',
        description: cleanText(safeExtract(channelContent, "description"), { maxLength: 2000 }),
        items: []
    };

    // 解析频道元数据
    channel.language = safeExtract(channelContent, "language", { stripHTML: true });
    channel.copyright = safeExtract(channelContent, "copyright", { stripHTML: true });
    channel.pubDate = parseDate(safeExtract(channelContent, "pubDate", { stripHTML: true }));
    channel.lastBuildDate = parseDate(safeExtract(channelContent, "lastBuildDate", { stripHTML: true }));
    channel.generator = safeExtract(channelContent, "generator", { stripHTML: true });

    // 解析图片
    const imageContent = safeExtract(channelContent, "image");
    if (imageContent) {
        const imageURL = safeExtract(imageContent, "url");
        if (imageURL) {
            channel.image = {
                url: normalizeURL(imageURL, baseURL),
                title: cleanText(safeExtract(imageContent, "title")),
                link: normalizeURL(safeExtract(imageContent, "link"), baseURL),
                width: parseInt(safeExtract(imageContent, "width")) || undefined,
                height: parseInt(safeExtract(imageContent, "height")) || undefined,
                description: cleanText(safeExtract(imageContent, "description"))
            };
        }
    }

    // 批量解析items - 使用更灵活的正则表达式
    const itemMatches = [...channelContent.matchAll(/<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi)];
    channel.items = itemMatches
        .map(match => parseItem(match[1] || '', baseURL))
        .filter(item => item.title && item.link); // 过滤掉无效项

    return { channel, version };
}

// Atom 解析函数
function parseAtom(xmlContent: string): RSSFeed {
    // 提取 feed 标签内容
    const channelMatch = CHANNEL_REGEX.exec(xmlContent);
    
    // 即使没有匹配到 feed 闭合标签，也尝试解析 XML 内容
    const feedContent = channelMatch?.[1] || xmlContent;
    
    // 尝试提取直接的标题和链接
    let title = cleanText(safeExtract(feedContent, "title"), { maxLength: 500 });
    
    // 处理链接 - 提取各种可能的链接格式
    const linkAlternateMatch = /<link[^>]+rel=["']?alternate["']?[^>]+href=["']([^"']+)["'][^>]*>/i.exec(feedContent);
    const linkSelfMatch = /<link[^>]+rel=["']?self["']?[^>]+href=["']([^"']+)["'][^>]*>/i.exec(feedContent);
    const genericLinkMatch = extractAttribute(feedContent, "link", "href");
    
    let link = normalizeURL(
        (linkAlternateMatch && linkAlternateMatch[1]) || 
        (linkSelfMatch && linkSelfMatch[1]) || 
        genericLinkMatch
    );
    
    // 如果找不到直接的标题，尝试在整个 XML 中搜索
    if (!title) {
        const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i.exec(xmlContent);
        if (titleMatch?.[1]) {
            title = cleanText(titleMatch[1], { maxLength: 500 });
        }
    }
    
    // 如果找不到直接的链接，尝试提取所有链接并选择第一个
    if (!link) {
        const linkMatches = [...xmlContent.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)];
        if (linkMatches.length > 0 && linkMatches[0]?.[1]) {
            link = normalizeURL(linkMatches[0][1]);
        }
    }
    
    // 如果仍然没有链接，尝试从网站元数据中提取
    if (!link) {
        const websiteMatch = /<website[^>]*>([^<]+)<\/website>/i.exec(xmlContent);
        if (websiteMatch?.[1]) {
            link = normalizeURL(websiteMatch[1]);
        }
    }
    
    // 创建 channel 对象
    const channel: RSSChannel = {
        title: title || 'Unknown Feed',
        link: link || '',
        description: cleanText(safeExtract(feedContent, "subtitle") || 
                             safeExtract(feedContent, "summary") || 
                             safeExtract(feedContent, "description") || 
                             safeExtract(feedContent, "content"), 
                     { maxLength: 2000 }),
        items: []
    };

    // 解析 Atom 特有的元数据
    // 尝试从feed标签属性中提取语言
    const langAttr = /<feed[^>]+xml:lang=["']([^"']+)["'][^>]*>/i.exec(feedContent);
    channel.language = langAttr?.[1] || safeExtract(feedContent, "lang", { stripHTML: true });
    channel.generator = safeExtract(feedContent, "generator", { stripHTML: true });
    channel.pubDate = parseDate(safeExtract(feedContent, "updated", { stripHTML: true })) || 
                     parseDate(safeExtract(feedContent, "published", { stripHTML: true }));
    
    // 解析图片 - 先查找logo标签，再查找icon标签
    const logoContent = safeExtract(feedContent, "logo") || safeExtract(feedContent, "icon");
    if (logoContent) {
        channel.image = {
            url: normalizeURL(logoContent),
            title: channel.title
        };
    }

    // 解析条目 - 更灵活的匹配模式
    const entryPattern = /<entry(?:\s+[^>]*)?>([\s\S]*?)<\/entry>/gi;
    const itemMatches = [...xmlContent.matchAll(entryPattern)];
    
    if (itemMatches.length > 0) {
        channel.items = itemMatches
            .map(match => parseAtomEntry(match[1] || '', channel.link))
            .filter(item => item.title || item.link); // 允许只有链接的条目
    } else {
        // 如果没有找到 entry 标签，尝试解析 item 标签
        const itemPattern = /<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi;
        const alternativeMatches = [...xmlContent.matchAll(itemPattern)];
        channel.items = alternativeMatches
            .map(match => parseItem(match[1] || '', channel.link))
            .filter(item => item.title || item.link);
    }

    return { channel, version: 'Atom' };
}

// Atom 条目解析函数
function parseAtomEntry(entryContent: string, baseURL?: string): RSSItem {
    const link = extractAttribute(entryContent, "link", "href");
    return {
        title: cleanText(safeExtract(entryContent, "title"), { maxLength: 500 }),
        link: normalizeURL(link) || '',  // 确保返回字符串
        description: cleanText(safeExtract(entryContent, "summary") || safeExtract(entryContent, "content"), { maxLength: 5000 }),
        pubDate: parseDate(safeExtract(entryContent, "published") || safeExtract(entryContent, "updated")),
        author: cleanText(safeExtract(entryContent, "author/name") || safeExtract(entryContent, "author")),
        guid: safeExtract(entryContent, "id"),
        categories: extractAllTags(entryContent, "category").map(cat =>
            extractAttribute(cat, "category", "term") || cleanText(cat)
        ),
        contentEncoded: cleanText(safeExtract(entryContent, "content"), { maxLength: 50000 })
    };
}

// RDF/RSS 1.0 解析函数
function parseRDF(xmlContent: string): RSSFeed {
    const channelMatch = /<channel[^>]*>([\s\S]*?)<\/channel>/i.exec(xmlContent);
    if (!channelMatch?.[1]) {
        // 尝试使用更宽松的正则表达式
        const relaxedChannelRegex = /<(?:channel|rdf:Description)[^>]*>([\s\S]*?)(?:<\/(?:channel|rdf:Description)>|$)/i;
        const relaxedMatch = relaxedChannelRegex.exec(xmlContent);
        
        if (!relaxedMatch?.[1]) {
            // 如果仍然无法匹配，创建默认的 channel 对象
            const defaultChannel: RSSChannel = {
                title: 'Unknown RDF Feed',
                link: '',
                description: '',
                items: []
            };
            
            // 尝试直接提取 item 标签
            const itemMatches = [...xmlContent.matchAll(/<(?:item|rdf:li|rdf:Description)[^>]*>([\s\S]*?)<\/(?:item|rdf:li|rdf:Description)>/gi)];
            if (itemMatches.length > 0) {
                defaultChannel.items = itemMatches
                    .map(match => parseRDFItem(match[1] || ''))
                    .filter(item => item.title && item.link);
            }
            
            return { channel: defaultChannel, version: 'RDF' };
        }
        
        // 使用放宽的匹配结果
        const channelContent = relaxedMatch[1];
        const baseURL = safeExtract(channelContent, "link");
        
        const channel: RSSChannel = {
            title: cleanText(safeExtract(channelContent, "title") || safeExtract(channelContent, "dc:title"), { maxLength: 500 }) || 'Unknown RDF Feed',
            link: normalizeURL(baseURL) || '',
            description: cleanText(safeExtract(channelContent, "description") || safeExtract(channelContent, "dc:description"), { maxLength: 2000 }),
            items: []
        };
        
        // 解析 RDF 特有的元数据
        channel.language = safeExtract(channelContent, "dc:language", { stripHTML: true });
        channel.pubDate = parseDate(safeExtract(channelContent, "dc:date", { stripHTML: true }));
        
        return { channel, version: 'RDF' };
    }

    const channelContent = channelMatch[1];
    const baseURL = safeExtract(channelContent, "link");

    const channel: RSSChannel = {
        title: cleanText(safeExtract(channelContent, "title") || safeExtract(channelContent, "dc:title"), { maxLength: 500 }) || 'Unknown RDF Feed',
        link: normalizeURL(baseURL) || '',
        description: cleanText(safeExtract(channelContent, "description") || safeExtract(channelContent, "dc:description"), { maxLength: 2000 }),
        items: []
    };

    // 解析 RDF 特有的元数据
    channel.language = safeExtract(channelContent, "dc:language", { stripHTML: true });
    channel.pubDate = parseDate(safeExtract(channelContent, "dc:date", { stripHTML: true }));

    // 解析条目 - 使用更灵活的正则表达式
    const itemPattern = /<(?:item|rdf:li|rdf:Description)[^>]*>([\s\S]*?)<\/(?:item|rdf:li|rdf:Description)>/gi;
    const itemMatches = [...xmlContent.matchAll(itemPattern)];
    channel.items = itemMatches
        .map(match => parseRDFItem(match[1] || '', baseURL))
        .filter(item => item.title && item.link);

    return { channel, version: 'RDF' };
}

// RDF 条目解析函数
function parseRDFItem(itemContent: string, baseURL?: string): RSSItem {
    const link = safeExtract(itemContent, "link");
    return {
        title: cleanText(safeExtract(itemContent, "title"), { maxLength: 500 }),
        link: normalizeURL(link) || '',  // 确保返回字符串
        description: cleanText(safeExtract(itemContent, "description"), { maxLength: 5000 }),
        pubDate: parseDate(safeExtract(itemContent, "dc:date")),
        author: cleanText(safeExtract(itemContent, "dc:creator")),
        guid: safeExtract(itemContent, "dc:identifier") || safeExtract(itemContent, "rdf:about"),
        categories: extractAllTags(itemContent, "dc:subject").map(cat => cleanText(cat))
    };
}

// 优化后的条目解析函数
function parseItem(itemContent: string, baseURL?: string): RSSItem {
    // 安全检查
    if (!itemContent) {
        return {
            title: '',
            link: '',
            description: ''
        };
    }
    
    // 提取链接并确保规范化
    const linkRaw = safeExtract(itemContent, "link");
    const link = normalizeURL(linkRaw, baseURL) || '';
    
    // 提取标题内容 - 处理CDATA
    let title = '';
    const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is.exec(itemContent);
    if (titleMatch && titleMatch[1]) {
        title = cleanText(titleMatch[1], { maxLength: 500 });
    }
    
    // 提取描述 - 处理CDATA
    let description = '';
    const descriptionMatch = /<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/is.exec(itemContent);
    if (descriptionMatch && descriptionMatch[1]) {
        description = cleanText(descriptionMatch[1], { maxLength: 5000 });
    }
    
    // 创建条目并添加其他元数据
    const item: RSSItem = {
        title: title,
        link: link,
        description: description,
        contentEncoded: cleanText(safeExtract(itemContent, "content:encoded"), { maxLength: 50000 }),
        pubDate: parseDate(safeExtract(itemContent, "pubDate", { stripHTML: true })),
        guid: safeExtract(itemContent, "guid", { stripHTML: true }),
        author: validateEmail(safeExtract(itemContent, "author")) ||
            validateEmail(safeExtract(itemContent, "dc:creator")) ||
            cleanText(safeExtract(itemContent, "author") || safeExtract(itemContent, "dc:creator")),
        categories: extractAllTags(itemContent, "category").map(cat => cleanText(cat)),
        comments: normalizeURL(safeExtract(itemContent, "comments"), baseURL) || '',
        enclosure: parseEnclosure(itemContent, baseURL),
        source: parseSource(itemContent, baseURL),
        dcCreator: cleanText(safeExtract(itemContent, "dc:creator")),
        dcDate: parseDate(safeExtract(itemContent, "dc:date", { stripHTML: true })),
        dcSubject: extractAllTags(itemContent, "dc:subject").map(subj => cleanText(subj))
    };

    // 如果没有pubDate，尝试使用dc:date
    if (!item.pubDate && item.dcDate) {
        item.pubDate = item.dcDate;
    }
    
    // 如果缺少必要内容，尝试从内容中提取
    if (!item.title && item.description) {
        // 从描述中提取标题（取前50个字符）
        item.title = item.description.substring(0, 50) + (item.description.length > 50 ? '...' : '');
    }

    // 提取iTunes特有的元数据
    item.itunesDuration = normalizeDuration(safeExtract(itemContent, "itunes:duration"));
    item.itunesExplicit = normalizeBoolean(safeExtract(itemContent, "itunes:explicit"));
    
    // 尝试兼容不同命名空间的iTunes图片
    const itunesImageHref = extractAttribute(itemContent, "itunes:image", "href");
    const itunesImageUrl = extractAttribute(itemContent, "itunes:image", "url");
    item.itunesImage = normalizeURL(itunesImageHref || itunesImageUrl, baseURL) || '';
    
    item.itunesEpisode = normalizeInteger(safeExtract(itemContent, "itunes:episode"));
    item.itunesSeason = normalizeInteger(safeExtract(itemContent, "itunes:season"));
    
    // 处理媒体内容
    item.mediaContent = parseMediaContent(itemContent, baseURL);
    
    // 处理媒体缩略图
    item.mediaThumbnail = extractAllAttributes(itemContent, "media:thumbnail", "url")
        .map(url => normalizeURL(url, baseURL) || '')
        .filter(url => url !== '');
    
    // 如果没有找到media:thumbnail，尝试提取其他格式的图片
    if (!item.mediaThumbnail || item.mediaThumbnail.length === 0) {
        // 从内容中提取图片
        const imgSrcMatch = /<img[^>]+src=["']([^"']+)["'][^>]*>/i.exec(item.description || item.contentEncoded || '');
        if (imgSrcMatch && imgSrcMatch[1]) {
            item.mediaThumbnail = [normalizeURL(imgSrcMatch[1], baseURL) || ''];
        }
    }

    return item;
}

// 辅助函数：验证邮箱
function validateEmail(email?: string): string | undefined {
    if (!email) return undefined;
    return EMAIL_REGEX.test(email) ? email : undefined;
}

// 辅助函数：规范化布尔值
function normalizeBoolean(value?: string): boolean {
    if (!value) return false;
    return ['yes', 'true', '1'].includes(value.toLowerCase());
}

// 辅助函数：规范化整数
function normalizeInteger(value?: string): number | undefined {
    if (!value) return undefined;
    const num = parseInt(value);
    return isNaN(num) ? undefined : num;
}

// 辅助函数：规范化时长
function normalizeDuration(duration?: string): string | undefined {
    if (!duration) return undefined;

    // 已经是HH:MM:SS格式
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(duration)) {
        return duration;
    }

    // 纯数字（秒）
    if (/^\d+$/.test(duration)) {
        const seconds = parseInt(duration);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return duration;
}

// 优化后的附件解析函数
function parseEnclosure(content: string, baseURL?: string): RSSItem['enclosure'] | undefined {
    const enclosureMatch = content.match(/<enclosure[^>]+>/i);
    if (!enclosureMatch) return undefined;

    const url = extractAttribute(enclosureMatch[0], "enclosure", "url");
    if (!url) return undefined;

    return {
        url: normalizeURL(url, baseURL),
        length: normalizeInteger(extractAttribute(enclosureMatch[0], "enclosure", "length")),
        type: extractAttribute(enclosureMatch[0], "enclosure", "type")
    };
}

// 优化后的来源解析函数
function parseSource(content: string, baseURL?: string): RSSItem['source'] | undefined {
    const sourceUrl = extractAttribute(content, "source", "url");
    const sourceTitle = safeExtract(content, "source");

    if (!sourceUrl || !sourceTitle) return undefined;

    return {
        title: cleanText(sourceTitle),
        url: normalizeURL(sourceUrl, baseURL)
    };
}

// 优化后的媒体内容解析函数
function parseMediaContent(content: string, baseURL?: string): RSSItem['mediaContent'] {
    const mediaMatches = [...content.matchAll(/<media:content[^>]+>/gi)];
    if (!mediaMatches.length) return undefined;

    return mediaMatches.map(match => {
        const url = extractAttribute(match[0], "media:content", "url");
        return {
            url: normalizeURL(url) || '',  // 确保返回字符串
            type: extractAttribute(match[0], "media:content", "type"),
            width: normalizeInteger(extractAttribute(match[0], "media:content", "width")),
            height: normalizeInteger(extractAttribute(match[0], "media:content", "height")),
            duration: normalizeInteger(extractAttribute(match[0], "media:content", "duration"))
        };
    }).filter(media => media.url !== '');  // 过滤掉无效URL
}

// 优化后的标签内容提取函数 - 不使用缓存
function extractTagContent(content: string, tagName: string): string {
    const regex = TAG_CONTENT_REGEX(tagName);
    const match = content.match(regex);
    const rawContent = match?.[1]?.trim() || "";

    // 处理CDATA内容
    return rawContent.replace(CDATA_REGEX, (_, content) => {
        // 对CDATA内容进行特殊处理
        return content
            .replace(NORMALIZE_SPACE_REGEX, ' ') // 规范化空白字符
            .replace(WHITESPACE_REGEX, ' ') // 处理多余空白
            .trim();
    });
}

// 优化后的 extractAllTags 函数 - 不使用缓存
function extractAllTags(content: string, tagName: string): string[] {
    const regex = TAG_CONTENT_REGEX(tagName, true);
    return [...content.matchAll(regex)]
        .map(m => decodeXMLEntities((m[1] || '').trim()))
        .filter(Boolean);
}

// 简化的HTML清理函数
function cleanContent(html: string): string {
    return stripHTML(decodeXMLEntities(html));
}

function stripHTML(html: string): string {
    return html
        .replace(HTML_TAG_REGEX, '')
        .replace(WHITESPACE_REGEX, ' ')
        .trim();
}

// 优化的实体解码函数 - 不使用缓存
function decodeXMLEntities(text: string): string {
    if (!text) return '';
    
    // CDATA处理优化
    const withoutCDATA = text.replace(CDATA_REGEX, (_, content) => content);

    // 实体解码
    return withoutCDATA.replace(XML_ENTITY_REGEX, (match, entity) => {
        // 数字实体
        if (entity[0] === '#') {
            const code = entity[1]?.toLowerCase() === 'x'
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10);

            // 检查是否为有效的 Unicode 码点
            if (!isNaN(code) && code >= 0 && code <= 0x10FFFF) {
                try {
                    return String.fromCodePoint(code);
                } catch {
                    return match; // 如果无法转换，保留原始实体
                }
            }
            return match; // 无效的数字实体，保留原始实体
        }

        // 命名实体
        return XML_ENTITIES[entity.toLowerCase()] || match; // 如果实体未定义，保留原始实体而不是返回空字符串
    });
}

// 优化后的属性提取函数
function extractAttribute(content: string, tag: string, attr: string): string | undefined {
    const regex = ATTRIBUTE_REGEX(tag, attr);
    const match = regex.exec(content);
    if (!match?.[1]) return undefined;

    // 如果是URL属性，进行规范化
    const urlAttributes = ['href', 'src', 'url', 'link'];
    if (urlAttributes.includes(attr.toLowerCase())) {
        return normalizeURL(match[1]);
    }

    return match[1];
}

// 优化后的多属性提取函数
function extractAllAttributes(content: string, tag: string, attr: string): string[] {
    const regex = ATTRIBUTE_REGEX_GLOBAL(tag, attr);
    return [...content.matchAll(regex)]
        .map(match => match[1])
        .filter((value): value is string => value !== undefined)
        .map(value => {
            // 如果是URL属性，进行规范化
            const urlAttributes = ['href', 'src', 'url', 'link'];
            if (urlAttributes.includes(attr.toLowerCase())) {
                return normalizeURL(value);
            }
            return value;
        });
}

// 增强的日期解析函数
function parseDate(dateStr?: string): Date | undefined {
    if (!dateStr) return undefined;
    
    // 清理输入
    const cleanedStr = dateStr.trim();
    if (!cleanedStr) return undefined;

    // ISO格式快速路径
    const isoMatch = cleanedStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (isoMatch) {
        const normalized = `${isoMatch[1]}T${isoMatch[2]}${isoMatch[3]?.replace(/:(?=\d{2}$)/, '') || 'Z'}`;
        const parsed = new Date(normalized);
        if (!isNaN(parsed.getTime())) return parsed;
    }

    // RFC 822/RFC 2822格式 (常见于RSS)
    const rfcMatch = cleanedStr.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(?:GMT|UTC)?([+-]\d{4})?$/i);
    if (rfcMatch && rfcMatch[1] && rfcMatch[2] && rfcMatch[3] && rfcMatch[4] && rfcMatch[5] && rfcMatch[6]) {
        const months: {[key: string]: number} = {
            jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
        };
        const day = rfcMatch[1];
        const monthStr = rfcMatch[2];
        const year = rfcMatch[3];
        const hour = rfcMatch[4];
        const minute = rfcMatch[5];
        const second = rfcMatch[6];
        const timezone = rfcMatch[7];
        
        const monthLower = monthStr.toLowerCase();
        const month = months[monthLower];
        
        if (month !== undefined) {
            const date = new Date(Date.UTC(
                parseInt(year), 
                month, 
                parseInt(day), 
                parseInt(hour), 
                parseInt(minute), 
                parseInt(second)
            ));
            
            // 处理时区偏移
            if (timezone) {
                const offset = parseInt(timezone);
                const hours = Math.floor(Math.abs(offset) / 100);
                const minutes = Math.abs(offset) % 100;
                const totalMinutes = hours * 60 + minutes;
                
                if (offset > 0) {
                    date.setTime(date.getTime() - totalMinutes * 60000);
                } else {
                    date.setTime(date.getTime() + totalMinutes * 60000);
                }
            }
            
            if (!isNaN(date.getTime())) return date;
        }
    }

    // 处理更多日期格式
    try {
        const cleaned = cleanedStr
            .replace(/,/g, ' ')
            .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
            .replace(/([A-Z]{3,4})\s+([A-Z]{3})/, '$1 $2')
            .replace(/(\d{2}:\d{2}:\d{2})\s+([A-Z]+)/, '$1 GMT$2')
            // 处理中文日期格式
            .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, '$1-$2-$3')
            // 处理公共时间格式
            .replace(/(\d{4})\/(\d{1,2})\/(\d{1,2})/, '$1-$2-$3')
            // 处理欧洲时间格式 DD/MM/YYYY
            .replace(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/, '$3-$2-$1')
            // 处理美国时间格式 MM/DD/YYYY
            .replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, '$3-$1-$2');

        const parsed = new Date(cleaned);
        if (!isNaN(parsed.getTime())) return parsed;
        
        // 最后尝试使用区域设置无关的解析
        const timestamp = Date.parse(cleanedStr);
        if (!isNaN(timestamp)) {
            return new Date(timestamp);
        }
        
        return undefined;
    } catch {
        return undefined;
    }
}

// 创建一个带超时控制的请求
function createRequestWithTimeout(timeoutMs = 15000): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeoutId)
    };
}

// 带重试机制的Fetch
async function fetchRSS(url: string, retries = 3): Promise<RSSFeed> {
    for (let i = 0; i < retries; i++) {
        // 设置请求选项
        const { signal, cleanup } = createRequestWithTimeout(15000);
        
        const bunOptions: BunFetchRequestInit = {
            signal,
            headers: {
                // 添加常见的请求头，增加兼容性
                'User-Agent': 'Mozilla/5.0 NatsukiNext RSS Reader',
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
            }
        };
        
        try {
            const response = await fetch(url, bunOptions);
            cleanup(); // 清理超时定时器
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = response.headers.get('Content-Type') || '';
            // 检查是否是JSON格式，如果是则拒绝
            if (contentType.includes('application/json')) {
                throw new Error("不支持JSON格式的RSS");
            }

            const text = await response.text();
            if (!text || text.trim() === '') {
                throw new Error("Empty response body");
            }

            return parseRSS(text);
        } catch (error) {
            cleanup(); // 确保在出错时也清理超时定时器
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`尝试 ${i + 1}/${retries} 失败:`, errorMessage);

            // 处理特定错误类型
            if (errorMessage.includes('certificate') && process && process.env) {
                // 在 Node.js 环境下，提示用户设置环境变量
                console.warn('遇到证书错误。如果您信任该网站，可以尝试设置 NODE_TLS_REJECT_UNAUTHORIZED=0 环境变量');
            }

            if (i === retries - 1) throw error;
            await (typeof Bun !== 'undefined' ? Bun.sleep(1000 * (i + 1)) : new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))));
        }
    }
    throw new Error("Max retries reached");
}

// 示例用法
async function main() {
    try {
        const feed = await fetchRSS("http://cn.nytimes.com/rss/news.xml");

        console.log(`Feed: ${feed.channel.title}`);
        console.log(`Link: ${feed.channel.link}`);
        console.log(`Description: ${feed.channel.description.slice(0, 100)}...`);

        feed.channel.items.slice(0, 3).forEach((item, index) => {
            console.log(`\n[${index + 1}] ${item.title}`);
            console.log(`Link: ${item.link}`);
            console.log(`Published: ${item.pubDate?.toISOString() || 'N/A'}`);
            console.log(`Description: ${item.description.slice(0, 120)}...`);
            console.log(item)
        });
    } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
    }
}

// main().catch(console.error);

export { fetchRSS, stripHTML, decodeXMLEntities };
export type { RSSFeed, RSSChannel, RSSItem };