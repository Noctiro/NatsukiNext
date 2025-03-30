import { log } from "../../log";

export interface Message {
    role: "user" | "assistant" | "system";
    content: string;
    thinking?: string;
}

export interface ProviderConfig {
    baseURL: string;
    defaultModel: string;
    headers: Record<string, string>;
    params: {
        temperature: number;
        max_tokens: number;
        top_p: number;
        frequency_penalty: number;
        presence_penalty: number;
        chain_of_thought?: boolean;
        thinking_parameter?: string;
    };
}

export const slowModeState: { isSlowMode: boolean; slowModeStart: number | null } = { isSlowMode: false, slowModeStart: null };

export default class BaseProvider {
    protected messages: Message[];
    protected model: string;
    protected apiKey?: Array<string>;
    protected chainOfThought: boolean;
    protected thinkingParameter: string;

    constructor(messages: Message[] = [], model: string = '', chainOfThought: boolean = false, thinkingParameter: string = 'thinking') {
        this.messages = messages;
        this.model = model;
        this.chainOfThought = chainOfThought;
        this.thinkingParameter = thinkingParameter;
    }

    static async delayIfSlowMode(): Promise<void> {
        if (slowModeState.isSlowMode) {
            const now = Date.now();
            if (slowModeState.slowModeStart && now - slowModeState.slowModeStart > 60000) {
                log.info('Slow mode expired, resuming normal speed.');
                slowModeState.slowModeStart = null;
            } else if (slowModeState.slowModeStart) {
                log.info('Slow mode active, delaying for 5 seconds.');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    protected handleError(error: any, attempt: number, maxRetries: number): boolean {
        const statusCode = error.response?.status;
        if (statusCode === 429) {
            log.warn(`Rate limit hit. Attempt ${attempt + 1} of ${maxRetries}`);
            slowModeState.isSlowMode = true;
            slowModeState.slowModeStart = Date.now();
            return true;
        }

        const errorMap: Record<number, string> = {
            401: 'Invalid API key or unauthorized access',
            404: 'Model not found or unavailable',
            400: `Bad request: ${error.response?.data?.error?.message || 'Unknown error'}`,
            402: 'Insufficient credits'
        };

        if (errorMap[statusCode]) throw new Error(errorMap[statusCode]);
        return attempt < maxRetries - 1;
    }

    /**
     * 处理流式输出的数据块
     * @param event 事件数据
     * @param content 当前累积的内容
     * @param thinking 当前累积的思考过程
     * @param output 输出回调函数
     * @returns 更新后的内容和思考过程
     */
    protected processStreamEvent(
        event: string, 
        content: string, 
        thinking: string | undefined, 
        output: (content: string, isFinal: boolean, thinking?: string) => void
    ): { content: string, thinking?: string } {
        if (!event.trim()) return { content, thinking };
        
        const dataPrefix = 'data: ';
        const dataStart = event.indexOf(dataPrefix);
        
        if (dataStart === -1) return { content, thinking };
        
        const jsonStr = event.substring(dataStart + dataPrefix.length).trim();
        if (jsonStr === '[DONE]') return { content, thinking };
        
        try {
            const parsed = JSON.parse(jsonStr);
            
            // 确保parsed.choices存在且不为空
            if (parsed && parsed.choices && Array.isArray(parsed.choices) && parsed.choices.length > 0) {
                // 处理内容
                if (parsed.choices[0].delta?.content) {
                    content += parsed.choices[0].delta.content;
                }
                
                // 处理思考过程
                if (this.chainOfThought && parsed.choices[0].delta?.[this.thinkingParameter]) {
                    thinking = (thinking || '') + parsed.choices[0].delta[this.thinkingParameter];
                }
                
                // 输出更新
                output(content, false, thinking);
            }
        } catch (e) {
            // 忽略解析错误
            log.debug('Stream event parsing error:', e);
        }
        
        return { content, thinking };
    }

    /**
     * 基础的流式处理方法，子类可以重写或使用此方法
     */
    protected async handleStream(
        reader: { read(): Promise<{ done: boolean; value?: any }> },
        output: (content: string, done: boolean, thinking?: string) => void
    ): Promise<{ content: string, thinking?: string }> {
        let content = '';
        let thinking: string | undefined = '';
        const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                // 确保value是有效的
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    // log.info(`buffer: ${buffer}, value: ${value}`);
                    const events = buffer.split("\n\n");
                    buffer = events.pop() || '';

                    for (const event of events) {
                        const result = this.processStreamEvent(event, content, thinking, output);
                        content = result.content;
                        thinking = result.thinking;
                    }
                }
            }

            // 确保完成最后一部分解码
            buffer += decoder.decode(undefined, { stream: false });
            
            // 处理最后的缓冲区
            if (buffer.trim()) {
                const result = this.processStreamEvent(buffer, content, thinking, output);
                content = result.content;
                thinking = result.thinking;
            }

            return { content, thinking };
        } catch (error) {
            log.error('Stream handling error:', error);
            throw error;
        }
    }

    protected validateApiKey(): void {
        if (!this.apiKey || this.apiKey.length === 0) {
            throw new Error('API key is not configured');
        }
    }

    protected getApiKey(): string | undefined {
        if (this.apiKey && this.apiKey.length > 0) {
            return this.apiKey[Math.floor(Math.random() * this.apiKey.length)];
        }
    }
}