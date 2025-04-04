<div align="center">
  <h1>✨ NatsukiMiyu Next ✨</h1>
  <p>
    <img src="https://img.shields.io/badge/version-3.0-blue" alt="版本">
    <img src="https://img.shields.io/badge/language-TypeScript-blue" alt="语言">
    <img src="https://img.shields.io/badge/platform-Telegram-blue" alt="平台">
  </p>
  <p>📱 多功能的第三代 NatsukiMiyu 机器人 🤖</p>
</div>

> [!WARNING]
> NatsukiMiyu Next 目前处于开发阶段，API 可能不稳定，功能可能随时变更

---

## 📋 目录

- [🚀 快速开始](#-快速开始)
- [🧩 插件开发详解](#-插件开发详解)
- [🔥 高级功能](#-高级功能)
- [📚 API参考](#-api参考)

---

## 🚀 快速开始

### 📥 安装

```bash
# 安装依赖
bun install
```

### ⚙️ 环境变量

创建一个 `.env` 文件，并填入以下内容:

```env
# 时区设置
TZ=Asia/Shanghai

# Telegram API 凭证
TG_API_ID=xxxxx
TG_API_HASH=xxxxx
TG_TOKEN=xxxxx

# 管理员 ID 和启用的聊天
MANAGER_IDS=1111,22222
ENABLE_CHATS=-33333

# AI API密钥
AI_OPENROUTER_API_KEY=sk-or-v1-xxx,sk-or-v1-xxxxx
```

> [!IMPORTANT]
> 请确保妥善保管您的 API 密钥和令牌，不要将它们分享给他人或提交到公共代码库

### 🏃‍♂️ 运行

```bash
bun start
```

---

## 🧩 插件开发详解

> [!NOTE]
> 插件是 NatsukiMiyu 的核心功能扩展方式，掌握插件开发可以让您定制自己的机器人功能

### 📝 基本结构

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

> [!TIP]
> 尽量保持插件结构清晰，将相关功能组织在一起，便于维护和理解

### 🔄 命令处理

#### 🔹 基础命令定义

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

#### 🔹 命令参数解析

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

> [!NOTE]
> `ctx.content` 包含完整的参数字符串，而 `ctx.args` 是按空格分割的参数数组，方便不同场景的使用

#### 🔹 命令冷却与权限检查

冷却和权限检查自动实现，无需手动编写。当用户触发命令时：

1. ✅ 框架检查用户是否有命令要求的权限
2. ⏱️ 检查用户是否在冷却时间内
3. 🔄 通过检查后，执行命令处理程序

> [!IMPORTANT]
> 合理设置命令冷却时间可以防止滥用和避免触发 Telegram 的频率限制

### 📊 事件系统

#### 🔹 支持的事件类型

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

#### 🔹 事件过滤器

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

> [!TIP]
> 善用过滤器可以避免不必要的处理逻辑，提高机器人的响应效率

#### 🔹 事件优先级

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

> [!WARNING]
> 优先级数值越大越先处理，合理设置优先级避免处理冲突，尤其是在有多个插件时

### ⚙️ 配置管理

#### 🔹 读取与保存配置

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

> [!NOTE]
> 配置会自动保存到 JSON 文件中，重启机器人后仍然有效，适合存储持久性设置

### 🔒 权限管理

#### 🔹 声明权限

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

> [!IMPORTANT]
> 通过 `parent` 属性可以创建权限继承关系，简化权限管理。拥有父权限的用户自动拥有所有子权限

#### 🔹 检查权限

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

### 📝 日志系统

#### 🔹 基础日志

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

> [!TIP]
> 善用不同级别的日志，便于调试和监控机器人运行状态

#### 🔹 高级日志功能

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

> [!NOTE]
> 设置 `remote: true` 可以将重要日志直接发送给管理员，便于远程监控机器人状态

### 🔄 回调数据处理

#### 🔹 创建回调按钮

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

> [!WARNING]
> 回调数据有大小限制，不要在回调数据中存储过多信息。必要时可以使用 ID 引用数据库中的数据

### 💬 消息编辑与交互式 UI

#### 🔹 发送和编辑消息

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

> [!TIP]
> 使用 HTML 标记可以创建格式丰富的消息，增强用户体验。支持的标签包括 `<b>`, `<i>`, `<code>`, `<pre>`, `<a>` 等

#### 🔹 发送媒体文件

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

### 👥 用户和聊天操作

#### 🔹 用户信息获取

```typescript
// 获取用户信息
const user = await ctx.client.getUser("username"); // 通过用户名
const userById = await ctx.client.getUserById(123456789); // 通过ID

// 在事件处理中直接获取
const senderId = ctx.message.sender.id;
const senderName = ctx.message.sender.displayName;
const username = ctx.message.sender.username;
```

#### 🔹 聊天管理

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

> [!WARNING]
> 对聊天成员的管理操作需要机器人拥有相应的管理员权限，否则将返回权限错误

### 🔌 插件间通信

#### 🔹 直接调用其他插件的方法

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

> [!CAUTION]
> 直接调用其他插件的方法会创建强耦合，尽量使用事件系统进行松耦合的插件间通信

#### 🔹 使用事件进行解耦通信

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

> [!TIP]
> 使用前缀（如 `custom:`）可以避免事件名冲突，建议采用特定的命名约定

## 🔥 高级功能

> [!NOTE]
> 本节介绍 NatsukiMiyu 机器人提供的高级功能和使用技巧，掌握这些功能可以更好地发挥机器人的潜力

### 🤖 内存管理

NatsukiMiyu 内置了智能内存管理系统，能够自动监控和优化内存使用：

```typescript
// 手动触发内存清理
client.features.cleanupMemory(false); // 普通清理
client.features.cleanupMemory(true);  // 深度清理

// 内存使用情况分析
client.features.analyzeMemoryUsage();
```

> [!TIP]
> 当机器人运行时间较长或处理大量请求后，可以考虑定期触发内存清理

### 🔄 错误处理与恢复

NatsukiMiyu 提供了健壮的错误处理机制，确保单个插件的错误不会影响整个机器人的运行：

```typescript
try {
  // 可能出错的代码
} catch (error) {
  // 记录错误信息
  this.logger?.error("操作失败", { 
    error,
    remote: true, // 发送到管理员
    metadata: {
      operation: "数据处理",
      userId: ctx.message.sender.id
    }
  });
  
  // 向用户返回友好信息
  await ctx.message.replyText("很抱歉，处理您的请求时遇到了问题");
}
```

> [!IMPORTANT]
> 在插件中妥善处理异常，避免未捕获的错误导致插件被自动禁用

### 📊 性能监控

NatsukiMiyu 内置性能监控工具，帮助开发者优化机器人性能：

```typescript
// 在插件中标记性能关键点
const startTime = Date.now();
await processData(); // 执行耗时操作
const elapsedTime = Date.now() - startTime;

this.logger?.info(`数据处理完成`, {
  performance: {
    operation: "数据处理",
    duration: elapsedTime,
    dataSize: dataSize
  }
});
```

### 🔌 插件热重载

NatsukiMiyu 支持在不重启机器人的情况下重载插件：

```typescript
// 重载单个插件
await client.features.disablePlugin("plugin-name");
await client.features.loadPlugin("plugin-name", true);

// 重载所有插件
await client.features.reload();
```

> [!CAUTION]
> 插件热重载可能导致状态丢失，确保插件正确实现了 `onUnload` 方法来保存必要的状态

### 🧩 上下文处理

NatsukiMiyu 提供多种上下文类型，方便开发者处理不同类型的交互：

```typescript
// 命令上下文 (CommandContext)
// 当用户发送 /command 参数 时触发
async handler(ctx: CommandContext) {
  // 获取命令名称（不含/）
  const command = ctx.command;  // 例如: "command"
  
  // 获取命令参数
  const args = ctx.args;  // 例如: ["参数"]
  const content = ctx.content;  // 例如: "参数"
  
  // 获取原始消息文本
  const rawText = ctx.rawText;  // 例如: "/command 参数"
  
  // 检查权限
  if (!ctx.hasPermission("plugin.admin")) {
    return;
  }
}

// 消息上下文 (MessageEventContext)
// 当用户发送普通消息时触发
async handler(ctx: MessageEventContext) {
  // 获取消息内容
  const text = ctx.message.text;
  
  // 获取用户信息
  const userId = ctx.message.sender.id;
  const username = ctx.message.sender.username;
}

// 回调上下文 (CallbackEventContext)
// 当用户点击按钮时触发
async handler(ctx: CallbackEventContext) {
  // 获取回调数据
  const data = ctx.data;  // 完整回调数据
  
  // 使用匹配结果
  const { param1, param2 } = ctx.match;
  
  // 回复回调查询
  await ctx.query.answer({ text: "已处理" });
}
```

> [!TIP]
> 善用不同的上下文类型和属性，可以更精确地处理用户交互，提供更好的用户体验

### 🔍 数据验证

在处理用户输入时，应当进行充分的数据验证：

```typescript
// 简单输入验证
if (!ctx.content) {
  await ctx.message.replyText("请提供参数");
  return;
}

// 数字参数验证
const amount = parseInt(ctx.args[0]);
if (isNaN(amount) || amount <= 0) {
  await ctx.message.replyText("请提供有效的正数金额");
  return;
}

// 复杂参数验证
function validateUserInput(input: string): boolean {
  return /^[a-zA-Z0-9_]{3,20}$/.test(input);
}

if (!validateUserInput(ctx.args[0])) {
  await ctx.message.replyText("输入格式不正确，请使用3-20个字母、数字或下划线");
  return;
}
```

> [!IMPORTANT]
> 对用户输入进行严格验证，可以避免潜在的安全问题和意外错误

### 🌐 国际化支持

NatsukiMiyu 支持多语言功能，方便为不同地区的用户提供本地化体验：

```typescript
// 在插件加载时初始化语言配置
async onLoad(client) {
  this.translations = {
    'en': {
      'greeting': 'Hello, {name}!',
      'farewell': 'Goodbye, {name}!'
    },
    'zh': {
      'greeting': '你好，{name}！',
      'farewell': '再见，{name}！'
    }
  };
}

// 获取用户语言设置并翻译文本
async handler(ctx: CommandContext) {
  const userLang = await getUserLanguage(ctx.message.sender.id) || 'zh';
  const name = ctx.message.sender.displayName;
  
  const greeting = this.translations[userLang]['greeting'].replace('{name}', name);
  await ctx.message.replyText(greeting);
}
```

---

## 📚 API参考

### 📊 完整插件示例：投票系统

<details>
<summary>点击展开完整代码</summary>

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
</details>

> [!NOTE]
> 此示例展示了如何整合命令处理、回调按钮、配置管理等功能，是一个完整的插件实现参考

### 🧩 上下文接口参考

NatsukiMiyu 提供了丰富的上下文接口，以下是常用接口的属性和方法：

#### BaseContext

所有上下文类型的基础接口：

```typescript
interface BaseContext {
  // Telegram客户端实例
  client: TelegramClient;
  // 当前聊天ID
  chatId: number;
  // 权限检查函数
  hasPermission(permission: string): boolean;
}
```

#### CommandContext

命令处理上下文：

```typescript
interface CommandContext extends BaseContext {
  type: 'command';
  message: MessageContext;
  // 命令名，不包含/
  command: string;
  // 命令参数数组
  args: string[];
  // 命令参数拼接成字符串
  content: string;
  // 完整原始文本
  rawText: string;
  // 权限级别，用于快速检查
  permissionLevel: number;
}
```

#### MessageEventContext

消息事件上下文：

```typescript
interface MessageEventContext extends BaseContext {
  type: 'message';
  message: MessageContext;
}
```

#### CallbackEventContext

回调查询上下文：

```typescript
interface CallbackEventContext extends BaseContext {
  type: 'callback';
  query: CallbackQueryContext;
  data: string;
  parseData: CallbackDataParser;
  match?: {
    [key: string]: any;
    _pluginName?: string; // 匹配的插件名
    _actionType?: string; // 匹配的操作类型
  };
}
```

#### CallbackDataParser

回调数据解析器：

```typescript
interface CallbackDataParser {
  // 检查回调数据是否以指定前缀开头
  hasPrefix(prefix: string): boolean;
  
  // 获取回调数据的部分
  getPart(index: number): string | undefined;
  
  // 获取回调数据的整数部分
  getIntPart(index: number, defaultValue?: number): number;
  
  // 获取所有回调数据部分
  getParts(): string[];
  
  // 获取回调数据的命令部分（通常是第一部分）
  getCommand(): string;
  
  // 获取回调数据的子命令部分（通常是第二部分）
  getSubCommand(): string | undefined;
  
  // 解析回调数据为对象
  parseAsObject<T>(
    schema: Record<string, 'int' | 'string' | 'boolean'>, 
    startIndex?: number
  ): T;
}
```

### 📱 MessageContext API

消息上下文提供了丰富的方法来处理消息：

```typescript
// 回复文本消息
await ctx.message.replyText("回复内容", {
  parseMode: "html",               // 解析模式: html 或 markdown
  disableWebPagePreview: true,     // 禁用网页预览
  replyToMessageId: ctx.message.id // 引用回复的消息ID
});

// 回复媒体消息
await ctx.message.replyMedia(
  {
    type: "photo",               // 媒体类型: photo, document, video, audio...
    file: "path/to/image.jpg",   // 文件路径、Buffer或URL
    fileName: "image.jpg"        // 文件名
  },
  {
    caption: "图片说明",          // 媒体说明文本
    parseMode: "html"            // 说明文本解析模式
  }
);

// 编辑消息
await ctx.client.editMessage({
  chatId: ctx.chatId,
  message: messageId,            // 要编辑的消息ID
  text: "新内容",
  parseMode: "html",
  replyMarkup: keyboard          // 可更新的键盘
});

// 删除消息
await ctx.client.deleteMessage({
  chatId: ctx.chatId,
  message: messageId
});
```

### ⌨️ 键盘和按钮API

创建交互式键盘和按钮：

```typescript
import { BotKeyboard } from "@mtcute/bun";

// 创建内联键盘（消息内的按钮）
const inlineKeyboard = BotKeyboard.inline([
  // 第一行按钮
  [
    BotKeyboard.callback("按钮1", "callback:data:1"),
    BotKeyboard.callback("按钮2", "callback:data:2")
  ],
  // 第二行按钮
  [
    BotKeyboard.url("访问网站", "https://example.com"),
    BotKeyboard.switchInline("分享", "查询内容")
  ]
]);

// 创建回复键盘（替代用户输入区的按钮）
const replyKeyboard = BotKeyboard.reply(
  [
    ["按钮1", "按钮2"], // 第一行
    ["按钮3", "按钮4"]  // 第二行
  ],
  {
    placeholder: "请选择一个选项",   // 输入框提示文字
    oneTime: true,                 // 使用一次后自动隐藏
    resizable: true,               // 可调整大小
    selective: true                // 仅对特定用户显示
  }
);

// 在消息中使用键盘
await ctx.message.replyText("请选择:", {
  replyMarkup: inlineKeyboard     // 或 replyKeyboard
});

// 移除键盘
await ctx.message.replyText("已移除键盘", {
  replyMarkup: BotKeyboard.remove()
});
```

---

<div align="center">
  <p>🌟 由 NatsukiMiyu 开发团队开发 🌟</p>
  <p>欢迎贡献和提出问题！</p>
</div>
