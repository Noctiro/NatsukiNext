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

// ==========================================================
// 常量和配置
// ==========================================================

// 初始化结巴分词器
const jieba = Jieba.withDict(dict);

// 定义各种文字的Unicode范围 - 精简优化版本，减少检查范围
const scriptRanges: ScriptRanges = {
    // 中文 - 合并常用范围
    chinese: [
        [0x4e00, 0x9fff],   // CJK统一汉字（最常用）
        [0x3400, 0x4dbf],   // CJK扩展A
        [0xf900, 0xfaff],   // CJK兼容汉字
        [0x20000, 0x2ebef], // CJK扩展B-F (合并)
    ],
    // 日文特有字符
    japanese: [
        [0x3040, 0x30ff],   // 平假名和片假名（合并）
        [0x31f0, 0x31ff],   // 片假名音标扩展
    ],
    // 韩文 - 合并常用范围
    korean: [
        [0xac00, 0xd7af],   // 韩文音节（最常用）
        [0x1100, 0x11ff],   // 韩文字母
        [0x3130, 0x318f],   // 韩文兼容字母
    ],
    // 泰文
    thai: [
        [0x0e00, 0x0e7f],   // 泰文
    ],
};

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

// 常见中文标点符号
const chinesePunctuations: Set<string> = new Set([
    '，', '。', '？', '！', '、', '：', '；',
    '"', '"', '\'', '\'', '（', '）', '【', '】',
    '《', '》', '〈', '〉', '…', '—', '～', '·'
]);

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
        // 性能优化：对短文本使用简单分词，对长文本使用结巴分词
        const result = text.length < 50 ? 
            simpleSegmentChinese(text) : 
            jieba.cut(text, false);
        
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
        if (substr.length > 6 && new Set(substr).size <= 2) return false;
        if (substr.length > 15 && new Set(substr).size <= 4) return false;
        
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
        const result = segmentJapaneseText(text);
        return Array.isArray(result) ? result : [];
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
        const result = segmentKoreanText(text);
        return Array.isArray(result) ? result : [];
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
        const result = segmentThaiText(text);
        return Array.isArray(result) ? result : [];
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
        const result = segmentLatinText(text);
        return Array.isArray(result) ? result : [];
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
     * 检查子串是否有效
     * 根据不同语言的规则判断子串是否有效
     */
    private isValidSubstring(substr: string): boolean {
        // 使用全局的子串有效性检测函数
        return isValidSubstring(substr, this.scriptType);
    }

    /**
     * 检测不同脚本的特有模式
     * @returns 模式惩罚分数
     */
    private detectScriptPatterns(): number {
        if (!this.segmentedInput || this.segmentedInput.length < 10) {
            return 0;
        }

        // 使用语言处理器的模式检测方法
        if (this.languageProcessor.detectPatterns) {
            return this.languageProcessor.detectPatterns(this.segmentedInput);
        }
        
        return 0;
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
                        const distance = positions[i]! - positions[i-1]!;
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
    if (!input || input.length < minLength * 2) {
        // 基本检查：如果输入太短，无法包含足够长的重复，则返回0
        return 0;
    }
    const detector = new SubstringDetector(input, minLength);
    return detector.detect(debug);
}

/**
 * 基于分词的文本相似度计算优化版，针对多种语言进行了优化。
 * 使用余弦相似度算法，结合了特定语言的处理策略和参数调整。
 * 
 * @param text1 第一个文本
 * @param text2 第二个文本
 * @returns 相似度得分 (0-1)，0表示完全不同，1表示完全相同
 */
