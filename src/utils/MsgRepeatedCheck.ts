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
 */
interface LanguageProcessor {
    segment(text: string): string[];
    detectPatterns?(segments: string[]): number;
    isValidSubstring(substr: string): boolean;
    similarityParams: {
        lengthThreshold: number;
        adjustmentFactor: number;
        lenRatioThreshold: number;
        penaltyFactor: number;
        coveragePower: number;
        maxLength(length: number): number;
        stepSize(length: number): number;
    };
}

// ==========================================================
// 常量和配置
// ==========================================================

// 初始化结巴分词器
const jieba = Jieba.withDict(dict);

// 定义各种文字的Unicode范围
const scriptRanges: ScriptRanges = {
    // 中文
    chinese: [
        [0x4e00, 0x9fff],   // CJK统一汉字
        [0x3400, 0x4dbf],   // CJK扩展A
        [0x20000, 0x2a6df], // CJK扩展B
        [0x2a700, 0x2b73f], // CJK扩展C
        [0x2b740, 0x2b81f], // CJK扩展D
        [0x2b820, 0x2ceaf], // CJK扩展E
        [0x2ceb0, 0x2ebef], // CJK扩展F
        [0xf900, 0xfaff],   // CJK兼容汉字
    ],
    // 日文特有字符（不包括与中文共享的汉字）
    japanese: [
        [0x3040, 0x309f],   // 平假名
        [0x30a0, 0x30ff],   // 片假名
        [0x31f0, 0x31ff],   // 片假名音标扩展
    ],
    // 韩文
    korean: [
        [0xac00, 0xd7af],   // 韩文音节
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

    // 语言相关属性
    private adjustedMinLength: number = 2;       // 调整后的最小长度
    private scriptType: ScriptType;              // 文本的主要脚本类型
    private segmentedInput: string[] | null = null; // 分词结果

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

        // 检测文本的脚本类型
        this.scriptType = detectMainScript(input);

        // 对无空格分隔的语言进行预处理：分词
        if (this.isNonSpacedScript()) {
            this.segmentedInput = segmentText(input);
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
     * 不同语言的文本特性需要不同的最小长度阈值
     */
    private adjustMinLength(): void {
        if (this.isNonSpacedScript()) {
            // 对于无空格分隔的语言，使用更小的阈值
            switch (this.scriptType) {
                case 'chinese':
                    // 中文文本的最小长度调整
                    this.adjustedMinLength = Math.max(
                        Math.min(this.minLength, 4), // 中文最小长度可以更小，但不小于原最小长度和4之间的较小值
                        Math.min(Math.ceil(Math.log2(this.totalLength) / 3), 6) // 中文文本对数平滑，最大值为6
                    );
                    break;
                case 'japanese':
                    // 日文需要更小的阈值，因为单个假名字符的信息量较小
                    this.adjustedMinLength = Math.max(
                        Math.min(this.minLength, 3), // 日文最小长度可以更小
                        Math.min(Math.ceil(Math.log2(this.totalLength) / 4), 5) // 最大值为5
                    );
                    break;
                case 'korean':
                    // 韩文音节包含较多信息
                    this.adjustedMinLength = Math.max(
                        Math.min(this.minLength, 3),
                        Math.min(Math.ceil(Math.log2(this.totalLength) / 3), 5)
                    );
                    break;
                case 'thai':
                    // 泰文也需要较小的阈值
                    this.adjustedMinLength = Math.max(
                        Math.min(this.minLength, 3),
                        Math.min(Math.ceil(Math.log2(this.totalLength) / 3), 5)
                    );
                    break;
                default:
                    // 兜底
                    this.adjustedMinLength = Math.max(
                        this.minLength,
                        Math.min(Math.ceil(Math.log2(this.totalLength) / 3), 6)
                    );
            }
        } else {
            // 拉丁文和其他使用空格分隔的语言使用原来的逻辑
            this.adjustedMinLength = Math.max(
                this.minLength,
                Math.min(Math.ceil(Math.log2(this.totalLength) / 2), 10)
            );
        }

        // 确保最小长度至少为2
        this.adjustedMinLength = Math.max(2, this.adjustedMinLength);
    }

    /**
     * 检测所有符合条件的重复子串并计算总惩罚
     * @param debug 如果为true，则打印详细的调试信息到控制台
     * @returns 重复子串的总惩罚分数
     */
    detect(debug: boolean = false): number {
        // 性能考虑：对于极长的文本，后缀数组/树可能更快
        // 但内存开销和复杂度更高。
        // 基于KMP的方法对中等长度的文本是一个很好的平衡。

        // 根据语言类型调整最大长度
        const maxLength = this.getMaxLengthForScript();

        let totalPenalty = 0;
        let totalCoverageLength = 0; // 所有覆盖段长度之和

        // 针对无空格语言的特殊处理
        if (this.isNonSpacedScript() && this.segmentedInput && this.segmentedInput.length > 5) {
            // 调用对应的模式检测函数
            const patternPenalty = this.detectScriptPatterns();
            totalPenalty += patternPenalty;
        }

        // 迭代字符串长度 (从长到短)
        for (let strLen = maxLength; strLen >= this.adjustedMinLength; strLen--) {
            // 根据语言设置步长
            const step = this.getStepSizeForScript(strLen);

            for (let i = 0; i <= this.totalLength - strLen; i += step) {
                // 如果该位置已被标记为覆盖，则跳过
                if (this.isPositionCovered(i, strLen)) {
                    continue;
                }

                const substr = this.input.slice(i, i + strLen);

                // 如果该子串已被处理过，则跳过
                if (this.repeats.has(substr)) {
                    continue;
                }

                // 判断子串是否有效
                // 不同语言有不同规则
                if (!this.isValidSubstring(substr)) {
                    continue;
                }

                // 构建KMP表
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

                    // 累计惩罚分数和覆盖长度
                    const penalty = repeated.calculatePenalty();
                    // 根据不同语言调整重复惩罚权重
                    totalPenalty += this.getScriptPenaltyFactor() * penalty;
                    totalCoverageLength += positions.length * strLen;
                }
            }
        }

        // 最终惩罚调整
        // 不同语言的覆盖比例需要不同程度的惩罚
        const coverageRatio = this.totalLength > 0
            ? Math.log2(1 + totalCoverageLength) / Math.log2(1 + this.totalLength)
            : 0;

        // 语言相关的覆盖率调整
        const coveragePower = this.getCoveragePowerForScript();
        const finalPenalty = totalPenalty * (1 + Math.pow(Math.min(coverageRatio, 1.0), coveragePower));

        if (debug) {
            this.printDebugInfo(coverageRatio, finalPenalty);
        }

        return finalPenalty;
    }

    // 辅助方法 - 位置和范围处理

    /**
     * 检查潜在子串范围是否与已覆盖的范围重叠
     */
    private isPositionCovered(position: number, length: number): boolean {
        const newRange = new Range(position, position + length);
        for (const range of this.coveredRanges) {
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
    }

    // 语言相关的参数调整方法

    /**
     * 根据脚本类型获取最大子串长度
     */
    private getMaxLengthForScript(): number {
        const params = getLanguageParams(this.scriptType);
        return params.maxLength(this.totalLength);
    }

    /**
     * 根据脚本类型获取步长
     */
    private getStepSizeForScript(strLen: number): number {
        const params = getLanguageParams(this.scriptType);
        return params.stepSize(strLen);
    }

    /**
     * 获取不同脚本的惩罚系数
     */
    private getScriptPenaltyFactor(): number {
        const params = getLanguageParams(this.scriptType);
        return params.penaltyFactor;
    }

    /**
     * 获取不同脚本的覆盖率幂指数
     */
    private getCoveragePowerForScript(): number {
        const params = getLanguageParams(this.scriptType);
        return params.coveragePower;
    }

    // KMP算法子串搜索方法

    /**
     * 使用KMP算法在输入文本中查找模式的起始索引
     */
    private kmpSearch(pattern: string, table: number[], startPos: number): number {
        const patternLength = pattern.length;
        let patternIndex = 0; // index for pattern[]
        let textIndex = startPos; // index for input[]

        while (textIndex < this.totalLength) {
            if (pattern[patternIndex] === this.input[textIndex]) {
                patternIndex++;
                textIndex++;
            }

            if (patternIndex === patternLength) {
                // Found a match
                return textIndex - patternIndex;
            } else if (textIndex < this.totalLength && pattern[patternIndex] !== this.input[textIndex]) {
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
     * 构建KMP失败函数（部分匹配表）
     */
    private buildKMPTable(pattern: string): number[] {
        const patternLength = pattern.length;
        const table: number[] = new Array(patternLength).fill(0);
        let prefixLen = 0; // 前一个最长前缀后缀的长度
        let i = 1;

        // table[0]始终为0，所以我们从i = 1开始
        while (i < patternLength) {
            if (pattern[i] === pattern[prefixLen]) {
                prefixLen++;
                table[i] = prefixLen;
                i++;
            } else {
                if (prefixLen !== 0) {
                    prefixLen = table[prefixLen - 1]!;
                    // 注意，我们不在此处递增i
                } else {
                    table[i] = 0;
                    i++;
                }
            }
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

        while (searchStartIndex <= this.totalLength - length) {
            const foundIndex = this.kmpSearch(substr, kmpTable, searchStartIndex);

            if (foundIndex === -1) {
                break; // 未找到更多匹配项
            }

            // 检查此特定匹配项是否被先前找到的*较长*重复覆盖
            if (!this.isPositionCovered(foundIndex, length)) {
                positions.push(foundIndex);
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
        if (!this.segmentedInput || this.segmentedInput.length < 5) {
            return 0;
        }

        // 使用全局的语言特定模式检测函数
        return detectLanguagePatterns(this.scriptType, this.segmentedInput);
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
 * 文本相似度计算
 * 
 * 基于分词的文本相似度计算，针对多种语言进行了优化。
 * 使用余弦相似度算法，结合了特定语言的处理策略和参数调整。
 * 
 * @param text1 第一个文本
 * @param text2 第二个文本
 * @returns 相似度得分 (0-1)，0表示完全不同，1表示完全相同
 */
export function calculateTextSimilarity(text1: string, text2: string): number {
    // 对空文本的处理
    if (!text1.trim() || !text2.trim()) {
        return 0;
    }

    // 检测文本的主要语言类型
    const script1 = detectMainScript(text1);
    const script2 = detectMainScript(text2);

    // 如果两个文本的主要语言类型不同，可以降低相似度阈值
    let scriptMismatchPenalty = 0;

    // 不同语言混合使用的情况通常很难被认为具有高相似性
    if (script1 !== script2 && script1 !== 'other' && script2 !== 'other') {
        // 如果语言完全不同，则相似度得分降低
        scriptMismatchPenalty = 0.3;

        // 不过，中日韩之间有一定的文字共通性，可以减轻惩罚
        const cjkScripts = ['chinese', 'japanese', 'korean'];
        if (cjkScripts.includes(script1) && cjkScripts.includes(script2)) {
            // 中日韩之间的语言差异惩罚减轻
            scriptMismatchPenalty = 0.1;
        }
    }

    // 长度比较，如果长度相差太多，可以快速判定相似度较低
    const lenRatio = Math.min(text1.length, text2.length) / Math.max(text1.length, text2.length);

    // 根据不同语言调整长度比例阈值
    const params = getLanguageParams(script1);
    const lenRatioThreshold = params.lenRatioThreshold;

    // 如果长度比例过小，快速返回一个较低的相似度值
    if (lenRatio < lenRatioThreshold) {
        return lenRatio * 0.5; // 基于长度比例给出一个较低的相似度估计
    }

    // 获取词频映射
    const freqMap1 = getWordFrequencyMap(text1);
    const freqMap2 = getWordFrequencyMap(text2);

    // 计算余弦相似度
    return calculateCosineSimilarity(freqMap1, freqMap2, script1, text1.length, text2.length);
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

    // 根据语言类型选择不同的分词策略
    switch (scriptType) {
        case 'chinese':
            // 对中文使用结巴分词 - 性能优化：对较短的中文文本使用更快速但粗糙的分词
            return text.length < 50 ?
                simpleSegmentChinese(text) :
                jieba.cut(text, false);

        case 'japanese':
            // 日文使用简单基于字符的分词 + 特殊处理
            return segmentJapaneseText(text);

        case 'korean':
            // 韩文使用简单基于字符的分词 + 特殊处理
            return segmentKoreanText(text);

        case 'thai':
            // 泰文使用简单基于字符的分词
            return segmentThaiText(text);

        default:
            // 拉丁文和其他语言使用空格和标点分割
            return segmentLatinText(text);
    }
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

    const counts: Record<ScriptType, number> = {
        chinese: 0,
        japanese: 0,
        korean: 0,
        thai: 0,
        latin: 0,
        other: 0
    };

    // 性能优化：对长文本只采样部分字符
    // 对于长文本，完整分析每个字符开销较大且意义不大
    const maxSampleSize = 200; // 设置最大采样字符数

    // 设置采样间隔，确保采样覆盖文本开头、中间和结尾
    const stride = text.length <= maxSampleSize ? 1 : Math.ceil(text.length / maxSampleSize);
    let sampledChars = 0;

    // 计算各种文字的字符数量
    for (let i = 0; i < text.length && sampledChars < maxSampleSize; i += stride) {
        sampledChars++;
        const charCode = text.codePointAt(i) || 0;

        // 如果是代理对，调整索引（但不影响采样计数）
        if (charCode > 0xFFFF) {
            i++;
        }

        // 使用更高效的范围检查方式
        // 按出现频率高低排序检查，减少平均检查次数
        if (charCode >= 0x4e00 && charCode <= 0x9fff) {
            // 最常见的CJK统一汉字范围
            counts.chinese++;
        } else if (charCode >= 0x3040 && charCode <= 0x30ff) {
            // 日文平假名和片假名范围
            counts.japanese++;
        } else if (charCode >= 0xac00 && charCode <= 0xd7af) {
            // 韩文音节范围
            counts.korean++;
        } else if (charCode >= 0x0041 && charCode <= 0x007A ||
            charCode >= 0x00C0 && charCode <= 0x00FF) {
            // 拉丁字母范围
            counts.latin++;
        } else if (charCode >= 0x0e00 && charCode <= 0x0e7f) {
            // 泰文范围
            counts.thai++;
        } else if (isInLessCommonRanges(charCode)) {
            // 检查不太常见的文字范围
            // 由于这些范围出现频率较低，所以放在最后检查
        } else {
            counts.other++;
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
    const totalChars = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const maxRatio = maxCount / totalChars;

    // 如果最多类型的比例不足30%，则视为其他类型
    if (maxRatio < 0.3) {
        return 'other';
    }

    // 特殊处理：中日文共享汉字，如果有日文特有字符且比例超过10%，则优先判定为日文
    if (maxType === 'chinese' && counts.japanese > 0 && counts.japanese / totalChars >= 0.1) {
        return 'japanese';
    }

    return maxType;
}

/**
 * 检查字符是否属于不太常见的文字范围
 * 分离这部分逻辑以提高主函数性能
 * @param charCode 字符编码
 * @returns 对应的文字类型，或null
 */
function isInLessCommonRanges(charCode: number): string | null {
    // 检查不常见的中文范围
    if ((charCode >= 0x3400 && charCode <= 0x4dbf) || // CJK扩展A
        (charCode >= 0xf900 && charCode <= 0xfaff) || // CJK兼容汉字
        (charCode >= 0x20000 && charCode <= 0x2ebef)) { // CJK扩展B-F
        return 'chinese';
    }

    // 检查不常见的日文范围
    if (charCode >= 0x31f0 && charCode <= 0x31ff) { // 片假名音标扩展
        return 'japanese';
    }

    // 检查不常见的韩文范围
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
    // 简单地按空格和标点分割
    return text
        .split(/([^\w\u00C0-\u00FF]|\s+)/u)
        .filter(Boolean)
        .map(word => word.trim())
        .filter(Boolean);
}

/**
 * 基于分词计算词频映射
 * 
 * 对文本进行分词并统计每个词的出现频率。
 * 优化了中文等亚洲语言的处理逻辑。
 * 
 * @param text 输入文本
 * @returns 词与频率的映射 (词 -> 频率)
 */
export function getWordFrequencyMap(text: string): Record<string, number> {
    // 如果文本为空，返回空对象
    if (!text.trim()) {
        return {};
    }

    // 使用结巴分词
    const segments = segmentText(text);

    // 统计词频
    const freqMap: Record<string, number> = {};
    for (const word of segments) {
        // 过滤掉单个标点符号和空白字符
        if (word.trim() && !/^[\p{P}\p{Z}]$/u.test(word)) {
            freqMap[word] = (freqMap[word] || 0) + 1;
        }
    }

    return freqMap;
}

/**
 * 计算两个词频向量之间的余弦相似度
 * @param freqMap1 第一个词频映射
 * @param freqMap2 第二个词频映射
 * @param scriptType 主要脚本类型
 * @param length1 文本1长度
 * @param length2 文本2长度
 * @returns 余弦相似度 (0-1)
 */
function calculateCosineSimilarity(
    freqMap1: Record<string, number>,
    freqMap2: Record<string, number>,
    scriptType: ScriptType,
    length1: number,
    length2: number
): number {
    const words1 = Object.keys(freqMap1);
    const words2 = Object.keys(freqMap2);

    // 如果任一文本没有有效词语，返回0
    if (words1.length === 0 || words2.length === 0) {
        return 0;
    }

    const allWords = new Set([...words1, ...words2]);

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    // 计算点积和向量范数
    allWords.forEach(word => {
        const count1 = freqMap1[word] || 0;
        const count2 = freqMap2[word] || 0;
        dotProduct += count1 * count2;
        norm1 += count1 ** 2;
        norm2 += count2 ** 2;
    });

    // 计算余弦相似度
    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    if (denominator === 0) {
        return 0;
    }

    // 词频相似度
    let cosineSim = dotProduct / denominator;

    // 长文本相似度调整：针对不同语言调整参数
    if (length1 > 50 || length2 > 50) {
        // 获取语言参数
        const params = getLanguageParams(scriptType);
        const lengthThreshold = params.maxLength(100); // 使用maxLength函数计算阈值
        const adjustmentFactor = 0.1; // 基本调整因子

        // 实际应用调整量
        const textLengthFactor = Math.log(Math.max(length1, length2) / lengthThreshold + 1) * adjustmentFactor;
        cosineSim = Math.max(0, cosineSim - textLengthFactor);
    }

    return cosineSim;
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
 * @param charCode 字符编码
 * @param ranges 范围数组
 * @returns 是否在范围内
 */
function isInRanges(charCode: number, ranges: number[][]): boolean {
    if (!ranges) return false; // 添加空值检查

    for (const range of ranges) {
        if (range.length === 2) {
            const [start, end] = range;
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
} {
    switch (scriptType) {
        case 'chinese':
            return {
                maxLength: (length: number) => Math.min(Math.floor(length / 2), 80),
                stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
                penaltyFactor: 1.2,
                coveragePower: 1.3,
                lenRatioThreshold: 0.25,
                adjustmentFactor: 0.12
            };
        case 'japanese':
            return {
                maxLength: (length: number) => Math.min(Math.floor(length / 2), 60),
                stepSize: (length: number) => Math.max(1, Math.floor(length / 4)),
                penaltyFactor: 1.1,
                coveragePower: 1.25,
                lenRatioThreshold: 0.25,
                adjustmentFactor: 0.11
            };
        case 'korean':
            return {
                maxLength: (length: number) => Math.min(Math.floor(length / 2), 70),
                stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
                penaltyFactor: 1.15,
                coveragePower: 1.25,
                lenRatioThreshold: 0.25,
                adjustmentFactor: 0.11
            };
        case 'thai':
            return {
                maxLength: (length: number) => Math.min(Math.floor(length / 2), 70),
                stepSize: (length: number) => Math.max(1, Math.floor(length / 3)),
                penaltyFactor: 1.15,
                coveragePower: 1.25,
                lenRatioThreshold: 0.25,
                adjustmentFactor: 0.1
            };
        default:
            return {
                maxLength: (length: number) => Math.min(Math.floor(length / 2), 150),
                stepSize: (length: number) => Math.max(1, Math.floor(length / 5)),
                penaltyFactor: 1.0,
                coveragePower: 1.2,
                lenRatioThreshold: 0.3,
                adjustmentFactor: 0.1
            };
    }
}

/**
 * 检查子串是否有效
 * @param substr 子串
 * @param scriptType 语言类型
 * @returns 是否有效
 */
function isValidSubstring(substr: string, scriptType: ScriptType): boolean {
    const trimmed = substr.trim();
    // 忽略空白字符串
    if (!trimmed) return false;

    // 忽略简单的单字符重复
    if (/^(.)\1+$/.test(trimmed)) return false;

    // 根据不同的脚本类型使用不同的过滤规则
    switch (scriptType) {
        case 'chinese':
            // 中文文本的特殊规则

            // 忽略全是标点或空格的子串
            if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

            // 中文文本对熵的要求更低，因为中文字符本身携带更多信息
            // 允许更多的低熵子串
            if (substr.length > 6 && new Set(substr).size <= 2) return false;

            // 对于长子串，仍要求一定的信息熵
            if (substr.length > 15 && new Set(substr).size <= 4) return false;
            break;

        case 'japanese':
            // 日文特殊处理
            // 忽略全是标点或空格的子串
            if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

            // 由于假名字符比中文字符信息量更低，需要更严格的熵要求
            if (substr.length > 5 && new Set(substr).size <= 2) return false;
            if (substr.length > 12 && new Set(substr).size <= 3) return false;

            // 检查是否为纯假名串，假名重复性更高（比如「あああ」这样的）
            const hiraganaRatio = (trimmed.match(/[\u3040-\u309f]/g) || []).length / trimmed.length;
            const katakanaRatio = (trimmed.match(/[\u30a0-\u30ff]/g) || []).length / trimmed.length;

            if ((hiraganaRatio > 0.8 || katakanaRatio > 0.8) && new Set(trimmed).size <= 3) {
                return false;
            }
            break;

        case 'korean':
            // 韩文特殊处理
            // 忽略全是标点或空格的子串
            if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

            // 韩文字符的熵要求
            if (substr.length > 5 && new Set(substr).size <= 2) return false;
            if (substr.length > 10 && new Set(substr).size <= 3) return false;
            break;

        case 'thai':
            // 泰文特殊处理
            if (/^[\p{P}\p{Z}]+$/u.test(trimmed)) return false;

            // 泰文字符的熵要求
            if (substr.length > 5 && new Set(substr).size <= 2) return false;
            if (substr.length > 10 && new Set(substr).size <= 3) return false;
            break;

        default:
            // 拉丁文和其他语言使用原有规则
            if (substr.length > 4 && new Set(substr).size <= 2) return false;
            if (substr.length > 10 && new Set(substr).size <= 3) return false;

            // 忽略全数字或全标点的子串
            if (/^\d+$/.test(trimmed)) return false;
            if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return false;
    }

    return true;
}

/**
 * 检测语言特定模式
 * @param scriptType 脚本类型
 * @param segments 分词结果数组
 * @returns 模式惩罚分数
 */
function detectLanguagePatterns(scriptType: ScriptType, segments: string[]): number {
    if (!segments || segments.length < 10) {
        return 0;
    }

    switch (scriptType) {
        case 'chinese':
            return detectChinesePatterns(segments);
        case 'japanese':
            return detectJapanesePatterns(segments);
        case 'korean':
        case 'thai':
            // 简化实现，韩文和泰文暂不单独处理
            return 0;
        default:
            return 0;
    }
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
