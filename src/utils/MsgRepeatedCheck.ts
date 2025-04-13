/**
 * MsgRepeatedCheck.ts
 * 
 * 消息重复检测模块
 * 用于文本相似度计算、重复子串检测和多语言文本处理
 */

// 外部依赖
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

// ==========================================================
// 类型定义
// ==========================================================

/**
 * 支持的脚本类型
 */
export type ScriptType = 'chinese' | 'japanese' | 'korean' | 'thai' | 'latin' | 'other';

/**
 * 脚本范围配置接口
 */
interface ScriptRanges {
    [key: string]: number[][];
}

/**
 * 语言处理器接口
 * 提供语言特定的文本处理方法和参数
 */
interface LanguageProcessor {
    // 核心方法
    segment(text: string): string[];                    // 分词方法
    isValidSubstring(substr: string): boolean;          // 判断子串是否有效
    detectPatterns?(segments: string[]): number;        // 检测语言特定模式

    // 相似度计算参数
    similarityParams: {
        lengthThreshold: number;                       // 长度阈值
        adjustmentFactor: number;                      // 调整因子
        lenRatioThreshold: number;                     // 长度比例阈值
        penaltyFactor: number;                         // 惩罚因子
        coveragePower: number;                         // 覆盖率幂指数
    };

    // 子串检测参数
    substringParams: {
        maxLength(length: number): number;             // 计算最大子串长度
        stepSize(length: number): number;              // 计算步长
        minLength(rawMin: number, textLength: number): number; // 计算最小子串长度
    };

    // 实用工具方法
    getLanguageSeparators(): string[];                 // 获取语言分隔符
}

/**
 * 语言处理器工厂接口
 */
interface LanguageProcessorFactory {
    getProcessor(scriptType: ScriptType): LanguageProcessor;
    createProcessor(scriptType: ScriptType): LanguageProcessor;
}

/**
 * 文本相似度检测选项接口
 */
export interface TextSimilarityOptions {
    // 基础选项
    minTextLength: number;           // 最小文本长度
    minWordsCount: number;           // 最小词语数量

    // 相似度阈值选项
    baseThreshold: number;           // 基础相似度阈值
    lengthRatioThreshold: number;    // 长度比例阈值

    // 语言特定的调整参数
    languageAdjustments: {
        cjk: {                       // 中日韩文字特定调整
            thresholdAdjustment: number;  // 相似度阈值调整
            overlapThreshold: number;     // 字符重叠阈值
        },
        latin: {                     // 拉丁文字特定调整
            thresholdAdjustment: number;
            overlapThreshold: number;
        },
        other: {                     // 其他语言特定调整
            thresholdAdjustment: number;
            overlapThreshold: number;
        }
    };

    // 长文本处理选项
    longTextThreshold: number;       // 长文本阈值
    longTextAdjustment: number;      // 长文本相似度调整
}

/**
 * 默认的文本相似度检测选项
 */
export const DEFAULT_SIMILARITY_OPTIONS: TextSimilarityOptions = {
    // 基础选项
    minTextLength: 6,
    minWordsCount: 3,
    
    // 相似度阈值选项
    baseThreshold: 0.75,
    lengthRatioThreshold: 0.3,
    
    // 语言特定的调整参数
    languageAdjustments: {
        cjk: {
            thresholdAdjustment: 0.08,  // 中日韩文本需要更高的相似度阈值
            overlapThreshold: 0.3,      // 中日韩文本需要更高的字符重叠率
        },
        latin: {
            thresholdAdjustment: 0,
            overlapThreshold: 0.2,
        },
        other: {
            thresholdAdjustment: 0,
            overlapThreshold: 0.2,
        }
    },
    
    // 长文本处理选项
    longTextThreshold: 200,
    longTextAdjustment: 0.05,
};

// ==========================================================
// 常量和配置
// ==========================================================

// 初始化结巴分词器
const jieba = Jieba.withDict(dict);

// 各种语言的句子分隔符
const languageSeparators: Record<string, string[]> = {
    chinese: ["。", "！", "？", "…", "，", ";", "；", ":", "：", "\n"],
    japanese: ["。", "！", "？", "…", "，", ";", "；", ":", "：", "、", "\n", "」"],
    korean: [".", "!", "?", "…", ",", ";", ":", "\n"],
    thai: [".", "!", "?", "…", ",", ";", ":", "\n"],
    latin: [".", "!", "?", ";", "\n", "\r\n"],
    other: [".", "!", "?", "\n", "\r\n"]
};

// 日文特有的终助词
const japaneseEndParticles = ["ね", "よ", "な", "わ", "かな", "かしら", "ぞ", "ぜ", "ぞよ"];


// ==========================================================
// 语言处理器实现
// ==========================================================

/**
 * 基础语言处理器抽象类
 * 提供通用实现和默认值
 */
abstract class BaseLanguageProcessor implements LanguageProcessor {
    protected scriptType: ScriptType;

    constructor(scriptType: ScriptType) {
        this.scriptType = scriptType;
    }

    // 抽象方法，需子类实现
    // 确保返回值永远是字符串数组，即使是空数组
    abstract segment(text: string): string[];

    // 默认的子串有效性检测，子类可覆盖
    isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        // 忽略空白字符串
        if (!trimmed) return false;

        // 忽略简单的单字符重复
        if (/^(.)\1+$/.test(trimmed)) return false;

        // 基础过滤规则，适用于多数语言
        if (substr.length > 4 && new Set(substr).size <= 2) return false;
        if (substr.length > 10 && new Set(substr).size <= 3) return false;

        // 忽略全数字或全标点的子串
        if (/^\d+$/.test(trimmed)) return false;
        if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return false;

        return true;
    }

    // 可选的模式检测方法
    detectPatterns(segments: string[]): number {
        return 0; // 默认不检测任何模式
    }

    // 默认的相似度参数
    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.1,
            lenRatioThreshold: 0.3,
            penaltyFactor: 1.0,
            coveragePower: 1.2
        };
    }

    // 默认的子串检测参数
    get substringParams() {
        return {
            maxLength: (length: number) => Math.min(Math.floor(length / 2), 150),
            stepSize: (length: number) => Math.max(1, Math.floor(length / 5)),
            minLength: (rawMin: number, textLength: number) => {
                return Math.max(
                    rawMin,
                    Math.min(Math.ceil(Math.log2(textLength) / 2), 10)
                );
            }
        };
    }

    // 获取当前语言的分隔符
    getLanguageSeparators(): string[] {
        const separators = languageSeparators[this.scriptType];
        return Array.isArray(separators) ? separators : languageSeparators.other || [];
    }
}

/**
 * 中文语言处理器
 */
class ChineseProcessor extends BaseLanguageProcessor {
    constructor() {
        super('chinese');
    }

    segment(text: string): string[] {
        // 使用结巴分词替代简单分词
        const result = jieba.cut(text, false);

        // 确保返回值是数组
        return Array.isArray(result) ? result : [];
    }

    isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        if (!trimmed) return false;
        
        // 忽略单字符重复
        if (/^(.)\1+$/.test(trimmed)) return false;
        
        // 忽略全是标点或空格的子串
        if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;
        
