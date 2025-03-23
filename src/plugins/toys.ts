import { getFastAI } from "../ai/AiManager";
import type { BotPlugin, CommandContext } from "../features";

// ASCII 艺术图集合
const asciiArts: Record<string, string> = {
    cat: `
  /\\_/\\  
 ( o.o ) 
  > ^ <  
    `,
    dog: `
  / \\__
 (    @\\___
 /         O
/   (_____/
/_____/   U
    `,
    rabbit: `
  (\\(\\ 
 (='.') 
 (")_(")
    `,
    bear: `
 ʕ•ᴥ•ʔ
    `,
    panda: `
 ⟋⏝⟋
 (•ㅅ•)
 / 　 \\
(ノ^ヮ^)ノ
    `,
    penguin: `
   _
  (o)_
 //(")\\
 ^^~~~^^
    `,
    heart: `
  /\\  /\\ 
 /  \\/  \\
|        |
 \\      /
  \\    /
   \\  /
    \\/
    `,
    fish: `
    ><(((('>
    `,
    coffee: `
   ( (
    ) )
  .........
  |       |]
  \\     /
   -----
    `,
    castle: `
       _~^~^~_
   \\) /  o o  \\ (/
     '_   v   _'
     / '-----' \\
  /~~|         |~~\\
 /   |         |   \\
|    |         |    |
|    |_________|    |
|    |         |    |
|    |         |    |
|====|         |====|
^^^^^|_________|^^^^^
     (____|____)     
     (____|____)     
     (____|____)
     (____|____)
    `,
    sword: `
      />
      />
     (:)
     (:)
     |~|
     |~|
     |~|
     |~|
     |~|
     |~|
     |~|
     |~|
     |~|
     |~|
 /~~~~~~~\\
 |       |
 |       |
 |/\\/\\/\\/|
     |
     |
     |
    `,
    cat2: `
 /\\_/\\
( o.o )
 > ^ <
    `,
    piano: `
    ♫ ┏━┓ ┏━┓ ♪
       ┃  ┃ ┃  ┃  
       ┗━┛ ┗━┛  
    `,
    hug: `
     (つ ◕_◕ )つ
    `,
    moon: `
         _..._
       .:::::::.
      :::::::::::
      :::::::::::
      \`:::::::::'
        \`':::'
    `,
    stars: `
       ✧  　  · 
    　   ✦  　 · 
      · *  
       　 ⋆ 　✦   
         · ✫ 
    `,
};

// ASCII 对话气泡 - 右上角显示的美化版本
const asciiBubble = (text: string): string => {
    const lines = text.split('\n');
    const width = Math.max(...lines.map(line => line.length || 0));
    const paddedWidth = Math.min(width, 25); // 限制最大宽度，防止气泡过大

    // 创建对话气泡，不含左侧填充（用于组合时添加）
    let bubble = '';

    // 顶部边框
    bubble += ` ${'_'.repeat(paddedWidth + 2)}\n`;

    if (lines.length === 1) {
        // 单行文本使用更简洁的样式
        bubble += `< ${lines[0]?.padEnd(paddedWidth, ' ') || ''} >\n`;
        bubble += ` ${'‾'.repeat(paddedWidth + 2)}\n`;
        bubble += `  \\\n`;
        bubble += `   \\\n`;
    } else {
        // 多行文本使用更美观的气泡样式
        bubble += `/ ${lines[0]?.padEnd(paddedWidth, ' ') || ''} \\\n`;

        // 中间行
        for (let i = 1; i < lines.length - 1; i++) {
            const line = lines[i] || '';
            bubble += `| ${line.padEnd(paddedWidth, ' ')} |\n`;
        }

        // 最后一行
        if (lines.length > 1) {
            const lastLine = lines[lines.length - 1] || '';
            bubble += `\\ ${lastLine.padEnd(paddedWidth, ' ')} /\n`;
        }

        bubble += ` ${'‾'.repeat(paddedWidth + 2)}\n`;
        bubble += `  \\\n`;
        bubble += `   \\\n`;
    }

    return bubble;
};

// 随机整数函数
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 将ASCII艺术和说话内容转换为消息格式，避免Markdown解析错误
const formatAsciiOutput = (content: string, extraInfo?: string): string => {
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
        return codeBlock + '\n' + extraInfo;
    }

    return codeBlock;
};

