import { TelegramClient } from "@mtcute/bun";

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    FATAL = 4
}

export interface LogOptions {
    tags?: string[];
    metadata?: Record<string, any>;
    remote?: boolean;
}

export interface LogConfig {
    level: LogLevel;
    showTimestamp: boolean;
    showTrace: boolean;
    useColors: boolean;
    timeFormat: string;
    telegram?: {
        client: TelegramClient;
        managerId?: number;
    };
}

const Colors = {
    Reset: "\x1b[0m",
    FgCyan: "\x1b[36m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgRed: "\x1b[31m",
    FgWhiteBgRed: `\x1b[41m\x1b[37m\x1b[1m`,
    Bright: "\x1b[1m"
} as const;

class Logger {
    private config: LogConfig = {
        level: LogLevel.INFO,
        showTimestamp: true,
        showTrace: false,
        useColors: true,
        timeFormat: "YYYY-MM-DD HH:mm:ss"
    };

    private lastMessage: { messageId?: number; text: string } | null = null;
    private hostname = Bun.env.HOSTNAME || "unknown";
    private lastTimestamp = 0;
    private cachedTimestamp = "";

    private levelColors = {
        [LogLevel.DEBUG]: Colors.FgCyan,
        [LogLevel.INFO]: Colors.FgGreen,
        [LogLevel.WARN]: Colors.FgYellow,
        [LogLevel.ERROR]: Colors.FgRed,
        [LogLevel.FATAL]: Colors.FgWhiteBgRed
    };

    constructor(config?: Partial<LogConfig>) {
        if (config) {
            this.config = { ...this.config, ...config };
        }
    }

    setConfig(config: Partial<LogConfig>) {
        this.config = { ...this.config, ...config };
    }

    private async sendToTelegram(text: string) {
        if (!this.config.telegram?.client || !this.config.telegram.managerId) return;

        try {
            if (this.lastMessage && text === this.lastMessage.text && this.lastMessage.messageId) {
                // 如果消息相同，编辑上一条消息
                await this.config.telegram.client.sendText(
                    this.config.telegram.managerId,
                    text,
                    { replyTo: this.lastMessage.messageId }
                );
            } else {
                // 发送新消息
                const msg = await this.config.telegram.client.sendText(
                    this.config.telegram.managerId,
                    text
                );
                this.lastMessage = {
                    messageId: msg.id,
                    text
                };
            }
        } catch (err) {
            console.error('Failed to send log to Telegram:', err);
        }
    }

    private formatTimestamp() {
        const now = Date.now();
        if (now === this.lastTimestamp) return this.cachedTimestamp;

        this.lastTimestamp = now;
        const date = new Date(now);
        const pad = (n: number, len = 2) => String(n).padStart(len, "0");

        this.cachedTimestamp = this.config.timeFormat
            .replace("YYYY", date.getFullYear().toString())
            .replace("MM", pad(date.getMonth() + 1))
            .replace("DD", pad(date.getDate()))
            .replace("HH", pad(date.getHours()))
            .replace("mm", pad(date.getMinutes()))
            .replace("ss", pad(date.getSeconds()))
            .replace("SSS", pad(date.getMilliseconds(), 3));

        return this.cachedTimestamp;
    }

    private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
        const parts: string[] = [];

        if (this.config.showTimestamp) {
            parts.push(`[${this.formatTimestamp()}]`);
        }

        // 合并消息和参数
        const fullMessage = args.length > 0 ? `${message} ${args.join(' ')}` : message;
        parts.push(`[${LogLevel[level]}] ${fullMessage}`);

        return parts.join(" ");
    }

    private log(level: LogLevel, message: any, ...args: any[]) {
        const options = args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])
            ? args.pop() as LogOptions
            : undefined;

        if (level < this.config.level) return;

        const formattedMessage = this.formatMessage(level, String(message), ...args);
        console.log(formattedMessage);

        // 只在以下情况发送到 Telegram：
        // 1. 错误级别 (ERROR 或 FATAL)
        // 2. 手动指定 remote: true
        if ((level >= LogLevel.ERROR || options?.remote) && this.config.telegram?.client) {
            this.sendToTelegram(formattedMessage);
        }

        if (level === LogLevel.FATAL) {
            process.exit(1);
        }
    }

    debug(message: any, ...args: any[]) {
        this.log(LogLevel.DEBUG, message, ...args);
    }

    info(message: any, ...args: any[]) {
        this.log(LogLevel.INFO, message, ...args);
    }

    warn(message: any, ...args: any[]) {
        this.log(LogLevel.WARN, message, ...args);
    }

    error(message: any, ...args: any[]) {
        this.log(LogLevel.ERROR, message, ...args);
    }

    fatal(message: any, ...args: any[]) {
        this.log(LogLevel.FATAL, message, ...args);
    }
}

export const log = new Logger();