# NatsukiMiyu Next

NatsukiMiyu Next 是一个基于 [mtcute](https://github.com/mtcute/mtcute) 构建的模块化、可扩展的 Telegram 机器人框架。

## 核心特性

- **插件化架构**: 通过独立的插件来组织和管理机器人的功能，易于扩展和维护。
- **强大的事件系统**: 支持消息、命令、回调查询等多种事件类型，并提供优先级和过滤器。
- **灵活的命令处理**: 支持命令别名、冷却时间、权限控制和参数解析。
- **精细的权限管理**: 内置权限系统，可以定义和管理用户及用户组的权限。
- **配置管理**: 每个插件都可以拥有独立的配置文件，并支持默认配置。
- **依赖管理**: 插件可以声明对其他插件的依赖，确保加载顺序。
- **插件专用日志**: 为每个插件提供专用的日志记录器，自动标记插件来源，便于调试和问题排查。
- **TypeScript 支持**: 使用 TypeScript 编写，提供类型安全和更好的开发体验。

## 快速开始

### 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/NatsukiMiyu-Next.git
cd NatsukiMiyu-Next

# 安装依赖
bun install
```

### 配置

1. 复制示例配置文件
```bash
cp config/config.example.json config/config.json
```

2. 编辑配置文件，填入必要信息
```json
{
  "apiId": 123456,           // 替换为你的API ID
  "apiHash": "your_api_hash", // 替换为你的API Hash
  "botToken": "bot_token",    // 替换为你的Bot Token
  "adminUsers": [123456789],  // 管理员用户ID
  "logLevel": "info"          // 日志级别 (debug, info, warn, error)
}
```

### 运行

```bash
# 使用Bun运行(推荐)
bun start

# 或使用Node运行
npm start
```

初次运行时，程序会自动扫描并加载`src/plugins`目录中的所有插件。

### 基本使用

机器人启动后，可以使用以下命令进行基本操作：

- `/help` - 显示可用命令列表
- `/plugins` - 查看已加载的插件
- `/plugin <plugin_name>` - 查看指定插件的详细信息
- `/admin` - 访问管理员面板(仅管理员可用)

## 插件开发指南

插件是NatsukiMiyu Next的核心构建块。每个插件都是独立的功能模块，可以自由组合。

### 基本结构

```typescript
import type { BotPlugin } from "../features";

// 插件定义
const plugin: BotPlugin = {
  // 基础信息
  name: "example",              // [必需] 唯一标识符
  description: "示例插件",       // [可选] 插件描述
  version: "1.0.0",             // [可选] 版本号
  
  // 依赖关系
  dependencies: ["system"],     // [可选] 依赖的其他插件
  
  // 权限声明
  permissions: [                // [可选] 插件所需的权限
    {
      name: "example.use",
      description: "使用插件的基本功能"
    }
  ],
  
  // 生命周期钩子
  async onLoad(client) {        // [可选] 加载时执行
    // 加载配置、初始化资源等
    const config = await client.features.getPluginConfig("example", defaultConfig);
  },
  
  async onUnload() {            // [可选] 卸载时执行
    // 清理资源、保存状态等
  },
  
  // 命令定义
  commands: [                   // [可选] 斜杠命令
    {
      name: "example",
      description: "示例命令",
      aliases: ["ex"],
      cooldown: 5,
      async handler(ctx) {
        await ctx.message.replyText("示例命令已执行");
      }
    }
  ],
  
  // 事件处理
  events: [                    // [可选] 事件处理器
    {
      type: "message",
      filter: ctx => ctx.message.text?.includes("关键词"),
      async handler(ctx) {
        this.logger?.info("收到消息");
        await ctx.message.replyText("检测到关键词");
      }
    }
  ]
};

export default plugin;
```

### 配置管理

提供方便的API管理插件配置：

```typescript
// 读取配置(会自动合并默认值)
const config = await client.features.getPluginConfig<Config>("plugin_name", defaultConfig);

// 保存配置
await client.features.savePluginConfig("plugin_name", config);
```

### 日志系统

每个插件都有独立的日志记录器，自动注入到`logger`属性：

```typescript
// 在插件对象内部
this.logger?.info("插件已加载");  // 普通信息
this.logger?.error("出现错误");   // 错误信息
this.logger?.debug("调试信息");   // 调试信息

// 在外部函数中
plugin.logger?.info("处理完成");

// 高级用法
this.logger?.error("API错误", { 
  remote: true,                 // 发送到管理员
  tags: ["api", "error"],       // 添加标签
  metadata: { status: 404 }     // 附加元数据
});
```

### 权限管理

插件可以声明和使用权限控制用户访问：

```typescript
// 声明权限(在插件对象中)
permissions: [
  {
    name: "example.use",
    description: "使用示例插件的基本功能",
    parent: "basic"             // 继承自basic权限
  }
]

// 检查权限(在事件处理中)
if (!ctx.hasPermission("example.use")) {
  await ctx.message.replyText("您没有权限执行此操作");
              return;
            }
```

### 回调数据解析器

NatsukiMiyu Next提供两种处理回调数据的方式：简单解析器和结构化构建器。

#### 简单解析器 (parseData)

`CallbackEventContext`的内置解析器，适用于基本场景：

```typescript
// 基本使用方式
const action = ctx.parseData.getCommand();       // 获取第一部分
const subAction = ctx.parseData.getSubCommand(); // 获取第二部分
const userId = ctx.parseData.getIntPart(2);      // 获取第三部分并转为数字
```

主要方法：
- `hasPrefix(prefix)` - 检查前缀
- `getPart(index)` - 获取指定部分
- `getIntPart(index, default = 0)` - 获取并转换为数字
- `parseAsObject<T>(schema, startIndex = 1)` - 解析为对象

#### 结构化构建器 (CallbackDataBuilder)

类型安全的回调数据构建和解析工具：

```typescript
// 1. 定义构建器
const DeleteButton = new CallbackDataBuilder<{
  itemId: number;
  userId: number;
}>('myPlugin', 'delete', ['itemId', 'userId']);

// 2. 生成回调数据
const data = DeleteButton.build({ itemId: 123, userId: 456 });
// 结果: "myPlugin:delete:123:456"

// 3. 处理回调 - 方式一：使用name属性(推荐)
{
  type: 'callback',
  name: 'delete',  // 匹配功能名
  async handler(ctx) {
    // 自动解析并注入ctx.match
    const { _param0, _param1 } = ctx.match; // _param0=itemId, _param1=userId
    console.log(`删除项目${_param0}，由用户${_param1}发起`);
  }
}

// 3. 处理回调 - 方式二：使用filter方法
{
  type: 'callback',
  filter: DeleteButton.filter(), // 或带条件: DeleteButton.filter({userId: 123})
  async handler(ctx) {
    const { itemId, userId } = ctx.match;
    console.log(`删除项目${itemId}，由用户${userId}发起`);
  }
}
```

#### 最佳实践

- **选择合适的方式**：简单场景用`name`属性，复杂场景用`filter`方法
- **数据格式**：始终使用`插件名:功能名:参数1:参数2...`的标准格式
- **参数设计**：重要参数靠前，使用数字ID替代字符串，总长度控制在64字节内
- **权限检查**：包含用户ID用于权限验证，处理前先验证权限
- **组织管理**：使用工厂函数统一管理同一插件的回调构建器

### 创建新插件

按照以下步骤快速创建一个新插件：

1. 在`src/plugins`目录下创建文件，如`my-plugin.ts`
2. 使用基本框架实现插件功能：

```typescript
import type { BotPlugin } from "../features";

// 定义插件对象
const plugin: BotPlugin = {
  name: "my-plugin",
  description: "我的自定义插件",
  version: "1.0.0",
  
  // 实现加载逻辑
  async onLoad(client) {
    this.logger?.info("插件已加载");
  },
  
  // 添加命令
  commands: [
    {
      name: "myplugin",
      description: "我的插件命令",
      async handler(ctx) {
        await ctx.message.replyText("命令已执行");
      }
    }
  ],
  
  // 处理事件
  events: [
    {
      type: "message",
      filter: ctx => ctx.message.text?.includes("触发词"),
      async handler(ctx) {
        await ctx.message.replyText("已触发事件");
      }
    }
  ]
};

export default plugin;
```

3. 保存文件后重启机器人，插件会自动加载

### 事件类型参考

NatsukiMiyu支持以下主要事件类型：

| 事件类型 | 上下文对象 | 说明 |
|---------|----------|------|
| `message` | `MessageEventContext` | 处理新消息 |
| `callback` | `CallbackEventContext` | 处理按钮回调 |
| `inline` | `InlineEventContext` | 处理内联查询 |
| `chat_join` | `ChatJoinEventContext` | 处理用户加入聊天 |
| `chat_leave` | `ChatLeaveEventContext` | 处理用户离开聊天 |

### 插件交互示例

#### 创建内联键盘

  ```typescript
// 在命令或事件处理函数中
await ctx.message.replyText("请选择操作", {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "选项A", callback_data: "plugin:optionA" },
        { text: "选项B", callback_data: "plugin:optionB" }
      ],
      [
        { text: "访问网站", url: "https://example.com" }
      ]
    ]
  }
});
```

#### 处理按钮点击

  ```typescript