// 将ASCII艺术和对话气泡组合在一起，气泡在右上角
const combineAsciiAndBubble = (asciiArt: string, speakText: string): string => {
    // 将ASCII艺术和气泡分别分成行
    const asciiLines = asciiArt.split('\n');
    const bubbleLines = asciiBubble(speakText).split('\n');

    // 移除首尾的空行
    const trimmedAsciiLines = [];
    let startIndex = 0;
    let endIndex = asciiLines.length - 1;

    // 找到第一个非空行
    while (startIndex < asciiLines.length && (asciiLines[startIndex]?.trim() === '' || asciiLines[startIndex] === undefined)) {
        startIndex++;
    }

    // 找到最后一个非空行
    while (endIndex >= 0 && (asciiLines[endIndex]?.trim() === '' || asciiLines[endIndex] === undefined)) {
        endIndex--;
    }

    // 提取有效的ASCII行
    for (let i = startIndex; i <= endIndex; i++) {
        trimmedAsciiLines.push(asciiLines[i] || '');
    }

    if (trimmedAsciiLines.length === 0) {
        return asciiArt; // 没有有效行，返回原始ASCII
    }

    // 确定气泡显示的行数和ASCII艺术的最大宽度
    const maxBubbleLines = Math.min(bubbleLines.length, 5); // 最多显示5行气泡
    const maxAsciiWidth = Math.max(...trimmedAsciiLines.map(line => line.length));

    // 为了确保气泡在右侧，添加足够的空格
    const spacedBubbleLines = bubbleLines.map(line => ' '.repeat(maxAsciiWidth + 2) + line);

    // 组合结果
    let result = '';

    // 添加顶部气泡行
    for (let i = 0; i < Math.min(maxBubbleLines, trimmedAsciiLines.length); i++) {
        if (i < trimmedAsciiLines.length) {
            const asciiLine = trimmedAsciiLines[i] || '';
            const bubbleLine = spacedBubbleLines[i] || '';

            // 将ASCII行与气泡行组合
            result += asciiLine.padEnd(maxAsciiWidth, ' ') + bubbleLine.substring(maxAsciiWidth) + '\n';
        } else {
            // 如果ASCII行数不足，单独添加气泡行
            result += ' '.repeat(maxAsciiWidth) + bubbleLines[i] + '\n';
        }
    }

    // 添加剩余的ASCII行
    for (let i = maxBubbleLines; i < trimmedAsciiLines.length; i++) {
        result += trimmedAsciiLines[i] + '\n';
    }

    // 添加原始ASCII的尾部空行
    for (let i = endIndex + 1; i < asciiLines.length; i++) {
        result += (asciiLines[i] || '') + '\n';
    }

    return result;
};

