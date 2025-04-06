import { md, type TextWithEntities } from "@mtcute/bun";
import { getFastAI } from "../ai/AiManager";
import type { BotPlugin, CommandContext } from "../features";

// New ASCII Art Collection (incorporating existing, improved, and new ones)
const asciiArts: Record<string, string> = {
    // Animals
    cat: `
  /\\_/\\  
 ( o.o ) 
  > ^ <  
    `, // Kept original
    // Memes
    doge: `
       ▄              ▄
      ▌▒█           ▄▀▒▌
      ▌▒▒█        ▄▀▒▒▒▐
     ▐▄▀▒▒▀▀▀▀▄▄▄▀▒▒▒▒▒▐
   ▄▄▀▒░▒▒▒▒▒▒▒▒▒█▒▒▄█▒▐
 ▄▀▒▒▒░░░▒▒▒░░░▒▒▒▀██▀▒▌
▐▒▒▒▄▄▒▒▒▒░░░▒▒▒▒▒▒▒▀▄▒▒▐
▌░░▌█▀▒▒▒▒▒▄▀█▄▒▒▒▒▒▒▒█▒▐
▐░░░▒▒▒▒▒▒▒▒▌██▀▒▒░░░▒▒▒▀▄▌
▌░▒▄██▄▒▒▒▒▒▒▒▒▐░░░░░░▒▒▒▒▌
▀▒▀▐▄█▄█▌▄░▀▒▒░░░░░░░░░░▒▒▒▐
▐▒▒▐▀▐▀▒░▄▄▒▄▒▒▒▒▒▒░▒░▒░▒▒▒▒▌
▐▒▒▒▀▀▄▄▒▒▒▄▒▒▒▒▒▒▒▒░▒░▒▒▒▒▐
▌▒▒▒▒▒▒▀▀▀▒▒▒▒▒▒░▒░▒░▒▒▒▒▌
▐▒▒▒▒▒▒▒▒▒▒▒▒▒▒░▒░▒░▒▒▒▒▐
▀▄▒▒▒▒▒▒▒▒▒▒▄▄▄▀▒▒▒▒▄▀
  ▀▄▒▒▒▒▒▒▒▒▒▒▒█▀▒▄▀▒▐
    ▀▄▄▒▒▒▒▒▒▒▒▄▀▒▒▒▒▐
       ▀▄▄▄▄▄▄▀▀▒▒▒▄▀
    `, // Added Doge
    nyan_cat: `
+      o     +              o
    +             o     +       +
o          +
    o  +           +        +
+        o     o       +        o
-_-_-_-_-_-_-_,------,      o
_-_-_-_-_-_-_-|   /\_/\  |     +
-_-_-_-_-_-_-~|__( ^ .^) |
_-_-_-_-_-_-_-""  ""      
+      o         o   +       o
    +         +
o        +         o      o     +
    o           +
+      +     o        o      +
    `, // Added Nyan Cat
    cat2: `
  _                        
  \\\`*-.                    
   )  _\`-.                 
  .  : \`. .                
  : _   '  \               
  ; *\` _.   \`*-._          
  \`-.-'          \`-.       
    ;       \`       \`.     
    :.       .        \    
    . \  .   :   .-'   .   
    '  \`+.;  ;  '      :   
    :  '  |    ;       ;-. 
    ; '   : :\`-:     _.\`* ;
 .*' /  .*' ; .*\`- +'  \`*' 
 \`*-*   \`*-*  \`*-*'
    `,
};

interface PositionedBubble {
    lines: string[];
    startY: number;
    position?: 'top' | 'right' | 'bottom' | 'left';
}