// 在插件的events数组中
{
  type: "callback",
  name: "optionA",  // 匹配callback_data中的功能名
  async handler(ctx) {
    await ctx.query.answer({ text: "已选择选项A" });
    // 可以更新原消息
    await ctx.client.editMessageText({
      chat: ctx.chatId,
      message: ctx.query.messageId,
      text: "已选择选项A"
    });
  }
}
```

#### 访问数据库

  ```typescript
// 在插件中使用数据库
async function saveUserData(userId, data) {
  const db = client.features.getDatabase();
  
  // 插入或更新数据
  await db.collection("users").updateOne(
    { userId },
    { $set: { ...data, updatedAt: new Date() } },
    { upsert: true }
  );
  
  // 查询数据
  const user = await db.collection("users").findOne({ userId });
  return user;
}
```

#### 使用HTTP请求

```typescript
// 发起HTTP请求
import axios from "axios";

async function fetchWeather(city) {
  try {
    const response = await axios.get(`https://api.example.com/weather`, {
      params: { city, units: "metric" },
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    return response.data;
  } catch (error) {
    this.logger?.error("获取天气数据失败", { 
      remote: true,
      metadata: { city, error: error.message }
    });
    return null;
  }
}
```

## 贡献指南

我们欢迎并感谢任何形式的贡献！

### 提交问题

如果您发现了Bug或有新功能建议，请通过GitHub Issues提交，并尽可能提供以下信息：

- 详细的问题描述或功能建议
- 重现步骤（如果是Bug）
- 预期的行为和实际行为
- 日志或错误信息
- 您认为可能有帮助的其他信息

### 提交代码

1. Fork本仓库
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建一个Pull Request

### 编码规范

- 遵循TypeScript的命名规范
- 使用ESLint和Prettier保持代码风格一致
- 为公共API提供适当的文档注释
- 编写单元测试（如适用）

## 许可证

本项目采用MIT许可证 - 详情参见 [LICENSE](LICENSE) 文件

## 致谢

- [mtcute](https://github.com/mtcute/mtcute) - 提供了强大的Telegram客户端库
- [Bun](https://bun.sh/) - 现代JavaScript运行时
- 所有贡献者和用户 - 感谢您的支持和反馈
