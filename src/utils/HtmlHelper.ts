/**
 * HTML处理工具（服务端优化版）
 * 严格遵循Telegram HTML规范，无浏览器依赖
 */

// 支持的标签列表
export const ALLOWED_TAGS = ['a', 'b', 'i', 'u', 's', 'code', 'pre', 'br', 'blockquote', 'spoiler', 'tg-spoiler'];

// 性能优化常量
const TAG_CATEGORIES = {
  BLOCK: new Set(['pre', 'blockquote']),
  INLINE: new Set(['a', 'b', 'i', 'u', 's', 'code', 'spoiler', 'tg-spoiler']),
  SELF_CLOSING: new Set(['br'])
};

// 预编译正则表达式（性能关键）
const REGEX = {
  INVALID_TAG: /<\/?(?!a|br|pre|blockquote|b|i|u|s|code|spoiler|tg-spoiler)[a-z][^>]*>/gi,
  TAG: /<(\/?)([a-z][a-z0-9]*)(?:\s+([^>]*?))?>/gi,
  SELF_CLOSING: /<br\s*\/?>/gi,
  COMMENT: /<!--[\s\S]*?-->/g,
  TRAILING_TAG: /<[^>]*$/,
  ATTRIBUTES: /(\w+)(?:=["']?((?:.(?!["']?\s+(?:\S+)=|\s*\/?[>"']))+.)["']?)?/gi,
  SPOILER: /<\/?((?:tg-)?spoiler)/gi
};

// HTML实体解码表
const HTML_ENTITIES: Record<string, string> = {
  'lt': '<',
  'gt': '>',
  'amp': '&',
  'quot': '"',
  'apos': "'",
  'nbsp': '\u00A0'
};

interface TagInfo {
  type: 'open' | 'close';
  name: string;
  index: number;
}

/**
 * 高性能HTML清理函数
 */
export function cleanHTML(html: string): string {
  if (!html) return '';

  // 优化后的初始化清理流程
  let sanitized = html
    .replace(REGEX.COMMENT, '')
    .replace(REGEX.TRAILING_TAG, '')
    .replace(REGEX.SELF_CLOSING, '<br>')
    .replace(REGEX.INVALID_TAG, (m) =>
      ALLOWED_TAGS.some(t => m.toLowerCase().startsWith(`<${t}`)) ? m : ''
    );

  // 增强型标签解析
  const tagStack: Array<{ name: string; isBlock: boolean }> = [];
  const output: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  REGEX.TAG.lastIndex = 0; // 重置正则表达式的lastIndex
  while ((match = REGEX.TAG.exec(sanitized)) !== null) {
    const [full, slash = '', nameRaw = '', attrsRaw] = match;
    const name = nameRaw.toLowerCase();
    const isClosing = !!slash;
    const isAllowed = ALLOWED_TAGS.includes(name);
    const isBlock = TAG_CATEGORIES.BLOCK.has(name);
    const isSelfClosing = TAG_CATEGORIES.SELF_CLOSING.has(name);
    const index = match.index;

    // 添加前面的文本内容
    output.push(sanitized.slice(lastIndex, index));
    lastIndex = index + full.length;

    if (!isAllowed) continue;

    // 处理标签属性（增强安全性）
    let processedTag = `<${slash}${name}`;
    if (!isClosing) {
      const safeAttrs = processAttributes(name, attrsRaw || '');
      if (safeAttrs) processedTag += ` ${safeAttrs}`;
    }
    processedTag += '>';

    if (isSelfClosing) {
      // 自闭合标签直接输出不入栈
      output.push(processedTag);
    } else if (isClosing) {
      // 精确查找匹配的打开标签
      let stackIndex = tagStack.length - 1;
      while (stackIndex >= 0 && tagStack[stackIndex]?.name !== name) {
        stackIndex--;
      }

      if (stackIndex >= 0) {
        // 正确闭合匹配的标签及其内部标签
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
      // 处理开标签
      if (name === 'a') {
        // a标签不允许嵌套，先关闭之前的a标签
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
        // 块级标签不能嵌套在行内标签中
        let lastInlineIndex = -1;
        for (let i = 0; i < tagStack.length; i++) {
          const tag = tagStack[i];
          if (tag && tag.name && TAG_CATEGORIES.INLINE.has(tag.name)) {
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
      
      // 非自闭合标签入栈
      if (!TAG_CATEGORIES.SELF_CLOSING.has(name)) {
        tagStack.push({ name, isBlock });
      }
    }
  }

  // 添加剩余文本
  output.push(sanitized.slice(lastIndex));

  // 闭合未闭合标签
  for (let i = tagStack.length - 1; i >= 0; i--) {
    const tag = tagStack[i];
    if (tag && tag.name) {
      output.push(`</${tag.name}>`);
    }
  }

  // 最终格式修正
  return output.join('')
    .replace(REGEX.SPOILER, (m, p1) =>
      p1.toLowerCase() === 'spoiler' ? '<span class="spoiler">' : '</span>'
    )
    .replace(/<br\b[^>]*>/gi, '<br>'); // 精确匹配br标签
}

/**
 * 安全处理标签属性
 */
function processAttributes(tag: string, attrs: string): string {
  const validAttrs: string[] = [];
  const seenAttrs = new Set<string>();
  let match;

  REGEX.ATTRIBUTES.lastIndex = 0; // 重置正则表达式
  while ((match = REGEX.ATTRIBUTES.exec(attrs)) !== null) {
    const [_, key = '', value = ''] = match;
    const lowerKey = key.toLowerCase();

    // 防止重复属性
    if (seenAttrs.has(lowerKey)) continue;
    seenAttrs.add(lowerKey);

    switch (tag) {
      case 'a':
        if (lowerKey === 'href') {
          const safeUrl = sanitizeUrl(value);
          if (safeUrl) validAttrs.push(`href="${safeUrl}"`);
        }
        break;

      case 'pre':
        if (lowerKey === 'language') {
          const safeValue = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
          validAttrs.push(`language="${safeValue}"`);
        }
        break;

      case 'blockquote':
        if (lowerKey === 'collapsible' && !value) {
          validAttrs.push('collapsible');
        }
        break;

      case 'code':
        // 代码块不允许任何属性
        break;

      default:
        // 其他标签只允许全局属性
        if (['id', 'class'].includes(lowerKey)) {
          const safeValue = value.replace(/[^a-zA-Z0-9-_]/g, '');
          validAttrs.push(`${lowerKey}="${safeValue}"`);
        }
    }
  }

  return validAttrs.join(' ');
}

/**
 * 安全解码HTML实体
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#?[a-z0-9]+);/gi, (_, entity) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') ?
        parseInt(entity.substring(2), 16) :
        parseInt(entity.substring(1), 10);

      return isNaN(code) ? _ : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[entity] || _;
  });
}

/**
 * 提取纯文本内容
 */
export function extractText(html: string): string {
  return decodeEntities(
    cleanHTML(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * URL安全处理函数
 */
function sanitizeUrl(url: string): string {
  try {
    // 自动补全协议
    if (!/^https?:/i.test(url) && url.includes('.')) {
      url = 'https://' + url;
    }
    const parsed = new URL(url);

    // 协议白名单验证
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
      return '#';
    }

    // 标准化URL格式
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '#';
  }
}
