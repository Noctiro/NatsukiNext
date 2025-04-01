/**
 * HTML处理工具
 * 严格遵循Mtcute HTML规范，无浏览器依赖
 * 
 * 主要功能：
 * 1. 清理HTML，只保留允许的标签和属性
 * 2. 处理未知标签（删除或转义）
 * 3. 修复标签嵌套和闭合问题
 * 4. 提取HTML中的纯文本内容
 * 5. 解码HTML实体
 * 
 * 安全特性：
 * - 只允许安全的标签和属性
 * - 对URL进行安全处理
 * - 阻止XSS攻击
 * - 标签闭合修复
 */

// 支持的标签列表 - 默认遵循Telegram HTML规范支持的标签
export const ALLOWED_TAGS = ['a', 'b', 'i', 'u', 's', 'code', 'pre', 'br', 'blockquote', 'spoiler', 'tg-spoiler'];

// 性能优化常量 - 预先分类标签以减少运行时判断
const TAG_CATEGORIES = {
  // 块级标签：影响文档结构和布局的标签
  BLOCK: new Set(['pre', 'blockquote']),
  // 内联标签：不会破坏文档流的标签
  INLINE: new Set(['a', 'b', 'i', 'u', 's', 'code', 'spoiler', 'tg-spoiler']),
  // 自闭合标签：不需要闭合标签的元素
  SELF_CLOSING: new Set(['br'])
};

// 预编译正则表达式（性能关键）- 预编译可显著提高性能
const REGEX = {
  // 匹配不在允许列表中的标签
  INVALID_TAG: /<\/?(?!a|br|pre|blockquote|b|i|u|s|code|spoiler|tg-spoiler)[a-z][^>]*>/gi,
  // 匹配所有HTML标签
  TAG: /<(\/?)([a-z][a-z0-9]*)(?:\s+([^>]*?))?>/gi,
  // 匹配自闭合br标签的各种形式
  SELF_CLOSING: /<br\s*\/?>/gi,
  // 匹配HTML注释
  COMMENT: /<!--[\s\S]*?-->/g,
  // 匹配不完整的标签（结尾处）
  TRAILING_TAG: /<[^>]*$/,
  // 匹配HTML属性
  ATTRIBUTES: /(\w+)(?:=["']?((?:.(?!["']?\s+(?:\S+)=|\s*\/?[>"']))+.)["']?)?/gi,
  // 匹配spoiler标签（包括tg-spoiler）
  SPOILER: /<\/?((?:tg-)?spoiler)/gi,
  // 匹配所有HTML标签（包括非字母标签如h1, h2等）
  ALL_TAGS: /<(\/?)([\w-]+)(?:\s+([^>]*?))?>/gi
};

// HTML实体解码表 - 常用HTML实体映射到对应的字符
const HTML_ENTITIES: Record<string, string> = {
  'lt': '<',         // 小于号
  'gt': '>',         // 大于号
  'amp': '&',        // 与符号
  'quot': '"',       // 双引号
  'apos': "'",       // 单引号
  'nbsp': '\u00A0'   // 不间断空格
};

/**
 * HTML清理选项接口
 * 定义了HTML清理过程中可配置的选项
 */
export interface HtmlCleanOptions {
  /** 
   * 是否转义未知标签
   * - true: 将未允许的标签转换为HTML实体（如 &lt;div&gt;）
   * - false: 完全删除未允许的标签
   */
  escapeUnknownTags?: boolean;
  
  /** 
   * 自定义允许的标签列表
   * 如果提供，将覆盖默认的ALLOWED_TAGS列表
   */
  allowedTags?: string[];
  
  /** 
   * 是否允许blockquote的collapsible属性
   * - true: 保留可折叠引用块功能
   * - false: 删除此属性，使引用块始终展开
   */
  allowBlockquoteCollapsible?: boolean;
  
  /** 
   * 标签分类设置
   * 允许自定义哪些标签是块级、内联或自闭合的
   * 提供的分类将与默认分类合并
   */
  tagCategories?: {
    /** 额外的块级标签列表 */
    block?: string[];
    /** 额外的内联标签列表 */
    inline?: string[];
    /** 额外的自闭合标签列表 */
    selfClosing?: string[];
  };
}

