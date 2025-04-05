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
    highlight?: boolean;
}

export interface LogConfig {
    level: LogLevel;
    showTimestamp: boolean;
    showTrace: boolean;
    useColors: boolean;
    timeFormat: string;
    showIcons: boolean;
    remoteThrottleInterval?: number;
    prettyPrint?: boolean;
    indentSize?: number;
    showHostname?: boolean;
    simplifyRemoteMessages?: boolean;
    telegram?: {
        client: TelegramClient;
        managerId?: number;
    };
}

const Colors = {
    Reset: "\x1b[0m",
    Bright: "\x1b[1m",
    Dim: "\x1b[2m",
    Underscore: "\x1b[4m",
    Blink: "\x1b[5m",
    Reverse: "\x1b[7m",
    Hidden: "\x1b[8m",

    FgBlack: "\x1b[30m",
    FgRed: "\x1b[31m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgBlue: "\x1b[34m",
    FgMagenta: "\x1b[35m",
    FgCyan: "\x1b[36m",
    FgWhite: "\x1b[37m",
    FgGray: "\x1b[90m",

    BgBlack: "\x1b[40m",
    BgRed: "\x1b[41m",
    BgGreen: "\x1b[42m",
    BgYellow: "\x1b[43m",
    BgBlue: "\x1b[44m",
    BgMagenta: "\x1b[45m",
    BgCyan: "\x1b[46m",
    BgWhite: "\x1b[47m",
    BgGray: "\x1b[100m",

    FgWhiteBgRed: `\x1b[41m\x1b[37m\x1b[1m`,
    FgBlackBgYellow: `\x1b[43m\x1b[30m\x1b[1m`,
    FgBlackBgCyan: `\x1b[46m\x1b[30m\x1b[1m`,
    FgBlackBgGreen: `\x1b[42m\x1b[30m\x1b[1m`,
    FgWhiteBgBlue: `\x1b[44m\x1b[37m\x1b[1m`
} as const;

// Icons for different log levels
const LogIcons = {
    [LogLevel.DEBUG]: "🔍",
    [LogLevel.INFO]: "ℹ️",
    [LogLevel.WARN]: "⚠️",
    [LogLevel.ERROR]: "❌",
    [LogLevel.FATAL]: "☠️"
};

class Logger {
    private config: LogConfig = {
        level: LogLevel.INFO,
        showTimestamp: true,
        showTrace: false,
        useColors: true,
        showIcons: true,
        timeFormat: "YYYY-MM-DD HH:mm:ss",
        remoteThrottleInterval: 2000,
        prettyPrint: true,
        indentSize: 2,
        showHostname: false,
        simplifyRemoteMessages: true
    };

    private pluginName?: string;

    private lastMessage: { messageId?: number; text: string } | null = null;
    private hostname = Bun.env.HOSTNAME || "unknown";
    private lastTimestamp = 0;
    private cachedTimestamp = "";
    private lastRemoteSendTime = 0;
    private pendingRemoteMessage: string | null = null;
    private pendingRemoteTimer: ReturnType<typeof setTimeout> | null = null;

    private levelBgColors = {
        [LogLevel.DEBUG]: Colors.FgBlackBgCyan,
        [LogLevel.INFO]: Colors.FgBlackBgGreen,
        [LogLevel.WARN]: Colors.FgBlackBgYellow,
        [LogLevel.ERROR]: Colors.BgRed,
        [LogLevel.FATAL]: Colors.FgWhiteBgRed
    };

    constructor(config?: Partial<LogConfig>, pluginName?: string) {
        if (config) {
            this.config = { ...this.config, ...config };
        }
        this.pluginName = pluginName;
    }

    setConfig(config: Partial<LogConfig>) {
        this.config = { ...this.config, ...config };
    }

    forPlugin(pluginName: string): Logger {
        return new Logger(this.config, pluginName);
    }

    private formatSimplifiedMessage(level: LogLevel, message: any, args: any[], options?: LogOptions): string {
        const parts: string[] = [];
        const levelName = LogLevel[level];
        const icon = LogIcons[level];

        if (this.config.showTimestamp) {
            parts.push(`[${this.formatTimestamp()}]`);
        }

        parts.push(`[${icon} ${levelName}]`);

        if (this.pluginName) {
            parts.push(`[${this.pluginName}]`);
        }

        let simpleMessage = "";
        if (typeof message === 'string') {
            simpleMessage = message;
        } else if (message instanceof Error) {
            simpleMessage = `${message.name}: ${message.message}`;
        } else {
            try {
                simpleMessage = JSON.stringify(message, (key, value) => {
                    if (typeof value === 'object' && value !== null) {
                        if (Array.isArray(value) && value.length > 3) {
                            return [...value.slice(0, 3), `... (${value.length - 3} more items)`];
                        }
                    }
                    return value;
                }, 2);

                if (simpleMessage.length > 500) {
                    simpleMessage = simpleMessage.substring(0, 497) + "...";
                }
            } catch (e) {
                simpleMessage = String(message);
            }
        }
        parts.push(simpleMessage);

        if (options?.tags && options.tags.length > 0) {
            parts.push(options.tags.map(tag => `#${tag}`).join(' '));
        }

        if (options?.metadata && Object.keys(options.metadata).length > 0) {
            const metaKeys = Object.keys(options.metadata);
            if (metaKeys.length > 0) {
                const metaStr = metaKeys.map(k => {
                    const metadataValue = options.metadata?.[k];
                    const valueStr = typeof metadataValue === 'object' && metadataValue !== null
                        ? '(object)'
                        : String(metadataValue);
                    return `${k}: ${valueStr}`;
                }).join(', ');
                parts.push(`[${metaStr}]`);
            }
        }

        return parts.join(' ');
    }

    private async sendToTelegram(text: string, level: LogLevel, message: any, args: any[], options?: LogOptions) {
        if (!this.config.telegram?.client || !this.config.telegram.managerId) return;

        const now = Date.now();
        const throttleInterval = this.config.remoteThrottleInterval || 2000;

        let telegramText = text;
        if (this.config.simplifyRemoteMessages) {
            telegramText = this.formatSimplifiedMessage(level, message, args, options);
        } else {
            telegramText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        }

        if (now - this.lastRemoteSendTime < throttleInterval) {
            this.pendingRemoteMessage = telegramText;

            if (!this.pendingRemoteTimer) {
                const remainingTime = throttleInterval - (now - this.lastRemoteSendTime);
                this.pendingRemoteTimer = setTimeout(() => {
                    if (this.pendingRemoteMessage) {
                        const messageToSend = this.pendingRemoteMessage;
                        this.pendingRemoteMessage = null;
                        this.pendingRemoteTimer = null;
                        this.sendToTelegram(messageToSend, level, message, args, options);
                    }
                }, remainingTime);
            }
            return;
        }

        this.lastRemoteSendTime = now;
        this.pendingRemoteMessage = null;

        try {
            if (this.lastMessage && telegramText === this.lastMessage.text && this.lastMessage.messageId) {
                await this.config.telegram.client.sendText(
                    this.config.telegram.managerId,
                    telegramText,
                    { replyTo: this.lastMessage.messageId }
                );
            } else {
                const msg = await this.config.telegram.client.sendText(
                    this.config.telegram.managerId,
                    telegramText
                );
                this.lastMessage = {
                    messageId: msg.id,
                    text: telegramText
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

    private formatValue(value: any, indent = 0): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';

        if (typeof value === 'object') {
            if (value instanceof Error) {
                return this.formatError(value, indent);
            }

            if (Array.isArray(value)) {
                if (!this.config.prettyPrint) return JSON.stringify(value);

                if (value.length === 0) return '[]';

                const indentSize = this.config.indentSize || 2;
                const indentStr = ' '.repeat(indent + indentSize);
                const baseIndent = ' '.repeat(indent);

                return '[\n' +
                    value.map(item => `${indentStr}${this.formatValue(item, indent + indentSize)}`).join(',\n') +
                    '\n' + baseIndent + ']';
            }

            if (!this.config.prettyPrint) return JSON.stringify(value);

            if (Object.keys(value).length === 0) return '{}';

            const indentSize = this.config.indentSize || 2;
            const indentStr = ' '.repeat(indent + indentSize);
            const baseIndent = ' '.repeat(indent);

            return '{\n' +
                Object.entries(value)
                    .map(([key, val]) => `${indentStr}${key}: ${this.formatValue(val, indent + indentSize)}`)
                    .join(',\n') +
                '\n' + baseIndent + '}';
        }

        if (typeof value === 'string') return value;

        return String(value);
    }

    private formatError(err: Error, indent = 0): string {
        const indentStr = ' '.repeat(indent);
        const parts = [`${indentStr}${Colors.FgRed}${err.name}${Colors.Reset}: ${err.message}`];

        if (err.stack) {
            parts.push(`${indentStr}${Colors.FgGray}${err.stack.split('\n').slice(1).join('\n')}${Colors.Reset}`);
        }

        return parts.join('\n');
    }

    private formatMessage(level: LogLevel, message: any, args: any[], options?: LogOptions): string {
        const useColors = this.config.useColors;
        const levelName = LogLevel[level];
        const levelBgColor = this.levelBgColors[level];
        const icon = this.config.showIcons ? `${LogIcons[level]} ` : '';
        const indentStr = '  '; // Indentation for details

        // --- Header ---
        let header = '';

        // Timestamp
        if (this.config.showTimestamp) {
            const timestamp = this.formatTimestamp();
            header += useColors ? `${Colors.Dim}[${timestamp}]${Colors.Reset}` : `[${timestamp}]`;
        }

        // Level Indicator
        const levelIndicator = useColors
            ? `${levelBgColor} ${icon}${levelName.padEnd(5)} ${Colors.Reset}`
            : `[${icon}${levelName}]`;
        header += ` ${levelIndicator}`;

        // Source (Plugin/Hostname)
        const source = this.pluginName || (this.config.showHostname ? this.hostname : null);
        if (source) {
            header += useColors ? ` ${Colors.Dim}[${source}]${Colors.Reset}` : ` [${source}]`;
        }

        // --- Main Message ---
        let mainMessage = '';
        if (typeof message === 'string') {
            mainMessage = message;
        } else if (message instanceof Error) {
            // Handle errors specifically here, formatValue might be too generic now
            mainMessage = useColors
                ? `${Colors.FgRed}${message.name}${Colors.Reset}: ${message.message}`
                : `${message.name}: ${message.message}`;
        } else {
            // Use formatValue for other types, but without indentation initially
            mainMessage = this.formatValue(message, 0);
        }

        // Apply highlighting
        if (options?.highlight && useColors) {
            mainMessage = `${Colors.Bright}${mainMessage}${Colors.Reset}`;
        }

        // Append additional arguments to the main message
        if (args.length > 0) {
            // 特殊处理第一个参数是字符串，第二个参数是对象的情况（例如：log.error('Invalid API response:', JSON.stringify(data))）
            if (typeof message === 'string' && args.length === 1 && typeof args[0] === 'string') {
                // 检查这个字符串是否可能是JSON
                try {
                    const jsonObj = JSON.parse(args[0]);
                    if (typeof jsonObj === 'object' && jsonObj !== null) {
                        // 如果是JSON对象，使用格式化显示
                        const jsonStr = this.formatValue(jsonObj, this.config.prettyPrint ? indentStr.length : 0);
                        if (this.config.prettyPrint) {
                            mainMessage += `\n${indentStr}${jsonStr}`;
                        } else {
                            mainMessage += ` ${jsonStr}`;
                        }
                    } else {
                        // 不是对象，直接附加
                        mainMessage += ` ${args[0]}`;
                    }
                } catch (e) {
                    // 不是有效的JSON，直接附加
                    mainMessage += ` ${args[0]}`;
                }
            } else {
                // 其他情况使用原有逻辑
                const formattedArgs = args.map(arg => this.formatValue(arg, 0)).join(' ');
                mainMessage += ` ${formattedArgs}`;
            }
        }

        // --- Details (Tags, Metadata, Stack Trace) ---
        let details = '';

        // Tags
        if (options?.tags && options.tags.length > 0) {
            const formattedTags = options.tags.map(tag => useColors ? `${Colors.FgBlue}#${tag}${Colors.Reset}` : `#${tag}`).join(' ');
            details += ` ${formattedTags}`;
        }

        // Metadata
        if (options?.metadata && Object.keys(options.metadata).length > 0) {
            // Format metadata potentially on a new line if prettyPrint is enabled
            const metadataStr = this.formatValue(options.metadata, this.config.prettyPrint ? indentStr.length : 0);
            const prefix = this.config.prettyPrint ? `\n${indentStr}${Colors.Dim}↳ Metadata:${Colors.Reset} ` : ` ${Colors.Dim}`;
            const suffix = this.config.prettyPrint ? '' : Colors.Reset;
            details += useColors ? `${prefix}${metadataStr}${suffix}` : ` ${metadataStr}`;
        }

        // Error Stack Trace (if message was an Error and showTrace is enabled)
        if (message instanceof Error && this.config.showTrace && message.stack) {
            const stackLines = message.stack.split('\n').slice(1); // Skip the first line (error name/message)
            const formattedStack = stackLines.map(line => `${indentStr}${line.trim()}`).join('\n');
            details += useColors
                ? `\n${Colors.Dim}${indentStr}↳ Stack Trace:\n${formattedStack}${Colors.Reset}`
                : `\n${indentStr}↳ Stack Trace:\n${formattedStack}`;
        }
        // General Stack Trace (if configured and level is ERROR/FATAL, but message wasn't Error)
        else if (this.config.showTrace && (level === LogLevel.ERROR || level === LogLevel.FATAL)) {
            const stack = new Error().stack?.split('\n').slice(3).join('\n'); // slice(3) to skip log call itself
            if (stack) {
                const formattedStack = stack.split('\n').map(line => `${indentStr}${line.trim()}`).join('\n');
                details += useColors
                    ? `\n${Colors.Dim}${indentStr}↳ Stack Trace:\n${formattedStack}${Colors.Reset}`
                    : `\n${indentStr}↳ Stack Trace:\n${formattedStack}`;
            }
        }

        // Combine parts
        // Use a subtle separator ›
        const separator = useColors ? ` ${Colors.Dim}›${Colors.Reset} ` : ' › ';
        return `${header}${separator}${mainMessage}${details}`;
    }

    private log(level: LogLevel, message: any, ...args: any[]) {
        const options = args.length > 0 && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])
            ? args.pop() as LogOptions
            : undefined;

        if (level < this.config.level) return;

        const formattedMessage = this.formatMessage(level, message, args, options);

        // Output the formatted message
        // Keep the separator for high-severity logs, but maybe make it less intrusive
        if (level >= LogLevel.ERROR && this.config.useColors) {
            const separator = "─".repeat(process.stdout.columns || 80); // Use lighter line, adapt to terminal width
            console.log(`${Colors.Dim}${separator}${Colors.Reset}`); // Dim separator
            console.log(formattedMessage);
            console.log(`${Colors.Dim}${separator}${Colors.Reset}`); // Dim separator
        } else {
            console.log(formattedMessage);
        }

        if ((level >= LogLevel.ERROR || options?.remote) && this.config.telegram?.client) {
            this.sendToTelegram(formattedMessage, level, message, args, options);
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