const plugin: BotPlugin = {
    name: 'toys',
    description: '一些有趣的玩具命令和互动工具',
    version: '1.0.0',

    commands: [
        {
            name: 'ascii',
            description: '生成ASCII艺术图或让ASCII图案说话\n用法：\n/ascii 列表 - 查看所有可用图案\n/ascii 猫 - 显示猫的ASCII图案\n/ascii 猫 你好 - 让猫说"你好"\n/ascii 你好 - 随机选择图案说"你好"',
            async handler(ctx: CommandContext) {
                // 如果参数是"列表"，显示所有可用的ASCII艺术
                if (ctx.content?.trim().toLowerCase() === '列表') {
                    const artList = Object.keys(asciiArts).join(', ');
                    await ctx.message.replyText(`可用的ASCII图案列表：\n${artList}\n\n使用方法：\n/ascii [图案名] - 显示指定图案\n/ascii [图案名] [文本] - 让指定图案说话\n/ascii [文本] - 让随机图案说话`);
                    return;
                }

                if (!ctx.content) {
                    // 如果没有参数，显示帮助和可用的ASCII艺术列表
                    const artList = Object.keys(asciiArts).join(', ');
                    await ctx.message.replyText(`请输入要显示的ASCII图案名称或想让图案说的话：\n\n可用图案: ${artList}\n\n使用 "/ascii 列表" 查看详细说明`);
                    return;
                }

                // 检查是否请求了预定义的ASCII艺术
                const contentParts = ctx.content?.split(' ') || [];
                const requestedArt = contentParts[0]?.trim().toLowerCase() || '';

                if (asciiArts[requestedArt]) {
                    // 获取ASCII艺术
                    let result = asciiArts[requestedArt];

                    // 如果有额外文本，将其添加到ASCII艺术的气泡中
                    if (contentParts.length > 1) {
                        const speakText = contentParts.slice(1).join(' ');
                        result = combineAsciiAndBubble(result, speakText);
                    }

                    await ctx.message.replyText(formatAsciiOutput(result));
                    return;
                }

                // 否则显示随机ASCII艺术并让它说话
                const artKeys = Object.keys(asciiArts);
                const randomArtKey = artKeys[Math.floor(Math.random() * artKeys.length)];

                // 确保我们能够获取到有效的ASCII艺术
                if (randomArtKey && asciiArts[randomArtKey]) {
                    const randomArt = asciiArts[randomArtKey];

                    // 添加用户文本到随机ASCII艺术的气泡中
                    let result = randomArt;
                    if (ctx.content) {
                        result = combineAsciiAndBubble(randomArt, ctx.content);
                    }

                    const extraInfo = `(随机选择了: ${randomArtKey}，输入 /ascii 列表 查看所有图案)`;
                    await ctx.message.replyText(formatAsciiOutput(result, extraInfo));
                } else {
                    // 如果出现意外情况，显示简单消息
                    await ctx.message.replyText('无法生成ASCII艺术，请稍后再试');
                }
                return;
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
2. 合理组合 emoji，确保传达完整语义，不仅仅是单词替换  
3. 融合表情、动作和场景 emoji，构建一个微型故事  
4. 可运用箭头、符号等辅助元素以增强表达效果  
5. 情感和状态优先选用面部表情 emoji  
6. 仅返回 emoji 组合，不附加任何解释性文字

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
                    console.error('Emoji转换错误:', error);
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
            name: 'say',
            description: '让机器人说话，并删除您的命令消息\n用法：\n/say 你好 - 机器人说"你好"\n回复某消息并使用 /say 文本 - 机器人回复该消息',
            async handler(ctx: CommandContext) {
                if (!ctx.content) {
                    await ctx.message.replyText('请输入要说的话');
                    return;
                }

                // 尝试回复被引用的消息，如果没有则直接发送
                if (ctx.message.replyToMessage) {
                    await ctx.message.replyText(ctx.content);
                } else {
                    await ctx.client.sendText(ctx.chatId, ctx.content);
                }

                // 尝试删除用户的指令消息
                try {
                    await ctx.client.deleteMessagesById(ctx.chatId, [ctx.message.id]);
                } catch (err) {
                    // 忽略权限错误
                }
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
            name: 'magic8',
            description: '魔法8球，回答是/否问题\n用法：\n/magic8 我今天会遇到好事吗？ - 随机给出一个预测回答',
            async handler(ctx: CommandContext) {
                if (!ctx.content) {
                    await ctx.message.replyText('请输入一个问题');
                    return;
                }

                const answers = [
                    "是的，绝对如此！✅",
                    "确定是这样。🟢",
                    "毫无疑问。✅",
                    "迹象表明是的。🟢",
                    "看起来不错。👍",
                    "很有可能。🔮",
                    "前景光明。✨",
                    "是的。👌",
                    "回答模糊，请再试一次。🔄",
                    "过会儿再问。⏳",
                    "现在不方便透露。🤐",
                    "无法预测。❓",
                    "专心提问，再问一次。🧠",
                    "不要指望它。❌",
                    "我的回答是否定的。🔴",
                    "我的消息来源说不行。🚫",
                    "前景不太好。☹️",
                    "很成疑。❓"
                ];

                const randomIndex = Math.floor(Math.random() * answers.length);
                const answer = answers[randomIndex];

                await ctx.message.replyText(`🎱 问题: ${ctx.content}\n\n${answer}`);
            }
        },

        {
            name: 'scramble',
            description: '打乱文字顺序，但保留首尾字母位置\n用法：\n/scramble 这是一段测试文本 - 将文本中单词的中间字母顺序打乱',
            async handler(ctx: CommandContext) {
                if (!ctx.content) {
                    await ctx.message.replyText('请输入要打乱的文本');
                    return;
                }

                // 打乱文字顺序，但保留首尾字母位置
                const words = ctx.content.split(' ');

                const scrambledWords = words.map(word => {
                    if (word.length <= 3) return word;

                    const first = word.charAt(0);
                    const last = word.charAt(word.length - 1);
                    const middle = word.substring(1, word.length - 1).split('');

                    // 打乱中间字母
                    for (let i = middle.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        const temp = middle[i];
                        middle[i] = middle[j] || '';
                        middle[j] = temp || '';
                    }

                    return first + middle.join('') + last;
                });

                await ctx.message.replyText(`原文: ${ctx.content}\n打乱后: ${scrambledWords.join(' ')}\n\n(研究表明，只要单词的首尾字母位置不变，中间字母顺序混乱也不影响阅读)`);
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