        // 中文文本对熵的要求更低，因为中文字符本身携带更多信息
        if (substr.length > 5 && new Set(substr).size <= 2) return false;
        if (substr.length > 15 && new Set(substr).size <= 4) return false;
        
        // 中文文本特殊判断 - 对于6-10字的短文本，要求每个字的信息量更高
        if (substr.length >= 6 && substr.length <= 10) {
            // 计算中文字符的比例（优化性能）
            let chineseCharCount = 0;
            let i = 0;
            const len = substr.length;
            
            // 手动迭代而不是使用数组方法，避免创建临时数组
            for (; i < len; i++) {
                const code = substr.codePointAt(i) || 0;
                // 检查是否在中文 CJK 统一汉字范围内
                if (code >= 0x4e00 && code <= 0x9fff) {
                    chineseCharCount++;
                }
                // 如果是代理对，跳过低代理
                if (code > 0xFFFF) {
                    i++;
                }
            }
            
            const chineseRatio = chineseCharCount / substr.length;
            
            // 如果主要是中文字符，需要更高的熵
            if (chineseRatio > 0.7) {
                // 对于主要由中文组成的短文本，要求至少一半以上的字符是不同的
                const uniqueCharsRatio = new Set(substr).size / substr.length;
                if (uniqueCharsRatio < 0.5) return false;
            }
        }
        
        return true;
    }

    detectPatterns(segments: string[]): number {
        if (!segments || segments.length < 10) return 0;
        return detectChinesePatterns(segments);
    }

    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.12,
            lenRatioThreshold: 0.25,
            penaltyFactor: 1.2,
            coveragePower: 1.3
        };
    }

    get substringParams() {
        return {
            maxLength: (length: number) => Math.min(Math.floor(length / 2), 80),
            stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
            minLength: (rawMin: number, textLength: number) => {
                return Math.max(
                    Math.min(rawMin, 4),
                    Math.min(Math.ceil(Math.log2(textLength) / 3), 6)
                );
            }
        };
    }
}

/**
 * 日文语言处理器
 */
class JapaneseProcessor extends BaseLanguageProcessor {
    constructor() {
        super('japanese');
    }

    segment(text: string): string[] {
        // 优化日文分词实现
        // 使用更高效的方法分割日文文本
        return this.optimizedJapaneseSegment(text);
    }

    private optimizedJapaneseSegment(text: string): string[] {
        if (!text) return [];
        
        const segments: string[] = [];
        const separators = this.getLanguageSeparators();
        
        // 使用正则表达式直接进行分词
        const regex = /([ぁ-んァ-ヶー一-龯]+|[、。！？…，;；:：]|[\s\n]+|[a-zA-Z0-9]+|[^\s\n])/g;
        
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const token = match[0];
            if (!token || !token.trim()) continue;
            
            // 处理分隔符
            if (separators.some(sep => token.includes(sep))) {
                // 每个分隔符单独作为一个token
                for (let i = 0; i < token.length; i++) {
                    const char = token.charAt(i);
                    if (separators.includes(char)) {
                        segments.push(char);
                    } else if (char.trim()) {
                        segments.push(char);
                    }
                }
            }
            // 处理日文文本块
            else if (/[ぁ-んァ-ヶー一-龯]/.test(token)) {
                // 长文本进一步分割
                if (token.length > 8) {
                    // 按2-3个字符分割
                    for (let i = 0; i < token.length; i += 3) {
                        segments.push(token.substring(i, Math.min(i + 3, token.length)));
                    }
                } else {
                    segments.push(token);
                }
            }
            // 处理其他文本
            else {
                segments.push(token);
            }
        }
        
        return segments.filter(Boolean);
    }
    
    isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        if (!trimmed) return false;

        // 忽略单字符重复
        if (/^(.)\1+$/.test(trimmed)) return false;

        // 忽略全是标点或空格的子串
        if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

        // 由于假名字符比中文字符信息量更低，需要更严格的熵要求
        if (substr.length > 5 && new Set(substr).size <= 2) return false;
        if (substr.length > 12 && new Set(substr).size <= 3) return false;

        // 检查是否为纯假名串，假名重复性更高
        const hiraganaRatio = (trimmed.match(/[\u3040-\u309f]/g) || []).length / trimmed.length;
        const katakanaRatio = (trimmed.match(/[\u30a0-\u30ff]/g) || []).length / trimmed.length;

        if ((hiraganaRatio > 0.8 || katakanaRatio > 0.8) && new Set(trimmed).size <= 3) {
            return false;
        }

        return true;
    }

    detectPatterns(segments: string[]): number {
        if (!segments || segments.length < 10) return 0;
        return detectJapanesePatterns(segments);
    }

    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.11,
            lenRatioThreshold: 0.25,
            penaltyFactor: 1.1,
            coveragePower: 1.25
        };
    }

    get substringParams() {
        return {
            maxLength: (length: number) => Math.min(Math.floor(length / 2), 60),
            stepSize: (length: number) => Math.max(1, Math.floor(length / 4)),
            minLength: (rawMin: number, textLength: number) => {
                return Math.max(
                    Math.min(rawMin, 3),
                    Math.min(Math.ceil(Math.log2(textLength) / 4), 5)
                );
            }
        };
    }
}

/**
 * 韩文语言处理器
 */
class KoreanProcessor extends BaseLanguageProcessor {
    constructor() {
        super('korean');
    }

    segment(text: string): string[] {
        // 优化韩文分词实现
        // 使用更高效的方法处理韩文
        return this.optimizedKoreanSegment(text);
    }
    
    private optimizedKoreanSegment(text: string): string[] {
        if (!text) return [];
        
        const segments: string[] = [];
        const separators = this.getLanguageSeparators();
        
        // 使用正则表达式直接分词
        const regex = /([가-힣ㄱ-ㅎㅏ-ㅣ]+|[.!?,;:]|[\s\n]+|[a-zA-Z0-9]+|[^\s\n])/g;
        
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const token = match[0];
            if (!token || !token.trim()) continue;
            
            // 处理分隔符
            if (separators.some(sep => token.includes(sep))) {
                for (let i = 0; i < token.length; i++) {
                    const char = token.charAt(i);
                    if (separators.includes(char)) {
                        segments.push(char);
                    } else if (char.trim()) {
                        segments.push(char);
                    }
                }
            }
            // 处理韩文文本块
            else if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(token)) {
                // 长文本进一步分割
                if (token.length > 8) {
                    for (let i = 0; i < token.length; i += 3) {
                        segments.push(token.substring(i, Math.min(i + 3, token.length)));
                    }
                } else {
                    segments.push(token);
                }
            }
            // 处理其他文本
            else {
                segments.push(token);
            }
        }
        
        return segments.filter(Boolean);
    }
    
    isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        if (!trimmed) return false;

        // 忽略单字符重复
        if (/^(.)\1+$/.test(trimmed)) return false;

        // 忽略全是标点或空格的子串
        if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

        // 韩文字符的熵要求
        if (substr.length > 5 && new Set(substr).size <= 2) return false;
        if (substr.length > 10 && new Set(substr).size <= 3) return false;

        return true;
    }

    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.11,
            lenRatioThreshold: 0.25,
            penaltyFactor: 1.15,
            coveragePower: 1.25
        };
    }

    get substringParams() {
        return {
            maxLength: (length: number) => Math.min(Math.floor(length / 2), 70),
            stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
            minLength: (rawMin: number, textLength: number) => {
                return Math.max(
                    Math.min(rawMin, 3),
                    Math.min(Math.ceil(Math.log2(textLength) / 3), 5)
                );
            }
        };
    }
}