export function calculateTextSimilarity(text1: string, text2: string): number {
    // 快速路径1: 空文本或完全相同文本的处理
    if (!text1 || !text2) return 0;
    const trimmed1 = text1.trim();
    const trimmed2 = text2.trim();
    if (!trimmed1 || !trimmed2) return 0;
    
    // 快速路径2: 文本完全相同
    if (trimmed1 === trimmed2) return 1.0;
    
    // 快速路径3: 非常短的文本直接比较
    if (trimmed1.length < 5 && trimmed2.length < 5) {
        return trimmed1 === trimmed2 ? 1.0 : 0.0;
    }

    // 快速路径4: 长度比较，如果长度相差太多，可以快速判定相似度较低
    const len1 = trimmed1.length;
    const len2 = trimmed2.length;
    const lenRatio = Math.min(len1, len2) / Math.max(len1, len2);
    
    // 长度差异过大
    if (lenRatio < 0.1) {
        return lenRatio * 0.5; // 基于长度比例给出一个较低的相似度估计
    }

    // 快速路径5: 字符集差异检查 - 如果两个文本的字符集完全不同，相似度很低
    if (len1 > 10 && len2 > 10) {
        const chars1 = new Set(trimmed1.substring(0, 100));
        const chars2 = new Set(trimmed2.substring(0, 100));
        
        // 检查字符集交集比例
        let overlap = 0;
        for (const char of chars1) {
            if (chars2.has(char)) overlap++;
        }
        
        const overlapRatio = overlap / Math.min(chars1.size, chars2.size);
        if (overlapRatio < 0.2) {
            return overlapRatio * 0.5; // 极低字符重叠，直接返回低相似度
        }
    }

    // 检测文本的主要语言类型
    const script1 = detectMainScript(trimmed1);
    const script2 = detectMainScript(trimmed2);

    // 获取语言参数
    const params = getLanguageParams(script1);
    const lenRatioThreshold = params.lenRatioThreshold;

    // 语言差异惩罚计算
    let scriptMismatchPenalty = 0;

    // 不同语言混合使用的情况通常很难被认为具有高相似性
    if (script1 !== script2 && script1 !== 'other' && script2 !== 'other') {
        // 预先计算相似度特征
        scriptMismatchPenalty = 0.3;

        // 中日韩文字有共通性，减轻惩罚
        const cjkScripts = ['chinese', 'japanese', 'korean'];
        if (cjkScripts.includes(script1) && cjkScripts.includes(script2)) {
            scriptMismatchPenalty = 0.1;
        }
    }

    // 长度比例低于阈值且语言不同，相似度较低
    if (lenRatio < lenRatioThreshold) {
        return Math.max(0, lenRatio * 0.5 - scriptMismatchPenalty);
    }
    
    // 采样优化: 超长文本只对部分内容进行比较
    // 选择重点区域比较: 开头、中间、结尾
    const maxFullAnalysisLength = 5000; // 降低全文分析长度阈值
    let sampleText1 = trimmed1;
    let sampleText2 = trimmed2;
    
    if (len1 > maxFullAnalysisLength || len2 > maxFullAnalysisLength) {
        // 智能采样: 更注重文本的开头和结尾部分
        const sampleSize = Math.min(1500, Math.max(len1, len2) / 3);
        
        // 采样三个区域: 开头、中间和结尾
        sampleText1 = smartSampleText(trimmed1, sampleSize);
        sampleText2 = smartSampleText(trimmed2, sampleSize);
    }

    // 获取词频映射 - 使用缓存提高性能
    const freqMap1 = getWordFrequencyMap(sampleText1, script1);
    const freqMap2 = getWordFrequencyMap(sampleText2, script2);

    // 计算优化版的余弦相似度
    return calculateCosineSimilarity(
        freqMap1, 
        freqMap2, 
        script1, 
        len1, 
        len2,
        scriptMismatchPenalty
    );
}

/**
 * 智能文本采样 - 关注文本的关键部分
 * @param text 原始文本
 * @param sampleSize 每个区域的采样大小
 * @returns 采样后的文本
 */
function smartSampleText(text: string, sampleSize: number): string {
    const len = text.length;
    
    if (len <= sampleSize * 3) {
        return text;
    }
    
    // 采样开头、中间和结尾
    const headSample = text.substring(0, sampleSize);
    const middleStart = Math.floor((len - sampleSize) / 2);
    const middleSample = text.substring(middleStart, middleStart + sampleSize);
    const tailSample = text.substring(len - sampleSize);
    
    return headSample + middleSample + tailSample;
}

/**
 * 获取词频映射 - 添加缓存层优化性能
 */
const wordFreqCache = new Map<string, Record<string, number>>();
const MAX_CACHE_SIZE = 100; // 限制缓存大小