/**
 * HTML清理选项默认值
 * 定义所有配置的默认值，使用Required来确保所有可选字段都有值
 */
export const DEFAULT_HTML_CLEAN_OPTIONS: Required<HtmlCleanOptions> = {
  escapeUnknownTags: false,              // 默认删除未知标签
  allowedTags: ALLOWED_TAGS,             // 使用预定义的允许标签列表
  allowBlockquoteCollapsible: true,      // 默认允许blockquote的collapsible属性
  tagCategories: {                       // 默认不添加额外的标签分类
    block: [],
    inline: [],
    selfClosing: []
  }
};

/**
 * 内部标签信息接口
 * 用于存储解析过程中的标签信息
 */
interface TagInfo {
  /** 标签类型（开始或结束） */
  type: 'open' | 'close';
  /** 标签名称 */
  name: string;
  /** 标签在原始文本中的位置 */
  index: number;
}

/**
 * HTML转义函数
 * 将HTML特殊字符转换为对应的HTML实体
 * 
 * @param text 要转义的文本
 * @returns 转义后的安全文本
 */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')   // & 必须首先转义，否则会影响其他实体
    .replace(/</g, '&lt;')    // 小于号
    .replace(/>/g, '&gt;')    // 大于号
    .replace(/"/g, '&quot;')  // 双引号
    .replace(/'/g, '&apos;'); // 单引号
}

/**
 * 高性能HTML清理函数
 * 核心功能：清理HTML，只保留允许的标签和属性，修复标签嵌套和闭合问题
 * 
 * @param html 要清理的HTML字符串
 * @param options 清理选项，控制清理行为
 * @returns 清理后的安全HTML
 */
export function cleanHTML(html: string, options: HtmlCleanOptions = {}): string {
  // 空内容直接返回
  if (!html) return '';
  
  // 合并用户提供的选项与默认选项，确保所有选项都有值
  const mergedOptions: Required<HtmlCleanOptions> = {
    ...DEFAULT_HTML_CLEAN_OPTIONS,
    ...options,
    tagCategories: {
      ...DEFAULT_HTML_CLEAN_OPTIONS.tagCategories,
      ...(options.tagCategories || {})
    }
  };
  
  // 解构选项以便使用
  const { 
    escapeUnknownTags,            // 是否转义未知标签
    allowedTags,                  // 允许的标签列表
    allowBlockquoteCollapsible,   // 是否允许blockquote的collapsible属性
    tagCategories                 // 标签分类
  } = mergedOptions;
  
  // 合并标签分类：将用户提供的分类与默认分类合并
  const mergedCategories = {
    BLOCK: new Set([...TAG_CATEGORIES.BLOCK, ...(tagCategories.block || [])]),
    INLINE: new Set([...TAG_CATEGORIES.INLINE, ...(tagCategories.inline || [])]),
    SELF_CLOSING: new Set([...TAG_CATEGORIES.SELF_CLOSING, ...(tagCategories.selfClosing || [])])
  };
  
  // 动态生成未知标签的正则表达式，以适应自定义的allowedTags
  let invalidTagPattern = '';
  if (allowedTags.length > 0) {
    // 如果有允许的标签，创建排除这些标签的正则表达式
    invalidTagPattern = `<\\/?(?!${allowedTags.join('|')})[a-z][^>]*>`;
  } else {
    // 如果没有允许的标签，匹配所有标签
    invalidTagPattern = '<\\/?[a-z][^>]*>';
  }
  const DYNAMIC_INVALID_TAG = new RegExp(invalidTagPattern, 'gi');
  
  // 第一阶段预处理：删除注释、不完整标签，标准化br标签
  let sanitized = html
    .replace(REGEX.COMMENT, '')         // 删除所有HTML注释
    .replace(REGEX.TRAILING_TAG, '')    // 删除不完整的尾部标签
    .replace(REGEX.SELF_CLOSING, '<br>'); // 统一br标签格式
    
  // 第二阶段：根据选项处理未知标签（转义或删除）
  if (escapeUnknownTags) {
    // 如果启用了转义选项，使用正则表达式匹配所有标签并检查是否为允许的标签
    REGEX.ALL_TAGS.lastIndex = 0; // 重置正则表达式索引
    const segments: string[] = []; // 存储处理后的文本片段
    let lastIndex = 0;            // 追踪上次处理位置
    let match;                    // 存储正则匹配结果
    
    // 逐个匹配并处理标签
    while ((match = REGEX.ALL_TAGS.exec(sanitized)) !== null) {
      const [full, slash, name = '', attrs] = match; // 解构匹配结果
      const lowerName = name.toLowerCase();         // 标签名转小写
      const isAllowed = allowedTags.includes(lowerName); // 检查是否是允许的标签
      
      // 添加标签前的文本内容
      segments.push(sanitized.slice(lastIndex, match.index));
      
      // 对标签进行处理：允许的保留，不允许的转义
      if (isAllowed) {
        // 允许的标签保持不变
        segments.push(full);
      } else {
        // 不允许的标签被转义为HTML实体
        segments.push(escapeHTML(full));
      }
      
      // 更新处理位置
      lastIndex = match.index + full.length;
    }
    
    // 添加剩余未处理的文本内容
    segments.push(sanitized.slice(lastIndex));
    sanitized = segments.join(''); // 合并所有处理后的片段
  } else {
    // 如果未启用转义，直接使用动态正则表达式删除未知标签
    sanitized = sanitized.replace(DYNAMIC_INVALID_TAG, ''); // 直接删除匹配到的无效标签
  }

  // 第三阶段：标签结构重建和修复
  // 使用堆栈跟踪打开的标签，确保正确嵌套和闭合
  const tagStack: Array<{ name: string; isBlock: boolean }> = [];
  const output: string[] = []; // 存储最终输出
  let lastIndex = 0;          // 标记当前处理位置
  let match: RegExpExecArray | null;

  // 重置标签匹配正则
  REGEX.TAG.lastIndex = 0;
  
  // 逐个处理标签
  while ((match = REGEX.TAG.exec(sanitized)) !== null) {
    const [full, slash = '', nameRaw = '', attrsRaw] = match;
    const name = nameRaw.toLowerCase();           // 标签名转小写
    const isClosing = !!slash;                    // 是否是闭合标签 (</tag>)
    const isAllowed = allowedTags.includes(name); // 是否是允许的标签
    const isBlock = mergedCategories.BLOCK.has(name);         // 是否是块级标签
    const isSelfClosing = mergedCategories.SELF_CLOSING.has(name); // 是否是自闭合标签
    const index = match.index;                    // 标签在字符串中的位置

    // 添加标签前的文本内容
    output.push(sanitized.slice(lastIndex, index));
    lastIndex = index + full.length;

    // 跳过不允许的标签
    if (!isAllowed) continue;

    // 处理标签属性，增强安全性
    let processedTag = `<${slash}${name}`;
    if (!isClosing) {
      // 只对开始标签处理属性
      const safeAttrs = processAttributes(name, attrsRaw || '', { allowBlockquoteCollapsible });
      if (safeAttrs) processedTag += ` ${safeAttrs}`;
    }
    processedTag += '>';

    // 根据标签类型进行不同处理
    if (isSelfClosing) {
      // 自闭合标签直接输出不入栈
      output.push(processedTag);
    } else if (isClosing) {
      // 处理闭合标签：查找匹配的开标签并正确闭合中间的标签
      let stackIndex = tagStack.length - 1;
      while (stackIndex >= 0 && tagStack[stackIndex]?.name !== name) {
        stackIndex--;
      }

      if (stackIndex >= 0) {
        // 找到匹配的开标签，闭合它及其后的所有标签
        const tagsToClose = tagStack.splice(stackIndex);
        for (let i = tagsToClose.length - 1; i >= 0; i--) {
          const tag = tagsToClose[i];
          if (tag && tag.name) {
            output.push(`</${tag.name}>`);
          }
        }
      } else {
        // 未找到匹配的开标签，忽略这个闭标签
        continue;
      }
    } else {
      // 处理开标签，确保标签嵌套合法
      if (name === 'a') {
        // a标签特殊处理：不允许嵌套，先关闭之前的a标签
        const aIndex = tagStack.findIndex(t => t && t.name === 'a');
        if (aIndex !== -1) {
          // 闭合从a到栈顶的所有标签
          const tagsToClose = tagStack.splice(aIndex);
          for (let i = tagsToClose.length - 1; i >= 0; i--) {
            const tag = tagsToClose[i];
            if (tag && tag.name) {
              output.push(`</${tag.name}>`);
            }
          }
        }
      } else if (isBlock) {
        // 块级标签不能嵌套在行内标签中，需要先闭合行内标签
        let lastInlineIndex = -1;
        for (let i = 0; i < tagStack.length; i++) {
          const tag = tagStack[i];
          if (tag && tag.name && mergedCategories.INLINE.has(tag.name)) {
            lastInlineIndex = i;
          }
        }
        
        if (lastInlineIndex !== -1) {
          // 闭合所有行内标签
          const tagsToClose = tagStack.splice(lastInlineIndex);
          for (let i = tagsToClose.length - 1; i >= 0; i--) {
            const tag = tagsToClose[i];
            if (tag && tag.name) {
              output.push(`</${tag.name}>`);
            }
          }
        }
      }

      // 添加开标签到输出
      output.push(processedTag);
      
      // 非自闭合标签入栈，用于后续配对
      if (!mergedCategories.SELF_CLOSING.has(name)) {
        tagStack.push({ name, isBlock });
      }
    }
  }

  // 添加剩余未处理的文本内容
  output.push(sanitized.slice(lastIndex));

  // 闭合所有未闭合的标签，确保HTML结构完整
  for (let i = tagStack.length - 1; i >= 0; i--) {
    const tag = tagStack[i];
    if (tag && tag.name) {
      output.push(`</${tag.name}>`);
    }
  }

  // 最终格式修正和特殊处理
  let finalHtml = output.join('');

  // 正确处理spoiler/tg-spoiler标签
  finalHtml = finalHtml.replace(/<(\/?)((?:tg-)?spoiler)>/gi, (_, slash, tagName) => {
    return slash ? '</span>' : '<span class="spoiler">';
  });

  // 标准化br标签
  finalHtml = finalHtml.replace(/<br\b[^>]*>/gi, '<br>');

  // 移除紧跟在</blockquote>之前的<br>
  finalHtml = finalHtml.replace(/<br>(<\/blockquote>)/gi, '$1');

  return finalHtml;
}

/**
 * 安全处理标签属性
 * 清理和过滤HTML标签的属性，只保留允许的安全属性
 * 
 * @param tag 标签名
 * @param attrs 属性字符串
 * @param options 处理选项
 * @returns 处理后的安全属性字符串
 */
function processAttributes(
  tag: string, 
  attrs: string, 
  options: { allowBlockquoteCollapsible: boolean }
): string {
  const validAttrs: string[] = [];      // 存储有效属性
  const seenAttrs = new Set<string>();  // 跟踪已处理的属性，防止重复
  let match;                           // 存储正则匹配结果

  // 重置属性匹配正则
  REGEX.ATTRIBUTES.lastIndex = 0;
  
  // 逐个属性进行处理
  while ((match = REGEX.ATTRIBUTES.exec(attrs)) !== null) {
    const [_, key = '', value = ''] = match; // 解构属性名和值
    const lowerKey = key.toLowerCase();      // 属性名转小写

    // 防止重复属性，确保每个属性只处理一次
    if (seenAttrs.has(lowerKey)) continue;
    seenAttrs.add(lowerKey);

    // 根据标签类型处理不同的属性
    switch (tag) {
      case 'a':
        // a标签只允许href属性，且进行URL安全处理
        if (lowerKey === 'href') {
          const safeUrl = sanitizeUrl(value);
          if (safeUrl) validAttrs.push(`href="${safeUrl}"`);
        }
        break;

      case 'pre':
        // pre标签只允许language属性，用于代码高亮
        if (lowerKey === 'language') {
          // 清理language值，只允许字母、数字、下划线和连字符
          const safeValue = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
          validAttrs.push(`language="${safeValue}"`);
        }
        break;

      case 'blockquote':
        // blockquote标签可以有collapsible属性，但受配置控制
        if (lowerKey === 'collapsible' && !value && options.allowBlockquoteCollapsible) {
          validAttrs.push('collapsible');
        }
        break;

      case 'code':
        // 代码块不允许任何属性，确保代码安全显示
        break;

      default:
        // 其他标签只允许全局安全属性（id和class）
        if (['id', 'class'].includes(lowerKey)) {
          // 清理属性值，只允许字母、数字、下划线和连字符
          const safeValue = value.replace(/[^a-zA-Z0-9-_]/g, '');
          validAttrs.push(`${lowerKey}="${safeValue}"`);
        }
    }
  }

  // 返回处理后的属性字符串
  return validAttrs.join(' ');
}

/**
 * 安全解码HTML实体
 * 将HTML实体转换回对应的字符
 * 
 * @param text 包含HTML实体的文本
 * @returns 解码后的文本
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#?[a-z0-9]+);/gi, (_, entity) => {
    if (entity.startsWith('#')) {
      // 处理数字实体 (如 &#123; 或 &#x7B;)
      const code = entity.startsWith('#x') ?
        parseInt(entity.substring(2), 16) :  // 十六进制
        parseInt(entity.substring(1), 10);   // 十进制

      // 确保code是有效的Unicode码点
      return isNaN(code) ? _ : String.fromCodePoint(code);
    }
    // 处理命名实体 (如 &lt;)
    return HTML_ENTITIES[entity] || _;  // 返回映射的字符或原文本
  });
}

/**
 * 提取纯文本内容
 * 从HTML中提取纯文本，去除所有标签和格式
 * 
 * @param html 要处理的HTML字符串
 * @param options 清理选项
 * @returns 提取的纯文本内容
 */
export function extractText(html: string, options: HtmlCleanOptions = {}): string {
  return decodeEntities(
    cleanHTML(html, options)
      .replace(/<br\s*\/?>/gi, '\n')  // 将br标签转换为换行
      .replace(/<[^>]+>/g, '')        // 删除所有剩余标签
      .replace(/\s+/g, ' ')           // 合并连续空白
      .trim()                         // 去除首尾空白
  );
}

/**
 * URL安全处理函数
 * 清理和验证URL，防止XSS和恶意链接
 * 
 * @param url 要处理的URL
 * @returns 安全的URL或fallback值
 */
function sanitizeUrl(url: string): string {
  // Trim whitespace
  url = url.trim();
  if (!url) return '#'; // Return placeholder for empty URLs

  try {
    // 自动补全协议（如果缺少且看起来像域名/路径）
    if (!/^[a-z]+:/i.test(url) && (url.startsWith('//') || !url.includes(':'))) {
       // If starts with //, browser treats it as protocol-relative, let URL handle it
       // Otherwise, if no colon (potential protocol separator) assume http/https
       if (!url.startsWith('//')) {
         url = 'https://' + url;
       }
    }

    // 解析URL
    const parsed = new URL(url, 'https://dummybase'); // Provide a base for relative URLs if needed, though we expect absolute usually

    // Handle protocol-relative URLs by assigning a default scheme if needed after parsing
    if (parsed.protocol === 'https:') { // Check against the dummy base's protocol
        // If the original URL started with //, parsed.protocol might be http/https based on the dummy base
        // If it didn't start with // and had no scheme, we added https:// earlier
        // If it had a scheme originally, it would be retained.
        // Let's reconstruct carefully if it was protocol-relative
        if (url.startsWith('//')) {
            // Keep it protocol-relative for flexibility, though less common now
            // Or force https:
             parsed.protocol = 'https:'; // Force https for protocol-relative
        }
    }

    // 协议白名单验证，只允许安全的协议
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
      return '#'; // 不安全的协议返回占位符
    }

    // 标准化URL格式，移除hash部分和尾部斜杠
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // URL解析失败，返回安全的占位符
    return '#';
  }
}