/**
 * 泰文语言处理器
 */
class ThaiProcessor extends BaseLanguageProcessor {
    constructor() {
        super('thai');
    }

    segment(text: string): string[] {
        // 优化泰文分词实现
        return this.optimizedThaiSegment(text);
    }
    
    private optimizedThaiSegment(text: string): string[] {
        if (!text) return [];
        
        const segments: string[] = [];
        const separators = this.getLanguageSeparators();
        
        // 使用正则表达式直接分词
        const regex = /([ก-๛]+|[.!?,;:]|[\s\n]+|[a-zA-Z0-9]+|[^\s\n])/g;
        
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const token = match[0];
            if (!token || !token.trim()) continue;
            
            // 处理分隔符
            if (separators.some(sep => token.includes(sep))) {
                for (let i = 0; i < token.length; i++) {
                    const char = token.charAt(i);
                    if (separators.includes(char)) {
                        segments.push(char);
                    } else if (char.trim()) {
                        segments.push(char);
                    }
                }
            }
            // 处理泰文文本块
            else if (/[ก-๛]/.test(token)) {
                // 长文本进一步分割
                if (token.length > 6) {
                    for (let i = 0; i < token.length; i += 2) {
                        segments.push(token.substring(i, Math.min(i + 2, token.length)));
                    }
                } else {
                    segments.push(token);
                }
            }
            // 处理其他文本
            else {
                segments.push(token);
            }
        }
        
        return segments.filter(Boolean);
    }
    
    isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        if (!trimmed) return false;

        // 忽略单字符重复
        if (/^(.)\1+$/.test(trimmed)) return false;

        // 忽略全是标点或空格的子串
        if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

        // 泰文字符的熵要求
        if (substr.length > 5 && new Set(substr).size <= 2) return false;
        if (substr.length > 10 && new Set(substr).size <= 3) return false;

        return true;
    }

    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.1,
            lenRatioThreshold: 0.25,
            penaltyFactor: 1.15,
            coveragePower: 1.25
        };
    }

    get substringParams() {
        return {
            maxLength: (length: number) => Math.min(Math.floor(length / 2), 70),
            stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
            minLength: (rawMin: number, textLength: number) => {
                return Math.max(
                    Math.min(rawMin, 3),
                    Math.min(Math.ceil(Math.log2(textLength) / 3), 5)
                );
            }
        };
    }
}

/**
 * 拉丁文(和其他空格分隔语言)处理器
 */
class LatinProcessor extends BaseLanguageProcessor {
    constructor() {
        super('latin');
    }

    segment(text: string): string[] {
        // 优化拉丁文分词
        return this.optimizedLatinSegment(text);
    }
    
    private optimizedLatinSegment(text: string): string[] {
        if (!text) return [];
        
        // 使用正则表达式分词
        const regex = /([a-zA-Z]+|[0-9]+|[.!?,;:"\(\)\[\]{}]|[\s\n]+|[^\s\n])/g;
        
        const segments: string[] = [];
        
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const token = match[0];
            if (token && token.trim()) {
                segments.push(token);
            }
        }
        
        return segments.filter(Boolean);
    }

    get similarityParams() {
        return {
            lengthThreshold: 50,
            adjustmentFactor: 0.1,
            lenRatioThreshold: 0.3,
            penaltyFactor: 1.0,
            coveragePower: 1.2
        };
    }
}

/**
 * 语言处理器工厂单例实现
 */
class LanguageProcessorFactoryImpl implements LanguageProcessorFactory {
    private static instance: LanguageProcessorFactoryImpl;
    private processors: Map<ScriptType, LanguageProcessor> = new Map();

    private constructor() {
        // 私有构造函数，防止外部直接实例化
    }

    /**
     * 获取工厂单例
     */
    public static getInstance(): LanguageProcessorFactoryImpl {
        if (!LanguageProcessorFactoryImpl.instance) {
            LanguageProcessorFactoryImpl.instance = new LanguageProcessorFactoryImpl();
        }
        return LanguageProcessorFactoryImpl.instance;
    }

    /**
     * 获取语言处理器实例
     * 优先使用缓存，缓存未命中时创建新实例
     */
    getProcessor(scriptType: ScriptType): LanguageProcessor {
        if (!this.processors.has(scriptType)) {
            this.processors.set(scriptType, this.createProcessor(scriptType));
        }
        return this.processors.get(scriptType)!;
    }

    /**
     * 创建语言处理器实例
     */
    createProcessor(scriptType: ScriptType): LanguageProcessor {
        switch (scriptType) {
            case 'chinese':
                return new ChineseProcessor();
            case 'japanese':
                return new JapaneseProcessor();
            case 'korean':
                return new KoreanProcessor();
            case 'thai':
                return new ThaiProcessor();
            case 'latin':
            case 'other':
            default:
                return new LatinProcessor();
        }
    }
}

// 导出工厂单例
export const languageProcessorFactory = LanguageProcessorFactoryImpl.getInstance();

// ==========================================================
// 基础工具类
// ==========================================================

/**
 * 表示文本中的一个范围
 */
class Range {
    public start: number;
    public end: number;
    public length: number;

    constructor(start: number, end: number) {
        this.start = start;
        this.end = end;
        this.length = end - start;
    }

    /**
     * 检查此范围是否与另一个范围重叠
     */
    overlaps(other: Range): boolean {
        return this.start < other.end && this.end > other.start;
    }

    /**
     * 检查一个位置是否包含在此范围内
     */
    contains(position: number): boolean {
        return position >= this.start && position < this.end;
    }
}

// ==========================================================
// 重复子串检测
// ==========================================================

/**
 * 表示在文本中找到的重复子串
 */
class RepeatedSubstring {
    public content: string;          // 子串内容
    public positions: number[];      // 子串出现的位置
    public length: number;           // 子串长度
    private textLength: number;      // 总文本长度（用于计算惩罚）

    /**
     * 创建重复子串实例
     * @param content 子串内容
     * @param firstPosition 第一次出现的位置
     * @param textLength 原文本总长度
     */
    constructor(content: string, firstPosition: number, textLength: number) {
        this.content = content;
        this.positions = [firstPosition];
        this.length = content.length;
        this.textLength = textLength;
    }

    /**
     * 添加子串的新出现位置
     * @param position 子串出现的位置
     */
    addPosition(position: number): void {
        this.positions.push(position);
    }

    /**
     * 获取子串重复次数
     */
    get count(): number {
        return this.positions.length;
    }