function getWordFrequencyMap(text: string, scriptType: ScriptType = 'other'): Record<string, number> {
    // 生成缓存键
    const cacheKey = `${scriptType}:${text.substring(0, 100)}:${text.length}`;
    
    // 检查缓存
    if (wordFreqCache.has(cacheKey)) {
        return wordFreqCache.get(cacheKey)!;
    }
    
    // 获取语言处理器并进行分词
    const processor = languageProcessorFactory.getProcessor(scriptType);
    const segments = processor.segment(text);
    
    // 统计词频
    const freqMap: Record<string, number> = {};
    for (const segment of segments) {
        const word = segment.trim();
        if (word) {
            freqMap[word] = (freqMap[word] || 0) + 1;
        }
    }
    
    // 缓存管理：如果缓存过大，清除最早的条目
    if (wordFreqCache.size >= MAX_CACHE_SIZE) {
        const firstKey = wordFreqCache.keys().next().value;
        wordFreqCache.delete(firstKey);
    }
    
    // 存入缓存
    wordFreqCache.set(cacheKey, freqMap);
    return freqMap;
}

/**
 * 计算两个词频向量之间的余弦相似度 - 高度优化版
 * @param freqMap1 第一个词频映射
 * @param freqMap2 第二个词频映射
 * @param scriptType 主要脚本类型
 * @param length1 文本1长度
 * @param length2 文本2长度
 * @param scriptPenalty 语言差异惩罚
 * @returns 余弦相似度 (0-1)
 */
function calculateCosineSimilarity(
    freqMap1: Record<string, number>,
    freqMap2: Record<string, number>,
    scriptType: ScriptType,
    length1: number,
    length2: number,
    scriptPenalty: number = 0
): number {
    const words1 = Object.keys(freqMap1);
    const words2 = Object.keys(freqMap2);

    // 如果任一文本没有有效词语，返回低相似度
    if (words1.length === 0 || words2.length === 0) {
        return 0.1;
    }
    
    // 词汇多样性差异检查
    const vocabRatio = Math.min(words1.length, words2.length) / Math.max(words1.length, words2.length);
    if (vocabRatio < 0.2) {
        return vocabRatio * 0.5;
    }
    
    // 性能优化：如果一个映射远小于另一个，使用较小的映射作为迭代基础
    const useMap1AsBase = words1.length <= words2.length;
    const baseWords = useMap1AsBase ? words1 : words2;
    const compareMap = useMap1AsBase ? freqMap2 : freqMap1;
    
    // 预先计算平方和，避免重复计算
    let norm1 = 0;
    for (const word of words1) {
        const count = freqMap1[word]!;
        norm1 += count * count;
    }
    
    let norm2 = 0;
    for (const word of words2) {
        const count = freqMap2[word]!;
        norm2 += count * count;
    }
    
    // 只对基础映射中的词进行点积计算，减少查找操作
    let dotProduct = 0;
    let matches = 0;
    for (const word of baseWords) {
        const count1 = useMap1AsBase ? freqMap1[word]! : compareMap[word] || 0;
        const count2 = useMap1AsBase ? compareMap[word] || 0 : freqMap2[word]!;
        
        if (count1 > 0 && count2 > 0) {
            matches++;
            dotProduct += count1 * count2;
        }
    }

    // 计算余弦相似度
    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    if (denominator === 0) {
        return 0.1;
    }

    // 基础余弦相似度
    let cosineSim = dotProduct / denominator;
    
    // 词汇匹配率调整 - 计算共同词汇的占比
    const matchRatio = matches / Math.max(words1.length, words2.length);
    cosineSim = cosineSim * (0.8 + 0.2 * matchRatio);

    // 长文本相似度调整：针对不同语言进行参数调整
    if (length1 > 50 || length2 > 50) {
        const params = getLanguageParams(scriptType);
        const adjustmentFactor = params.adjustmentFactor;
        const lengthThreshold = params.lengthThreshold;
        
        // 使用对数缩放进行长度调整
        const maxLength = Math.max(length1, length2);
        const textLengthFactor = maxLength > lengthThreshold ? 
            adjustmentFactor * Math.log10(maxLength / lengthThreshold) : 0;
            
        cosineSim = Math.max(0, cosineSim - textLengthFactor);
    }
    
    // 应用语言差异惩罚
    cosineSim = Math.max(0, cosineSim - scriptPenalty);
    
    return cosineSim;
}

/**
 * 对长文本进行智能采样
 * @param text 原始文本
 * @param maxLength 采样后的最大长度
 * @returns 采样后的文本
 */
function sampleLongText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    
    // 智能采样策略：取文本开头、中间和结尾部分
    const headRatio = 0.4; // 开头占比
    const midRatio = 0.2;  // 中间占比
    const tailRatio = 0.4; // 结尾占比
    
    const headLength = Math.floor(maxLength * headRatio);
    const midLength = Math.floor(maxLength * midRatio);
    const tailLength = maxLength - headLength - midLength;
    
    const head = text.substring(0, headLength);
    const mid = text.substring(
        Math.floor(text.length / 2 - midLength / 2),
        Math.floor(text.length / 2 + midLength / 2)
    );
    const tail = text.substring(text.length - tailLength);
    
    return head + mid + tail;
}

