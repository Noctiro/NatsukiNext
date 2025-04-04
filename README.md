# NatsukiMiyu Next

多功能的第三代 NatsukiMiyu 机器人

## 快速开始

### 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/NatsukiMiyu-Next.git
cd NatsukiMiyu-Next

# 安装依赖
bun install
```

### 环境变量

```env
TZ=Asia/Shanghai

TG_API_ID=xxxxx
TG_API_HASH=xxxxx
TG_TOKEN=xxxxx

MANAGER_IDS=1111,22222
ENABLE_CHATS=-33333
AI_OPENROUTER_API_KEY=sk-or-v1-xxx,sk-or-v1-xxxxx
```

### 运行

```bash
bun start
```

## 基础命令

- `/help` - 显示命令列表
- `/plugins` - 查看已加载插件
- `/plugin <name>` - 查看插件详情
- `/admin` - 管理员面板

## 插件开发详解

### 基本结构

```typescript
import type { BotPlugin } from "../features";

const plugin: BotPlugin = {
  // 基础信息
  name: "example", // 必需，唯一标识符
  description: "示例插件", // 可选，插件描述
  version: "1.0.0", // 可选，版本号

  // 依赖关系
  dependencies: ["system"], // 可选，依赖的其他插件

  // 权限声明
  permissions: [
    // 可选，插件定义的权限
    {
      name: "example.use",
      description: "使用插件基本功能",
      parent: "basic", // 可选，继承自父权限
    },
  ],

  // 生命周期钩子
  async onLoad(client) {
    // 可选，插件加载时调用
    const config = await client.features.getPluginConfig("example");
    // 初始化资源、设置事件监听等
  },

  async onUnload() {
    // 可选，插件卸载时调用
    // 清理资源、取消事件监听等
  },

  // 命令定义
  commands: [
    {
      name: "example", // 命令名称（不含/）
      description: "示例命令", // 命令描述
      aliases: ["ex", "eg"], // 命令别名
      cooldown: 5, // 冷却时间（秒）
      requiredPermission: "example.use", // 所需权限
      async handler(ctx) {
        await ctx.message.replyText("命令已执行");
      },
    },
  ],

  // 事件处理
  events: [
    {
      type: "message", // 事件类型
      filter: (ctx) => ctx.message.text?.includes("关键词"), // 过滤条件
      priority: 10, // 优先级，数值越大越先处理
      async handler(ctx) {
        await ctx.message.replyText("检测到关键词");
      },
    },
  ],
};

export default plugin;
```

### 命令处理

#### 基础命令定义

```typescript
commands: [
  {
    name: "greet", // 命令名称
    description: "向用户打招呼", // 命令描述（在帮助中显示）
    aliases: ["hi", "hello"], // 命令别名
    cooldown: 10, // 冷却时间（秒）
    requiredPermission: "basic.chat", // 执行所需权限
    async handler(ctx) {
      const username = ctx.message.sender.displayName;
      await ctx.message.replyText(`你好，${username}！`);
    },
  },
];
```

#### 命令参数解析

```typescript
{
  name: "echo",
  description: "复读消息",
  async handler(ctx) {
    // ctx.content - 完整参数字符串
    // ctx.args - 参数数组
    // ctx.rawText - 原始消息文本

    if (!ctx.content) {
      await ctx.message.replyText("请输入要复读的内容");
      return;
    }

    await ctx.message.replyText(`你说：${ctx.content}`);
  }
}
```

#### 命令冷却与权限检查

冷却和权限检查自动实现，无需手动编写。当用户触发命令时：

1. 框架检查用户是否有命令要求的权限
2. 检查用户是否在冷却时间内
3. 通过检查后，执行命令处理程序

### 事件系统

#### 支持的事件类型

```typescript
// 消息事件
{
  type: "message",
  async handler(ctx: MessageEventContext) {
    // 处理新消息
  }
}

// 回调查询事件（按钮点击）
{
  type: "callback",
  name: "action",  // 匹配回调数据中的功能名
  async handler(ctx: CallbackEventContext) {
    // 处理按钮点击
  }
}

// 内联查询事件
{
  type: "inline",
  async handler(ctx: InlineEventContext) {
    // 处理内联查询
  }
}

// 用户加入聊天事件
{
  type: "chat_join",
  async handler(ctx: ChatJoinEventContext) {
    // 处理用户加入
  }
}