    /**
     * 计算此重复子串的惩罚分数
     * 分数考虑长度、频率和总文本覆盖率
     * @returns 计算的惩罚分数
     */
    calculatePenalty(): number {
        // 避免除零或极短文本的log(0)
        if (this.textLength <= 1) return 0;

        // 长度比率：对较长的重复加大惩罚，按文本长度平方根缩放
        const lengthRatio = Math.min(this.length / Math.sqrt(this.textLength), 0.5);

        // 覆盖率：使用对数比例考虑覆盖率影响递减
        // 添加小常数避免log(0)或log(1)问题
        const coverageRatio = Math.log2(1 + (this.length * this.count)) / Math.log2(3 + this.textLength);

        // 重复因子：基于重复次数的指数增长
        const repeatFactor = Math.pow(this.count, 1.5) / 10;

        // 基础分数组合各因素
        const baseScore = lengthRatio * (1 + coverageRatio) * repeatFactor;

        // 应用修改的sigmoid函数平滑0到1之间的分数分布
        const normalizedScore = this.modifiedSigmoid(baseScore * 5); // 乘数调整敏感度

        // 最终分数缩放
        return normalizedScore * 3;
    }

    /**
     * 修改的sigmoid函数，用于平滑分数分布
     * @param x 输入值（基础分数）
     * @returns 0到1之间的值
     */
    private modifiedSigmoid(x: number): number {
        // 调整k以控制曲线的陡度
        const k = 0.5;
        return 1 / (1 + Math.exp(-k * x));
    }
}

/**
 * 子串检测器
 * 检测文本中的重复子串并计算惩罚分数
 */
class SubstringDetector {
    // 核心属性
    private input: string;                       // 输入文本
    private minLength: number;                   // 最小子串长度
    private repeats: Map<string, RepeatedSubstring>; // 存储发现的重复子串
    private coveredRanges: Range[];              // 存储较长重复已覆盖的范围
    private totalLength: number;                 // 文本总长度
    private processedSubstrings: Set<string>;    // 已处理子串缓存
    private resultCache: Map<string, number>;    // 缓存计算结果

    // 语言相关属性
    private adjustedMinLength: number = 2;       // 调整后的最小长度
    private scriptType: ScriptType;              // 文本的主要脚本类型
    private languageProcessor: LanguageProcessor; // 语言处理器
    private segmentedInput: string[] = [];       // 分词结果 - 初始化为空数组而非null

    /**
     * 创建子串检测器实例
     * @param input 要分析的输入文本
     * @param minLength 最小子串长度（默认为2）
     */
    constructor(input: string, minLength: number = 2) {
        this.input = input;
        this.minLength = minLength;
        this.repeats = new Map<string, RepeatedSubstring>();
        this.coveredRanges = [];
        this.totalLength = input.length;
        this.processedSubstrings = new Set<string>();
        this.resultCache = new Map<string, number>();

        // 检测文本的脚本类型
        this.scriptType = detectMainScript(input);

        // 获取对应的语言处理器
        this.languageProcessor = languageProcessorFactory.getProcessor(this.scriptType);

        // 对无空格分隔的语言进行预处理：分词
        if (this.isNonSpacedScript()) {
            const segmented = this.languageProcessor.segment(input);
            // 确保分词结果是数组
            this.segmentedInput = Array.isArray(segmented) ? segmented : [];
        }

        // 动态调整最小长度，不同语言需要不同的阈值
        this.adjustMinLength();
    }

    /**
     * 检查当前文本是否为无空格分隔的脚本类型
     */
    private isNonSpacedScript(): boolean {
        return ['chinese', 'japanese', 'korean', 'thai'].includes(this.scriptType);
    }

    /**
     * 根据脚本类型调整最小长度
     */
    private adjustMinLength(): void {
        // 使用语言处理器计算最小长度
        this.adjustedMinLength = this.languageProcessor.substringParams.minLength(
            this.minLength,
            this.totalLength
        );

        // 确保最小长度至少为2
        this.adjustedMinLength = Math.max(2, this.adjustedMinLength);
    }

    /**
     * 执行重复子串检测
     * @param debug 是否启用调试输出
     * @returns 重复子串的总惩罚分数
     */
    detect(debug: boolean = false): number {
        // 缓存检查 - 如果相同输入已经计算过，直接返回结果
        const cacheKey = `${this.input}:${this.minLength}:${this.scriptType}`;
        if (this.resultCache.has(cacheKey)) {
            return this.resultCache.get(cacheKey)!;
        }

        // 快速路径：极短文本直接返回0
        if (this.totalLength < this.adjustedMinLength * 2) {
            return 0;
        }

        // 快速路径：检查字符多样性 - 如果文本熵很低，可能包含大量重复
        const uniqueChars = new Set(this.input).size;
        const charDiversity = uniqueChars / this.totalLength;

        // 极低熵文本（如重复字符）快速返回高惩罚
        if (this.totalLength > 10 && charDiversity < 0.1) {
            const quickPenalty = 0.5 + (1 - charDiversity) * 0.5;
            this.resultCache.set(cacheKey, quickPenalty);
            return quickPenalty;
        }

        // 根据语言类型调整最大长度
        const maxLength = this.languageProcessor.substringParams.maxLength(this.totalLength);

        let totalPenalty = 0;
        let totalCoverageLength = 0; // 所有覆盖段长度之和

        // 长度搜索策略优化
        // 1. 非常长的文本 (>10000): 稀疏采样检查，主要关注较长子串
        // 2. 长文本 (1000-10000): 二分采样搜索
        // 3. 中等文本 (100-1000): 常规增量搜索
        // 4. 短文本 (<100): 精确搜索所有可能长度

        // 策略1：非常长的文本，超稀疏采样
        if (this.totalLength > 10000) {
            // 只检查几个长度代表性样本
            const representativeLengths = [
                Math.floor(maxLength * 0.8),
                Math.floor(maxLength * 0.5),
                Math.floor(maxLength * 0.3),
                Math.floor(this.adjustedMinLength * 2)
            ].filter(len => len >= this.adjustedMinLength);

            for (const strLen of representativeLengths) {
                totalPenalty += this.detectForLength(strLen, true); // 启用稀疏采样
            }
        }
        // 策略2：长文本，使用二分采样搜索
        else if (this.totalLength > 1000) {
            const potentialLengths = this.getSampledLengths(maxLength, this.adjustedMinLength);
            for (const strLen of potentialLengths) {
                totalPenalty += this.detectForLength(strLen);
            }
        }
        // 策略3和4：中短文本，特殊优化
        else {
            // 针对无空格语言的特殊处理
            if (this.isNonSpacedScript() && this.segmentedInput.length > 5) {
                // 使用语言处理器检测特定模式
                if (this.languageProcessor.detectPatterns) {
                    const patternPenalty = this.languageProcessor.detectPatterns(this.segmentedInput);
                    if (patternPenalty > 0) {
                        totalPenalty += patternPenalty;
                    }
                }

                // 处理分词结果中的重复短语
                if (this.segmentedInput.length >= 4) {
                    totalPenalty += this.detectSegmentedRepeats();
                }
            }

            // 短文本使用更密集的长度步长
            const lengthStep = this.totalLength < 100 ? 1 : 2;
            for (let strLen = maxLength; strLen >= this.adjustedMinLength; strLen -= lengthStep) {
                totalPenalty += this.detectForLength(strLen);
            }
        }

        // 最终惩罚调整
        // 不同语言的覆盖比例需要不同程度的惩罚
        const coverageRatio = this.totalLength > 0 ?
            Math.min(totalCoverageLength / this.totalLength, 1.0) : 0;

        // 语言相关的覆盖率调整
        const coveragePower = this.languageProcessor.similarityParams.coveragePower;
        const finalPenalty = totalPenalty * (1 + Math.pow(Math.min(coverageRatio, 1.0), coveragePower));

        if (debug) {
            this.printDebugInfo(coverageRatio, finalPenalty);
        }

        // 缓存结果
        this.resultCache.set(cacheKey, finalPenalty);
        return finalPenalty;
    }

