import BaseProvider from './BaseProvider';
import type { Message } from './BaseProvider';
import { log } from '../../log';
import { slowModeState } from './BaseProvider';
import { generateRandomUserAgent } from '../../utils/UserAgent';

// const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MODEL = 'o3-mini';

interface DuckResponse {
    action?: string;
    status?: number;
    type?: string;
    message?: string;
}

class DuckDuckGoError extends Error {
    constructor(message: string, public type?: string) {
        super(message);
        this.name = 'DuckDuckGoError';
    }
}

export default class DuckDuckGo extends BaseProvider {
    private vqd: string = '';
    private lastRequestTime = 0;

    constructor(messages: Message[] = [], model: string = DEFAULT_MODEL) {
        // 将 system 消息转换为 user 消息
        const processedMessages = messages.map(msg =>
            msg.role === "system" ? { ...msg, role: "user" as const } : msg
        );
        super(processedMessages, model || DEFAULT_MODEL);
    }

    private async sleep(): Promise<void> {
        const now = Date.now();
        if (this.lastRequestTime > 0) {
            const delay = Math.max(0, 750 - (now - this.lastRequestTime));
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        this.lastRequestTime = now;
    }

    private async fetchVqd(maxRetries = 3): Promise<string> {
        const headers = new Headers({
            "accept": "text/event-stream",
            "content-type": "application/json",
            "x-vqd-accept": "1",
            "User-Agent": generateRandomUserAgent()
        });

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await this.sleep();
                const response = await fetch("https://duckduckgo.com/duckchat/v1/status", { headers });

                if (!response.ok) {
                    throw new Error(`Failed to fetch VQD token: ${response.status} ${response.statusText}`);
                }

                const vqd = response.headers.get('x-vqd-4');
                if (vqd) {
                    this.vqd = vqd;
                    return vqd;
                }

                const responseText = await response.text();
                throw new Error(`Failed to fetch VQD token: ${response.status} ${responseText}`);
            } catch (error) {
                if (attempt < maxRetries - 1) {
                    const waitTime = Math.random() * 2000 + 1000 * (attempt + 1);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } else {
                    throw new Error(`Failed to fetch VQD token after ${maxRetries} attempts: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }

        throw new Error("Failed to fetch VQD token: Maximum retries exceeded");
    }

    private async requestCompletion(maxRetries = 3): Promise<Response> {
        if (!this.vqd) {
            await this.fetchVqd();
        }

        await this.sleep();
        await DuckDuckGo.delayIfSlowMode();

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const headers = new Headers({
                    "accept": "text/event-stream",
                    "content-type": "application/json",
                    "x-vqd-4": this.vqd,
                    "User-Agent": generateRandomUserAgent()
                });

                const response = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: this.model,
                        messages: this.messages,
                    })
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        const errorData = await response.json() as DuckResponse;
                        if (errorData.type === "ERR_CONVERSATION_LIMIT") {
                            throw new DuckDuckGoError("Conversation limit reached", errorData.type);
                        }
                        log.warn(`Rate limit hit. Attempt ${attempt + 1} of ${maxRetries}. Enabling slow mode.`);
                        slowModeState.isSlowMode = true;
                        slowModeState.slowModeStart = Date.now();
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }
                    if (response.status === 418) {
                        log.warn('DuckDuckGo API temporarily unavailable. Retrying...');
                        await new Promise(resolve => setTimeout(resolve, 10000));
                        continue;
                    }
                    const errorData = await response.text().catch(() => 'Failed to read error response');
                    throw new Error(`Request failed: ${response.status} ${response.statusText} - ${errorData}`);
                }

                // 更新VQD
                const newVqd = response.headers.get('x-vqd-4');
                if (newVqd) {
                    this.vqd = newVqd;
                }

                return response;
            } catch (error) {
                if (error instanceof DuckDuckGoError) {
                    throw error;
                }
                if (attempt === maxRetries - 1) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
        throw new Error(`Request failed after ${maxRetries} retries.`);
    }

    async stream(output: (content: string, done: boolean) => void, text: string, store = true): Promise<void> {
        this.messages.push({ role: "user", content: text });

        try {
            const response = await this.requestCompletion();
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
                    const data = event.split("data: ")[1];
                    if (!data || data === "[DONE]") continue;
                    try {
                        const parsed = JSON.parse(data) as DuckResponse;
                        if (parsed.action === 'error') {
                            throw new DuckDuckGoError(parsed.type || 'Unknown error', parsed.type);
                        }
                        if (parsed.message) {
                            content += parsed.message;
                            output(content, false);
                        }
                    } catch (error) {
                        if (error instanceof DuckDuckGoError) {
                            throw error;
                        }
                        continue;
                    }
                }
            }

            if (buffer) {
                const events = buffer.split("\n\n");
                for (const event of events) {
                    const data = event.split("data: ")[1];
                    if (!data || data === "[DONE]") continue;
                    try {
                        const parsed = JSON.parse(data) as DuckResponse;
                        if (parsed.message) {
                            content += parsed.message;
                        }
                    } catch (error) {
                        if (error instanceof Error) {
                            log.error('Parsing error:', error.message);
                        }
                    }
                }
            }

            output(content, true);
            if (store) {
                this.messages.push({ role: "assistant", content });
            }
        } catch (error: unknown) {
            if (error instanceof Error) {
                log.error('Stream failed:', error.message);
            }
            throw error;
        }
    }

    async get(text: string, store = true): Promise<string> {
        return new Promise((resolve, reject) => {
            this.stream((content: string, done: boolean) => {
                if (done) resolve(content);
            }, text, store).catch(reject);
        });
    }
}

(new DuckDuckGo).stream((content, done) => console.log(content), "早上好");