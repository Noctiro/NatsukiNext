/**
 * HTML处理工具
 * 提供HTML标签处理、清理和安全相关的实用方法
 */

// 支持的标签列表（根据 @mtcute/html-parser 文档）
export const ALLOWED_TAGS = ['b', 'i', 'u', 's', 'code', 'a', 'pre', 'br', 'blockquote'];

// 不同类型的标签分类
export const SIMPLE_TAGS = ['b', 'i', 'u', 's', 'code'];
export const COMPLEX_TAGS = ['a', 'pre', 'blockquote'];
export const SELF_CLOSING_TAGS = ['br'];

// 正则表达式缓存
const TAG_PATTERN_CACHE = new Map<string, RegExp>();
const ATTRIBUTE_PATTERN_CACHE = new Map<string, RegExp>();

/**
 * 修复简单标签的开关对
 * @param html HTML文本
 * @param tag 标签名
 * @returns 修复后的HTML
 */
export function fixTagPairs(html: string, tag: string): string {
  const openPattern = new RegExp(`<${tag}[^>]*>`, 'g');
  const closePattern = new RegExp(`</${tag}>`, 'g');
  
  const openMatches = html.match(openPattern) || [];
  const closeMatches = html.match(closePattern) || [];
  
  let result = html;
  
  // 添加缺失的闭合标签
  if (openMatches.length > closeMatches.length) {
    for (let i = 0; i < openMatches.length - closeMatches.length; i++) {
      result += `</${tag}>`;
    }
  }
  // 移除多余的闭合标签
  else if (closeMatches.length > openMatches.length) {
    let excessCloseCount = closeMatches.length - openMatches.length;
    
    // 从字符串末尾开始删除多余的闭合标签
    while (excessCloseCount > 0) {
      const lastTag = `</${tag}>`;
      const lastPos = result.lastIndexOf(lastTag);
      if (lastPos !== -1) {
        result = result.substring(0, lastPos) + result.substring(lastPos + lastTag.length);
        excessCloseCount--;
      } else {
        break;
      }
    }
  }
  
  return result;
}

/**
 * 修复复杂标签的开关对，支持带属性的标签
 * @param html HTML文本
 * @param tag 标签名
 * @returns 修复后的HTML
 */
export function fixComplexTagPairs(html: string, tag: string): string {
  // 支持带属性的标签，如 <blockquote collapsible>
  const openPattern = new RegExp(`<${tag}(\\s+[^>]*)*>`, 'g');
  const closePattern = new RegExp(`</${tag}>`, 'g');
  
  const openMatches = html.match(openPattern) || [];
  const closeMatches = html.match(closePattern) || [];
  
  let result = html;
  
  // 添加缺失的闭合标签
  if (openMatches.length > closeMatches.length) {
    for (let i = 0; i < openMatches.length - closeMatches.length; i++) {
      result += `</${tag}>`;
    }
  }
  
  return result;
}

/**
 * 规范化自闭合标签
 * @param html HTML文本
 * @param tag 标签名
 * @returns 规范化后的HTML
 */
export function normalizeVoidTag(html: string, tag: string): string {
  // 确保自闭合标签格式正确，例如 <br> 而不是 <br/>
  return html.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'g'), `<${tag}>`);
}

/**
 * 确保HTML标签正确闭合，并移除任何残留的占位符
 * @param html HTML文本
 * @returns 清理并修复后的HTML
 */
export function ensureProperHtml(html: string): string {
  if (!html) return '';
  
  // 移除任何可能的HTML占位符
  let cleanedHtml = html.replace(/HTML[_-][A-Za-z]+[_-]?\d*/g, '');
  cleanedHtml = cleanedHtml.replace(/__TAG_\d+__/g, '');
  
  // 修复简单标签
  for (const tag of SIMPLE_TAGS) {
    cleanedHtml = fixTagPairs(cleanedHtml, tag);
  }
  
  // 修复复杂标签（包括有属性的标签）
  for (const tag of COMPLEX_TAGS) {
    cleanedHtml = fixComplexTagPairs(cleanedHtml, tag);
  }
  
  // 确保自闭合标签格式正确
  for (const tag of SELF_CLOSING_TAGS) {
    cleanedHtml = normalizeVoidTag(cleanedHtml, tag);
  }
  
  return cleanedHtml;
}

