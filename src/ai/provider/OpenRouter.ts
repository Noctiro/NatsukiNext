import BaseProvider from './BaseProvider';
import type { Message, ProviderConfig } from './BaseProvider';
import { log } from '../../log';

const API_CONFIG: ProviderConfig = {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-r1:free',
    headers: {
        'HTTP-Referer': 'https://github.com/MistEO/NatsukiMiyu',
        'X-Title': 'NatsukiMiyu Bot',
        'Content-Type': 'application/json'
    },
    params: {
        temperature: 1.0,
        max_tokens: 10000,
        top_p: 1.0,
        frequency_penalty: 0,
        presence_penalty: 0,
        chain_of_thought: true,
        thinking_parameter: 'reasoning'
    }
};

interface OpenAIResponse {
    choices: Array<{
        message: {
            content: string;
            reasoning?: string;
        };
    }>;
}

export default class OpenRouter extends BaseProvider {
    constructor(
        messages: Message[] = [], 
        model: string = API_CONFIG.defaultModel, 
        chainOfThought: boolean = API_CONFIG.params.chain_of_thought as boolean, 
        thinkingParameter: string = API_CONFIG.params.thinking_parameter as string
    ) {
        super(messages, model, chainOfThought, thinkingParameter);
        this.apiKey = process.env.AI_OPENROUTER_API_KEY?.split(',') || [];
    }

    private async makeRequest(streaming = false, maxRetries = 3): Promise<Response> {
        this.validateApiKey();
        await OpenRouter.delayIfSlowMode();

        const headers = {
            ...API_CONFIG.headers,
            'Authorization': `Bearer ${this.getApiKey()}`,
            ...(streaming ? { 'Accept': 'text/event-stream' } : {})
        };

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
        
        // 添加思考过程配置
        if (this.chainOfThought) {
            requestBody.reasoning = {
                enabled: true,
                store: true
            };
        }

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 180000);
                
                const response = await fetch(`${API_CONFIG.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId); // 清理定时器

                if (!response.ok) {
                    // 获取详细错误信息
                    const errorData = await response.json().catch(() => ({ message: 'Failed to parse error response' }));
                    log.error(`API错误 (${response.status}):`, JSON.stringify(errorData));
                    throw { response: { status: response.status, data: errorData } };
                }

                return response;
            } catch (error) {
                if (!this.handleError(error, attempt, maxRetries)) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        throw new Error(`Request failed after ${maxRetries} retries`);
    }

    async stream(output: (content: string, done: boolean, thinking?: string) => void, text: string, store = true): Promise<void> {
        this.messages.push({ role: "user", content: text });
        try {
            const response = await this.makeRequest(true);
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader available');

            // 使用基类的流式处理方法
            const { content, thinking } = await this.handleStream(reader, output);

            // 最终输出和存储
            output(content, true, thinking);
            if (store) {
                const messageToStore: Message = { role: "assistant", content };
                if (thinking) {
                    messageToStore.thinking = thinking;
                }
                this.messages.push(messageToStore);
            }
        } catch (error: unknown) {
            if (error instanceof Error) {
                log.error('Stream failed:', error.message);
            } else {
                log.error('Stream failed with unknown error:', error);
            }
            throw error;
        }
    }

    async get(text: string, store = true): Promise<string> {
        this.messages.push({ role: "user", content: text });
        try {
            const response = await this.makeRequest(false);
            const data = await response.json() as OpenAIResponse;
            
            let content: string = '';
            let thinking: string | undefined;
            
            // 添加对API响应的有效性检查
            if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
                log.error('Invalid API response:', JSON.stringify(data));
                throw new Error('API返回的响应格式不正确或为空');
            }
            
            // 获取内容
            content = data.choices[0]?.message?.content || '';
            
            // 获取思考过程 - 使用正确的字段名
            if (this.chainOfThought) {
                const messageObj = data.choices[0]?.message as Record<string, any>;
                thinking = messageObj?.[this.thinkingParameter];
            }
            
            if (!content) {
                throw new Error('Invalid response format from API');
            }
            
            if (store) {
                const messageToStore: Message = { role: "assistant", content };
                if (thinking) {
                    messageToStore.thinking = thinking;
                }
                this.messages.push(messageToStore);
            }
            
            return content;
        } catch (error: unknown) {
            if (error instanceof Error) {
                log.error('Request failed:', error.message);
            } else {
                log.error('Request failed with unknown error:', error);
            }
            throw error;
        }
    }
}

// 测试代码：使用思考模式流式输出
// (new OpenRouter()).stream(
//     (content, done, thinking) => {
//         if (content) console.log('内容:', content);
//         if (thinking) console.log('思考过程:', thinking);
//         if (done) console.log('输出完成');
//     }, 
//     "求解方程 ln(x) = -x 的解，一步一步地思考，详细解释每一步的推导过程"
// );