// 用户离开聊天事件
{
  type: "chat_leave",
  async handler(ctx: ChatLeaveEventContext) {
    // 处理用户离开
  }
}
```

#### 事件过滤器

```typescript
// 仅处理特定用户的消息
{
  type: "message",
  filter: ctx => ctx.message.sender.id === 123456789,
  async handler(ctx) {
    await ctx.message.replyText("收到您的消息");
  }
}

// 仅处理包含特定关键词的消息
{
  type: "message",
  filter: ctx => {
    const text = ctx.message.text;
    return text ? /关键词/.test(text) : false;
  },
  async handler(ctx) {
    await ctx.message.replyText("检测到关键词");
  }
}

// 仅处理群组中的消息
{
  type: "message",
  filter: ctx => ctx.message.chat.type !== "private",
  async handler(ctx) {
    await ctx.message.replyText("收到群组消息");
  }
}
```

#### 事件优先级

```typescript
// 高优先级事件处理器（先执行）
{
  type: "message",
  priority: 100,
  async handler(ctx) {
    // 先执行的逻辑
  }
}

// 低优先级事件处理器（后执行）
{
  type: "message",
  priority: 10,
  async handler(ctx) {
    // 后执行的逻辑
  }
}
```

### 配置管理

#### 读取与保存配置

```typescript
// 定义配置类型
interface MyPluginConfig {
  enabled: boolean;
  defaultValue: string;
  options: string[];
}

// 默认配置
const defaultConfig: MyPluginConfig = {
  enabled: true,
  defaultValue: "default",
  options: ["option1", "option2"]
};

// 在onLoad中读取配置
async onLoad(client) {
  // 读取配置，自动合并默认值
  const config = await client.features.getPluginConfig<MyPluginConfig>(
    "my-plugin",
    defaultConfig
  );

  // 使用配置
  if (config.enabled) {
    this.logger?.info(`插件已启用，默认值: ${config.defaultValue}`);
  }

  // 修改配置
  config.options.push("option3");

  // 保存配置
  await client.features.savePluginConfig("my-plugin", config);
}
```

### 权限管理

#### 声明权限

```typescript
permissions: [
  {
    name: "myplugin.basic", // 基础权限
    description: "基本插件使用权",
  },
  {
    name: "myplugin.admin", // 管理权限
    description: "管理插件设置",
    parent: "myplugin.basic", // 继承基础权限
  },
  {
    name: "myplugin.super", // 超级权限
    description: "高级功能使用权",
    parent: "admin", // 继承系统admin权限
  },
];
```

#### 检查权限

```typescript
// 在命令或事件处理器中检查权限
async handler(ctx) {
  // 检查用户是否有特定权限
  if (!ctx.hasPermission("myplugin.admin")) {
    await ctx.message.replyText("您没有权限执行此操作");
    return;
  }

  // 执行需要权限的操作
  await ctx.message.replyText("管理操作已执行");
}
```

### 日志系统

#### 基础日志

```typescript
// 基础日志级别
this.logger?.debug("调试信息"); // 调试级别
this.logger?.info("一般信息"); // 信息级别
this.logger?.warn("警告信息"); // 警告级别
this.logger?.error("错误信息"); // 错误级别

// 带上下文的日志
this.logger?.info("处理请求", {
  user: userId,
  action: "login",
});
```

#### 高级日志功能

```typescript
// 发送日志到管理员
this.logger?.error("严重错误", {
  remote: true, // 发送给管理员
  tags: ["api", "error"], // 标签分类
  metadata: {
    // 详细元数据
    status: 500,
    endpoint: "/api/data",
    response: "服务器错误",
  },
});

// 带错误堆栈的日志
try {
  throw new Error("API错误");
} catch (error) {
  this.logger?.error("请求失败", { error });
}
```

### 回调数据处理

#### 创建回调按钮

```typescript
import { CallbackDataBuilder } from "../../utils/callback";

// 创建回调数据构建器
const VoteCallback = new CallbackDataBuilder<{
  postId: number;
  action: string; // "up" 或 "down"
  userId: number;
}>("vote", "action", ["postId", "action", "userId"]);

// 创建投票按钮
const createVoteButtons = (postId: number, userId: number) => {
  return [
    BotKeyboard.callback(
      "👍 赞同",
      VoteCallback.build({
        postId,
        action: "up",
        userId,
      })
    ),
    BotKeyboard.callback(
      "👎 反对",
      VoteCallback.build({
        postId,
        action: "down",
        userId,
      })
    ),
  ];
};