/**
 * 过滤HTML，只保留允许的标签
 * @param html HTML文本
 * @param allowedTags 允许的标签列表（默认使用ALLOWED_TAGS）
 * @returns 过滤后的HTML
 */
export function filterAllowedTags(html: string, allowedTags: string[] = ALLOWED_TAGS): string {
  if (!html) return '';
  
  // 先替换掉所有HTML标签占位符
  let cleanedText = html.replace(/HTML[_-][A-Za-z]+[_-]?\d*/g, '');
  
  // 标记现有的标签，以便后面恢复合法标签
  const existingTags: string[] = [];
  cleanedText = cleanedText.replace(/<[^>]+>/g, (match) => {
    existingTags.push(match);
    return `__TAG_${existingTags.length - 1}__`;
  });
  
  // 恢复合法的HTML标签，过滤掉不允许的标签
  for (let i = 0; i < existingTags.length; i++) {
    const tagContent = existingTags[i] || '';
    const tagMatch = tagContent.match(/<\/?([a-z]+).*?>/i);
    if (tagMatch && tagMatch[1] && allowedTags.includes(tagMatch[1].toLowerCase())) {
      cleanedText = cleanedText.replace(`__TAG_${i}__`, tagContent);
    } else {
      cleanedText = cleanedText.replace(`__TAG_${i}__`, '');
    }
  }
  
  // 确保所有标签都正确闭合
  return ensureProperHtml(cleanedText);
}

/**
 * 清理HTML文本中的占位符
 * @param html HTML文本
 * @returns 清理后的HTML
 */
export function cleanPlaceholders(html: string): string {
  if (!html) return '';
  
  return html
    .replace(/HTML[_-][A-Za-z]+[_-]?\d*/g, '')
    .replace(/__TAG_\d+__/g, '');
}

/**
 * 检查一个标签是否是完全闭合的
 * @param html HTML文本
 * @param tag 标签名
 * @returns 是否完全闭合
 */
export function isProperlyClosedTag(html: string, tag: string): boolean {
  let openPattern: RegExp;
  
  if (!TAG_PATTERN_CACHE.has(tag)) {
    openPattern = new RegExp(`<${tag}(\\s+[^>]*)*>`, 'g');
    TAG_PATTERN_CACHE.set(tag, openPattern);
  } else {
    openPattern = TAG_PATTERN_CACHE.get(tag)!;
  }
  
  const closePattern = new RegExp(`</${tag}>`, 'g');
  
  const openMatches = html.match(openPattern) || [];
  const closeMatches = html.match(closePattern) || [];
  
  return openMatches.length === closeMatches.length;
}

/**
 * 提取标签属性
 * @param html HTML文本
 * @param tag 标签名
 * @param attribute 属性名
 * @returns 属性值数组
 */
export function extractTagAttributes(html: string, tag: string, attribute: string): string[] {
  const cacheKey = `${tag}-${attribute}`;
  let pattern: RegExp;
  
  if (!ATTRIBUTE_PATTERN_CACHE.has(cacheKey)) {
    pattern = new RegExp(`<${tag}[^>]+${attribute}=["']([^"']+)["']`, 'gi');
    ATTRIBUTE_PATTERN_CACHE.set(cacheKey, pattern);
  } else {
    pattern = ATTRIBUTE_PATTERN_CACHE.get(cacheKey)!;
  }
  
  const matches: string[] = [];
  let match;
  
  while ((match = pattern.exec(html)) !== null) {
    if (match[1]) {
      matches.push(match[1]);
    }
  }
  
  return matches;
}

/**
 * 移除所有HTML标签，只保留文本内容
 * @param html HTML文本
 * @returns 纯文本
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  
  // 先处理CDATA
  let text = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  
  // 移除所有HTML标签
  text = text.replace(/<[^>]*>/g, '');
  
  // 解码HTML实体
  text = text.replace(/&([a-z0-9#]+);/gi, (match, entity) => {
    if (entity.charAt(0) === '#') {
      const code = entity.charAt(1) === 'x' ?
        parseInt(entity.substring(2), 16) :
        parseInt(entity.substring(1), 10);
      return String.fromCharCode(code);
    }
    
    const entities: Record<string, string> = {
      'amp': '&',
      'lt': '<',
      'gt': '>',
      'quot': '"',
      'apos': "'",
      'nbsp': ' '
    };
    
    return entities[entity] || match;
  });
  
  return text;
} 