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
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0
    }
};

interface OpenAIResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
}

export default class OpenRouter extends BaseProvider {
    constructor(messages: Message[] = [], model: string = API_CONFIG.defaultModel) {
        super(messages, model);
        this.apiKey = process.env.AI_OPENROUTER_API_KEY;
    }

    private async makeRequest(streaming = false, maxRetries = 3): Promise<Response> {
        this.validateApiKey();
        await OpenRouter.delayIfSlowMode();

        const headers = {
            ...API_CONFIG.headers,
            'Authorization': `Bearer ${this.apiKey}`,
            ...(streaming ? { 'Accept': 'text/event-stream' } : {})
        };

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(`${API_CONFIG.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        ...API_CONFIG.params,
                        model: this.model,
                        messages: this.messages,
                        stream: streaming
                    }),
                    signal: AbortSignal.timeout(60000)
                });

                if (!response.ok) {
                    throw { response: { status: response.status, data: await response.json() } };
                }

                return response;
            } catch (error) {
                if (!this.handleError(error, attempt, maxRetries)) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        throw new Error(`Request failed after ${maxRetries} retries`);
    }

    async stream(output: (content: string, done: boolean) => void, text: string, store = true): Promise<void> {
        this.messages.push({ role: "user", content: text });
        try {
            const response = await this.makeRequest(true);
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No reader available');

            let content = '';
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split("\n\n");
                buffer = events.pop() || '';

                for (const event of events) {
                    content = this.processStreamChunk(event, content, output);
                }
            }

            if (buffer) {
                for (const event of buffer.split("\n\n")) {
                    content = this.processStreamChunk(event, content, output);
                }
            }

            output(content, true);
            if (store) this.messages.push({ role: "assistant", content });
        } catch (error: unknown) {
            if (error instanceof Error) {
                log.error('Stream failed:', error.message);
            }
            throw error;
        }
    }

    async get(text: string, store = true): Promise<string> {
        this.messages.push({ role: "user", content: text });
        try {
            const response = await this.makeRequest(false);
            const data = await response.json() as OpenAIResponse;
            const content = data.choices[0]?.message?.content;
            if (!content) {
                throw new Error('Invalid response format from API');
            }
            if (store) this.messages.push({ role: "assistant", content });
            return content;
        } catch (error: unknown) {
            if (error instanceof Error) {
                log.error('Request failed:', error.message);
            }
            throw error;
        }
    }
}

// (new OpenRouter).stream((content, done) => console.log(content), "早上好");