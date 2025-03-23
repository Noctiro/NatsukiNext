import { log } from "../../log";

export interface Message {
    role: "user" | "assistant" | "system";
    content: string;
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
    };
}

export const slowModeState: { isSlowMode: boolean; slowModeStart: number | null } = { isSlowMode: false, slowModeStart: null };

export default class BaseProvider {
    protected messages: Message[];
    protected model: string;
    protected apiKey?: string;

    constructor(messages: Message[] = [], model: string = '') {
        this.messages = messages;
        this.model = model;
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

    protected processStreamChunk(chunk: string, content: string, output: (content: string, isFinal: boolean) => void): string {
        const data = chunk.split("data: ")[1] || '';
        if (data === "[DONE]") return content;
        try {
            const parsed = JSON.parse(data);
            if (parsed.choices[0].delta?.content) {
                content += parsed.choices[0].delta.content;
                output(content, false);
            }
        } catch { }
        return content;
    }

    protected validateApiKey(): void {
        if (!this.apiKey) {
            throw new Error('API key is not configured');
        }
    }
}