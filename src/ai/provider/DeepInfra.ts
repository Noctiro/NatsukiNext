import BaseProvider from './BaseProvider';
import type { Message } from './BaseProvider';
import { log } from '../../log';
import { generateRandomUserAgent } from '../../utils/UserAgent';
import { slowModeState } from './BaseProvider'; 

// 默认模型配置
const API_CONFIG = {
    baseURL: 'https://api.deepinfra.com/v1/openai/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': 'https://deepinfra.com',
        'Referer': 'https://deepinfra.com/',
        'X-Deepinfra-Source': 'web-page',
        'accept': 'text/event-stream'
    },
    params: {
        temperature: 1.0,
        max_tokens: 8000,
        top_p: 1.0,
        frequency_penalty: 0.0,
        presence_penalty: 0.0
    }
};

// DeepInfra响应接口
interface DeepInfraResponse {
    choices: Array<{
        message: {
            content: string;
            thinking?: string;
            function_call?: {
                name: string;
                arguments: string;
            };
            [key: string]: any;
        };
        delta?: {
            content?: string;
            thinking?: string;
            function_call?: {
                name?: string;
                arguments?: string;
            };
            [key: string]: any;
        };
    }>;
}

export default class DeepInfra extends BaseProvider {
    private lastRequestTime = 0;
    private functionBuffer: string = '';
    private readonly thinkStartTag: string = '<think>';
    private readonly thinkEndTag: string = '</think>';

    /**
     * 构造函数
     * @param messages 消息列表
     * @param model 模型名称
     * @param chainOfThought 是否使用思维链
     * @param thinkingParameter 思维链参数名
     */
    constructor(
        messages: Message[] = [], 
        model: string = API_CONFIG.defaultModel,
        chainOfThought: boolean = false,
        thinkingParameter: string = 'think'
    ) {
        super(messages, model, chainOfThought, thinkingParameter);
    }