    /**
     * 针对特定长度执行子串检测，支持稀疏采样
     * @param strLen 子串长度
     * @param sparseSampling 是否使用稀疏采样(用于超长文本)
     * @returns 该长度的惩罚分数
     */
    private detectForLength(strLen: number, sparseSampling: boolean = false): number {
        let lengthPenalty = 0;

        // 根据语言设置步长，调整遍历粒度
        let step = this.languageProcessor.substringParams.stepSize(strLen);

        // 估算候选子串数量，如果太多则增加步长
        const candidateCount = Math.ceil((this.totalLength - strLen) / step);

        // 使用稀疏采样时大幅增加步长
        if (sparseSampling) {
            step = Math.max(step * 4, Math.ceil((this.totalLength - strLen) / 500));
        }
        // 正常采样的自适应步长
        else {
            step = candidateCount > 1000 ?
                Math.max(step, Math.ceil((this.totalLength - strLen) / 1000)) :
                step;
        }

        // 使用块处理策略，减少范围检查次数
        const blockSize = Math.min(1000, this.totalLength);
        for (let blockStart = 0; blockStart < this.totalLength - strLen; blockStart += blockSize) {
            const blockEnd = Math.min(blockStart + blockSize, this.totalLength - strLen);

            // 检查这个块是否已经被完全覆盖
            let blockFullyCovered = true;
            for (let pos = blockStart; pos < blockEnd; pos += Math.max(1, Math.floor(strLen / 2))) {
                if (!this.isPositionCovered(pos, strLen)) {
                    blockFullyCovered = false;
                    break;
                }
            }

            if (blockFullyCovered) continue;

            // 处理当前块中的候选子串
            for (let i = blockStart; i < blockEnd; i += step) {
                // 如果该位置已被标记为覆盖，则跳过
                if (this.isPositionCovered(i, strLen)) {
                    continue;
                }

                const substr = this.input.slice(i, i + strLen);

                // 如果该子串已被处理过，则跳过
                if (this.processedSubstrings.has(substr)) {
                    continue;
                }

                this.processedSubstrings.add(substr);

                // 判断子串是否有效
                if (!this.languageProcessor.isValidSubstring(substr)) {
                    continue;
                }

                // 构建KMP表 (优化版)
                const kmpTable = this.buildKMPTable(substr);

                // 查找所有有效位置
                const positions = this.findValidPositions(substr, strLen, kmpTable);

                // 仅当重复次数大于1时才计入
                if (positions.length > 1) {
                    const repeated = new RepeatedSubstring(substr, positions[0]!, this.totalLength);
                    for (let k = 1; k < positions.length; k++) {
                        repeated.addPosition(positions[k]!);
                    }

                    this.repeats.set(substr, repeated);

                    // 标记所有该子串的出现位置为已覆盖
                    positions.forEach(pos => this.markRangeCovered(pos, strLen));

                    // 累计惩罚分数
                    const penalty = repeated.calculatePenalty();
                    // 根据不同语言调整重复惩罚权重
                    lengthPenalty += this.languageProcessor.similarityParams.penaltyFactor * penalty;
                }
            }
        }

        return lengthPenalty;
    }

    /**
     * 获取采样的长度值，用于超长文本的二分检测
     */
    private getSampledLengths(maxLength: number, minLength: number): number[] {
        const result: number[] = [];

        // 添加最大长度
        result.push(maxLength);

        // 使用对数缩放采样间隔
        const samples = Math.min(10, maxLength - minLength);
        const logRange = Math.log(maxLength / minLength);

        for (let i = 1; i < samples; i++) {
            const factor = Math.exp(logRange * (i / samples));
            const length = Math.floor(minLength * factor);

            if (!result.includes(length) && length > minLength && length < maxLength) {
                result.push(length);
            }
        }

        // 添加最小长度
        if (!result.includes(minLength)) {
            result.push(minLength);
        }

        // 按降序排序
        return result.sort((a, b) => b - a);
    }

    // 辅助方法 - 位置和范围处理

