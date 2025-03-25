import { html, md, SqliteStorage, TelegramClient } from "@mtcute/bun";
import { log } from './log';
import { Features } from './features';
import { Dispatcher } from "@mtcute/dispatcher";

export const enableChats = process.env.ENABLE_CHATS?.split(',').map(Number) || [];
export const managerIds = process.env.MANAGER_IDS?.split(',').map(Number) || [];

if (!managerIds.length) {
    throw new Error('请设置 MANAGER_IDS 环境变量');
}

const telegram = new TelegramClient({
    apiId: Number.parseInt(process.env.TG_API_ID || '4'),
    apiHash: process.env.TG_API_HASH || '',
    storage: new SqliteStorage('client.session')
});

const self = await telegram.start({
    botToken: process.env.TG_TOKEN
});

// 配置日志系统
log.setConfig({
    telegram: {
        client: telegram,
        managerId: managerIds[0]
    }
});

log.info(`Login in ${self.username} (${self.id})`, { remote: true });

// Dispatcher.for(telegram).onNewMessage(
//     async (ctx) => {
//         ctx.replyText(html`<blockquote collapsible><br></blockquote>`)
//     }
// )

// 初始化功能模块
// Features类负责设置事件处理器和命令处理
const features = new Features(telegram);
const initSuccess = await features.init();

// 将 features 实例添加到 client
if (initSuccess) {
    (telegram as any).features = features;
    log.info('功能模块已成功初始化并添加到客户端', { remote: true });
} else {
    log.error('功能模块初始化失败，程序可能无法正常工作', { remote: true });
    process.exit(1);
}

// 处理进程信号
process.on('SIGINT', async () => {
    log.info('接收到SIGINT信号，正在关闭...', { remote: true });
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log.info('接收到SIGTERM信号，正在关闭...', { remote: true });
    process.exit(0);
});

// 未捕获的异常处理
process.on('uncaughtException', (err) => {
    log.error(`未捕获的异常: ${err.message}`, { remote: true });
    log.error(err.stack || '无堆栈信息', { remote: true });
});

process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    log.error(`未处理的Promise拒绝: ${error.message}`, { remote: true });
    log.error(error.stack || '无堆栈信息', { remote: true });
});