/**
 * 检查是否为纯英文字母或数字
 * @param char 要检查的字符
 * @returns 是否为纯英文字母或数字
 */
function isPlainLetter(char: string): boolean {
    // 检查是否为纯英文字母或数字
    const charCode = char.codePointAt(0) || 0;
    const isLatin = (charCode >= 0x0041 && charCode <= 0x007A) || // Basic Latin letters
        (charCode >= 0x00C0 && charCode <= 0x00FF);  // Latin-1 Supplement
    const isDigit = charCode >= 0x0030 && charCode <= 0x0039; // 0-9
    return isLatin || isDigit;
}

/**
 * 检查是否为纯标点符号
 * @param char 要检查的字符
 * @returns 是否为纯标点符号
 */
function isPunctuation(char: string): boolean {
    const charCode = char.codePointAt(0) || 0;

    // 常见标点符号范围
    if ((charCode >= 0x0021 && charCode <= 0x002F) || // !"#$%&'()*+,-./
        (charCode >= 0x003A && charCode <= 0x0040) || // :;<=>?@
        (charCode >= 0x005B && charCode <= 0x0060) || // [\]^_`
        (charCode >= 0x007B && charCode <= 0x007E) || // {|}~
        (charCode >= 0x2000 && charCode <= 0x206F) || // 常见标点符号与格式控制字符
        (charCode >= 0x3000 && charCode <= 0x303F) || // CJK符号与标点
        (charCode >= 0xFF00 && charCode <= 0xFFEF)) { // 全角ASCII、半角片假名、全角片假名、全角标点
        return true;
    }

    return false;
}

/**
 * 针对短文本的快速简易中文分词
 * 性能优先于准确性，适用于重复检测场景
 * @param text 中文文本
 * @returns 分词结果
 */
function simpleSegmentChinese(text: string): string[] {
    const segments: string[] = [];
    let currentSegment = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;

        // 处理标点符号
        if (chinesePunctuations.has(char)) {
            // 保存当前片段
            if (currentSegment) {
                segments.push(currentSegment);
                currentSegment = '';
            }
            segments.push(char);
            continue;
        }

        // 检查是否为英文或数字
        if (/[a-zA-Z0-9]/.test(char)) {
            // 如果当前片段是中文，先保存
            if (currentSegment && /[\u4e00-\u9fff]/.test(currentSegment[0]!)) {
                segments.push(currentSegment);
                currentSegment = char;
            } else {
                // 继续积累英文/数字片段
                currentSegment += char;
            }
        } else {
            // 处理中文字符
            // 简化策略：每1-2个中文字符作为一个词（比真实分词粗糙但计算快）
            const prevChar = currentSegment[currentSegment.length - 1];

            // 如果当前片段为空或者是英文/数字，或已有两个中文字符，则开始新片段
            if (!currentSegment || /[a-zA-Z0-9]/.test(prevChar!) || currentSegment.length >= 2) {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = char;
            } else {
                // 继续积累中文片段
                currentSegment += char;
            }
        }
    }

    // 处理最后一个片段
    if (currentSegment) {
        segments.push(currentSegment);
    }

    return segments;
}

/**
 * 检查字符编码是否在指定的范围数组内
 * 优化版本：内联扁平化范围检查，减少循环
 * @param charCode 字符编码
 * @param ranges 范围数组
 * @returns 是否在范围内
 */
function isInRanges(charCode: number, ranges: number[][]): boolean {
    if (!ranges) return false;
    
    // 直接检查范围而不使用循环
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        if (range && range.length === 2) {
            const start = range[0];
            const end = range[1];
            if (start !== undefined && end !== undefined && charCode >= start && charCode <= end) {
                return true;
            }
        }
    }
    return false;
}

// ==========================================================
// 各语言特定处理模块
// ==========================================================

/**
 * 获取特定语言脚本的处理参数
 * @param scriptType 脚本类型
 * @returns 语言处理参数
 */