// 在插件中使用
events: [
  {
    type: "callback",
    name: "action", // 匹配 'vote:action:*:*:*' 格式的数据
    async handler(ctx) {
      // 从ctx.match中获取解析后的数据
      const { postId, action, userId } = ctx.match;

      // 检查当前用户是否为原始用户
      if (ctx.query.user.id !== userId) {
        await ctx.query.answer({
          text: "这不是您的投票按钮",
          alert: true,
        });
        return;
      }

      // 处理投票
      if (action === "up") {
        await processUpvote(postId);
        await ctx.query.answer({ text: "已赞同" });
      } else if (action === "down") {
        await processDownvote(postId);
        await ctx.query.answer({ text: "已反对" });
      }
    },
  },
];
```

### 消息编辑与交互式 UI

#### 发送和编辑消息

```typescript
// 发送纯文本消息
await ctx.message.replyText("Hello World");

// 发送HTML格式消息
await ctx.message.replyText(html`
  <b>粗体文字</b>
  <i>斜体文字</i>
  <code>代码</code>
  <a href="https://example.com">链接</a>
`);

// 发送带引用的消息
await ctx.message.replyText("引用回复", {
  replyToMessageId: ctx.message.id,
});

// 编辑消息
await ctx.client.editMessage({
  chatId: ctx.chatId,
  message: messageId,
  text: "新的消息内容",
});
```

#### 发送媒体文件

```typescript
// 发送图片
await ctx.message.replyMedia(
  {
    type: "photo",
    file: "./assets/image.jpg", // 本地文件路径
    fileName: "image.jpg",
  },
  {
    caption: "图片描述", // 可选的图片说明
  }
);

// 发送文件
await ctx.message.replyMedia(
  {
    type: "document",
    file: Buffer.from("文件内容"), // 内存中的文件数据
    fileName: "document.txt",
  },
  {
    caption: "文件描述",
  }
);

// 发送视频
await ctx.message.replyMedia({
  type: "video",
  file: "https://example.com/video.mp4", // 远程URL
  fileName: "video.mp4",
});
```

### 用户和聊天操作

#### 用户信息获取

```typescript
// 获取用户信息
const user = await ctx.client.getUser("username"); // 通过用户名
const userById = await ctx.client.getUserById(123456789); // 通过ID

// 在事件处理中直接获取
const senderId = ctx.message.sender.id;
const senderName = ctx.message.sender.displayName;
const username = ctx.message.sender.username;
```

#### 聊天管理

```typescript
// 获取聊天信息
const chat = await ctx.client.getChat(chatId);

// 发送聊天操作
await ctx.client.sendChatAction(ctx.chatId, "typing"); // 显示"正在输入"

// 获取聊天成员
const chatMember = await ctx.client.getChatMember(ctx.chatId, userId);

// 踢出用户
await ctx.client.kickChatMember(ctx.chatId, userId);

// 限制用户权限
await ctx.client.restrictChatMember(ctx.chatId, userId, {
  untilDate: Math.floor(Date.now() / 1000) + 3600, // 1小时
  permissions: {
    canSendMessages: false,
  },
});
```

### 插件间通信

#### 直接调用其他插件的方法

```typescript
// 在onLoad中获取其他插件
async onLoad(client) {
  // 获取其他插件实例
  const otherPlugin = client.features.getPlugin("other-plugin");

  if (otherPlugin && typeof otherPlugin.publicMethod === "function") {
    // 调用其他插件的方法
    const result = await otherPlugin.publicMethod("param");
    this.logger?.info(`调用结果: ${result}`);
  }
}

// 公开方法以供其他插件调用
publicMethod(param: string): string {
  return `处理了参数: ${param}`;
}
```

#### 使用事件进行解耦通信

```typescript
// 插件A: 发布事件
client.features.dispatcher.emit("custom:data-updated", {
  source: "plugin-a",
  data: { key: "value" }
});

// 插件B: 监听事件
async onLoad(client) {
  client.features.dispatcher.on("custom:data-updated", (data) => {
    this.logger?.info(`收到数据更新: ${JSON.stringify(data)}`);
  });
}
```

### 完整插件示例：投票系统

```typescript
import type {
  BotPlugin,
  CommandContext,
  CallbackEventContext,
} from "../features";
import { html, BotKeyboard } from "@mtcute/bun";
import { CallbackDataBuilder } from "../utils/callback";