// ASCII 对话气泡 - 根据文本和参照物(ASCII Art)计算气泡内容和位置
const createPositionedBubble = (asciiArt: string, text: string, styleIndex: number = 0): PositionedBubble | null => {
    const textLines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (textLines.length === 0) return null; // No text, no bubble

    // 优化: 更精确地计算气泡宽度，考虑多字节字符（如中文、表情符号等）
    const bubbleWidth = Math.max(...textLines.map(line => {
        // 使用更精确的方法计算字符串显示宽度
        return [...line].reduce((width, char) => {
            // 更全面的宽度计算：
            // - ASCII和半角字符占1个宽度
            // - 全角字符（包括中文、日文、韩文等）占2个宽度
            // - Emoji和特殊符号可能占2个或更多
            const code = char.codePointAt(0) || 0;
            
            // 使用字符范围判断
            if (code <= 0x7F) return width + 1; // ASCII字符
            if (
                (code >= 0x3000 && code <= 0x9FFF) || // CJK统一表意文字及符号
                (code >= 0xFF00 && code <= 0xFFEF) || // 全角ASCII、半角片假名等
                (code >= 0x20000 && code <= 0x2FA1F) // CJK扩展
            ) return width + 2; // 中日韩文字
            
            // 其他Unicode字符，包括Emoji等
            return width + (code > 0xFFFF ? 2 : 1);
        }, 0);
    }));

    // --- 生成气泡形状 ---
    // 允许选择不同的气泡风格
    const bubbleStyles = [
        { // 标准气泡
            top: '  .' + '-'.repeat(bubbleWidth + 2) + '.',
            middle: (line: string) => {
                // 优化填充方法，考虑多字节字符
                const displayWidth = [...line].reduce((w, c) => {
                    const code = c.codePointAt(0) || 0;
                    if (code <= 0x7F) return w + 1; // ASCII
                    if (
                        (code >= 0x3000 && code <= 0x9FFF) ||
                        (code >= 0xFF00 && code <= 0xFFEF) ||
                        (code >= 0x20000 && code <= 0x2FA1F)
                    ) return w + 2; // CJK
                    return w + (code > 0xFFFF ? 2 : 1); // 其他
                }, 0);
                
                // 计算需要的填充空格数
                const padding = bubbleWidth - displayWidth;
                return ` / ${line}${' '.repeat(padding)} \\`;
            },
            bottom: '  `' + '-'.repeat(bubbleWidth + 2) + '\''
        },
        { // 圆角气泡
            top: '  ╭' + '─'.repeat(bubbleWidth + 2) + '╮',
            middle: (line: string) => {
                // 优化填充方法，考虑多字节字符
                const displayWidth = [...line].reduce((w, c) => {
                    const code = c.codePointAt(0) || 0;
                    if (code <= 0x7F) return w + 1;
                    if (
                        (code >= 0x3000 && code <= 0x9FFF) ||
                        (code >= 0xFF00 && code <= 0xFFEF) ||
                        (code >= 0x20000 && code <= 0x2FA1F)
                    ) return w + 2;
                    return w + (code > 0xFFFF ? 2 : 1);
                }, 0);
                
                const padding = bubbleWidth - displayWidth;
                return ` │ ${line}${' '.repeat(padding)} │`;
            },
            bottom: '  ╰' + '─'.repeat(bubbleWidth + 2) + '╯'
        },
        { // 方角气泡
            top: '  ┌' + '─'.repeat(bubbleWidth + 2) + '┐',
            middle: (line: string) => {
                // 优化填充方法，考虑多字节字符
                const displayWidth = [...line].reduce((w, c) => {
                    const code = c.codePointAt(0) || 0;
                    if (code <= 0x7F) return w + 1;
                    if (
                        (code >= 0x3000 && code <= 0x9FFF) ||
                        (code >= 0xFF00 && code <= 0xFFEF) ||
                        (code >= 0x20000 && code <= 0x2FA1F)
                    ) return w + 2;
                    return w + (code > 0xFFFF ? 2 : 1);
                }, 0);
                
                const padding = bubbleWidth - displayWidth;
                return ` │ ${line}${' '.repeat(padding)} │`;
            },
            bottom: '  └' + '─'.repeat(bubbleWidth + 2) + '┘'
        }
    ];
    
    // 选择气泡样式 - 基于用户参数
    // 确保样式索引在有效范围内
    const validStyleIndex = Math.min(Math.max(0, styleIndex), bubbleStyles.length - 1);
    const bubbleStyle = bubbleStyles[validStyleIndex];
    
    if (!bubbleStyle) {
        // 如果发生异常，返回null
        return null;
    }
    
    const rawBubbleLines: string[] = [];
    rawBubbleLines.push(bubbleStyle.top); // 顶部边框
    textLines.forEach(line => {
        // 对每行文本应用气泡样式
        rawBubbleLines.push(bubbleStyle.middle(line));
    });
    rawBubbleLines.push(bubbleStyle.bottom); // 底部边框

    // --- 计算位置 (基于 ASCII 艺术) ---
    const asciiLines = asciiArt.split('\n');
    let minX = Infinity, maxX = 0, minY = Infinity, maxY = -1; // Initialize maxY to -1

    // 用安全的方式处理数组项，避免TypeScript错误
    for (let y = 0; y < asciiLines.length; y++) {
        const line = asciiLines[y] || '';
        const trimmedLine = line.trimEnd();
        if (trimmedLine.length > 0) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            const firstCharIndex = line.search(/\S/);
            if (firstCharIndex !== -1 && firstCharIndex < minX) minX = firstCharIndex;
            if (trimmedLine.length > maxX) maxX = trimmedLine.length;
        }
    }

    // 如果ASCII艺术为空或只有空白，设置默认位置
    if (minY === Infinity) {
        minY = 0;
        maxY = 0;
        minX = 0;
        maxX = 0;
    }

    // 自适应气泡位置策略
    const asciiHeight = (maxY - minY) + 1;
    const bubbleHeight = rawBubbleLines.length;
    
    // 智能决定气泡位置 (上/下/左/右)
    type BubblePosition = 'top' | 'right' | 'bottom' | 'left';
    let bubblePosition: BubblePosition = 'right'; // 默认右侧
    
    // 如果艺术很高，考虑上方或下方放置
    if (asciiHeight > 10 && maxX < 30) {
        bubblePosition = minY > 5 ? 'top' : 'bottom';
    }
    
    // 根据位置确定气泡开始坐标
    let bubbleStartY = 0;
    let bubbleStartX = 0;
    
    // 根据不同位置添加不同样式的尖角，并调整位置
    switch (bubblePosition) {
        case 'top':
            // 上方气泡，不再添加尖角
            bubbleStartY = Math.max(0, minY - bubbleHeight); // 不需要额外空间
            bubbleStartX = minX;
            break;
        case 'bottom':
            // 下方气泡，不再添加尖角
            bubbleStartY = maxY + 1;
            bubbleStartX = minX;
            break;
        case 'left' as BubblePosition:
            // 左侧气泡，不再添加尖角
            bubbleStartY = minY;
            bubbleStartX = Math.max(0, minX - bubbleWidth - 3);
            break;
        case 'right':
        default:
            // 右侧气泡，不再添加尖角
            
            // 计算相关ASCII宽度
            let relevantAsciiWidth = 0;
            const bubbleVerticalRange = Math.min(minY + bubbleHeight, asciiLines.length);
            for (let y = minY; y < bubbleVerticalRange; y++) {
                const line = asciiLines[y] || '';
                relevantAsciiWidth = Math.max(relevantAsciiWidth, line.trimEnd().length);
            }
            
            // 回退策略
            if (relevantAsciiWidth < minX && minY !== Infinity) {
                relevantAsciiWidth = maxX;
            }
            
            bubbleStartY = minY;
            bubbleStartX = relevantAsciiWidth + 2;
            break;
    }

    // 应用填充
    const positionedBubbleLines = rawBubbleLines.map(line => ' '.repeat(bubbleStartX) + line);

    return {
        lines: positionedBubbleLines,
        startY: bubbleStartY,
        position: bubblePosition
    };
};

