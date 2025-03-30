import { md } from '@mtcute/bun';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext, PluginEvent } from '../features';
import { log } from '../log';

const plugin: BotPlugin = {
    name: 'hole',
    description: '树洞',
    version: '1.0.0',

    // 命令处理
    commands: [
        {
            name: 'hole',
            description: '树洞',
            cooldown: 10,
            async handler(ctx: CommandContext) {
                const text = md(await getTextFromAPI());
                await ctx.message.replyText(text);
            }
        }
    ],

    events: [
        {
            type: 'message',
            filter: (ctx: EventContext) => {
                return Math.random() <= 0.002;
            },
            handler: async (ctx: MessageEventContext) => {
                const text = md(await getTextFromAPI());
                await ctx.message.answerText(text);
            }
        } as PluginEvent<MessageEventContext>
    ]
};

interface HitokotoResponse {
    hitokoto: string;
    from: string;
    from_who?: string;
}

export function getTextFromAPI(retry = 3): Promise<string> {
    return fetch("https://v1.hitokoto.cn/")
        .then(rep => rep.json())
        .then((data) => {
            const response = data as HitokotoResponse;
            const { hitokoto, from, from_who } = response;
            const by = (`—— ${from_who || ''}「${!!from ? from : "无名氏"}」`);
            return `<b>${hitokoto}</b><br>${repeat(' ', (Math.min(16, hitokoto.length) - by.length + 2) * 3)}${by}`;
        })
        .catch((e) => {
            if (retry) return getTextFromAPI(--retry);
            log.error(e);
            throw e;
        })
}

// https://www.jianshu.com/p/7a9f8c1e2167
function repeat(target: string, n: number) {
    var s = target, total = "";
    while (n > 0) {
        if (n % 2 == 1) {
            total += s;
        }
        if (n == 1) {
            break;
        }
        s += s;
        n = n >> 1;//相当于将n除以2取其商，或者说是开2次方
    }
    return total;
}

export default plugin;