function getLanguageParams(scriptType: ScriptType): {
    maxLength: (length: number) => number;
    stepSize: (length: number) => number;
    penaltyFactor: number;
    coveragePower: number;
    lenRatioThreshold: number;
    adjustmentFactor: number;
    lengthThreshold: number; // 添加lengthThreshold属性
} {
    const processor = languageProcessorFactory.getProcessor(scriptType);
    
    return {
        maxLength: processor.substringParams.maxLength,
        stepSize: processor.substringParams.stepSize,
        penaltyFactor: processor.similarityParams.penaltyFactor,
        coveragePower: processor.similarityParams.coveragePower,
        lenRatioThreshold: processor.similarityParams.lenRatioThreshold,
        adjustmentFactor: processor.similarityParams.adjustmentFactor,
        lengthThreshold: 50 // 使用默认值，与processor.similarityParams.lengthThreshold保持一致
    };
}

/**
 * 检测语言特定模式
 * @param scriptType 脚本类型
 * @param segments 分词结果数组
 * @returns 模式惩罚分数
 */
function detectLanguagePatterns(scriptType: ScriptType, segments: string[]): number {
    const processor = languageProcessorFactory.getProcessor(scriptType);
    if (processor.detectPatterns) {
        return processor.detectPatterns(segments);
    }
    return 0;
}

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
 * 检查子串是否有效
 * @param substr 子串
 * @param scriptType 语言类型
 * @returns 是否有效
 */
function isValidSubstring(substr: string, scriptType: ScriptType): boolean {
    const processor = languageProcessorFactory.getProcessor(scriptType);
    return processor.isValidSubstring(substr);
}

/**
 * 文本分词
 * 
 * 根据文本的主要语言类型进行智能分词。
 * 支持多种语言，包括中文、日文、韩文、泰文和拉丁文等。
 * 
 * @param text 要分词的文本
 * @returns 分词结果数组
 */
export function segmentText(text: string): string[] {
    // 检测文本的主要语言类型
    const scriptType = detectMainScript(text);
    const processor = languageProcessorFactory.getProcessor(scriptType);
    
    // 使用语言处理器进行分词
    return processor.segment(text);
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

    // 快速检查：短文本直接返回，避免后续计算
    if (text.length <= 2) {
        const charCode = text.codePointAt(0) || 0;
        
        // 快速判断最常见的情况
        if (charCode >= 0x4e00 && charCode <= 0x9fff) return 'chinese';
        if (charCode >= 0x3040 && charCode <= 0x30ff) return 'japanese';
        if (charCode >= 0xac00 && charCode <= 0xd7af) return 'korean';
        if ((charCode >= 0x0041 && charCode <= 0x007A) || 
            (charCode >= 0x0030 && charCode <= 0x0039)) return 'latin';
        if (charCode >= 0x0e00 && charCode <= 0x0e7f) return 'thai';
        return 'other';
    }

    const counts: Record<ScriptType, number> = {
        chinese: 0,
        japanese: 0,
        korean: 0,
        thai: 0,
        latin: 0,
        other: 0
    };

    // 性能优化：对长文本采用分布式采样
    // 对于长文本，完整分析每个字符开销较大且意义不大
    const maxSampleSize = 100; // 降低采样数，提高性能
    const textLength = text.length;
    
    // 创建采样方案：头部、中部、尾部各采样一定数量
    let samplePositions: number[] = [];
    
    if (textLength <= maxSampleSize) {
        // 文本较短，全部采样
        for (let i = 0; i < textLength; i++) {
            samplePositions.push(i);
        }
    } else {
        // 头部采样 (40%)
        const headSamples = Math.floor(maxSampleSize * 0.4);
        const headStride = Math.max(1, Math.floor(textLength * 0.25 / headSamples));
        for (let i = 0; i < textLength * 0.25; i += headStride) {
            samplePositions.push(Math.floor(i));
        }
        
        // 中部采样 (30%)
        const midSamples = Math.floor(maxSampleSize * 0.3);
        const midStart = Math.floor(textLength * 0.25);
        const midEnd = Math.floor(textLength * 0.75);
        const midStride = Math.max(1, Math.floor((midEnd - midStart) / midSamples));
        for (let i = midStart; i < midEnd; i += midStride) {
            samplePositions.push(Math.floor(i));
        }
        
        // 尾部采样 (30%)
        const tailSamples = Math.floor(maxSampleSize * 0.3);
        const tailStride = Math.max(1, Math.floor(textLength * 0.25 / tailSamples));
        for (let i = Math.floor(textLength * 0.75); i < textLength; i += tailStride) {
            samplePositions.push(Math.floor(i));
        }
    }

    // 使用查找表优化范围检查，避免多次条件判断
    const checkCharCode = (charCode: number): ScriptType => {
        // 按出现频率高低排序检查，减少平均检查次数
        if (charCode >= 0x4e00 && charCode <= 0x9fff) {
            return 'chinese'; // 最常见的CJK统一汉字范围
        } 
        if (charCode >= 0x3040 && charCode <= 0x30ff) {
            return 'japanese'; // 日文平假名和片假名范围
        } 
        if (charCode >= 0xac00 && charCode <= 0xd7af) {
            return 'korean'; // 韩文音节范围
        } 
        if ((charCode >= 0x0041 && charCode <= 0x007A) ||
            (charCode >= 0x00C0 && charCode <= 0x00FF)) {
            return 'latin'; // 拉丁字母范围
        } 
        if (charCode >= 0x0e00 && charCode <= 0x0e7f) {
            return 'thai'; // 泰文范围
        }
        
        // 不常见范围检查 - 仅当主要范围未匹配时才检查
        const lessCommonType = isInLessCommonRanges(charCode);
        if (lessCommonType) {
            return lessCommonType as ScriptType;
        }
        
        return 'other';
    };

    // 计算各种文字的字符数量
    for (const pos of samplePositions) {
        const charCode = text.codePointAt(pos) || 0;
        
        // 直接使用查找函数处理字符类型
        const type = checkCharCode(charCode);
        counts[type]++;
        
        // 如果是代理对，调整索引位置 (不影响采样)
        if (charCode > 0xFFFF && samplePositions.includes(pos + 1)) {
            const index = samplePositions.indexOf(pos + 1);
            if (index !== -1) {
                samplePositions.splice(index, 1);
            }
        }
    }

    // 找出数量最多的文字类型
    let maxCount = 0;
    let maxType: ScriptType = 'other';

    for (const type of Object.keys(counts) as ScriptType[]) {
        if (counts[type] > maxCount) {
            maxCount = counts[type];
            maxType = type;
        }
    }

    // 计算最多类型的比例
    const totalSamples = samplePositions.length;
    const maxRatio = maxCount / totalSamples;

    // 如果最多类型的比例不足30%，则视为其他类型
    if (maxRatio < 0.3) {
        return 'other';
    }

    // 特殊处理：中日文共享汉字，如果有日文特有字符且比例超过10%，则优先判定为日文
    if (maxType === 'chinese' && counts.japanese > 0 && counts.japanese / totalSamples >= 0.1) {
        return 'japanese';
    }

    return maxType;
}