// 随机整数函数
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 将ASCII艺术和说话内容转换为消息格式，避免Markdown解析错误
const formatAsciiOutput = (content: string, extraInfo?: string): TextWithEntities => {
    // 限制内容长度，防止消息过长
    const MAX_CONTENT_LENGTH = 2000; // Telegram消息的安全长度上限
    let truncatedContent = content;

    if (content.length > MAX_CONTENT_LENGTH) {
        truncatedContent = content.substring(0, MAX_CONTENT_LENGTH - 20) + '\n...(内容过长已截断)';
    }

    // 不使用Markdown解析，直接返回代码块格式的纯文本
    const codeBlock = '```\n' + truncatedContent + '\n```';

    // 如果有额外信息，单独添加
    if (extraInfo) {
        return md(codeBlock + '\n' + extraInfo);
    }

    return md(codeBlock);
};

// 将ASCII艺术和预先定位好的对话气泡组合在一起
const combineAsciiAndBubble = (asciiArt: string, speakText: string, bubbleStyle: number = 0): string => {
    // Create the positioned bubble based on the art and text
    const positionedBubble = createPositionedBubble(asciiArt, speakText, bubbleStyle);

    // If no bubble was created (e.g., empty text), return original art
    if (!positionedBubble) {
        return asciiArt;
    }

    const asciiLines = asciiArt.split('\n');
    const { lines: bubbleLines, startY: bubbleStartY } = positionedBubble;
    const bubbleHeight = bubbleLines.length;

    // --- 优化：更高效地合并行 ---
    // 计算需要的最终高度
    const requiredHeight = Math.max(asciiLines.length, bubbleStartY + bubbleHeight);
    const combinedLines: string[] = new Array(requiredHeight);
    
    // 先复制原始ASCII行
    for (let i = 0; i < asciiLines.length; i++) {
        combinedLines[i] = asciiLines[i] || '';
    }
    
    // 确保剩余行填充为空字符串
    for (let i = asciiLines.length; i < requiredHeight; i++) {
        combinedLines[i] = '';
    }

    // --- 优化：更安全地合并气泡 ---
    for (let i = 0; i < bubbleLines.length; i++) {
        const bubbleLine = bubbleLines[i];
        // 安全检查：确保气泡行存在
        if (!bubbleLine) continue;
        
        const targetY = bubbleStartY + i;
        if (targetY >= 0 && targetY < combinedLines.length) { // 安全检查
            const existingLine = combinedLines[targetY] || ''; // 确保行存在，否则使用空字符串
            
            // 查找气泡内容开始的位置
            const bubbleStartX = bubbleLine.search(/\S/);
            if (bubbleStartX === -1) continue; // 跳过空行
            
            // 取现有行的前缀部分
            const prefix = existingLine.substring(0, bubbleStartX);
            // 确保前缀有足够的空格
            const paddedPrefix = prefix.padEnd(bubbleStartX, ' ');
            
            // 取气泡行的非空格部分
            const bubbleContent = bubbleLine.substring(bubbleStartX);
            
            // 组合：前缀 + 气泡内容
            combinedLines[targetY] = paddedPrefix + bubbleContent;
        }
    }

    return combinedLines.join('\n');
};