    /**
     * 在请求之间添加延迟以避免速率限制
     * @param multiplier 延迟乘数
     */
    private async sleep(multiplier = 1.0): Promise<void> {
        const now = Date.now();
        if (this.lastRequestTime > 0) {
            const delay = Math.max(0, 500 - (now - this.lastRequestTime)) * multiplier;
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * 发送聊天请求
     * @param maxRetries 最大重试次数
     * @param streaming 是否启用流式传输
     * @returns HTTP响应
     */
    private async requestCompletion(maxRetries = 3, streaming = true): Promise<Response> {
        await this.sleep();
        await DeepInfra.delayIfSlowMode();

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const userAgent = generateRandomUserAgent();
                
                // 构建请求体
                const requestBody: any = {
                    model: this.model,
                    messages: this.messages,
                    stream: streaming,
                    temperature: API_CONFIG.params.temperature,
                    max_tokens: API_CONFIG.params.max_tokens,
                    top_p: API_CONFIG.params.top_p,
                    frequency_penalty: API_CONFIG.params.frequency_penalty,
                    presence_penalty: API_CONFIG.params.presence_penalty
                };
                
                // 如果启用了思维链，添加配置
                if (this.chainOfThought) {
                    requestBody.functions = [{
                        name: "thinking",
                        description: "Thinking step by step to solve the problem",
                        parameters: {
                            type: "object",
                            properties: {
                                [this.thinkingParameter]: {
                                    type: "string",
                                    description: "Your step by step thinking process"
                                }
                            },
                            required: [this.thinkingParameter]
                        }
                    }];
                    
                    // 添加函数调用配置
                    requestBody.function_call = {
                        name: "thinking"
                    };
                }
                
                // 创建请求
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 180000); // 3分钟超时
                
                const response = await fetch(API_CONFIG.baseURL, {
                    method: 'POST',
                    headers: {
                        ...API_CONFIG.headers,
                        'User-Agent': userAgent
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId); // 清除超时定时器

                if (!response.ok) {
                    if (response.status === 429) {
                        log.warn(`速率限制命中。尝试 ${attempt + 1} / ${maxRetries}。启用慢速模式。`);
                        slowModeState.isSlowMode = true;
                        slowModeState.slowModeStart = Date.now();
                        
                        // 重试延迟
                        const waitTime = 2000 * (2 ** attempt) * (1 + Math.random() * 0.2);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                    
                    // 尝试获取错误详情
                    const errorText = await response.text().catch(() => '无法读取错误详情');
                    throw new Error(`请求失败: ${response.status} ${response.statusText} - ${errorText}`);
                }
                
                return response;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log.warn(`请求失败 (${attempt + 1}/${maxRetries}): ${errorMessage}`);
                
                if (attempt < maxRetries - 1) {
                    // 重试延迟
                    const waitTime = 1000 * (2 ** attempt) * (1 + Math.random() * 0.2);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } else {
                    throw error;
                }
            }
        }
        
        throw new Error(`请求失败，已达最大重试次数 ${maxRetries}`);
    }

    /**
     * 流式处理响应
     * @param output 输出回调函数
     * @param text 输入文本
     * @param store 是否存储消息
     */
    async stream(
        output: (content: string, done: boolean, thinking?: string) => void, 
        text: string, 
        store = true
    ): Promise<void> {
        this.messages.push({ role: "user", content: text });
        this.functionBuffer = ''; // 重置函数参数缓冲区

        try {
            const response = await this.requestCompletion();
            const reader = response.body?.getReader();
            if (!reader) throw new Error('无可用的响应流读取器');

            let content = '';
            let thinking: string | undefined;
            const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
            let buffer = '';
            // 标记是否处于思考模式
            let inThinkingMode = false;
            // 记录未处理完的思考内容
            let pendingThinking = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    // 确保value是有效的
                    if (value) {
                        buffer += decoder.decode(value, { stream: true });
                        const events = buffer.split("\n\n");
                        buffer = events.pop() || '';

                        for (const event of events) {
                            if (!event.trim() || !event.includes('data: ')) continue;
                            
                            // 直接从事件中提取JSON数据
                            const dataPrefix = 'data: ';
                            const dataStart = event.indexOf(dataPrefix);
                            if (dataStart === -1) continue;
                            
                            const jsonStr = event.substring(dataStart + dataPrefix.length).trim();
                            if (jsonStr === '[DONE]') continue;
                            
                            try {
                                const parsed = JSON.parse(jsonStr);
                                
                                // 处理函数调用（用于思考过程）
                                if (this.chainOfThought && parsed?.choices?.[0]?.delta?.function_call) {
                                    const delta = parsed.choices[0].delta;
                                    if (delta.function_call.name === 'thinking') {
                                        // 累积函数参数
                                        if (delta.function_call.arguments) {
                                            this.functionBuffer += delta.function_call.arguments;
                                            
                                            // 尝试解析完整的JSON
                                            const extractedThinking = this.extractThinkingFromFunctionBuffer(this.functionBuffer);
                                            if (extractedThinking) {
                                                thinking = thinking ? thinking + extractedThinking : extractedThinking;
                                            }
                                        }
                                    }
                                    
                                    // 在函数调用模式下不处理常规内容
                                    output(content, false, thinking);
                                    continue;
                                }
                                
                                // 检查是否有有效的内容
                                if (!parsed?.choices?.[0]?.delta?.content) continue;
                                
                                const contentDelta = parsed.choices[0].delta.content;
                                
                                // 首先检查是否处于思考模式
                                if (inThinkingMode) {
                                    // 检查是否包含结束标签
                                    const endPos = contentDelta.indexOf(this.thinkEndTag);
                                    if (endPos !== -1) {
                                        // 提取思考内容（直到结束标签）
                                        const thinkingPart = contentDelta.substring(0, endPos);
                                        // 累积思考内容
                                        pendingThinking += thinkingPart;
                                        thinking = thinking ? thinking + pendingThinking : pendingThinking;
                                        pendingThinking = '';
                                        
                                        // 结束标签后的内容作为普通内容
                                        const normalContent = contentDelta.substring(endPos + this.thinkEndTag.length);
                                        content += normalContent;
                                        
                                        // 退出思考模式
                                        inThinkingMode = false;
                                    } else {
                                        // 全部作为思考内容累积
                                        pendingThinking += contentDelta;
                                    }
                                    
                                    // 输出更新（仅普通内容）
                                    output(content, false, thinking);
                                    continue;
                                }
                                
                                // 检查是否有思考标签开始
                                const startPos = contentDelta.indexOf(this.thinkStartTag);
                                if (startPos !== -1) {
                                    // 添加标签前的内容到普通内容
                                    content += contentDelta.substring(0, startPos);
                                    
                                    // 检查是否在同一块中包含结束标签
                                    const endPos = contentDelta.indexOf(this.thinkEndTag, startPos + this.thinkStartTag.length);
                                    if (endPos !== -1) {
                                        // 提取完整的思考内容
                                        const thinkContent = contentDelta.substring(
                                            startPos + this.thinkStartTag.length, 
                                            endPos
                                        );
                                        thinking = thinking ? thinking + thinkContent : thinkContent;
                                        
                                        // 添加结束标签后的内容到普通内容
                                        content += contentDelta.substring(endPos + this.thinkEndTag.length);
                                    } else {
                                        // 进入思考模式，标签后的内容作为未完成的思考内容
                                        inThinkingMode = true;
                                        pendingThinking = contentDelta.substring(startPos + this.thinkStartTag.length);
                                    }
                                } else if (content.endsWith(this.thinkStartTag.substring(0, this.thinkStartTag.length - 1)) && 
                                         contentDelta.startsWith(this.thinkStartTag.charAt(this.thinkStartTag.length - 1))) {
                                    // 处理跨事件的标签开始情况
                                    // 移除内容末尾的部分标签
                                    content = content.substring(0, content.length - (this.thinkStartTag.length - 1));
                                    
                                    // 检查是否在同一块中包含结束标签
                                    const remainingDelta = contentDelta.substring(1); // 跳过标签的最后一个字符
                                    const endPos = remainingDelta.indexOf(this.thinkEndTag);
                                    
                                    if (endPos !== -1) {
                                        // 提取完整的思考内容
                                        const thinkContent = remainingDelta.substring(0, endPos);
                                        thinking = thinking ? thinking + thinkContent : thinkContent;
                                        
                                        // 添加结束标签后的内容到普通内容
                                        content += remainingDelta.substring(endPos + this.thinkEndTag.length);
                                    } else {
                                        // 进入思考模式，后续内容作为未完成的思考内容
                                        inThinkingMode = true;
                                        pendingThinking = remainingDelta;
                                    }
                                } else {
                                    // 检查跨事件标签的更通用情况
                                    if (this.thinkStartTag.length > 1) {
                                        let tagFound = false;
                                        
                                        // 测试不同长度的前缀
                                        for (let i = 1; i < this.thinkStartTag.length && !tagFound; i++) {
                                            const prefix = this.thinkStartTag.substring(0, i);
                                            const suffix = this.thinkStartTag.substring(i);
                                            
                                            if (content.endsWith(prefix) && contentDelta.startsWith(suffix)) {
                                                // 移除前缀
                                                content = content.substring(0, content.length - prefix.length);
                                                
                                                // 检查后面的内容是否有结束标签
                                                const remainingDelta = contentDelta.substring(suffix.length);
                                                const endPos = remainingDelta.indexOf(this.thinkEndTag);
                                                
                                                if (endPos !== -1) {
                                                    // 完整的思考内容
                                                    const thinkContent = remainingDelta.substring(0, endPos);
                                                    thinking = thinking ? thinking + thinkContent : thinkContent;
                                                    
                                                    // 结束标签后的普通内容
                                                    content += remainingDelta.substring(endPos + this.thinkEndTag.length);
                                                } else {
                                                    // 进入思考模式
                                                    inThinkingMode = true;
                                                    pendingThinking = remainingDelta;
                                                }
                                                
                                                tagFound = true;
                                                break;
                                            }
                                        }
                                        
                                        if (tagFound) {
                                            // 已处理跨事件标签
                                            output(content, false, thinking);
                                            continue;
                                        }
                                    }
                                    
                                    // 检查内容中是否可能已经有部分未处理的思考标签
                                    if (this.containsPartialThinkTag(content)) {
                                        // 检查组合后是否形成完整标签
                                        const combinedContent = content + contentDelta;
                                        const tagPos = this.findFirstCompleteThinkTag(combinedContent);
                                        
                                        if (tagPos !== -1) {
                                            // 找到了完整的标签
                                            const startIdx = tagPos;
                                            const endIdx = startIdx + this.thinkStartTag.length;
                                            
                                            // 更新内容，保留标签前的部分
                                            content = combinedContent.substring(0, startIdx);
                                            
                                            // 检查是否有结束标签
                                            const endTagPos = combinedContent.indexOf(this.thinkEndTag, endIdx);
                                            
                                            if (endTagPos !== -1) {
                                                // 提取思考内容
                                                const thinkContent = combinedContent.substring(endIdx, endTagPos);
                                                thinking = thinking ? thinking + thinkContent : thinkContent;
                                                
                                                // 添加结束标签后的内容
                                                content += combinedContent.substring(endTagPos + this.thinkEndTag.length);
                                            } else {
                                                // 进入思考模式
                                                inThinkingMode = true;
                                                pendingThinking = combinedContent.substring(endIdx);
                                            }
                                            
                                            output(content, false, thinking);
                                            continue;
                                        }
                                    }
                                    
                                    // 普通内容，直接添加
                                    content += contentDelta;
                                }
                                
                                // 输出更新
                                output(content, false, thinking);
                            } catch (error) {
                                log.debug('解析事件JSON失败:', error);
                            }
                        }
                    }
                }

                // 确保完成最后一部分解码
                buffer += decoder.decode(undefined, { stream: false });
                
                // 处理最后的buffer
                if (buffer.trim()) {
                    if (inThinkingMode) {
                        // 如果仍在思考模式，尝试提取最后的内容
                        try {
                            const dataStart = buffer.indexOf('data: ');
                            if (dataStart !== -1) {
                                const jsonStr = buffer.substring(dataStart + 'data: '.length).trim();
                                if (jsonStr !== '[DONE]') {
                                    const parsed = JSON.parse(jsonStr);
                                    if (parsed?.choices?.[0]?.delta?.content) {
                                        const contentDelta = parsed.choices[0].delta.content;
                                        
                                        // 检查是否有结束标签
                                        const endPos = contentDelta.indexOf(this.thinkEndTag);
                                        if (endPos !== -1) {
                                            // 提取思考内容
                                            pendingThinking += contentDelta.substring(0, endPos);
                                            thinking = thinking ? thinking + pendingThinking : pendingThinking;
                                            pendingThinking = '';
                                            
                                            // 结束标签后的内容
                                            content += contentDelta.substring(endPos + this.thinkEndTag.length);
                                            inThinkingMode = false;
                                        } else {
                                            // 全部作为思考内容
                                            pendingThinking += contentDelta;
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            log.debug('处理最后buffer在思考模式中失败:', e);
                        }
                    } else {
                        // 正常处理最后的buffer
                        try {
                            const dataStart = buffer.indexOf('data: ');
                            if (dataStart !== -1) {
                                const jsonStr = buffer.substring(dataStart + 'data: '.length).trim();
                                if (jsonStr !== '[DONE]') {
                                    const parsed = JSON.parse(jsonStr);
                                    if (parsed?.choices?.[0]?.delta?.content) {
                                        const contentDelta = parsed.choices[0].delta.content;
                                        
                                        // 检查是否包含思考标签
                                        const startPos = contentDelta.indexOf(this.thinkStartTag);
                                        if (startPos !== -1) {
                                            // 处理包含标签的最后内容
                                            content += contentDelta.substring(0, startPos);
                                            
                                            // 检查是否有结束标签
                                            const endPos = contentDelta.indexOf(this.thinkEndTag, startPos + this.thinkStartTag.length);
                                            if (endPos !== -1) {
                                                // 完整的思考过程
                                                const thinkContent = contentDelta.substring(
                                                    startPos + this.thinkStartTag.length, 
                                                    endPos
                                                );
                                                thinking = thinking ? thinking + thinkContent : thinkContent;
                                                
                                                // 结束标签后的内容
                                                content += contentDelta.substring(endPos + this.thinkEndTag.length);
                                            } else {
                                                // 未闭合的思考标签，全部内容作为思考过程
                                                const thinkContent = contentDelta.substring(startPos + this.thinkStartTag.length);
                                                thinking = thinking ? thinking + thinkContent : thinkContent;
                                            }
                                        } else {
                                            // 普通内容
                                            content += contentDelta;
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            log.debug('处理最后普通buffer失败:', e);
                        }
                    }
                }
                
                // 如果思考模式下有未处理的内容，添加到thinking
                if (pendingThinking) {
                    thinking = thinking ? thinking + pendingThinking : pendingThinking;
                }
                
                // 再次尝试解析函数参数，获取思考过程
                if (this.chainOfThought && this.functionBuffer) {
                    const extractedThinking = this.extractThinkingFromFunctionBuffer(this.functionBuffer);
                    if (extractedThinking) {
                        thinking = thinking ? thinking + extractedThinking : extractedThinking;
                    }
                }
                
                // 最后检查内容中是否还包含残留的思考标签
                if (this.chainOfThought) {
                    content = this.cleanThinkTagsFromContent(content, thinking);
                }
                
                // 最终输出
                output(content, true, thinking);
                
                if (store) {
                    this.messages.push({ 
                        role: "assistant", 
                        content: content,
                        ...(thinking ? { thinking } : {})
                    });
                }
                
                return;
            } catch (error) {
                log.error('Stream handling error:', error);
                throw error;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error('流处理失败:', errorMessage);
            throw error;
        }
    }

    /**
     * 获取回复内容
     * @param text 输入文本
     * @param store 是否存储消息
     * @returns 回复内容
     */
    async get(text: string, store = true): Promise<string> {
        this.messages.push({ role: "user", content: text });
        
        try {
            const response = await this.requestCompletion(3, false);
            const data = await response.json() as DeepInfraResponse;
            
            // 添加对API响应的有效性检查
            if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
                log.error('无效的API响应:', JSON.stringify(data));
                throw new Error('API返回的响应格式不正确或为空');
            }
            
            // 获取内容
            const content = data.choices[0]?.message?.content || '';
            
            // 获取思考过程
            let thinking: string | undefined;
            if (this.chainOfThought) {
                const messageObj = data.choices[0]?.message as Record<string, any>;
                
                // 检查function_call返回
                if (messageObj.function_call && typeof messageObj.function_call === 'object') {
                    // 尝试解析函数调用参数
                    try {
                        const functionArgs = messageObj.function_call.arguments || '{}';
                        const parsedArgs = JSON.parse(functionArgs);
                        thinking = parsedArgs[this.thinkingParameter];
                    } catch (e) {
                        log.warn('解析函数调用参数失败:', e instanceof Error ? e.message : String(e));
                    }
                } else {
                    // 直接尝试获取思考过程字段
                    thinking = messageObj[this.thinkingParameter];
                }
            }
            
            // 清理内容中的思考标签
            let cleanedContent = content;
            if (this.chainOfThought && content) {
                cleanedContent = this.cleanThinkTagsFromContent(content, thinking);
            }
            
            if (!cleanedContent && !thinking) {
                throw new Error('API返回的响应内容为空');
            }
            
            if (store) {
                const messageToStore: Message = { 
                    role: "assistant", 
                    content: cleanedContent
                };
                if (thinking) {
                    messageToStore.thinking = thinking;
                }
                this.messages.push(messageToStore);
            }
            
            return cleanedContent;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error('获取响应失败:', errorMessage);
            throw error;
        }
    }

    /**
     * 从函数调用参数中提取思考过程
     * @param functionBuffer 函数调用参数缓冲区
     * @returns 提取的思考过程
     */
    private extractThinkingFromFunctionBuffer(functionBuffer: string): string | undefined {
        if (!functionBuffer.trim()) return undefined;
        
        try {
            // 查找完整的JSON对象
            const jsonStart = functionBuffer.indexOf('{');
            const jsonEnd = functionBuffer.lastIndexOf('}');
            
            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                const jsonStr = functionBuffer.substring(jsonStart, jsonEnd + 1);
                const parsedArgs = JSON.parse(jsonStr);
                return parsedArgs[this.thinkingParameter];
            }
        } catch (e) {
            log.warn('解析思考过程失败:', e instanceof Error ? e.message : String(e));
        }
        
        return undefined;
    }

    /**
     * 清除内容中的所有思考标签及其内容
     * @param content 输入内容
     * @param thinking 现有思考内容引用（可能被修改）
     * @returns 清理后的内容
     */
    private cleanThinkTagsFromContent(content: string, thinking: string | undefined): string {
        let cleanedContent = content;
        let startIdx: number;
        
        // 循环处理所有可能的思考标签
        while ((startIdx = cleanedContent.indexOf(this.thinkStartTag)) !== -1) {
            // 查找对应的结束标签
            const endIdx = cleanedContent.indexOf(this.thinkEndTag, startIdx + this.thinkStartTag.length);
            
            if (endIdx !== -1) {
                // 提取标签内容
                const tagContent = cleanedContent.substring(
                    startIdx + this.thinkStartTag.length, 
                    endIdx
                );
                
                // 累积思考内容
                if (tagContent) {
                    thinking = thinking ? thinking + tagContent : tagContent;
                }
                
                // 移除标签及内容
                cleanedContent = cleanedContent.substring(0, startIdx) + 
                               cleanedContent.substring(endIdx + this.thinkEndTag.length);
            } else {
                // 没有找到结束标签，认为从开始标签到结尾都是思考内容
                const tagContent = cleanedContent.substring(startIdx + this.thinkStartTag.length);
                
                // 累积思考内容
                if (tagContent) {
                    thinking = thinking ? thinking + tagContent : tagContent;
                }
                
                // 保留标签前的内容
                cleanedContent = cleanedContent.substring(0, startIdx);
            }
        }
        
        return cleanedContent;
    }

    /**
     * 检查内容中是否包含部分思考标签（不完整的标签）
     */
    private containsPartialThinkTag(content: string): boolean {
        if (!content || content.length < 1) return false;
        
        // 检查完整标签
        if (content.includes(this.thinkStartTag)) return true;
        
        // 检查部分标签（内容末尾与标签开头匹配）
        for (let i = 1; i < this.thinkStartTag.length; i++) {
            const partialTag = this.thinkStartTag.substring(0, i);
            if (content.endsWith(partialTag)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * 查找内容中第一个完整的思考标签的位置
     */
    private findFirstCompleteThinkTag(content: string): number {
        return content.indexOf(this.thinkStartTag);
    }
}

// (new DeepInfra()).stream(
//     (content: string, done: boolean, thinking?: string) => {
//         if (content) console.log('内容:', content);
//         if (thinking) console.log('思考过程:', thinking);
//         if (done) console.log('输出完成');
//     }, 
//     "求解方程 ln(x) = -x 的解，一步一步地思考，详细解释每一步的推导过程"
// );