/**
 * 检查字符是否属于不太常见的文字范围
 * 优化版本：内联常见范围检查，减少条件分支
 * @param charCode 字符编码
 * @returns 对应的文字类型，或null
 */
function isInLessCommonRanges(charCode: number): string | null {
    // 检查不常见的中文和日韩文范围
    if ((charCode >= 0x3400 && charCode <= 0x4dbf) ||    // CJK扩展A
        (charCode >= 0xf900 && charCode <= 0xfaff) ||    // CJK兼容汉字
        (charCode >= 0x20000 && charCode <= 0x2ebef)) {  // CJK扩展B-F
        return 'chinese';
    }
    
    if (charCode >= 0x31f0 && charCode <= 0x31ff) { // 片假名音标扩展
        return 'japanese';
    }
    
    if ((charCode >= 0x1100 && charCode <= 0x11ff) || // 韩文字母
        (charCode >= 0x3130 && charCode <= 0x318f)) { // 韩文兼容字母
        return 'korean';
    }

    return null;
}

/**
 * 对日文文本进行简单分词
 * 结合字符级别分割和基本词汇识别
 * @param text 日文文本
 * @returns 分词结果
 */
function segmentJapaneseText(text: string): string[] {
    // 基础实现：按字符和标点进行分割
    // 日文的分词实际上很复杂，这里做一个简化处理
    // 实际应用中应使用专门的日文分词库

    const segments: string[] = [];
    let currentSegment = '';
    let inJapaneseWord = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const charCode = text.codePointAt(i) || 0;

        // 如果是代理对，调整索引
        if (charCode > 0xFFFF) {
            i++;
        }

        // 判断字符类型
        const isJapaneseChar = isInRanges(charCode, scriptRanges.japanese || []) ||
            isInRanges(charCode, scriptRanges.chinese || []); // 汉字在日语中也常用
        const isPunctuation = /[\p{P}\p{Z}]/u.test(char);

        if (isPunctuation) {
            // 标点符号单独作为一个词
            if (currentSegment) {
                segments.push(currentSegment);
                currentSegment = '';
            }
            segments.push(char);
            inJapaneseWord = false;
        } else if (isJapaneseChar) {
            // 日文字符处理
            if (inJapaneseWord) {
                // 如果上一个字符也是日文，连接成一个词
                // 这里可以添加更复杂的规则，如助词、助动词的识别
                currentSegment += char;
            } else {
                // 开始一个新的日文词
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = char;
                inJapaneseWord = true;
            }
        } else {
            // 其他字符处理
            if (inJapaneseWord) {
                // 结束日文词
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = char;
                inJapaneseWord = false;
            } else {
                currentSegment += char;
            }
        }
    }

    // 处理最后一个片段
    if (currentSegment) {
        segments.push(currentSegment);
    }

    return segments.filter(Boolean);
}

