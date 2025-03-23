/**
 * 高性能RSS解析器 for Bun
 * 支持 RSS 2.0、RSS 1.0、Atom、RDF 等格式
 * 优化点：类型安全、HTML清理、日期解析优化、多格式支持
 */

// 预编译正则表达式
const RSS_VERSION_REGEX = /<(?:rss|rdf:RDF|feed)[^>]+(?:version=["']([^"']+)["']|xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["'])/i;
const CHANNEL_REGEX = /<(?:channel|feed)>([\s\S]*?)<\/(?:channel|feed)>/i;
const ITEM_REGEX = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
const HTML_TAG_REGEX = /<\/?[a-z][^>]*>|<!--[\s\S]*?-->/gi;

// XML实体映射表 - 保留常用实体以提高性能
const XML_ENTITIES: Record<string, string> = {
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    'apos': "'",
    'nbsp': '\u00A0',
    'copy': '©',
    'reg': '®',
    'trade': '™',
    'euro': '€',
    'mdash': '—',
    'ndash': '–',
    'hellip': '…'
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
        const searchParams = new URLSearchParams([...urlObj.searchParams.entries()].sort());
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
type RSSFormat = 'RSS2.0' | 'RSS1.0' | 'Atom' | 'RDF' | 'Unknown';

// 增加格式检测函数
function detectRSSFormat(xmlContent: string): RSSFormat {
    if (/<rss[^>]+version=["']2\.0["']/i.test(xmlContent)) return 'RSS2.0';
    if (/<rdf:RDF/i.test(xmlContent)) return 'RDF';
    if (/<feed[^>]+xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xmlContent)) return 'Atom';
    if (/<rss[^>]+version=["']1\.0["']/i.test(xmlContent)) return 'RSS1.0';
    return 'Unknown';
}

// 优化后的RSS解析函数
function parseRSS(xmlContent: string): RSSFeed {
    // 基本验证
    if (!xmlContent) {
        throw new Error("Empty RSS content");
    }

    // 移除危险字符
    xmlContent = xmlContent.replace(INVALID_CHARS_REGEX, '');

    // 检测 RSS 格式
    const format = detectRSSFormat(xmlContent);
    const version = RSS_VERSION_REGEX.exec(xmlContent)?.[1] ?? format;

    // 根据不同格式选择解析策略
    switch (format) {
        case 'Atom':
            return parseAtom(xmlContent);
        case 'RDF':
            return parseRDF(xmlContent);
        case 'RSS1.0':
            return parseRDF(xmlContent); // RSS 1.0 使用 RDF 格式
        case 'RSS2.0':
        default:
            return parseRSS2(xmlContent, version);
    }
}

// RSS 2.0 解析函数
function parseRSS2(xmlContent: string, version: string): RSSFeed {
    const channelMatch = CHANNEL_REGEX.exec(xmlContent);
    if (!channelMatch?.[1]) throw new Error("Invalid RSS: No channel element found");

    const channelContent = channelMatch[1];
    const baseURL = safeExtract(channelContent, "link");

    const channel: RSSChannel = {
        title: cleanText(safeExtract(channelContent, "title"), { maxLength: 500 }),
        link: normalizeURL(baseURL),
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

    // 批量解析items
    const itemMatches = [...channelContent.matchAll(ITEM_REGEX)];
    channel.items = itemMatches
        .map(match => parseItem(match[1] || '', baseURL))
        .filter(item => item.title && item.link); // 过滤掉无效项

    return { channel, version };
}

// Atom 解析函数
function parseAtom(xmlContent: string): RSSFeed {
    const channelMatch = CHANNEL_REGEX.exec(xmlContent);
    if (!channelMatch?.[1]) throw new Error("Invalid Atom: No feed element found");

    const feedContent = channelMatch[1];
    const channel: RSSChannel = {
        title: cleanText(safeExtract(feedContent, "title"), { maxLength: 500 }),
        link: normalizeURL(extractAttribute(feedContent, "link", "href")),
        description: cleanText(safeExtract(feedContent, "subtitle") || safeExtract(feedContent, "summary"), { maxLength: 2000 }),
        items: []
    };

    // 解析 Atom 特有的元数据
    channel.language = safeExtract(feedContent, "lang", { stripHTML: true });
    channel.generator = safeExtract(feedContent, "generator", { stripHTML: true });
    channel.pubDate = parseDate(safeExtract(feedContent, "updated", { stripHTML: true }));

    // 解析条目
    const itemMatches = [...xmlContent.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
    channel.items = itemMatches
        .map(match => parseAtomEntry(match[1] || '', channel.link))
        .filter(item => item.title && item.link);

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
    if (!channelMatch?.[1]) throw new Error("Invalid RDF: No channel element found");

    const channelContent = channelMatch[1];
    const baseURL = safeExtract(channelContent, "link");

    const channel: RSSChannel = {
        title: cleanText(safeExtract(channelContent, "title"), { maxLength: 500 }),
        link: normalizeURL(baseURL),
        description: cleanText(safeExtract(channelContent, "description"), { maxLength: 2000 }),
        items: []
    };

    // 解析 RDF 特有的元数据
    channel.language = safeExtract(channelContent, "dc:language", { stripHTML: true });
    channel.pubDate = parseDate(safeExtract(channelContent, "dc:date", { stripHTML: true }));

    // 解析条目
    const itemMatches = [...xmlContent.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
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
    const link = safeExtract(itemContent, "link");
    const item: RSSItem = {
        title: cleanText(safeExtract(itemContent, "title"), { maxLength: 500 }),
        link: normalizeURL(link) || '',  // 确保返回字符串
        description: cleanText(safeExtract(itemContent, "description"), { maxLength: 5000 }),
        contentEncoded: cleanText(safeExtract(itemContent, "content:encoded"), { maxLength: 50000 }),
        pubDate: parseDate(safeExtract(itemContent, "pubDate", { stripHTML: true })),
        guid: safeExtract(itemContent, "guid", { stripHTML: true }),
        author: validateEmail(safeExtract(itemContent, "author")) ||
            validateEmail(safeExtract(itemContent, "dc:creator")) ||
            cleanText(safeExtract(itemContent, "author") || safeExtract(itemContent, "dc:creator")),
        categories: extractAllTags(itemContent, "category").map(cat => cleanText(cat)),
        comments: normalizeURL(safeExtract(itemContent, "comments"), baseURL) || '',  // 确保返回字符串
        enclosure: parseEnclosure(itemContent, baseURL),
        source: parseSource(itemContent, baseURL),
        dcCreator: cleanText(safeExtract(itemContent, "dc:creator")),
        dcDate: parseDate(safeExtract(itemContent, "dc:date", { stripHTML: true })),
        dcSubject: extractAllTags(itemContent, "dc:subject").map(subj => cleanText(subj)),
        itunesDuration: normalizeDuration(safeExtract(itemContent, "itunes:duration")),
        itunesExplicit: normalizeBoolean(safeExtract(itemContent, "itunes:explicit")),
        itunesImage: normalizeURL(extractAttribute(itemContent, "itunes:image", "href"), baseURL) || '',  // 确保返回字符串
        itunesEpisode: normalizeInteger(safeExtract(itemContent, "itunes:episode")),
        itunesSeason: normalizeInteger(safeExtract(itemContent, "itunes:season")),
        mediaContent: parseMediaContent(itemContent, baseURL),
        mediaThumbnail: extractAllAttributes(itemContent, "media:thumbnail", "url")
            .map(url => normalizeURL(url, baseURL) || '')  // 确保返回字符串
            .filter(url => url !== '')  // 过滤掉空字符串
    };

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
    // CDATA处理优化
    const withoutCDATA = text.replace(CDATA_REGEX, (_, content) => content);

    // 实体解码
    return withoutCDATA.replace(XML_ENTITY_REGEX, (_, entity) => {
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
                    return '';
                }
            }
            return '';
        }

        // 命名实体
        return XML_ENTITIES[entity.toLowerCase()] || '';
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

    // ISO格式快速路径
    const isoMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (isoMatch) {
        const normalized = `${isoMatch[1]}T${isoMatch[2]}${isoMatch[3]?.replace(/:(?=\d{2}$)/, '') || 'Z'}`;
        const parsed = new Date(normalized);
        if (!isNaN(parsed.getTime())) return parsed;
    }

    // 处理更多日期格式
    try {
        const cleaned = dateStr
            .replace(/,/g, ' ')
            .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
            .replace(/([A-Z]{3,4})\s+([A-Z]{3})/, '$1 $2')
            .replace(/(\d{2}:\d{2}:\d{2})\s+([A-Z]+)/, '$1 GMT$2')
            // 处理中文日期格式
            .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, '$1-$2-$3')
            // 处理更多本地化日期格式
            .replace(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/, '$3-$1-$2');

        const parsed = new Date(cleaned);
        return isNaN(parsed.getTime()) ? undefined : parsed;
    } catch {
        return undefined;
    }
}

// 带重试机制的Fetch
async function fetchRSS(url: string, retries = 3): Promise<RSSFeed> {
    for (let i = 0; i < retries; i++) {
        try {
            // Bun 环境 - 使用 Bun 特有的选项
            const bunOptions: BunFetchRequestInit = {
                signal: AbortSignal.timeout(15000), // 增加超时时间
            };
            const response = await fetch(url, bunOptions);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const text = await response.text();
            if (!text || text.trim() === '') {
                throw new Error("Empty response body");
            }

            return parseRSS(text);
        } catch (error) {
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