    /**
     * 检查潜在子串范围是否与已覆盖的范围重叠
     */
    private isPositionCovered(position: number, length: number): boolean {
        // 性能优化：先进行快速检查，如果没有覆盖范围则直接返回false
        if (this.coveredRanges.length === 0) {
            return false;
        }

        const newRange = new Range(position, position + length);

        // 二分查找优化 - 按起始位置排序并二分查找相近的范围
        // 简化版：直接顺序遍历，但跳过明显不可能重叠的范围
        for (const range of this.coveredRanges) {
            // 快速路径：如果当前范围的起始位置远大于新范围的结束位置，则后续范围也不会重叠
            if (range.start >= newRange.end) {
                continue;
            }

            // 快速路径：如果当前范围的结束位置小于新范围的起始位置，则跳过
            if (range.end <= newRange.start) {
                continue;
            }

            // 经过快速路径筛选后，检查是否重叠
            if (range.overlaps(newRange)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 将检测到的重复子串覆盖的范围标记为已覆盖
     */
    private markRangeCovered(position: number, length: number): void {
        this.coveredRanges.push(new Range(position, position + length));

        // 性能优化：当覆盖范围过多时，按起始位置排序以优化后续查找
        if (this.coveredRanges.length % 50 === 0) {
            this.coveredRanges.sort((a, b) => a.start - b.start);
        }
    }

    // KMP算法子串搜索方法 - 优化版本

    /**
     * 使用KMP算法在输入文本中查找模式的起始索引
     */
    private kmpSearch(pattern: string, table: number[], startPos: number): number {
        const patternLength = pattern.length;
        let patternIndex = 0; // index for pattern[]
        let textIndex = startPos; // index for input[]

        // 性能优化：预计算输入文本的最大索引
        const maxTextIndex = this.totalLength;

        // 性能优化：避免重复字符串索引访问，缓存模式串
        const patternChars = [...pattern];

        while (textIndex < maxTextIndex) {
            if (patternChars[patternIndex] === this.input[textIndex]) {
                patternIndex++;
                textIndex++;
            }

            if (patternIndex === patternLength) {
                // Found a match
                return textIndex - patternIndex;
            } else if (textIndex < maxTextIndex && patternChars[patternIndex] !== this.input[textIndex]) {
                // Mismatch after patternIndex matches
                if (patternIndex !== 0) {
                    patternIndex = table[patternIndex - 1]!;
                } else {
                    textIndex++;
                }
            }
        }

        return -1; // Pattern not found
    }

    /**
     * 构建KMP失败函数（部分匹配表）- 优化版本
     */
    private buildKMPTable(pattern: string): number[] {
        const patternLength = pattern.length;
        const table: number[] = new Array(patternLength).fill(0);

        // 性能优化：预先分配内存
        let prefixLen = 0; // 前一个最长前缀后缀的长度

        // 优化循环：避免重复字符串索引访问
        const patternChars = [...pattern];

        // table[0]始终为0，从i = 1开始
        for (let i = 1; i < patternLength; i++) {
            // 处理前缀匹配
            while (prefixLen > 0 && patternChars[i] !== patternChars[prefixLen]) {
                prefixLen = table[prefixLen - 1]!;
            }

            // 如果当前字符匹配前缀的下一个字符，则前缀长度加1
            if (patternChars[i] === patternChars[prefixLen]) {
                prefixLen++;
            }

            // 设置表项
            table[i] = prefixLen;
        }

        return table;
    }

    /**
     * 在输入文本中查找子串的所有起始位置
     * 这些位置不被较长的重复覆盖
     */
    private findValidPositions(substr: string, length: number, kmpTable: number[]): number[] {
        const positions: number[] = [];
        let searchStartIndex = 0; // 在输入文本中开始下一次搜索的位置

        // 性能优化：对于长度超过100的文本，限制最大查找位置数
        const maxPositions = this.totalLength > 10000 ? 50 :
            (this.totalLength > 1000 ? 100 : 200);

        while (searchStartIndex <= this.totalLength - length) {
            const foundIndex = this.kmpSearch(substr, kmpTable, searchStartIndex);

            if (foundIndex === -1) {
                break; // 未找到更多匹配项
            }

            // 检查此特定匹配项是否被先前找到的*较长*重复覆盖
            if (!this.isPositionCovered(foundIndex, length)) {
                positions.push(foundIndex);

                // 限制最大位置数
                if (positions.length >= maxPositions) {
                    break;
                }
            }

            // 在当前匹配项之后立即开始下一次搜索
            searchStartIndex = foundIndex + 1;
        }

        return positions;
    }

    /**
     * Prints debug information about found repeats and scores.
     * @param coverageRatio Calculated coverage ratio.
     * @param finalPenalty The final calculated penalty score.
     */
    private printDebugInfo(coverageRatio: number, finalPenalty: number): void {
        if (this.repeats.size === 0) {
            console.log('No significant repeated substrings found.');
            return;
        }

        console.log('\n--- Repeated Substring Analysis ---');
        console.log(`Input Text Length: ${this.totalLength}`);
        console.log(`Adjusted Min Length: ${this.adjustedMinLength}`);
        console.log(`Overall Coverage Ratio (log-scaled): ${(coverageRatio * 100).toFixed(2)}%`);
        console.log(`Final Penalty Score: ${finalPenalty.toFixed(4)}`);
        console.log('------------------------------------');
        console.log('Detected Repeats (sorted by penalty):');

        const sortedRepeats = [...this.repeats.values()]
            .sort((a, b) => b.calculatePenalty() - a.calculatePenalty());

        sortedRepeats.forEach(repeat => {
            const score = repeat.calculatePenalty();
            // Calculate coverage percentage for this specific repeat
            const individualCoverage = this.totalLength > 0 ? (repeat.length * repeat.count / this.totalLength) * 100 : 0;

            console.log(
                `  - "${repeat.content}" (Len: ${repeat.length}, Count: ${repeat.count})` +
                `\n    Coverage: ${individualCoverage.toFixed(2)}%, Score: ${score.toFixed(4)}` +
                `\n    Positions: [${repeat.positions.join(', ')}]`
            );
        });
        console.log('------------------------------------\n');
    }

    /**
     * 在分词结果中检测重复短语
     * 专门针对中文、日文等已进行分词的语言
     * @returns 重复短语的惩罚分数
     */
    private detectSegmentedRepeats(): number {
        if (!this.segmentedInput || this.segmentedInput.length < 4) {
            return 0;
        }

        let penalty = 0;
        const segments = this.segmentedInput;
        const totalSegments = segments.length;

        // 检测重复的词组(2-4个词的组合)
        for (let phraseLen = 2; phraseLen <= 4; phraseLen++) {
            if (totalSegments < phraseLen * 2) continue;

            const phraseCounts: Map<string, number[]> = new Map();

            // 统计所有词组出现次数和位置
            for (let i = 0; i <= totalSegments - phraseLen; i++) {
                const phrase = segments.slice(i, i + phraseLen).join("");
                if (!phrase.trim()) continue;

                // 忽略熵过低的短语
                if (phraseLen === 2 && new Set(phrase).size < 2) continue;
                if (phraseLen > 2 && new Set(phrase).size < phraseLen) continue;

                if (!phraseCounts.has(phrase)) {
                    phraseCounts.set(phrase, [i]);
                } else {
                    phraseCounts.get(phrase)!.push(i);
                }
            }

            // 计算重复短语的惩罚
            for (const [phrase, positions] of phraseCounts.entries()) {
                if (positions.length > 1) {
                    // 计算短语的基础重要性分数 (短语长度越长，重要性越高)
                    const importance = Math.pow(phraseLen, 1.2) / 4;

                    // 计算重复次数的对数惩罚
                    const repetitionPenalty = Math.log2(positions.length) * 0.2;

                    // 计算间距的惩罚 (间距越近，惩罚越重)
                    let proximityPenalty = 0;
                    for (let i = 1; i < positions.length; i++) {
                        const distance = positions[i]! - positions[i - 1]!;
                        // 距离越近，惩罚越高，但有一个上限
                        proximityPenalty += Math.max(0, (10 - distance) / 10);
                    }
                    proximityPenalty = Math.min(proximityPenalty, positions.length);

                    // 组合所有惩罚因子
                    penalty += importance * (1 + repetitionPenalty + proximityPenalty / positions.length);
                }
            }
        }

        return penalty * this.languageProcessor.similarityParams.penaltyFactor;
    }
}

// ==========================================================
// 公共API - 主要导出函数
// ==========================================================

/**
 * 检测文本中的重复子串并计算惩罚分数
 * 
 * 该函数分析文本中的重复模式，考虑到重复的长度、频率和覆盖率，计算一个综合惩罚分数。
 * 支持多种语言，包括中文、日文、韩文、泰文和拉丁文等，为每种语言提供了优化的检测策略。
 * 
 * @param input 要分析的输入文本
 * @param debug 是否启用详细的调试输出（默认：false）
 * @param minLength 考虑为重复的最小子串长度（默认：5，实际会根据文本长度和语言类型动态调整）
 * @returns 表示重复程度的惩罚分数，分数越高表示重复越严重
 */
export function detectRepeatedSubstrings(input: string, debug: boolean = false, minLength: number = 5): number {
    // 基本检查
    if (!input || input.length < minLength * 2) {
        return 0;
    }

    // 检测文本的主要语言类型
    const scriptType = detectMainScript(input);
    
    // 快速路径：检查字符多样性（熵）
    const uniqueChars = new Set(input).size;
    const charDiversity = uniqueChars / input.length;
    
    // 低熵文本（大量重复字符）快速返回高惩罚
    if (input.length > 10 && charDiversity < 0.1) {
        return 0.8 + (1 - charDiversity) * 0.5; // 最高可达1.3
    }
    
    // 获取语言处理器并进行分词
    const processor = languageProcessorFactory.getProcessor(scriptType);
    const segments = processor.segment(input);
    
    // 组合得分计算
    let finalScore = 0;
    
    // 1. 子串级别的重复检测
    const detector = new SubstringDetector(input, minLength);
    const substringScore = detector.detect(debug);
    
    // 2. 分词级别的重复检测
    let segmentScore = 0;
    
    // 分词结果不为空时，检测词语和句式重复
    if (segments && segments.length >= 4) {
        // 词语重复检测
        const wordFrequency = new Map<string, number>();
        const wordPositions = new Map<string, number[]>();
        
        segments.forEach((word, index) => {
            // 忽略过短的词和数字
            if (word.length < 2 || /^\d+$/.test(word)) return; 
            
            // 记录词频和位置
            wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
            
            const positions = wordPositions.get(word) || [];
            positions.push(index);
            wordPositions.set(word, positions);
        });
        
        // 计算重复词的分数
        let wordRepetitionScore = 0;
        wordFrequency.forEach((count, word) => {
            if (count > 1) {
                // 计算因子：长词重复惩罚更高
                const wordLengthFactor = Math.min(1.5, Math.sqrt(word.length) / 2);
                // 重复次数的对数权重
                const countFactor = Math.log2(count + 1);
                
                // 位置分布评估
                const positions = wordPositions.get(word) || [];
                let proximityFactor = 1.0;
                
                if (positions.length > 1) {
                    // 计算平均间距
                    let totalDistance = 0;
                    for (let i = 1; i < positions.length; i++) {
                        const distance = positions[i]! - positions[i-1]!;
                        totalDistance += distance;
                    }
                    const avgDistance = totalDistance / (positions.length - 1);
                    
                    // 间距越小，惩罚越大
                    proximityFactor = Math.max(0.5, Math.min(1.5, 5 / (avgDistance + 1)));
                }
                
                // 根据重复模式计算词语重复得分
                const wordScore = wordLengthFactor * countFactor * proximityFactor;
                wordRepetitionScore += wordScore;
                
                // 开启调试模式时输出详细信息
                if (debug && wordScore > 0.5) {
                    console.log(`重复词: ${word}, 次数: ${count}, 分数: ${wordScore.toFixed(2)}`);
                }
            }
        });
        
        // 归一化词重复分数
        segmentScore = Math.min(1.0, wordRepetitionScore / Math.sqrt(segments.length));
        
        // 检测句式模式重复（中日文特别处理）
        if ((scriptType === 'chinese' || scriptType === 'japanese') && processor.detectPatterns) {
            const patternPenalty = processor.detectPatterns(segments) * 0.3;
            segmentScore += patternPenalty;
            
            if (debug && patternPenalty > 0.2) {
                console.log(`句式重复惩罚: ${patternPenalty.toFixed(2)}`);
            }
        }
    }
    
    // 3. 计算最终得分 - 结合子串级别和分词级别得分
    // 子串级别得分权重更高
    finalScore = substringScore * 0.7 + segmentScore * 0.3;
    
    // 4. 语言特定调整
    const scriptAdjustment: Record<ScriptType, number> = {
        'chinese': 1.1,    // 中文重复更明显
        'japanese': 1.1,   // 日文重复更明显
        'korean': 1.05,    // 韩文轻微提高
        'thai': 1.05,      // 泰文轻微提高
        'latin': 0.95,     // 拉丁文略微降低
        'other': 1.0       // 其他保持不变
    };
    
    finalScore *= (scriptAdjustment[scriptType] || 1.0);
    
    // 5. 长度归一化 - 对较长文本的要求更严格
    if (input.length > 200) {
        finalScore *= (1 + Math.log10(input.length / 200) * 0.2);
    }
    
    // 6. 最终限制得分范围
    return Math.min(2.0, Math.max(0, finalScore));
}

// ==========================================================
// 各语言特定处理模块
// ==========================================================

/**
 * 检测中文文本中的重复句式模式
 * @param segments 分词结果数组
 * @returns 句式重复的惩罚分数
 */
function detectChinesePatterns(segments: string[]): number {
    // 句式模式分析
    let patternPenalty = 0;

    // 1. 检测常见的句式重复 (如：句首词语重复)
    const sentenceBeginnings = new Map<string, number>();
    const sentenceEndings = new Map<string, number>();

    let currentSentence: string[] = [];

    // 安全获取中文分隔符
    const separators = languageSeparators['chinese'] || [];

    // 遍历所有分词，按句子分组并检测开头和结尾模式
    for (let i = 0; i < segments.length; i++) {
        const word = segments[i]!;
        currentSentence.push(word);

        // 如果是句末
        if (separators.includes(word) || i === segments.length - 1) {
            if (currentSentence.length >= 3) {
                // 记录句首词 (跳过可能的标点符号)
                let beginIndex = 0;
                while (beginIndex < currentSentence.length &&
                    separators.includes(currentSentence[beginIndex]!)) {
                    beginIndex++;
                }

                if (beginIndex < currentSentence.length) {
                    const beginWord = currentSentence[beginIndex]!;
                    sentenceBeginnings.set(beginWord, (sentenceBeginnings.get(beginWord) || 0) + 1);
                }

                // 记录句尾模式 (最后两个词，不包括句号等)
                let endIndex = currentSentence.length - 1;
                while (endIndex >= 0 && separators.includes(currentSentence[endIndex]!)) {
                    endIndex--;
                }

                if (endIndex >= 0) {
                    const endWord = currentSentence[endIndex]!;
                    sentenceEndings.set(endWord, (sentenceEndings.get(endWord) || 0) + 1);
                }
            }

            // 重置当前句子
            currentSentence = [];
        }
    }

    // 计算句式重复惩罚
    let maxBeginningCount = 0;
    let maxEndingCount = 0;

    // 找到最频繁的句首和句尾
    sentenceBeginnings.forEach(count => { maxBeginningCount = Math.max(maxBeginningCount, count); });
    sentenceEndings.forEach(count => { maxEndingCount = Math.max(maxEndingCount, count); });

    // 如果存在明显的句式重复，增加惩罚
    const sentenceCount = Math.max(1, Array.from(sentenceBeginnings.values()).reduce((sum, count) => sum + count, 0));

    if (maxBeginningCount > 2 && maxBeginningCount / sentenceCount > 0.4) {
        // 句首重复率超过40%
        patternPenalty += Math.log2(maxBeginningCount) * 0.8;
    }

    if (maxEndingCount > 2 && maxEndingCount / sentenceCount > 0.4) {
        // 句尾重复率超过40%
        patternPenalty += Math.log2(maxEndingCount) * 0.6;
    }

    return patternPenalty;
}

/**
 * 检测日文文本中的重复句式模式
 * @param segments 分词结果数组
 * @returns 句式重复的惩罚分数
 */
function detectJapanesePatterns(segments: string[]): number {
    let patternPenalty = 0;

    // 安全获取日文分隔符
    const separators = languageSeparators['japanese'] || [];

    // 分析句首和句尾
    const sentenceBeginnings = new Map<string, number>();
    const sentenceEndings = new Map<string, number>();

    let currentSentence: string[] = [];

    // 遍历所有分词
    for (let i = 0; i < segments.length; i++) {
        const word = segments[i]!;
        currentSentence.push(word);

        // 如果是句末
        if (separators.includes(word) || i === segments.length - 1) {
            if (currentSentence.length >= 3) {
                // 处理句首词
                let beginIndex = 0;
                while (beginIndex < currentSentence.length &&
                    separators.includes(currentSentence[beginIndex]!)) {
                    beginIndex++;
                }

                if (beginIndex < currentSentence.length) {
                    const beginWord = currentSentence[beginIndex]!;
                    sentenceBeginnings.set(beginWord, (sentenceBeginnings.get(beginWord) || 0) + 1);
                }

                // 处理句尾词
                let endIndex = currentSentence.length - 1;
                while (endIndex >= 0 && separators.includes(currentSentence[endIndex]!)) {
                    endIndex--;
                }

                if (endIndex >= 0) {
                    const endWord = currentSentence[endIndex]!;
                    sentenceEndings.set(endWord, (sentenceEndings.get(endWord) || 0) + 1);
                }
            }

            // 重置当前句子
            currentSentence = [];
        }
    }

    // 计算句式重复惩罚
    let maxBeginningCount = 0;
    let maxEndingCount = 0;

    sentenceBeginnings.forEach(count => { maxBeginningCount = Math.max(maxBeginningCount, count); });
    sentenceEndings.forEach(count => { maxEndingCount = Math.max(maxEndingCount, count); });

    // 统计句子总数
    const sentenceCount = Math.max(1, Array.from(sentenceBeginnings.values()).reduce((sum, count) => sum + count, 0));

    // 句首重复率超过一定阈值
    if (maxBeginningCount > 2 && maxBeginningCount / sentenceCount > 0.35) {
        patternPenalty += Math.log2(maxBeginningCount) * 0.7;
    }

    // 句尾重复率超过一定阈值
    if (maxEndingCount > 2 && maxEndingCount / sentenceCount > 0.35) {
        patternPenalty += Math.log2(maxEndingCount) * 0.5;
    }

    // 检测日语特有的终助词重复（如「～ね」「～よ」「～な」等）
    const endParticleCounts = new Map<string, number>();

    // 统计终助词出现次数
    sentenceEndings.forEach((count, word) => {
        if (japaneseEndParticles.some(particle => word.endsWith(particle))) {
            endParticleCounts.set(word, count);
        }
    });

    // 如果某个终助词出现频率过高
    if (endParticleCounts.size > 0) {
        let maxParticleCount = 0;
        endParticleCounts.forEach(count => { maxParticleCount = Math.max(maxParticleCount, count); });

        if (maxParticleCount > 2 && maxParticleCount / sentenceCount > 0.4) {
            patternPenalty += Math.log2(maxParticleCount) * 0.6;
        }
    }

    return patternPenalty;
}

/**
 * 检测文本的主要脚本类型
 * 
 * 分析文本字符的Unicode范围，确定文本的主要语言类型。
 * 针对长文本采用字符采样优化，减少处理时间。
 * 支持检测中文、日文、韩文、泰文、拉丁文等主要文字系统。
 * 
 * @param text 要检测的文本
 * @returns 检测到的主要脚本类型
 */
export function detectMainScript(text: string): ScriptType {
    if (!text) return 'other';

    // 快速检查：短文本直接检查首字符，避免采样开销
    if (text.length <= 5) {
        // 检查第一个有效字符
        for (let i = 0; i < text.length; i++) {
            const charCode = text.codePointAt(i) || 0;
            
            // 常见语言的快速检查
            if (charCode >= 0x4e00 && charCode <= 0x9fff) return 'chinese'; // 中文
            if (charCode >= 0x3040 && charCode <= 0x30ff) return 'japanese'; // 日文假名
            if (charCode >= 0xac00 && charCode <= 0xd7af) return 'korean'; // 韩文
            if (charCode >= 0x0e00 && charCode <= 0x0e7f) return 'thai'; // 泰文
            
            // 拉丁字母和数字
            if ((charCode >= 0x0041 && charCode <= 0x007A) || (charCode >= 0x0030 && charCode <= 0x0039)) {
                // 短文本中有超过一半是拉丁字符
                if (text.match(/[a-zA-Z0-9]/g)?.length || 0 > text.length / 2) {
                    return 'latin';
                }
            }
        }
    }

    // 初始化计数对象
    const counts: Record<ScriptType, number> = {
        chinese: 0,
        japanese: 0,
        korean: 0,
        thai: 0,
        latin: 0,
        other: 0
    };
    
    // 优化长文本的采样策略
    const sampleSize = Math.min(100, text.length);
    const samplePositions: number[] = [];
    const textLength = text.length;
    
    // 创建分布式采样位置
    if (textLength <= sampleSize) {
        // 文本较短，全部采样
        for (let i = 0; i < textLength; i++) {
            samplePositions.push(i);
        }
    } else {
        // 头中尾三段采样策略
        const stride = Math.max(1, Math.floor(textLength / sampleSize));
        for (let i = 0; i < textLength; i += stride) {
            samplePositions.push(i);
            if (samplePositions.length >= sampleSize) break;
        }
    }
    
    // 执行字符类型统计
    for (const pos of samplePositions) {
        const charCode = text.codePointAt(pos) || 0;
        
        // 主要脚本范围直接检查
        if (charCode >= 0x4e00 && charCode <= 0x9fff) {
            counts.chinese++;
        } else if (charCode >= 0x3040 && charCode <= 0x30ff) {
            counts.japanese++;
        } else if (charCode >= 0xac00 && charCode <= 0xd7af) {
            counts.korean++;
        } else if (charCode >= 0x0e00 && charCode <= 0x0e7f) {
            counts.thai++;
        } else if ((charCode >= 0x0041 && charCode <= 0x007A) || // 拉丁字母
                  (charCode >= 0x0030 && charCode <= 0x0039) || // 数字
                  (charCode >= 0x00C0 && charCode <= 0x00FF)) { // 扩展拉丁
            counts.latin++;
        } else {
            // 检查不常见范围
            if (charCode >= 0x3400 && charCode <= 0x4dbf || // CJK扩展A
                charCode >= 0xf900 && charCode <= 0xfaff || // CJK兼容汉字
                charCode >= 0x20000 && charCode <= 0x2ebef) { // CJK扩展B-F
                counts.chinese++;
            } else if (charCode >= 0x31f0 && charCode <= 0x31ff) { // 片假名音标扩展
                counts.japanese++;
            } else if ((charCode >= 0x1100 && charCode <= 0x11ff) || // 韩文字母
                       (charCode >= 0x3130 && charCode <= 0x318f)) { // 韩文兼容字母
                counts.korean++;
            } else {
                counts.other++;
            }
        }
    }
    
    // 找出主要脚本类型
    let maxCount = 0;
    let maxType: ScriptType = 'other';
    
    for (const type of Object.keys(counts) as ScriptType[]) {
        if (counts[type] > maxCount) {
            maxCount = counts[type];
            maxType = type;
        }
    }
    
    // 计算比例
    const totalSamples = samplePositions.length;
    const maxRatio = maxCount / totalSamples;
    
    // 比例太低视为混合文本
    if (maxRatio < 0.3) {
        return 'other';
    }
    
    // 特殊处理：中日混合文本
    // 中文和日文共享汉字，如果有日文特有字符超过10%，则判定为日文
    if (maxType === 'chinese' && counts.japanese > 0 && counts.japanese / totalSamples >= 0.1) {
        return 'japanese';
    }
    
    return maxType;
}