/**
 * 对韩文文本进行简单分词
 * @param text 韩文文本
 * @returns 分词结果
 */
function segmentKoreanText(text: string): string[] {
    // 韩文分词也很复杂，这里仅做简单处理
    // 实际应用中应使用专门的韩文分词库

    // 基本策略：按空格、标点分割，音节组合成词
    const segments: string[] = [];
    let currentSegment = '';
    let inKoreanWord = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const charCode = text.codePointAt(i) || 0;

        // 调整索引，处理代理对
        if (charCode > 0xFFFF) {
            i++;
        }

        const isKoreanChar = isInRanges(charCode, scriptRanges.korean || []);
        const isPunctuation = /[\p{P}\p{Z}]/u.test(char);

        if (isPunctuation) {
            // 处理标点和空格
            if (currentSegment) {
                segments.push(currentSegment);
                currentSegment = '';
            }
            if (!/\s/.test(char)) { // 忽略空白字符
                segments.push(char);
            }
            inKoreanWord = false;
        } else if (isKoreanChar) {
            // 韩文字符处理
            if (inKoreanWord) {
                currentSegment += char;
            } else {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = char;
                inKoreanWord = true;
            }
        } else {
            // 其他字符处理
            if (inKoreanWord) {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = char;
                inKoreanWord = false;
            } else {
                currentSegment += char;
            }
        }
    }

    // 处理最后一个片段
    if (currentSegment) {
        segments.push(currentSegment);
    }

    return segments.filter(Boolean);
}

/**
 * 对泰文文本进行简单分词
 * @param text 泰文文本
 * @returns 分词结果
 */
function segmentThaiText(text: string): string[] {
    // 泰文分词非常特殊，应该使用专门的泰文分词库
    // 这里仅做极简处理，按字符和标点分割

    const segments: string[] = [];
    let currentSegment = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const nextChar = text[i + 1] || '';
        const isPunctuation = /[\p{P}\p{Z}]/u.test(char);

        if (isPunctuation) {
            if (currentSegment) {
                segments.push(currentSegment);
                currentSegment = '';
            }
            if (!/\s/.test(char)) { // 忽略空白字符
                segments.push(char);
            }
        } else {
            currentSegment += char;

            // 尝试根据泰文的一些规则断词
            // 例如，一些泰文的元音标记常常表示词尾
            if (nextChar && (
                // 空格明确表示词的边界
                /\s/.test(nextChar) ||
                // 标点也是边界
                /[\p{P}]/u.test(nextChar) ||
                // 一些特殊的泰文字符组合可能表示词的结束
                (currentSegment.length >= 3 && /[\u0E30-\u0E3A]/.test(char))
            )) {
                segments.push(currentSegment);
                currentSegment = '';
            }
        }
    }

    // 处理最后一个片段
    if (currentSegment) {
        segments.push(currentSegment);
    }

    return segments.filter(Boolean);
}

/**
 * 对拉丁文本（使用空格分隔的文字系统）进行分词
 * @param text 拉丁文文本
 * @returns 分词结果
 */
function segmentLatinText(text: string): string[] {
    // 确保返回非空数组
    if (!text) return [];
    
    // 简单地按空格和标点分割
    return text
        .split(/([^\w\u00C0-\u00FF]|\s+)/u)
        .filter(Boolean)
        .map(word => word.trim())
        .filter(Boolean);
}