// 定义投票回调构建器
const VoteCallback = new CallbackDataBuilder<{
  pollId: number;
  optionId: number;
  userId: number;
}>("poll", "vote", ["pollId", "optionId", "userId"]);

// 定义投票配置
interface PollConfig {
  activePolls: number;
  allowMultipleVotes: boolean;
}

// 内存中的投票数据
const polls = new Map();

const plugin: BotPlugin = {
  name: "poll",
  description: "简单的投票系统",
  version: "1.0.0",

  permissions: [
    {
      name: "poll.create",
      description: "创建投票",
    },
    {
      name: "poll.vote",
      description: "参与投票",
    },
  ],

  async onLoad(client) {
    // 加载配置
    const config = await client.features.getPluginConfig<PollConfig>("poll", {
      activePolls: 10,
      allowMultipleVotes: false,
    });

    this.logger?.info(`投票插件已加载，最大活跃投票数: ${config.activePolls}`);
  },

  commands: [
    {
      name: "poll",
      description: "创建新投票",
      requiredPermission: "poll.create",
      async handler(ctx: CommandContext) {
        if (!ctx.content) {
          await ctx.message.replyText(`
使用方法: /poll 问题?|选项1|选项2|选项3...
例如: /poll 你喜欢哪种水果?|苹果|香蕉|橙子
`);
          return;
        }

        // 解析投票内容
        const parts = ctx.content.split("|");
        if (parts.length < 3) {
          await ctx.message.replyText(
            "格式错误：需要至少提供一个问题和两个选项"
          );
          return;
        }

        const question = parts[0].trim();
        const options = parts
          .slice(1)
          .map((o) => o.trim())
          .filter(Boolean);

        // 创建投票
        const pollId = Date.now();
        polls.set(pollId, {
          id: pollId,
          creator: ctx.message.sender.id,
          question,
          options: options.map((text, i) => ({ id: i, text, votes: 0 })),
          voters: new Set(),
        });

        // 创建投票键盘
        const keyboard = BotKeyboard.inline(
          options.map((_, i) => [
            BotKeyboard.callback(
              `${i + 1}. ${_}`,
              VoteCallback.build({
                pollId,
                optionId: i,
                userId: ctx.message.sender.id,
              })
            ),
          ])
        );

        // 发送投票消息
        await ctx.message.replyText(
          html`
            <b>📊 投票</b>: ${question} ${options
              .map((o, i) => `${i + 1}. ${o} (0票)`)
              .join("\n")}

            <i>0人已投票</i>
          `,
          { replyMarkup: keyboard }
        );
      },
    },
  ],

  events: [
    {
      type: "callback",
      name: "vote",
      async handler(ctx: CallbackEventContext) {
        // 获取回调数据
        const { pollId, optionId } = ctx.match;
        const userId = ctx.query.user.id;

        // 获取投票
        const poll = polls.get(Number(pollId));
        if (!poll) {
          await ctx.query.answer({
            text: "投票已过期或已删除",
            alert: true,
          });
          return;
        }

        // 检查权限
        if (!ctx.hasPermission("poll.vote")) {
          await ctx.query.answer({
            text: "您没有参与投票的权限",
            alert: true,
          });
          return;
        }

        // 检查是否已投票
        const config = await ctx.client.features.getPluginConfig<PollConfig>(
          "poll"
        );
        if (!config.allowMultipleVotes && poll.voters.has(userId)) {
          await ctx.query.answer({
            text: "您已经投过票了",
            alert: true,
          });
          return;
        }

        // 更新投票
        poll.options[optionId].votes++;
        poll.voters.add(userId);

        // 更新消息
        const totalVotes = poll.voters.size;
        await ctx.client.editMessage({
          chatId: ctx.chatId,
          message: ctx.query.messageId,
          text: html`
            <b>📊 投票</b>: ${poll.question} ${poll.options
              .map((o, i) => `${i + 1}. ${o.text} (${o.votes}票)`)
              .join("\n")}

            <i>${totalVotes}人已投票</i>
          `,
          replyMarkup: ctx.query.message.replyMarkup,
        });

        // 回复用户
        await ctx.query.answer({
          text: "投票成功！",
        });
      },
    },
  ],
};

export default plugin;
```