const plugin: BotPlugin = {
    name: 'toys',
    description: '一些有趣的玩具命令和互动工具',
    version: '1.0.0',

    commands: [
        {
            name: 'ascii',
            description: '生成ASCII艺术或让其说话\n用法:\n/ascii list - 显示可用的艺术名称\n/ascii <art_name> [text] - 显示特定艺术，可选择让其说话\n/ascii [text] - 显示随机艺术说话\n/ascii <art_name> -s=1 [text] - 使用样式1的气泡（0=标准，1=圆角，2=方角）',
            async handler(ctx: CommandContext) {
                // 如果没有提供内容，显示帮助信息
                if (!ctx.content || ctx.content.trim() === '') {
                    const artList = Object.keys(asciiArts).join(', ');
                    await ctx.message.replyText(`请提供艺术名称或让艺术说话的文本：\n\n可用艺术: ${artList}\n\n使用 "/ascii list" 获取详细信息`);
                    return;
                }

                const content = ctx.content.trim();

                // 处理列表命令
                if (content.toLowerCase() === 'list' || content.toLowerCase() === '列表') {
                    const artList = Object.keys(asciiArts).join(', ');
                    await ctx.message.replyText(`可用的ASCII艺术: \n${artList}\n\n用法:\n/ascii <艺术名称> [文本]\n/ascii [文本] (随机艺术)\n/ascii <艺术名称> -s=1 [文本] (使用样式1的气泡：0=标准,1=圆角,2=方角)`);
                    return;
                }

                // 分割内容为艺术名和文本
                let contentParts = content.split(' ');
                const firstPart = contentParts[0]?.toLowerCase() || '';
                let speakText = '';
                let selectedArtKey = '';
                let selectedArt: string = '';
                let isRandom = false;
                
                // 解析气泡样式参数
                let bubbleStyleIndex = 0; // 默认样式
                // 查找形如 -s=1 的样式参数
                const styleParamIndex = contentParts.findIndex(part => /^-s=\d+$/.test(part));
                if (styleParamIndex >= 0) {
                    const styleParam = contentParts[styleParamIndex] || '';
                    if (styleParam) {
                        const styleMatch = styleParam.match(/^-s=(\d+)$/);
                        if (styleMatch && styleMatch[1]) {
                            bubbleStyleIndex = parseInt(styleMatch[1], 10);
                            // 从内容部分移除样式参数
                            contentParts = contentParts.filter((_, i) => i !== styleParamIndex);
                        }
                    }
                }

                // 重新获取第一部分（如果样式参数是第一个，可能会变）
                const newFirstPart = contentParts[0]?.toLowerCase() || '';

                // 检查第一部分是否是有效的艺术名称
                if (newFirstPart && newFirstPart in asciiArts) {
                    // 使用指定的艺术
                    selectedArtKey = newFirstPart;
                    const art = asciiArts[newFirstPart];
                    if (typeof art === 'string') {
                        selectedArt = art;

                        // 如果有额外的文本，用于说话
                        if (contentParts.length > 1) {
                            speakText = contentParts.slice(1).join(' ');
                        }
                    }
                } else {
                    // 使用随机艺术，整个内容作为说话文本
                    isRandom = true;
                    speakText = contentParts.join(' '); // 重新组合所有内容作为说话文本
                    
                    const artKeys = Object.keys(asciiArts);

                    if (artKeys.length === 0) {
                        await ctx.message.replyText('没有可用的ASCII艺术。');
                        return;
                    }

                    // 优化随机选择，加权选择较小的艺术（更符合聊天界面）
                    const artSizes = artKeys.map((key, index) => {
                        // 为key添加类型保护
                        if (typeof key !== 'string') return Infinity;
                        
                        const art = asciiArts[key];
                        // 计算艺术的大小因子（行数 × 平均每行长度）
                        if (typeof art !== 'string') return Infinity;
                        
                        const lines = art.split('\n');
                        // 安全计算总长度
                        const totalLength = lines.reduce((sum, line) => {
                            return sum + (line ? line.length : 0);
                        }, 0);
                        
                        // 避免除以零
                        const avgLineLength = lines.length > 0 ? totalLength / lines.length : 0;
                        return lines.length * avgLineLength || 1; // 确保返回正数
                    });
                    
                    // 基于大小的反比例权重计算
                    const weights = artSizes.map(size => 1 / Math.sqrt(size));
                    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
                    
                    // 随机选择（权重）
                    let random = Math.random() * totalWeight;
                    let selectedIndex = 0;
                    
                    for (let i = 0; i < weights.length; i++) {
                        const weight = weights[i] || 0; // 添加安全检查，避免undefined
                        random -= weight;
                        if (random <= 0) {
                            selectedIndex = i;
                            break;
                        }
                    }
                    
                    const key = artKeys[selectedIndex];
                    if (key) {
                        selectedArtKey = key;
                        const art = asciiArts[key];
                        if (typeof art === 'string') {
                            selectedArt = art;
                            speakText = content; // 使用整个内容作为说话文本
                        }
                    }
                }

                // 处理艺术输出
                if (selectedArt) {
                    let outputContent = selectedArt;

                    // 如果有说话文本，将其与艺术组合，传入气泡样式
                    if (speakText) {
                        outputContent = combineAsciiAndBubble(outputContent, speakText, bubbleStyleIndex);
                    }

                    // 为随机选择的艺术添加额外信息
                    const extraInfo = isRandom ? `(随机选择: ${selectedArtKey}, 使用 /ascii list 查看所有)` : undefined;

                    // 回复格式化后的输出
                    await ctx.message.replyText(formatAsciiOutput(outputContent, extraInfo));
                } else {
                    // 如果出现问题导致没有艺术被选择
                    await ctx.message.replyText('无法生成ASCII艺术，请重试。');
                }
            }
        },

        {
            name: 'roll',
            description: '掷骰子生成随机数\n用法：\n/roll - 生成1-100的随机数\n/roll 20 - 生成1-20的随机数\n/roll 5-50 - 生成5-50的随机数',
            async handler(ctx: CommandContext) {
                let min = 1, max = 100;

                // 解析参数
                if (ctx.content) {
                    const parts = ctx.content.split('-');
                    if (parts.length === 2) {
                        const parsedMin = Number.parseInt(parts[0]?.trim() || '', 10);
                        const parsedMax = Number.parseInt(parts[1]?.trim() || '', 10);

                        if (!isNaN(parsedMin) && !isNaN(parsedMax) && parsedMin <= parsedMax) {
                            min = parsedMin;
                            max = parsedMax;
                        }
                    } else if (parts.length === 1) {
                        const parsedMax = Number.parseInt(parts[0]?.trim() || '', 10);
                        if (!isNaN(parsedMax) && parsedMax > 0) {
                            max = parsedMax;
                        }
                    }
                }

                const result = randomInt(min, max);

                await ctx.message.replyText(`🎲 ${ctx.message.sender.displayName} 掷出了 ${result} (${min}-${max})`);
            }
        },

        {
            name: 'dice',
            description: '模拟骰子游戏，支持多种骰子\n用法：\n/dice - 掷一个6面骰\n/dice 3d6 - 掷三个6面骰\n/dice 1d20 - 掷一个20面骰',
            async handler(ctx: CommandContext) {
                let count = 1;  // 骰子数量
                let faces = 6;  // 骰子面数

                // 解析参数: 格式为 NdM，如 2d6 表示投两个六面骰
                if (ctx.content) {
                    const match = ctx.content.match(/^(\d+)?d(\d+)$/i);
                    if (match) {
                        if (match[1]) count = Math.min(Math.max(parseInt(match[1], 10), 1), 10);
                        if (match[2]) faces = Math.min(Math.max(parseInt(match[2], 10), 2), 100);
                    }
                }

                let results = [];
                let sum = 0;
                for (let i = 0; i < count; i++) {
                    const roll = randomInt(1, faces);
                    results.push(roll);
                    sum += roll;
                }

                const diceEmoji = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
                const formatDice = (value: number) => {
                    if (faces === 6 && value >= 1 && value <= 6) {
                        return diceEmoji[value - 1];
                    }
                    return `${value}`;
                };

                const resultText = results.map(formatDice).join(" ");
                const senderName = ctx.message.sender.displayName;

                if (count === 1) {
                    await ctx.message.replyText(`🎲 ${senderName} 掷出了 ${resultText}`);
                } else {
                    await ctx.message.replyText(`🎲 ${senderName} 掷出了 ${count}个${faces}面骰: ${resultText}\n总和: ${sum}`);
                }
            }
        },

        {
            name: 'emoji',
            description: '将文本转换为emoji表达\n用法：\n/emoji 我很开心 - 将"我很开心"转换为相关emoji\n/emoji 今天下雨了 - 将"今天下雨了"转换为相关emoji',
            async handler(ctx: CommandContext) {
                if (!ctx.content) {
                    await ctx.message.replyText('请输入要转换为emoji的文本，例如：/emoji 今天天气真好');
                    return;
                }

                const waitMsg = ctx.message.replyText('🔄 正在将文本转换为emoji表达...');
                try {
                    // 显示正在处理的消息

                    // 使用AI将文本转为emoji
                    const fastAI = getFastAI();
                    const prompt = `请将以下文本转换为生动形象的 emoji 组合，要求如下：

1. 为每个关键概念挑选最具表现力的 emoji
2. 组合 emoji 传达完整语义，而非简单逐词替换
3. 结合表情、动作和场景 emoji，构建一个富有情节的微型故事
4. 可使用箭头、符号等增强逻辑性和动态感
5. 情感和状态优先选用面部表情 emoji
6. 可以运用多行排列，营造节奏感、层次感或对比效果
7. 仅返回 emoji 组合，不附加任何解释性文字

请确保输出结果精确、生动且富有创意：`;
                    const result = await fastAI.get(`${prompt}\n\n${ctx.content}`);

                    // 检查结果是否为空
                    if (!result || result.trim() === '') {
                        ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: (await waitMsg).id,
                            text: '😕 无法将您的文本转换为emoji，请尝试其他文本'
                        });
                        return;
                    }

                    ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: (await waitMsg).id,
                        text: result
                    });
                } catch (error) {
                    plugin.logger?.error('Emoji转换错误:', error);
                    ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: (await waitMsg).id,
                        text: '😢 转换过程中出现错误，请稍后再试'
                    });
                }
            }
        },

        {
            name: 'rps',
            description: '石头剪刀布游戏\n用法：\n/rps 石头 - 出石头\n/rps 剪刀 - 出剪刀\n/rps 布 - 出布\n也支持数字：1(石头), 2(剪刀), 3(布)',
            async handler(ctx: CommandContext) {
                const choices = ['石头 🪨', '剪刀 ✂️', '布 📄'];
                const botChoice = choices[Math.floor(Math.random() * choices.length)];

                let userChoice = '';
                if (ctx.content) {
                    const input = ctx.content.trim().toLowerCase();
                    if (input === '石头' || input === '石頭' || input === 'rock' || input === '1') {
                        userChoice = '石头 🪨';
                    } else if (input === '剪刀' || input === '剪刀' || input === 'scissors' || input === '2') {
                        userChoice = '剪刀 ✂️';
                    } else if (input === '布' || input === 'paper' || input === '3') {
                        userChoice = '布 📄';
                    }
                }

                if (!userChoice) {
                    await ctx.message.replyText('请选择：石头、剪刀或布');
                    return;
                }

                let result = '';
                if (userChoice === botChoice) {
                    result = '平局！';
                } else if (
                    (userChoice === '石头 🪨' && botChoice === '剪刀 ✂️') ||
                    (userChoice === '剪刀 ✂️' && botChoice === '布 📄') ||
                    (userChoice === '布 📄' && botChoice === '石头 🪨')
                ) {
                    result = '你赢了！';
                } else {
                    result = '你输了！';
                }

                // 获取用户名
                const senderName = ctx.message.sender.displayName;
                await ctx.message.replyText(`${senderName} 出了 ${userChoice}\n机器人出了 ${botChoice}\n\n${result}`);
            }
        },

        {
            name: 'coin',
            description: '抛硬币游戏，随机显示正面或反面\n用法：\n/coin - 随机抛出一枚硬币',
            async handler(ctx: CommandContext) {
                const result = Math.random() > 0.5 ? '正面 👑' : '反面 🌟';
                // 获取用户名
                await ctx.message.replyText(`🪙 ${ctx.message.sender.displayName} 抛出了硬币: ${result}`);
            }
        },

        {
            name: 'choose',
            description: '从多个选项中随机选择一个\n用法：\n/choose 选项1 选项2 选项3 - 从多个选项中随机选一个\n也支持用逗号、或字分隔：选项1,选项2或选项3',
            async handler(ctx: CommandContext) {
                if (!ctx.content) {
                    await ctx.message.replyText('请提供选项，用逗号、空格或者"或"分隔');
                    return;
                }

                // 分割选项（支持逗号、空格或"或"分隔）
                let options = ctx.content.split(/[,，、]|\s+|或/g).filter(Boolean);

                if (options.length === 0) {
                    await ctx.message.replyText('未检测到有效的选项');
                    return;
                }

                const chosen = options[Math.floor(Math.random() * options.length)];
                await ctx.message.replyText(`🤔 我选择: ${chosen}`);
            }
        }
    ]
};

export default plugin;
