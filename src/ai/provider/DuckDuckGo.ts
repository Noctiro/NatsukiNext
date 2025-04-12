import BaseProvider from './BaseProvider';
import type { Message } from './BaseProvider';
import { log } from '../../log';
import { slowModeState } from './BaseProvider';
import { generateRandomUserAgent } from '../../utils/UserAgent';

// 默认模型配置
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
    private vqdHash1: string = '';
    private initialized: boolean = false;
    private feVersion: string = '';
    private cookieInitialized: boolean = false;
    private baseDelay: number = 2;

    // 类静态变量，存储跨实例的x-fe-version
    private static chatXFE: string = '';

    /**
     * 构造函数
     * @param messages 消息列表
     * @param model 模型名称
     */
    constructor(messages: Message[] = [], model: string = DEFAULT_MODEL) {
        // 将 system 消息转换为 user 消息
        const processedMessages = messages.map(msg =>
            msg.role === "system" ? { ...msg, role: "user" as const } : msg
        );
        super(processedMessages, model || DEFAULT_MODEL);
    }

    /**
     * 在请求之间添加延迟以避免速率限制
     * @param multiplier 延迟乘数
     */
    private async sleep(multiplier = 1.0): Promise<void> {
        const now = Date.now();
        if (this.lastRequestTime > 0) {
            const delay = Math.max(0, 1500 - (now - this.lastRequestTime)) * multiplier;
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * 获取默认Cookie
     * @returns Cookie对象
     */
    private async getDefaultCookies(): Promise<Record<string, string>> {
        if (this.cookieInitialized) {
            return {};
        }

        try {
            await this.sleep();

            // 创建默认Cookie
            const cookies: Record<string, string> = {
                'dcs': '1',
                'dcm': '3'
            };

            this.cookieInitialized = true;
            return cookies;
        } catch (e) {
            log.error('获取默认Cookie失败:', e instanceof Error ? e.message : String(e));
            return {};
        }
    }

    /**
     * 获取前端版本信息
     * @returns fe-version值
     */
    private async fetchFeVersion(): Promise<string> {
        // 如果已有静态版本信息，直接返回
        if (DuckDuckGo.chatXFE) {
            return DuckDuckGo.chatXFE;
        }

        try {
            const url = "https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat&duckai=1";
            await this.sleep();

            const userAgent = generateRandomUserAgent();
            const response = await fetch(url, {
                headers: {
                    "User-Agent": userAgent
                }
            });

            if (!response.ok) {
                log.warn(`获取前端版本失败: ${response.status} ${response.statusText}`);
                return "";
            }

            const content = await response.text();

            // 提取x-fe-version组件
            try {
                const xfe1Match = content.match(/__DDG_BE_VERSION__="([^"]+)"/);
                const xfe2Match = content.match(/__DDG_FE_CHAT_HASH__="([^"]+)"/);

                if (xfe1Match && xfe2Match) {
                    DuckDuckGo.chatXFE = `${xfe1Match[1]}-${xfe2Match[1]}`;
                    this.feVersion = DuckDuckGo.chatXFE;
                    return DuckDuckGo.chatXFE;
                }
            } catch (e) {
                log.error('提取前端版本信息失败:', e instanceof Error ? e.message : String(e));
            }

            return "";
        } catch (e) {
            log.error('获取前端版本失败:', e instanceof Error ? e.message : String(e));
            return "";
        }
    }

    /**
     * 获取VQD令牌
     * @param maxRetries 最大重试次数
     * @param retryCount 当前重试次数
     * @returns VQD令牌和hash
     */
    private async fetchVqd(maxRetries = 3, retryCount = 0, isRetry = false): Promise<[string, string]> {
        // 如果是重试请求，增加延迟
        if (isRetry) {
            await this.sleep(1.0 + retryCount * 0.5);
        } else {
            await this.sleep();
        }

        const userAgent = generateRandomUserAgent();
        const headers = {
            "accept": "text/event-stream",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "pragma": "no-cache",
            "x-vqd-accept": "1",
            "origin": "https://duckduckgo.com",
            "referer": "https://duckduckgo.com/",
            "User-Agent": userAgent,
            "sec-ch-ua": '"Chromium";v="133", "Not_A Brand";v="8"'
        };

        try {
            log.info(`正在获取VQD令牌，尝试 ${retryCount + 1}/${maxRetries}`);

            // 确保有Cookie
            if (!this.cookieInitialized) {
                await this.getDefaultCookies();
            }

            const response = await fetch("https://duckduckgo.com/duckchat/v1/status", {
                headers: new Headers(headers),
                method: 'GET'
            });

            if (!response.ok) {
                const responseText = await response.text();
                log.warn(`获取VQD令牌失败: ${response.status} ${response.statusText} - ${responseText}`);

                if (retryCount < maxRetries - 1) {
                    const waitTime = this.baseDelay * (2 ** retryCount) * (1 + Math.random());
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    return this.fetchVqd(maxRetries, retryCount + 1, true);
                }

                throw new Error(`获取VQD令牌失败: ${response.status} ${responseText}`);
            }

            const vqd = response.headers.get('x-vqd-4');
            const vqdHash1 = response.headers.get('x-vqd-hash-1') || '';

            if (vqd) {
                log.info(`成功获取VQD令牌: ${vqd.substring(0, 10)}...`);
                this.vqd = vqd;
                this.vqdHash1 = vqdHash1;
                this.initialized = true;
                return [vqd, vqdHash1];
            }

            log.warn('响应中没有VQD令牌');
            const responseText = await response.text();
            throw new Error(`获取VQD令牌失败: ${response.status} ${responseText}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.warn(`获取VQD令牌错误 (${retryCount + 1}/${maxRetries}): ${errorMessage}`);

            if (retryCount < maxRetries - 1) {
                const waitTime = this.baseDelay * (2 ** retryCount) * (1 + Math.random());
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.fetchVqd(maxRetries, retryCount + 1, true);
            } else {
                throw new Error(`获取VQD令牌失败，已尝试 ${maxRetries} 次: ${errorMessage}`);
            }
        }
    }

    /**
     * 确保实例已初始化
     */
    private async ensureInitialized(): Promise<void> {
        // 确保有fe-version
        if (!this.feVersion && !DuckDuckGo.chatXFE) {
            this.feVersion = await this.fetchFeVersion();
        }

        // 确保有VQD
        if (!this.initialized || !this.vqd) {
            const [vqd, vqdHash1] = await this.fetchVqd();
            this.vqd = vqd;
            this.vqdHash1 = vqdHash1;
            this.initialized = true;
        }

        // 确保有Cookie
        if (!this.cookieInitialized) {
            await this.getDefaultCookies();
        }
    }

    /**
     * 发送聊天请求
     * @param maxRetries 最大重试次数
     * @returns HTTP响应
     */
    private async requestCompletion(maxRetries = 3): Promise<Response> {
        await this.ensureInitialized();
        await this.sleep();
        await DuckDuckGo.delayIfSlowMode();

        let retryCount = 0;
        while (retryCount < maxRetries) {
            try {
                const userAgent = generateRandomUserAgent();
                const headers: Record<string, string> = {
                    "accept": "text/event-stream",
                    "accept-language": "en-US,en;q=0.9",
                    "cache-control": "no-cache",
                    "content-type": "application/json",
                    "pragma": "no-cache",
                    "x-vqd-4": this.vqd,
                    "x-vqd-hash-1": "", // 初始请求发送空字符串
                    "origin": "https://duckduckgo.com",
                    "referer": "https://duckduckgo.com/",
                    "User-Agent": userAgent,
                    "sec-ch-ua": '"Chromium";v="133", "Not_A Brand";v="8"',
                };

                // 添加fe-version
                if (this.feVersion || DuckDuckGo.chatXFE) {
                    headers["x-fe-version"] = this.feVersion || DuckDuckGo.chatXFE;
                }

                const response = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
                    method: 'POST',
                    headers: new Headers(headers),
                    body: JSON.stringify({
                        model: this.model,
                        messages: this.messages,
                    })
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        const errorData = await response.json() as DuckResponse;
                        if (errorData.type === "ERR_CONVERSATION_LIMIT") {
                            throw new DuckDuckGoError("会话限制已达到", errorData.type);
                        }

                        log.warn(`速率限制命中。尝试 ${retryCount + 1} / ${maxRetries}。启用慢速模式。`);
                        slowModeState.isSlowMode = true;
                        slowModeState.slowModeStart = Date.now();

                        retryCount++;
                        const waitTime = this.baseDelay * (2 ** retryCount) * (1 + Math.random());
                        await new Promise(resolve => setTimeout(resolve, waitTime));

                        // 刷新Cookie和VQD
                        this.cookieInitialized = false;
                        await this.getDefaultCookies();
                        continue;
                    }

                    if (response.status === 400) {
                        try {
                            const errorData = await response.json() as DuckResponse;
                            if (errorData.type === "ERR_INVALID_VQD") {
                                log.warn("VQD令牌无效，重新获取");
                                this.initialized = false;
                                const [vqd, vqdHash1] = await this.fetchVqd(3, 0, true);
                                this.vqd = vqd;
                                this.vqdHash1 = vqdHash1;
                                continue;
                            }
                        } catch (parseError) {
                            // 解析错误，继续使用默认错误处理
                        }
                    }

                    if (response.status === 418) {
                        log.warn('DuckDuckGo API暂时不可用。重试中...');
                        retryCount++;
                        await new Promise(resolve => setTimeout(resolve, 10000));
                        continue;
                    }

                    const errorText = await response.text().catch(() => '无法读取错误响应');
                    throw new Error(`请求失败: ${response.status} ${response.statusText} - ${errorText}`);
                }

                // 更新VQD和VQD HASH
                const newVqd = response.headers.get('x-vqd-4');
                if (newVqd) {
                    this.vqd = newVqd;
                }

                const newVqdHash1 = response.headers.get('x-vqd-hash-1');
                if (newVqdHash1) {
                    this.vqdHash1 = newVqdHash1;
                }

                return response;
            } catch (error) {
                if (error instanceof DuckDuckGoError) {
                    throw error;
                }

                retryCount++;
                if (retryCount >= maxRetries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
        throw new Error(`请求失败，已达到最大重试次数 ${maxRetries}`);
    }

    /**
     * 流式处理响应
     * @param output 输出回调函数
     * @param text 输入文本
     * @param store 是否存储消息
     */
    async stream(output: (content: string, done: boolean) => void, text: string, store = true): Promise<void> {
        this.messages.push({ role: "user", content: text });

        try {
            const response = await this.requestCompletion();
            const reader = response.body?.getReader();
            if (!reader) throw new Error('无可用的响应流读取器');

            let content = '';
            const decoder = new TextDecoder();
            let buffer = '';
            let reason = null;

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
                            // 处理特定错误类型
                            if (parsed.status === 429) {
                                if (parsed.type === "ERR_CONVERSATION_LIMIT") {
                                    throw new DuckDuckGoError("会话限制已达到", parsed.type);
                                }
                                throw new DuckDuckGoError("速率限制", parsed.type);
                            }
                            throw new DuckDuckGoError(parsed.type || '未知错误', parsed.type);
                        }
                        if (parsed.message) {
                            if (parsed.message) {
                                content += parsed.message;
                                output(content, false);
                                reason = "length";
                            } else {
                                reason = "stop";
                            }
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
                            log.error('解析错误:', error.message);
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
                log.error('流处理失败:', error.message);
            }
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
        return new Promise((resolve, reject) => {
            this.stream((content: string, done: boolean) => {
                if (done) resolve(content);
            }, text, store).catch(reject);
        });
    }
}

// (new DuckDuckGo).stream((content, done) => console.log(content), "早上好");